import type {
  LLMProvider,
  LLMProviderBinding,
  LLMProviderBindingInput,
} from "../provider/llm/types";
import type { WorkflowConversationContext } from "../conversation/index";
import type { WorkflowFileStore } from "../files/index";
import type { WorkflowKVContext, WorkflowPersistentValueContext } from "../kv/index";
import type { WorkflowRelatedProjectsContext } from "../kv/related-projects";
import type { WorkflowTokenUsageContext } from "../token-usage/index";
import type { WorkflowTimerContext } from "../timer/index";
import type { WorkflowToolPermissionContext } from "../tool-permissions/index";
import type { WorkflowNodeMetadata } from "./node";
import type { WorkflowParamDefinition } from "../executor/types";

export interface ProviderRegistry {
  llm?: LLMProvider;
  llmProviders?: Record<string, LLMProvider>;
  llmProviderBindings?: Record<string, LLMProviderBindingInput>;
  defaultLLMProviderBinding?: LLMProviderBinding;
  defaultLLMProviderId?: string;
}

export type NodeExecutionKind = "node" | "stream-node" | "branch-node";

export type NodeExecutionHookStatus = "success" | "failed";

export interface NodeExecutionHookStartEvent {
  executionId: string;
  nodeName: string;
  kind: NodeExecutionKind;
  metadata?: WorkflowNodeMetadata;
  startedAt: Date;
}

export interface NodeExecutionHookFinishEvent extends NodeExecutionHookStartEvent {
  status: NodeExecutionHookStatus;
  endedAt: Date;
  durationMs: number;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  executionInfo?: unknown;
  outputVisibility?: "visible" | "hidden";
}

export interface NodeExecutionHookChunkEvent extends NodeExecutionHookStartEvent {
  chunk: unknown;
  chunkOrder: number;
  timestamp: Date;
}

export interface WorkflowUserInputRequest {
  requestId: string;
  nodeName: string;
  title: string;
  description?: string;
  params: WorkflowParamDefinition[];
  defaultValues?: Record<string, unknown>;
  metadata?: WorkflowNodeMetadata;
  createdAt: Date;
}

export interface WorkflowUserInputResolved {
  requestId: string;
  nodeName: string;
  values: Record<string, unknown>;
  submittedAt: Date;
  request?: WorkflowUserInputRequest;
}

export interface WorkflowUserInputContext {
  getResolvedInput(
    requestId: string,
    request?: WorkflowUserInputRequest,
  ): Promise<WorkflowUserInputResolved | undefined> | WorkflowUserInputResolved | undefined;
  requestInput(request: WorkflowUserInputRequest): Promise<void> | void;
}

export interface NodeExecutionHooks {
  onNodeStart?(
    event: NodeExecutionHookStartEvent,
  ): Promise<void> | void;
  onNodeChunk?(
    event: NodeExecutionHookChunkEvent,
  ): Promise<void> | void;
  onNodeSuccess?(
    event: NodeExecutionHookFinishEvent,
  ): Promise<void> | void;
  onNodeError?(
    event: NodeExecutionHookFinishEvent,
  ): Promise<void> | void;
  onNodeFinish?(
    event: NodeExecutionHookFinishEvent,
  ): Promise<void> | void;
}

export interface WorkflowStorageLocationContext {
  kv: WorkflowKVContext;
  persistentValue: WorkflowPersistentValueContext;
  relatedProjects: WorkflowRelatedProjectsContext;
}

export interface WorkflowStorageContext {
  local: WorkflowStorageLocationContext;
  server: WorkflowStorageLocationContext;
}

export interface NodeContext {
  providers: ProviderRegistry;
  storage: WorkflowStorageContext;
  conversation: WorkflowConversationContext;
  tokenUsage: WorkflowTokenUsageContext;
  userInput?: WorkflowUserInputContext;
  toolPermissions?: WorkflowToolPermissionContext;
  timers?: WorkflowTimerContext;
  files?: WorkflowFileStore;
  metadata?: Record<string, unknown>;
  nodeHooks?: NodeExecutionHooks;
  abortSignal?: AbortSignal;
}

export interface WorkflowContext extends NodeContext {}
