import type {
  LLMProvider,
  LLMProviderBinding,
  LLMProviderBindingInput,
} from "../provider/llm/types";
import type { ConversationContext } from "../conversation/index";
import type { FileStore } from "../files/index";
import type { KVContext, PersistentValueContext } from "../kv/index";
import type { DatabasesContext } from "../databases/index";
import type { EntriesContext } from "../entries/index";
import type { AccessActor } from "@steamharness/project-access";
import type { TokenUsageContext } from "../token-usage/index";
import type { TimerContext } from "../timer/index";
import type { ToolPermissionContext } from "../tool-permissions/index";
import type { NodeMetadata } from "./node";
import type { ParamDefinition } from "../executor/types";

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
  metadata?: NodeMetadata;
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

export interface UserInputRequest {
  requestId: string;
  nodeName: string;
  title: string;
  description?: string;
  params: ParamDefinition[];
  defaultValues?: Record<string, unknown>;
  metadata?: NodeMetadata;
  createdAt: Date;
}

export interface UserInputResolved {
  requestId: string;
  nodeName: string;
  values: Record<string, unknown>;
  submittedAt: Date;
  request?: UserInputRequest;
}

export interface UserInputContext {
  getResolvedInput(
    requestId: string,
    request?: UserInputRequest,
  ): Promise<UserInputResolved | undefined> | UserInputResolved | undefined;
  requestInput(request: UserInputRequest): Promise<void> | void;
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

export interface NodeContext {
  projectId: string;
  entryId: string;
  config: import("../configuration").ConfigurationValues;
  providers: ProviderRegistry;
  databases: DatabasesContext;
  entries: EntriesContext;
  actor?: AccessActor;
  conversation: ConversationContext;
  tokenUsage: TokenUsageContext;
  userInput?: UserInputContext;
  toolPermissions?: ToolPermissionContext;
  timers?: TimerContext;
  files?: FileStore;
  metadata?: Record<string, unknown>;
  nodeHooks?: NodeExecutionHooks;
  abortSignal?: AbortSignal;
}

export interface RunContext extends NodeContext {}
