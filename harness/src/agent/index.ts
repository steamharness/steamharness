// Public surface of the agent capability layer.
//
// Everything a project needs to build an agent lives here, and the pi SDK
// stays behind `./pi` so consumers never import it directly.

export {
  createAgentRuntime,
  parseAgentInput,
  normalizeAgentEvent,
  sumAgentUsage,
  type AgentRuntimeInternalOptions,
} from "./runtime";

export { createAgentNode, createNodeAgentHost } from "./node";
export { cancelAgentConversation, exportAgentDatabase, importAgentDatabase, type AgentStorageFactory } from "./storage";
export type { AgentExecutionEnvironment, AgentToolCatalog } from "./extensions";
export { createRegistry as createAgentRegistry, defineTask as defineAgentTask, defineDoc as defineAgentDoc,
  defineExtension as defineAgentExtension, hook as agentHook, ToolTask as AgentToolTask, GenerationTask as AgentGenerationTask } from "@earendil-works/pi-durable";
export type { Task as AgentTask, TaskRuntime as AgentTaskRuntime, Registry as AgentRegistry, RegistryReader as AgentRegistryReader,
  ToolRegistration as AgentNativeTool, Extension as AgentExtension, Storage as AgentStorage, TaskId as AgentTaskId } from "@earendil-works/pi-durable";
export type { ExecutionEnv as AgentExecutionEnv } from "@earendil-works/pi-durable/env";
export { controlAgentSession, createAgentSessionHost } from "./session-control";
export type { AgentPlanItem, AgentSessionCommand, AgentSessionOptions, AgentSessionReceipt, AgentSessionResources, AgentSessionSnapshot, AgentSessionTask, AgentSessionTurn } from "./session-types";
export {
  createAgentConversationProject,
  createAgentProjectInput,
  createAgentProjectParams,
  defineAgentConversationExecutor,
} from "./project";

export {
  AGENT_EFFORT_LEVELS,
  DEFAULT_AGENT_EFFORT,
  AGENT_PERMISSION_POLICIES,
  DEFAULT_AGENT_PERMISSION_POLICY,
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
} from "./types";

export type {
  AgentTool,
  AgentContextUsage,
  AgentEffort,
  AgentHost,
  AgentImageInput,
  AgentInput,
  AgentInputModality,
  AgentMode,
  AgentModelAttributes,
  AgentModelCost,
  AgentNodeOptions,
  AgentOutputPayload,
  AgentParsedInput,
  AgentPendingApproval,
  AgentPermissionPolicy,
  AgentPlanApprovalResume,
  AgentPlanDecision,
  AgentPlanApprovalRequest,
  AgentProjectOptions,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentStreamEvent,
  AgentToolApprovalRequest,
  AgentToolFactory,
  AgentToolSet,
  AgentTurnContinuationKind,
  AgentUsage,
} from "./types";

export {
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_FILE_LISTING,
  SKILL_ENTRY_FILE,
  SKILL_TOOL_NAME,
  createSkillTools,
  runSkillAction,
  type SkillToolOptions,
} from "./skills";

export {
  formatAgentEffortLabel,
  parseAgentEffort,
  resolveAgentEffort,
  toThinkingLevel,
  type AgentThinkingLevel,
} from "./effort";

export {
  AGENT_PLAN_APPROVAL_NODE_NAME,
  AGENT_PLAN_REQUEST_ID_PREFIX,
  AGENT_PLAN_SYSTEM_PROMPT,
  createAgentPlanApprovalRequest,
  createAgentPlanRequestId,
  createAgentPlanResumePrompt,
  createAgentStreamResumePrompt,
  createAgentStreamRetryText,
  parseAgentMode,
  readAgentPlanDecision,
} from "./plan";

export {
  isAgentPermissionPolicy,
  listEnabledAgentToolNames,
  parseAgentPermissionPolicy,
  readAgentToolDefinitions,
  resolveAgentPermissionPolicy,
} from "./permission";

export {
  AGENT_SUMMARIZATION_SYSTEM_PROMPT,
  DEFAULT_AGENT_COMPACTION_SETTINGS,
  compactAgentMessages,
  estimateAgentContextTokens,
  estimateAgentTokens,
  findCompactionSplitIndex,
  readAgentContextUsage,
  serializeAgentMessages,
  shouldCompactAgent,
  type AgentCompactionResult,
  type AgentCompactionSettings,
} from "./compaction";

export {
  AGENT_ANSWER_ITEM_ID,
  AGENT_OUTPUT_KINDS,
  createAgentCompactionChunks,
  createAgentDetailPatch,
  createAgentErrorChunks,
  createAgentNoticeChunks,
  createAgentOutputItemId,
  createAgentReasoningChunks,
  createAgentRetryChunks,
  createAgentTextChunks,
  createAgentToolChunks,
  type AgentOutputKind,
  type AgentOutputPartType,
  type AgentOutputStatus,
} from "./output-items";

export {
  BUILTIN_AGENT_TOOL_CATALOG,
  BUILTIN_AGENT_TOOL_NAMES,
  MUTATING_AGENT_TOOL_NAMES,
  READ_ONLY_AGENT_TOOL_NAMES,
  createBuiltinAgentTools,
  resolveInsideScope,
  selectAgentToolNames,
  type AgentToolScope,
  type BuiltinAgentToolDescriptor,
  type BuiltinAgentToolName,
} from "./tools";

export {
  DEFAULT_MCP_TIMEOUT_MS,
  MAX_MCP_SERVERS,
  MAX_MCP_TOOLS,
  connectMcpServer,
  createMcpToolId,
  createMcpTools,
  createMcpToolCatalog,
  normalizeMcpServers,
  readInheritedMcpEnvironment,
  toAgentToolContent,
  type McpConnectOptions,
  type McpServerConnection,
  type McpServerDefinition,
  type McpToolCallResult,
  type McpToolDescriptor,
  type McpToolOptions,
} from "./mcp/index";

// The workflow capabilities are a self-contained set of tool descriptions, so
// they travel as a group rather than one export line per id.
export * from "./capabilities/index";

export {
  createAgentProjectParamResolver,
  listAgentSystemModels,
  readAgentSystemCredentials,
  readAgentSystemModelCapabilities,
  readAgentSystemProtocol,
  resolveAgentBridgeBaseUrl,
  selectAgentSystemLLM,
  startAgentSystemLLMRuntime,
  toAgentModelAttributes,
  DEFAULT_AGENT_ANTHROPIC_MODEL,
  DEFAULT_AGENT_OPENAI_MODEL,
  type AgentSystemLLMProtocol,
  type AgentSystemLLMRuntime,
  type AgentSystemLLMSelection,
} from "./system-llm";

export {
  DEFAULT_AGENT_CONTEXT_WINDOW,
  DEFAULT_AGENT_PROVIDER,
  resolveAgentModelContextWindow,
  type AgentApiKind,
} from "./pi";

export { parseAgentModelAttributes } from "./model-attributes";

/** The factory callers use: creates a runnable agent from plain options. */
export { createAgentRuntime as createAgent } from "./runtime";
