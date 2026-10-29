import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
export type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type { NodeContext } from "../types/context";
import type { Definition } from "../types/node";
import type { FileReference } from "../files/index";
import type { AgentApiKind } from "./pi";
import type { OutputItem } from "../node/output/index";
import type { RunPayload } from "../types/payload";
import type { ConversationParamDeclaration, ParamOption, UserSettingParamBinding } from "../executor/types";
import type { ToolPermissionDefinition } from "../tool-permissions/index";
import type { AgentSessionCommand, AgentSessionOptions, AgentSessionReceipt, AgentSessionSnapshot } from "./session-types";

/**
 * Reasoning effort the agent asks the model for.
 *
 * `ultra` is accepted as a synonym for `max` so a project can pass the same
 * value it would hand the built-in OpenCode project; `resolveAgentEffort`
 * normalizes it before the value reaches the model.
 */
export type AgentEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export const AGENT_EFFORT_LEVELS: readonly AgentEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const DEFAULT_AGENT_EFFORT: AgentEffort = "medium";

/**
 * How far the built-in coding tools may reach.
 *
 * Mirrors the built-in OpenCode project: `read-only` hides the mutating tools,
 * `workspace` approves everything inside the workspace, and `auto` approves
 * every permission that is not explicitly denied, external paths included.
 * Caller-supplied tools answer to the host's own permission catalogue instead.
 */
export type AgentPermissionPolicy = "read-only" | "workspace" | "auto";

/** A concrete developer policy, or an explicit opt-in to the host's user settings. */
export type AgentPermissionPolicySetting = AgentPermissionPolicy | "inherit";

export const AGENT_PERMISSION_POLICIES: readonly AgentPermissionPolicy[] = [
  "read-only",
  "workspace",
  "auto",
];

export const DEFAULT_AGENT_PERMISSION_POLICY: AgentPermissionPolicy = "workspace";

/** The two modes the built-in OpenCode project exposes, kept identical here. */
export type AgentMode = "build" | "plan";

export const AGENT_MODES: readonly AgentMode[] = ["build", "plan"];

export const DEFAULT_AGENT_MODE: AgentMode = "build";

export interface AgentImageInput {
  /** Base64 payload (no data-URL prefix). */
  data: string;
  mimeType: string;
}

/** Modalities a model may declare it accepts. */
export type AgentInputModality = "text" | "image";

export const AGENT_INPUT_MODALITIES: readonly AgentInputModality[] = ["text", "image"];

export interface AgentModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What is known about the model a custom endpoint serves.
 *
 * A custom provider is absent from pi's own catalogue, so without this the
 * runtime has to guess: it would advertise a window off a name-prefix table,
 * claim every model accepts images, and report zero cost. The SteamHarness Server
 * resolves these from its model catalogue and hands them to a system-AI run;
 * a caller pointing the agent at its own endpoint supplies them directly.
 *
 * Every field is optional, and an absent field keeps the runtime's own
 * default — so this describes, it never disables.
 */
export interface AgentModelAttributes {
  /** Display name; falls back to the model id. */
  name?: string;
  /** Whether the model does reasoning at all. */
  reasoning?: boolean;
  /** Whether the endpoint supports provider-managed web search. */
  webSearch?: boolean;
  input?: readonly AgentInputModality[];
  cost?: AgentModelCost;
  /** Context window the "used / total" row divides by. */
  contextWindow?: number;
  maxTokens?: number;
  /**
   * pi thinking level → the value sent upstream, `null` when the level is
   * unsupported. A level the map omits keeps pi's default mapping, which is
   * also why `ultra` is not a key: it is an OpenCode spelling that folds onto
   * `max` before it reaches a model.
   */
  thinkingLevelMap?: Readonly<Partial<Record<Exclude<AgentEffort, "ultra">, string | null>>>;
}

export interface AgentPlanApprovalResume {
  requestId: string;
  approved: boolean;
  /** Free-form guidance the user attached to the decision. */
  instructions?: string;
}

/**
 * A question the model put to the user mid-turn.
 *
 * A question with options is a choice; one without them is answered in words.
 * `custom` adds the words to a question that has options, so a plan can offer
 * the two approaches it thought of and still take a third.
 */
export interface AgentQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiple?: boolean;
  custom?: boolean;
}

/** The answers a resumed turn carries back to the model. */
export interface AgentAskResume {
  requestId: string;
  questions: AgentQuestion[];
  answers: string[];
}

/**
 * Everything a caller can hand a single agent run.
 *
 * The shape deliberately mirrors the built-in OpenCode project's input so a
 * host can move a run between the two implementations without re-mapping.
 */
