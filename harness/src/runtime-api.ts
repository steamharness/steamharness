import {
  defineProjectEntrypoint,
  defineProjectExecutor,
} from "./executor/definition";
import {
  parseConversationDefaultInputArgs,
} from "./executor/default-input";
import {
  createAgentConversationProject,
  createAgentNode,
  createAgentProjectInput,
  createAgentProjectParamResolver,
  createAgentProjectParams,
  createAgentRuntime as createAgent,
  defineAgentConversationExecutor,
  createAgentRegistry,
  defineAgentTask,
  defineAgentExtension,
  defineAgentDoc,
  agentHook,
  AgentToolTask,
  AgentGenerationTask,
} from "./agent/index";
import {
  connectMcpServer,
  createMcpTools,
  createMcpToolCatalog,
  normalizeMcpServers,
} from "./agent/mcp/index";
import {
  createProjectCapabilityServer,
  createProjectCapabilityTools,
  isProjectCapabilityAvailable,
  listProjectCapabilityToolIds,
  runProjectCapabilityAction,
} from "./agent/capabilities/index";
import { createSkillTools, runSkillAction } from "./agent/skills";
import { readOpenAIConversationHostInput } from "./executor/openai";
import {
  createFileInputNode,
  createDetailsOutputNode,
  createInputNode,
  createLLMNode,
  createLLMStreamNode,
  addOutputItem,
  createOutputItem,
  createOutputItemChunk,
  createOutputNode,
  createOutputPayload,
  createQuestionClassifierNode,
  createUserInputNode,
  getLLMProvider,
} from "./node/index";
import {
  createToolApprovalGate,
} from "./tool-permissions/index";
import {
  createLLMProviderFromProjectEnv,
  createLLMProviderRef,
  getServerLLMCredentials,
} from "./provider/llm/index";
import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  editKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  readKnowledgeDocumentLines,
  searchKnowledgeDocuments,
} from "./knowledge/index";
import {
  createTimerNode,
  endTimer,
} from "./timer/index";
import { HarnessError, defineProject, runFor, runIf, runNode, runStreamNode, runWhile, runProject } from "./workflow/index";
import { getEnv } from "./env";
import { getRuntimeLocale } from "./runtime-locale";
import { getRuntimePlatform, isCli, isDesktop } from "./runtime-platform";

export const projectRuntimeApi = {
  createAgent,
  createAgentRegistry,
  defineAgentTask,
  defineAgentExtension,
  defineAgentDoc,
  agentHook,
  AgentToolTask,
  AgentGenerationTask,
  createAgentConversationProject,
  createAgentNode,
  createAgentProjectInput,
  createAgentProjectParamResolver,
  createAgentProjectParams,
  defineAgentConversationExecutor,
  connectMcpServer,
  createFileInputNode,
  addOutputItem,
  createDetailsOutputNode,
  createKnowledgeDocument,
  createInputNode,
  createLLMNode,
  createLLMProviderFromEnv: createLLMProviderFromProjectEnv,
  createLLMProviderRef,
  createLLMStreamNode,
  createMcpTools,
  createMcpToolCatalog,
  createOutputItem,
  createOutputItemChunk,
  createOutputNode,
  createOutputPayload,
  createQuestionClassifierNode,
  createSkillTools,
  createUserInputNode,
  createTimerNode,
  createToolApprovalGate,
  createProjectCapabilityServer,
  createProjectCapabilityTools,
  deleteKnowledgeDocument,
  defineEntrypoint: defineProjectEntrypoint,
  defineExecutor: defineProjectExecutor,
  defineProject,
  editKnowledgeDocument,
  endTimer,
  getEnv,
  getKnowledgeDocument,
  getRuntimeLocale,
  getRuntimePlatform,
  getLLMProvider,
  getServerLLMCredentials,
  isCli,
  isDesktop,
  isProjectCapabilityAvailable,
  parseConversationDefaultInputArgs,
  readOpenAIConversationHostInput,
  runFor,
  runIf,
  runNode,
  runSkillAction,
  runProjectCapabilityAction,
  listKnowledgeDocuments,
  listProjectCapabilityToolIds,
  normalizeMcpServers,
  readKnowledgeDocumentLines,
  runStreamNode,
  runWhile,
  runProject,
  searchKnowledgeDocuments,
  HarnessError,
};

export type RuntimeApi = typeof projectRuntimeApi;

declare global {
  // eslint-disable-next-line no-var
  var steamharness: RuntimeApi | undefined;
}

export function installProjectRuntimeGlobal(): RuntimeApi {
  globalThis.steamharness = projectRuntimeApi;
  return projectRuntimeApi;
}
