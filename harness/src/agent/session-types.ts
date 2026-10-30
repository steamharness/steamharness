import type { RegistryReader, ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentExecutionEnvironment, AgentToolCatalog } from "./extensions";
import type { RunOutputItemInput } from "../node/output/index";
import type { TokenUsageAggregate } from "../token-usage/index";
import type { AgentContextUsage, AgentImageInput } from "./types";

export interface AgentPlanItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** A project-defined role. Tools and models can only narrow the parent's authorization. */
export interface AgentDefinition {
  id: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: { provider: string; modelId: string };
  effort?: string;
  maxConcurrency?: number;
}

export interface AgentWorkInput {
  workId: string;
  agentId: string;
  prompt: string;
  label?: string;
  metadata?: Record<string, JsonValue>;
  /** Reports are durable follow-up inputs. Project batch tasks usually consume the receipt themselves. */
  reportToParent?: boolean;
}

export interface AgentWorkInfo {
  taskId: number;
  workId: string;
  agentId: string;
  label: string;
  status: string;
  attempt: number;
  childConversationId?: number;
  retryOf?: number;
  progress?: { completed: number; total: number; phase?: string };
  metadata?: Record<string, JsonValue>;
  result?: string;
  error?: string;
  /** Per-command delivery receipt; a settled child is never restarted by send. */
  messageDelivery?: { status: "accepted" | "not_running"; nextAction?: "wait" | "get" | "retry" };
}

export type AgentSubagentAction =
  | ({ action: "spawn"; background?: boolean } & AgentWorkInput)
  | { action: "list" }
  | { action: "get" | "wait" | "stop" | "retry"; taskId: number }
  | { action: "send"; taskId: number; prompt: string; mode?: "steer" | "followUp" };

export interface AgentSessionOptions {
  registry?: RegistryReader;
  toolSearch?: { catalogs?: readonly AgentToolCatalog[] };
  /** Opt-in. Scripts only call this conversation's authorized tools. */
  codeMode?: { memoryLimitBytes?: number; timeoutMs?: number };
  environment?: AgentExecutionEnvironment;
  subagents?: {
    /** Explicit subset of the parent's tools. Subagents cannot delegate again. */
    tools: string[];
    maxAgents?: number;
    /** Default for all child roles and anonymous delegations. Must be in models. */
    model?: { provider: string; modelId: string };
    /** Project configuration field with control="agent-model". Empty means inherit the main model. */
    modelConfiguration?: string;
    /** Allowed overrides, using registered provider/modelId pairs. Omit to inherit the parent's model only. */
    models?: { provider: string; modelId: string }[];
    definitions?: readonly AgentDefinition[];
  };
  /** Native durable tools can call api.executeTool(); all calls pass the same approval hooks. */
  nativeTools?: ToolRegistration[];
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number; backgroundTokens?: number };
  planFork?: "initial" | "current" | "asOf";
}

export type AgentSessionCommand = { requestId: string; targetId?: number } & (
  | { type: "submit"; prompt: string; mode: "steer" | "followUp" | "reject"; images?: AgentImageInput[] }
  | { type: "withdraw"; inputId: string }
  | { type: "promote"; inputId: string }
  | { type: "compact"; instructions?: string }
  | { type: "reset"; handoff?: string }
  | { type: "fork"; entryId: number }
  | { type: "delete" }
  | { type: "configure"; expectedVersion: number; model?: { provider: string; modelId: string }; effort?: string }
  | { type: "plan"; expectedVersion: number; items: AgentPlanItem[] }
  | { type: "cancel"; scope: "foreground" | "all" | "task"; taskId?: number }
  | { type: "snapshot" }
  | { type: "task"; name: string; input: JsonValue; background?: boolean }
  | ({ type: "subagent" } & AgentSubagentAction)
);

export interface AgentSessionReceipt {
  requestId: string;
  status: "accepted" | "aborted" | "already_placed" | "settled";
  conversationId: number;
  submissionId?: number;
  taskId?: number;
  forkId?: number;
  agents?: AgentWorkInfo[];
}

export interface AgentSessionTask {
  id: number;
  conversationId: number;
  parentId?: number;
  kind: string;
  label: string;
  status: string;
  phase?: string;
  background: boolean;
  stopping: boolean;
  blockedOn: number[];
  blockedReason?: string;
  toolName?: string;
  callId?: string;
  /** Owned child for anonymous as well as named delegations, including settled history. */
  childConversationId?: number;
  /** Submitted tool arguments, also available after the task has settled. */
  arguments?: unknown;
  replay?: "safe" | "never";
  attempt?: number;
  details?: unknown;
  definitionVersion?: number;
  checkpoint?: unknown;
  wakeAt?: number;
  script?: string;
  agent?: AgentWorkInfo;
  progress?: { completed: number; total: number; phase?: string };
}

export interface AgentSessionResources {
  extensions: { name: string; tools: string[]; tasks: { name: string; version: number }[] }[];
  catalogs: { id: string; state: "idle" | "connecting" | "ready" | "failed"; tools: string[]; loaded: string[] }[];
  codeMode: boolean;
  environment: { id: string; label: string; state: "idle" | "ready" | "failed"; remote: boolean };
  storage: string;
}

export interface AgentSessionTurn {
  requestId: string;
  conversationId: number;
  prompt: string;
  mode: "steer" | "followUp" | "reject" | "report";
  status: "queued" | "placed" | "done" | "unanswered";
  entryId?: number;
  answerId?: number;
  reason?: string;
  /** Human-readable terminal failure, preserved independently of the reason code. */
  detail?: string;
  epoch: number;
  items: RunOutputItemInput[];
  /** This turn's model responses, including retries; inherited history is not billed again. */
  usage?: TokenUsageAggregate;
}

export interface AgentSessionSnapshot {
  version: 1;
  /** Changes on reopen so a previous owner's sequence cannot suppress new snapshots. */
  ownerId: string;
  revision: number;
  conversationId: number;
  foreground: boolean;
  backgroundCount: number;
  epoch: number;
  configuration: { version: number; model: string; provider: string; effort: string; cwd?: string };
  prompt: { hash: string; version: number };
  plan: { version: number; items: AgentPlanItem[] };
  tasks: AgentSessionTask[];
  history: AgentSessionTask[];
  turns: AgentSessionTurn[];
  conversations: { id: number; parentId?: number; title: string; background: boolean; forkEntryId?: number }[];
  contexts: { conversationId: number; foreground: boolean; backgroundCount: number; epoch: number; configuration: AgentSessionSnapshot['configuration'];
    prompt: AgentSessionSnapshot['prompt']; plan: AgentSessionSnapshot['plan']; contextUsage?: AgentContextUsage;
    /** Standard auxiliary outputs supplied by the Agent node for this conversation. */
    outputs?: RunOutputItemInput[] }[];
  records: { id: number; conversationId: number; kind: string; label: string; data?: unknown }[];
  receipts: AgentSessionReceipt[];
  usage: { conversationId: number; parentId?: number; models: Record<string, unknown>; tools: Record<string, unknown> }[];
  compactionFailure?: string;
  resources?: AgentSessionResources;
  agents?: AgentWorkInfo[];
}
