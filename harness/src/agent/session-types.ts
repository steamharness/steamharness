import type { RegistryReader, ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentExecutionEnvironment, AgentToolCatalog } from "./extensions";
import type { WorkflowOutputItemInput } from "../node/output/index";
import type { WorkflowTokenUsageAggregate } from "../token-usage/index";
import type { AgentContextUsage, AgentImageInput } from "./types";

export interface AgentPlanItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

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
    models?: { provider: string; modelId: string }[];
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
);

export interface AgentSessionReceipt {
  requestId: string;
  status: "accepted" | "aborted" | "already_placed" | "settled";
  conversationId: number;
  submissionId?: number;
  taskId?: number;
  forkId?: number;
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
  /** Submitted tool arguments, also available after the task has settled. */
  arguments?: unknown;
  replay?: "safe" | "never";
  attempt?: number;
  details?: unknown;
  definitionVersion?: number;
  checkpoint?: unknown;
  wakeAt?: number;
  script?: string;
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
  epoch: number;
  items: WorkflowOutputItemInput[];
  /** This turn's model responses, including retries; inherited history is not billed again. */
  usage?: WorkflowTokenUsageAggregate;
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
    outputs?: WorkflowOutputItemInput[] }[];
  records: { id: number; conversationId: number; kind: string; label: string; data?: unknown }[];
  receipts: AgentSessionReceipt[];
  usage: { conversationId: number; parentId?: number; models: Record<string, unknown>; tools: Record<string, unknown> }[];
  compactionFailure?: string;
  resources?: AgentSessionResources;
}
