import type {
  LLMProvider,
  LLMProviderBinding,
  LLMProviderBindingInput,
} from "../provider/llm/types";
import type { ConversationContext } from "../conversation/index";
import type { FileStore } from "../files/index";
import type { EntriesContext } from "../entries/index";
import type { AccessActor } from "@steamharness/project-access";
import type { TokenUsageContext } from "../token-usage/index";
import type { TimerContext } from "../timer/index";
import type { ToolPermissionContext } from "../tool-permissions/index";
import type { NodeMetadata } from "./node";
import type { ParamDefinition } from "../executor/types";
import type { LLMBotModelRequestSnapshot } from "../provider/llm/request-trace";

export type { LLMBotModelRequestSnapshot } from "../provider/llm/request-trace";

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
  credential?: import("./bot-credential").BotCredentialSlot;
  /** Public descriptor for a native credential-backed operation, never the stored value. */
  credentialUse?: import("./bot-credential-use").BotCredentialUse;
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
  /** Resume an active run without restarting it. Hosts without live input leave this unset. */
  waitForInput?(request: UserInputRequest, signal?: AbortSignal): Promise<UserInputResolved>;
  /** Native host interaction. Only status and safe structure cross this boundary. */
  waitForCredential?(request: UserInputRequest & { credential: NonNullable<UserInputRequest["credential"]> }, signal?: AbortSignal): Promise<import("./bot-credential").BotCredentialStatus | import("./bot-credential").BotCredentialCaptureReceipt>;
  waitForCredentialUse?(request: UserInputRequest & { credentialUse: NonNullable<UserInputRequest["credentialUse"]> }, signal?: AbortSignal): Promise<import("./bot-credential-use").BotCredentialUseResult>;
  /** Omit for the original API key, password and SSH private key types. */
  credentialKinds?: readonly import("./bot-credential").BotCredentialKind[];
  /** Private catalog from the native host. */
  credentialUseOperations?: readonly import("./bot-credential-use").BotCredentialUseOperation[];
}

export interface NodeExecutionHooks {
  /** Opt-in host-only diagnostic for a dispatched LLM Bot call. Not a report event. */
  onLLMBotModelRequest?(request: LLMBotModelRequestSnapshot): Promise<void> | void;
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

export interface FolderContext {
  readonly directory: string;
}

export interface NodeContext {
  projectId: string;
  entryId: string;
  /** Present only for opted-in Bots launched with a trusted local folder. */
  readonly folderContext?: FolderContext;
  /** Identity of the project entry and host executing this run. */
  runtimeInfo?: import("../runtime-info").ProjectRuntimeInfo;
  config: import("../configuration").ConfigurationValues;
  providers: ProviderRegistry;
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
