import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpServerConnection, McpToolDescriptor } from "./client";
import type { TypeboxLike } from "../tools";
import { loadTypebox } from "../pi";

export interface McpToolOptions {
  /**
   * TypeBox runtime. Resolved from the agent SDK when omitted, which is what a
   * project wants: the SDK is inlined into Core and is not a project
   * dependency, so a project has no way to import it.
   */
  Type?: TypeboxLike;
  connection: McpServerConnection;
  /**
   * Consulted before a call runs. Throwing blocks it — a `user_input_required`
   * throw parks the run instead.
   */
  approve?: (toolId: string, args: unknown) => Promise<void>;
  /** Overrides how a tool is named. Defaults to `<serverId>_<toolName>`. */
  createToolId?: (serverId: string, toolName: string) => string;
}

/**
 * The id an MCP tool is addressed by.
 *
 * Keeping the `<serverId>_<toolName>` shape means a project's declared tool
 * catalogue — and therefore the host's per-tool permission panel — keeps
 * naming exactly what it is granting.
 */
export function createMcpToolId(serverId: string, toolName: string): string {
  return `${serverId}_${toolName}`;
}

/**
 * Turns a connection's tools into tools the agent can call.
 *
 * Resolving the schema wrapper is asynchronous only when the caller cannot
 * supply one; the SDK load behind it is memoized process-wide.
 */
export async function createMcpTools(options: McpToolOptions): Promise<AgentTool[]> {
  const createToolId = options.createToolId ?? createMcpToolId;
  const Type = options.Type ?? await loadTypebox();

  return options.connection.tools.map((tool) => createMcpTool({ ...options, Type }, tool, createToolId));
}

/** Bounds a server-published schema has to respect before the SDK sees it. */
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_BYTES = 256 * 1024;

function createMcpTool(
  options: McpToolOptions & { Type: TypeboxLike },
  tool: McpToolDescriptor,
  createToolId: (serverId: string, toolName: string) => string,
): AgentTool {
  const toolId = createToolId(options.connection.id, tool.name);
  assertUsableSchema(toolId, tool.inputSchema);

  return {
    name: toolId,
    label: toolId,
    description: tool.description ?? `Tool "${tool.name}" from the ${options.connection.id} MCP server.`,
    parameters: options.Type.Unsafe(tool.inputSchema),
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      await options.approve?.(toolId, params);

      const result = await options.connection.callTool(
        tool.name,
        (params ?? {}) as Record<string, unknown>,
        signal,
      );
      const content = toAgentToolContent(result.content);

      // pi reports a failed tool by throwing; returning the error as content
      // would tell the model the call succeeded.
      if (result.isError) {
        throw new Error(readErrorText(content) ?? `MCP tool "${tool.name}" failed.`);
      }

      return { content: content.length === 0 ? [{ type: "text" as const, text: "(no output)" }] : content, details: {} };
    },
  } as unknown as AgentTool;
}

type AgentToolContent = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

/**
 * Maps MCP content blocks onto what the agent SDK understands.
 *
 * Anything else — an embedded resource, a link — is rendered as text rather
 * than dropped, so the model still sees that the tool returned something.
 */
/**
 * Refuses a schema the agent SDK would choke on.
 *
 * The MCP SDK hands `inputSchema` over as `unknown` and the agent SDK takes
 * what it is given as already valid, so nothing between a server and the tool
 * registry checks anything. A schema nested deep enough exhausts the stack
 * while the tool is being registered — before a model turn could fail
 * politely, and before the error could be attributed to the server that sent
 * it. The depth is measured iteratively for the same reason it is measured.
 */
function assertUsableSchema(toolId: string, schema: unknown): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`MCP tool "${toolId}" published a schema that is not an object.`);
  }

  const depth = readSchemaDepth(schema);
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error(
      `MCP tool "${toolId}" published a schema nested ${String(depth)} levels deep; the limit is ${String(MAX_SCHEMA_DEPTH)}.`,
    );
  }

  const size = Buffer.byteLength(JSON.stringify(schema) ?? "", "utf8");
  if (size > MAX_SCHEMA_BYTES) {
    throw new Error(
      `MCP tool "${toolId}" published a schema of ${String(size)} UTF-8 bytes; the limit is ${String(MAX_SCHEMA_BYTES)}.`,
    );
  }
}

function readSchemaDepth(schema: unknown): number {
  let depth = 0;
  const pending: Array<{ node: unknown; depth: number }> = [{ node: schema, depth: 1 }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > depth) depth = current.depth;
    if (depth > MAX_SCHEMA_DEPTH) return depth;

    for (const child of readChildNodes(current.node)) {
      pending.push({ node: child, depth: current.depth + 1 });
    }
  }

  return depth;
}

function readChildNodes(node: unknown): unknown[] {
  if (Array.isArray(node)) {
    return [...node];
  }
  if (typeof node === "object" && node !== null) {
    return Object.values(node as Record<string, unknown>);
  }

  return [];
}

export function toAgentToolContent(content: unknown): AgentToolContent {
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? [] : [{ type: "text", text: stringify(content) }];
  }

  const mapped: AgentToolContent = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      mapped.push({ type: "text", text: stringify(block) });
      continue;
    }

    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      mapped.push({ type: "text", text: record["text"] });
      continue;
    }
    if (record["type"] === "image" && typeof record["data"] === "string" && typeof record["mimeType"] === "string") {
      mapped.push({ type: "image", data: record["data"], mimeType: record["mimeType"] });
      continue;
    }
    mapped.push({ type: "text", text: stringify(block) });
  }

  return mapped;
}

function readErrorText(content: AgentToolContent): string | undefined {
  const text = content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((entry) => entry !== "")
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
