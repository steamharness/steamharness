// MCP bridging: a stdio server's tools, surfaced as agent tools.
export { createMcpToolCatalog } from "./catalog";

export {
  connectMcpServer,
  normalizeMcpServers,
  readInheritedMcpEnvironment,
  DEFAULT_MCP_TIMEOUT_MS,
  MAX_MCP_SERVERS,
  MAX_MCP_TOOLS,
  type McpConnectOptions,
  type McpServerConnection,
  type McpServerDefinition,
  type McpToolCallResult,
  type McpToolDescriptor,
} from "./client";

export {
  createMcpToolId,
  createMcpTools,
  toAgentToolContent,
  type McpToolOptions,
} from "./tools";

// The other direction: a set of tools this process hosts for an MCP client.
export {
  createMcpToolServer,
  type McpToolServerOptions,
  type McpToolServerTool,
} from "./server";
