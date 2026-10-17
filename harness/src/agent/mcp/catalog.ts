import type { AgentToolCatalog } from "../extensions";
import { connectMcpServer, normalizeMcpServers, type McpConnectOptions, type McpServerDefinition, type McpToolDescriptor } from "./client";
import { createMcpToolId, createMcpTools, type McpToolOptions } from "./tools";

/** No process is spawned until discovery (or the first call with predeclared schemas). */
export async function createMcpToolCatalog(options: {
  definition: McpServerDefinition;
  allowedTools: readonly string[];
  descriptors?: readonly McpToolDescriptor[];
  connect?: McpConnectOptions;
  approve?: McpToolOptions["approve"];
}): Promise<AgentToolCatalog> {
  const [definition] = normalizeMcpServers([options.definition], options.connect);
  const allowed = new Set(options.allowedTools);
  if (!allowed.size || allowed.size !== options.allowedTools.length) throw new Error("MCP catalog needs a unique tool allowlist.");
  return {
    id: definition!.id,
    allowedTools: [...allowed].map(name => createMcpToolId(definition!.id, name)),
    ...(options.descriptors ? { tools: await createMcpTools({ connection: { id: definition!.id,
      tools: options.descriptors.filter(tool => allowed.has(tool.name)), close: async () => {}, callTool: async () => { throw new Error("MCP catalog is not connected."); } } }) } : {}),
    open: async () => {
      const connection = await connectMcpServer(definition!, options.connect);
      try {
        const tools = await createMcpTools({ connection: { ...connection, tools: connection.tools.filter(tool => allowed.has(tool.name)) }, approve: options.approve });
        return { tools, close: () => connection.close() };
      } catch (error) { await connection.close(); throw error; }
    },
  };
}
