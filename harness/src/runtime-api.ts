import {
  defineWorkflowEntrypoint,
  defineWorkflowExecutor,
} from "./executor/definition";
import {
  parseConversationDefaultInputArgs,
} from "./executor/default-input";
import {
  createAgentConversationWorkflow,
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
  createWorkflowCapabilityServer,
  createWorkflowCapabilityTools,
  isWorkflowCapabilityAvailable,
  listWorkflowCapabilityToolIds,
  runWorkflowCapabilityAction,
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
  createLLMProviderFromWorkflowEnv,
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
import { HarnessError, defineWorkflow, runFor, runIf, runNode, runStreamNode, runWhile, runWorkflow } from "./workflow/index";
import { getEnv } from "./env";
import { getRuntimeLocale } from "./runtime-locale";
import { getRuntimePlatform, isCli, isDesktop } from "./runtime-platform";

export const workflowRuntimeApi = {
  createAgent,
  createAgentRegistry,
  defineAgentTask,
  defineAgentExtension,
  defineAgentDoc,
  agentHook,
  AgentToolTask,
  AgentGenerationTask,
  createAgentConversationWorkflow,
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
  createLLMProviderFromEnv: createLLMProviderFromWorkflowEnv,
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
  createWorkflowCapabilityServer,
  createWorkflowCapabilityTools,
  deleteKnowledgeDocument,
  defineEntrypoint: defineWorkflowEntrypoint,
  defineExecutor: defineWorkflowExecutor,
  defineWorkflow,
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
  isWorkflowCapabilityAvailable,
  parseConversationDefaultInputArgs,
  readOpenAIConversationHostInput,
  runFor,
  runIf,
  runNode,
  runSkillAction,
  runWorkflowCapabilityAction,
  listKnowledgeDocuments,
  listWorkflowCapabilityToolIds,
  normalizeMcpServers,
  readKnowledgeDocumentLines,
  runStreamNode,
  runWhile,
  runWorkflow,
  searchKnowledgeDocuments,
  HarnessError,
};

export type RuntimeApi = typeof workflowRuntimeApi;

declare global {
  // eslint-disable-next-line no-var
  var workflow: RuntimeApi | undefined;
}

export function installWorkflowRuntimeGlobal(): RuntimeApi {
  globalThis.workflow = workflowRuntimeApi;
  return workflowRuntimeApi;
}