export interface AgentInput extends RunPayload {
  prompt: string;
  /** Stable logical input identity. Retrying the same input reuses its submission. */
  requestId?: string;
  workdir?: string;
  /**
   * Roots the built-in tools may touch, alongside the workdir.
   *
   * Per run because a host that links other folders into a workspace learns
   * which ones from that workspace, not from the project's own declaration.
   * Relative entries resolve against this run's `workdir`.
   */
  allowedDirectories?: string[];
  images?: AgentImageInput[];
  /**
   * Attachments as host file references, resolved through this run's file
   * store before the agent sees them.
   *
   * A composer hands over what the host stored — an id and a mime type, with
   * the bytes somewhere the workflow process can read — and only the workflow
   * runtime holds the file store that knows how to reach them. The input node
   * turns these into `images` and drops the key, so nothing downstream has to
   * know a reference was ever involved.
   */
  imageFiles?: FileReference[];
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Wire protocol of `baseUrl`; the host's AI bridge sets this per run. */
  apiKind?: AgentApiKind;
  /** Omit to follow the model's search capability; false disables search. */
  webSearch?: boolean;
  /**
   * Attributes for the model a custom endpoint serves.
   *
   * Set by the runtime for a system-AI run (from the Server's model
   * catalogue), or supplied by a caller that points the agent at its own
   * endpoint.
   */
  modelAttributes?: AgentModelAttributes;
  /**
   * Persona for this run. Falls back to the runtime's own prompt, which is what
   * a plain coding agent wants; a host-bound project supplies its own.
   */
  systemPrompt?: string;
  /** Reasoning effort; overrides any effort baked into the runtime options. */
  effort?: AgentEffort;
  /** `build` does the work, `plan` only researches and proposes. */
  agent?: AgentMode;
  permissionPolicy?: AgentPermissionPolicySetting;
  /** Context window shown next to the used-token count. */
  contextWindow?: number;
  /** Explicit `/compact` request; also inferred from a `/compact` prompt prefix. */
  compact?: boolean;
  /**
   * Host input this run was derived from, when the host keeps the transcript.
   *
   * The OpenAI/Responses gateway stores its own message history, so a run that
   * carries its host input is left out of the workflow conversation — the same
   * arrangement the built-in conversation project makes.
   */
  hostInput?: unknown;
  planResume?: AgentPlanApprovalResume;
  /**
   * Answers to questions the previous turn asked, when this run is the turn
   * that picks the plan back up.
   */
  askResume?: AgentAskResume;
}

export interface AgentParsedInput {
  prompt: string;
  workdir: string;
  allowedDirectories: string[];
  images: AgentImageInput[];
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKind?: AgentApiKind;
  webSearch?: boolean;
  systemPrompt?: string;
  effort: AgentEffort;
  agent: AgentMode;
  permissionPolicy: AgentPermissionPolicy;
  contextWindow?: number;
  /** Attributes of the resolved model, when anything knows them. */
  modelAttributes?: AgentModelAttributes;
  compact: boolean;
  /** Tool names the caller narrowed the run to; undefined keeps every enabled tool. */
  tools?: string[];
  sessionId?: string;
}

export interface AgentContextUsage {
  used: number;
  total: number;
}

