import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * A tool this process offers to an MCP client.
 *
 * The result is a string rather than a list of MCP content blocks because
 * every caller so far speaks JSON to its model, and a JSON envelope is what
 * carries a failure's code and metadata alongside its message.
 */
export interface McpToolServerTool {
  name: string;
  title?: string;
  description?: string;
  /** Published to the client verbatim. */
  inputSchema: Record<string, unknown>;
  /**
   * Runs the tool. Expected to report failure by returning `isError`, not by
   * throwing, so the caller's own envelope survives the trip out.
   */
  call(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError?: boolean }>;
}

export interface McpToolServerOptions {
  /** Name the client sees as the source of these tools. */
  name: string;
  version?: string;
  tools: readonly McpToolServerTool[];
}

/**
 * Hosts a fixed set of tools as a stdio/HTTP-agnostic MCP server.
 *
 * Built on the low-level `Server` rather than `McpServer` so the schemas stay
 * plain JSON Schema. That is the same shape the client side receives from any
 * other server, and the same shape the agent SDK is handed, so one
 * declaration can serve both without a translation layer in the middle.
 */
export async function createMcpToolServer(options: McpToolServerOptions): Promise<Server> {
  const [{ Server: McpServer }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);

  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const server = new McpServer(
    { name: options.name, version: options.version ?? "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.get(request.params.name);
    if (tool === undefined) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool "${request.params.name}".` }],
      };
    }

    try {
      const result = await tool.call(
        (request.params.arguments ?? {}) as Record<string, unknown>,
        extra.signal,
      );
      return {
        ...(result.isError === true ? { isError: true } : {}),
        content: [{ type: "text" as const, text: result.text }],
      };
    } catch (error) {
      // `call` is meant to report failure in its result. Reaching here means
      // it broke rather than failed, so the message is all there is to send.
      return {
        isError: true,
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });

  return server;
}
