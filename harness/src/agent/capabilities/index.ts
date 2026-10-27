// Workflow capabilities: the tools a project's agent reaches its surroundings
// with — its knowledge store, its KV, its durable memory, its host.
//
// Each capability is described once, as a JSON Schema plus a run function, and
// rendered twice from that description: as an agent tool, and as an MCP server
// for hosts whose harness speaks MCP.

export {
  STEAMHARNESS_CAPABILITIES,
  createProjectCapabilityServer,
  createProjectCapabilityTools,
  findProjectCapability,
  isProjectCapabilityAvailable,
  listProjectCapabilityToolIds,
  runProjectCapabilityAction,
  type CapabilityContext,
} from "./assemble";

export { selectDatabase } from "./databases";
export {
  KANBAN_METHODS_MCP_SERVER_ID, KANBAN_METHODS_MCP_TOOL_NAME, KANBAN_METHODS_MCP_TOOL_ID,
  KANBAN_METHODS_CAPABILITY, readKanbanMethodsBridgeConfig, runKanbanMethodsAction,
  type KanbanMethodsToolArgs,
} from "./kanban-methods";
export type { Capability } from "./types";

export {
  KNOWLEDGE_MCP_SERVER_ID,
  KNOWLEDGE_MCP_TOOL_ID,
  KNOWLEDGE_MCP_TOOL_NAME,
  KNOWLEDGE_CAPABILITY,
  runKnowledgeAction,
} from "./knowledge";

export {
  KV_MCP_SERVER_ID,
  KV_MCP_TOOL_ID,
  KV_MCP_TOOL_NAME,
  KV_CAPABILITY,
  runKvAction,
} from "./kv";

export {
  GLOBAL_MEMORY_MCP_SERVER_ID,
  GLOBAL_MEMORY_MCP_TOOL_ID,
  GLOBAL_MEMORY_MCP_TOOL_NAME,
  GLOBAL_MEMORY_CAPABILITY,
  runGlobalMemoryAction,
  type GlobalMemoryToolArgs,
} from "./global-memory";

export { readHostConfigurationBridgeConfig } from "./host-configuration";

export {
  PRESENTATION_CARD_MCP_SERVER_ID,
  PRESENTATION_CARD_MCP_TOOL_ID,
  PRESENTATION_CARD_MCP_TOOL_NAME,
  PRESENTATION_CARD_CAPABILITY,
  runPresentationCardAction,
  type PresentationCardKind,
  type PresentationCardToolArgs,
} from "./presentation-card";