export interface AgentUsage {
  /** Stable billing record identity; hosts must upsert this projection on replay. */
  recordId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface AgentOutputPayload extends RunPayload {
  items: OutputItem[];
  prompt: string;
  workdir: string;
  provider?: string;
  model?: string;
  effort: AgentEffort;
  agent: AgentMode;
  sessionId?: string;
  toolCallCount: number;
  contextUsage?: AgentContextUsage;
  /** Populated when the run paused for a plan or tool approval. */
  pendingApproval?: AgentPendingApproval;
}

export interface AgentPendingApproval {
  kind: "plan" | "tool";
  requestId: string;
  toolName?: string;
}

/**
 * Streaming events a run emits. Text and thinking deltas are separate so a
 * host can render reasoning collapsed without inspecting the message shape.
 */
/**
 * Why a turn had to be continued instead of being finished.
 *
 * `dropped` is a transport failure — the proxy or the bridge cut the stream
 * while the model was answering, and pi classified it as retryable. `length`
 * is the provider reporting that the response stopped at the model's output
 * token limit: nothing in the stack calls that an error, so without a name for
 * it here a half-written answer would be indistinguishable from a finished one.
 * `lost-call` is the response contradicting itself: it says a tool call is in
 * it and there is none, which is what a dropped tool-call block looks like from
 * this side. `recovery` resumes committed output after a host restart, rather
 * than reporting a model connection failure.
 */
export type AgentTurnContinuationKind = "dropped" | "length" | "lost-call" | "recovery";

export interface AgentSearchSource {
  url: string;
  title?: string;
  citedText?: string;
}

export interface AgentWebSearch {
  id: string;
  status: "running" | "success" | "failed";
  query?: string;
  sources: AgentSearchSource[];
  error?: string;
}

export type AgentStreamEvent =
  | { type: "session"; snapshot: AgentSessionSnapshot }
  | { type: "web_search"; search: AgentWebSearch }
  | { type: "sources"; sources: AgentSearchSource[] }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | {
      type: "tool";
      phase: "start" | "update" | "end";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | { type: "plan"; phase: "start" | "end"; text: string }
  | { type: "compaction"; phase: "start" | "end"; auto: boolean; summary?: string }
  /**
   * A model stream that died mid-answer, re-issued as a continuation.
   *
   * The text and tool calls the dropped attempt produced are kept — the turn
   * carries on from them. Hosts show dropped-connection retries; host recovery,
   * output-limit continuations and missing-call recovery continue silently.
   */
  | {
      type: "retry";
      /** One-based within the current consecutive failure sequence; a complete successful response resets it. */
      attempt: number;
      maxAttempts: number;
      reason: string;
      kind: AgentTurnContinuationKind;
    }
  | { type: "context_usage"; usage: AgentContextUsage }
  | { type: "approval"; kind: "plan" | "tool"; approved: boolean; requestId?: string; toolName?: string };

/**
 * Host hooks. The node implementation binds these to `NodeContext`; a
 * programmatic caller can leave them out and the run never pauses.
 */
export interface AgentHost {
  /** Resolve to allow the call; throwing denies it (the message becomes the tool error). */
  approveToolCall?(input: AgentToolApprovalRequest): Promise<void>;
  /** Request plan approval; throwing pauses the run until the host resumes it. */
  approvePlan?(input: AgentPlanApprovalRequest): Promise<AgentPlanDecision>;
  /** Incremental billed usage for each completed model response, including interrupted responses. */
  reportUsage?(usage: AgentUsage): Promise<void> | void;
  abortSignal?: AbortSignal;
}

export interface AgentToolApprovalRequest {
  callId?: string;
  toolName: string;
  label?: string;
  description?: string;
  arguments?: unknown;
}

export interface AgentPlanApprovalRequest {
  requestId: string;
  plan: string;
}

export interface AgentPlanDecision {
  approved: boolean;
  requestId?: string;
  instructions?: string;
}

/**
 * What a tool factory may return.
 *
 * A factory that starts something — a child process speaking MCP, say — has
 * to say how to stop it: the tools it built outlive the call that made them
 * by exactly one run, and nothing else knows the child exists. A factory that
 * only builds schemas returns the array.
 */
export interface AgentToolSet {
  tools: AgentTool[];
  /** Deferred, explicitly authorized tools. Requires session.toolSearch. */
  catalogs?: readonly import("./extensions").AgentToolCatalog[];
  /** Released at run end, or when the session owner lease ends, errors included. */
  close?(): Promise<void>;
}

export type AgentToolFactory = (
  context: NodeContext,
) => AgentTool[] | AgentToolSet | Promise<AgentTool[] | AgentToolSet>;

export interface AgentRuntimeOptions {
  /** Host-scoped account memory; false disables inherited memory. */
  memory?: false | import("./memory").AgentMemoryBinding;
  /** Project models supplement user models by default; project uses only project entries and their host references. */
  modelSource?: "user-settings" | "project";
  /** Enable durable session control, task projections, and background work. */
  session?: AgentSessionOptions;
  /** SQLite file for this isolated agent session. Omit only for an ephemeral programmatic agent. */
  databasePath?: string;
  /** Host-owned exclusive storage factory; mutually exclusive with databasePath. */
  storage?: import("./storage").AgentStorageFactory;
  /** Directory tools resolve relative paths against. Defaults to `process.cwd()`. */
  workdir?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Wire protocol of `baseUrl`. Required to reach a Responses-style endpoint. */
  apiKind?: AgentApiKind;
  /** Omit to enable search only when modelAttributes.webSearch is true. */
  webSearch?: boolean;
  effort?: AgentEffort;
  permissionPolicy?: AgentPermissionPolicySetting;
  mode?: AgentMode;
  tools?: string[];
  toolDefinitions?: ToolPermissionDefinition[];
  /** Extra directories tools may read from and write to. Defaults to `[workdir]`. */
  allowedDirectories?: string[];
  /**
   * Tools the caller supplies, on top of the built-in coding tools.
   *
   * Governed by the host's permission catalogue rather than `permissionPolicy`.
   */
  extraTools?: AgentTool[];
  /**
   * How the run asks the user something mid-turn.
   *
   * Supplied by a host that can park a run and resume it; without it the agent
   * has no way to ask, and planning runs on without the answers. The choice of
   * whether a question may pause a turn is the mode's, not this hook's.
   */
  askUser?: (request: { requestId: string; questions: AgentQuestion[] }) => Promise<never>;
  sessionId?: string;
  /** Provider id used for the reported token usage. Defaults to the resolved provider. */
  providerName?: string;
  /**
   * Provider collection to resolve against instead of the built-in catalog.
   *
   * For hosts that register their own provider once (a gateway, a local
   * runtime) and want every agent in the process to share it.
   */
  models?: MutableModels;
  /** Already-resolved model; skips the provider lookup entirely. */
  resolvedModel?: Model<Api>;
  /**
   * Attributes for the model, when the caller knows them.
   *
   * Only consulted for a model the runtime has to synthesize — one reached
   * through `baseUrl`. A model pi's own catalogue can answer keeps the
   * catalogue's values.
   */
  modelAttributes?: AgentModelAttributes;
}

export interface AgentNodeOptions extends AgentRuntimeOptions {
  name?: string;
  /** Skill roots, resolved relative to the entry root. Shared by runtime tools and read-only host previews. */
  skills?: { directories: readonly string[] };
  /**
   * Item id the answer is emitted under.
   *
   * A host that streams the answer out of the run report — the OpenAI/Responses
   * adapters look their item up **by id** — can only find it under the id the
   * project declared, so this must be the same value as
   * `conversation.openai.outputItemId`. Left unset, the id is derived from the
   * conversation, which no adapter can name in advance.
   */
  outputItemId?: string;
  /**
   * Builds the caller-supplied tools for one run.
   *
   * A factory rather than a list because these tools close over the run's
   * `NodeContext` — its storage, its approval gate, its user input.
   */
  createTools?: AgentToolFactory;
  /** Persisted conversation/session key so a resumed run keeps its transcript. */
  sessionKey?: string;
  historyLimit?: number;
}

export type AgentProjectParamName = "provider" | "model" | "effort" | "plan" | "permissionPolicy";
export interface AgentProjectParamOverride {
  defaultValue?: string;
  userSetting?: UserSettingParamBinding | null;
  visible?: boolean;
  fixedValue?: string;
  label?: string;
  description?: string;
  options?: ParamOption[];
}
export interface AgentProjectParamOptions {
  fields?: Partial<Record<AgentProjectParamName, AgentProjectParamOverride | false>>;
  groups?: ({ kind: "quick"; id: string; label: string; icon?: string; summary: AgentProjectParamName[]; fields: AgentProjectParamName[] }
    | { kind: "auxiliary"; id: string; label: string; fields: AgentProjectParamName[] })[];
}
declare const agentConversationProjectBrand: unique symbol;
/** A Core conversation project carrying an isolated, non-serialized parameter contract. */
export interface AgentConversationProject extends Definition<AgentInput, AgentOutputPayload> {
  readonly [agentConversationProjectBrand]: true;
}

export interface AgentProjectOptions extends AgentNodeOptions {
  /** Default presentation of completed turns. Defaults to true; does not change stored output. */
  collapseIntermediate?: boolean;
  /** Display name of the generated project. */
  projectName?: string;
  /** Name used for the executor and its node names. Defaults to `agent`. */
  executorName?: string;
  /** Assistant output item id; must match `conversation.openai.outputItemId`. */
  outputItemId?: string;
  params?: ConversationParamDeclaration[];
  /** Customize the built-in assistant parameters without repeating their declarations. */
  paramOptions?: AgentProjectParamOptions;
}

export interface AgentRuntime {
  control?(command: AgentSessionCommand): Promise<AgentSessionReceipt>;
  /** Release the Harness and its ownership lock. Pending work remains recoverable. */
  close(): Promise<void>;
  /** Run one prompt, yielding normalized stream events. */
  run(input: AgentInput, host?: AgentHost): AsyncIterable<AgentStreamEvent>;
  /** Current context occupancy, including the assistant message still streaming. */
  getContextUsage(): AgentContextUsage | undefined;
  /** Supply an absolute measurement; ongoing estimates grow from it until the next valid model usage. */
  updateContextUsage(usage: AgentContextUsage): void;
  /** Replace the caller-supplied tools for subsequent runs. */
  setExternalTools(tools: readonly AgentTool[], catalogs?: readonly import("./extensions").AgentToolCatalog[]): void;
  /** Session id the runtime reports back to the host. */
  readonly sessionId?: string;
  /** Drop transcript state. */
  reset(): void;
  /**
   * The messages this run should carry on from.
   *
   * Only the first run of a process can be seeded: once the agent exists, the
   * transcript it holds is the authority — a run that arrived with the same
   * messages would otherwise be sent twice.
   */
  restoreTranscript?(messages: readonly AgentMessage[]): void;
  /** The transcript as it stands, for a caller that stores it between runs. */
  readTranscript?(): readonly AgentMessage[];
}
