import { getProjectConfiguration, withProjectConfiguration } from "../configuration";
import { getUserSettings, withUserSettings, type UserSettings } from "../user-settings";
import { resolveAgentSystemAIInput } from "./model-resolution";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { HarnessError } from "../workflow/errors";
import { parseAgentWebSearch, type AgentSearchMessage } from "./web-search";
import { DurableAgent } from "./durable-agent";
import { getAgentMemoryBinding, createAgentMemoryTool, recallAgentMemory, submitAgentMemoryTurn, flushAgentMemoryOutbox } from "./memory";
import { AGENT_MEMORY_SKILL_PROMPT } from "./builtin-memory-skill";
import { BUILTIN_AGENT_SKILLS_PROMPT } from "./builtin-skills";
import { withStreamingMessage } from "./durable-context";
import type { AgentSessionCommand, AgentSessionReceipt } from "./session-types";
import {
  compactAgentMessages,
  DEFAULT_AGENT_COMPACTION_SETTINGS,
  estimateAgentContextTokens,
  findCompactionSplitIndex,
  readAgentContextUsage,
  type AgentCompactionResult,
  type AgentCompactionSettings,
} from "./compaction";
import {
  AGENT_ASK_TOOL_NAME,
  createAgentAskRequestId,
  createAgentAskResumePrompt,
  readAgentQuestions,
} from "./ask";
import { resolveAgentEffort, toThinkingLevel, type AgentThinkingLevel } from "./effort";
import {
  createAgentPlanRequestId,
  createAgentPlanResumePrompt,
  parseAgentMode,
  AGENT_PLAN_SYSTEM_PROMPT,
} from "./plan";
import {
  listEnabledAgentToolNames,
  resolveAgentPermissionPolicySetting,
  readAgentToolDefinitions,
  resolveAgentToolScope,
} from "./permission";
import {
  AGENT_PROVIDER_MAX_RETRIES,
  createPiRuntime,
  loadPiAi,
  type AgentApiKind,
  type PiRuntime,
} from "./pi";
import { createAskUserTool, createBuiltinAgentTools, type AgentToolScope, type TypeboxLike } from "./tools";
import type {
  AgentEffort,
  AgentContextUsage,
  AgentHost,
  AgentPermissionPolicy,
  AgentImageInput,
  AgentInput,
  AgentModelAttributes,
  AgentParsedInput,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentStreamEvent,
  AgentTurnContinuationKind,
  AgentUsage,
} from "./types";
import {
  DEFAULT_AGENT_EFFORT,
  DEFAULT_AGENT_MODE,
  DEFAULT_AGENT_PERMISSION_POLICY,
} from "./types";

/** Prompts that replace the turn with a compaction instead of calling the model. */
const COMPACT_COMMANDS = new Set(["/compact", "/summarize"]);

type PiAgent = DurableAgent;
type PiAgentTool = PiAgent["state"]["tools"][number];

export interface AgentRuntimeInternalOptions extends AgentRuntimeOptions {
  /** Host lease; pending work outlives the foreground answer. */
  sessionLease?: Promise<void>;
  sessionSuspend?: Promise<void>;
  resumeSession?: boolean;
  compaction?: AgentCompactionSettings;
  /** Node has already resolved and checked this connection. */
  modelResolved?: boolean;
  /** Pre-resolved SDK runtime. Tests inject a faux provider through this. */
  pi?: PiRuntime;
  /**
   * Tools the caller supplies for every run — MCP bridges, workflow
   * capabilities, skills.
   *
   * They are governed by the host's own permission catalogue rather than
   * `permissionPolicy`: a project declares them in `executor.tools`, and that
   * declaration is what carries their `enabled` / `autoApprove`. The policy
   * stays the authority for the built-in coding tools.
   */
  externalTools?: PiAgentTool[];
  /** Base delay for the Harness's persisted provider retries. */
  retryDelayMs?: number;
}

/**
 * Creates a runnable agent.
 *
 * Resolution is split deliberately: `createPiRuntime` owns everything
 * provider-shaped, while this object owns the run contract core exposes —
 * input parsing, effort, permission policy, compaction and plan mode.
 */
export async function createAgentRuntime(
  options: AgentRuntimeInternalOptions = {},
): Promise<AgentRuntime> {
  options = { ...options, memory: options.memory ?? getAgentMemoryBinding() };
  if (options.memory) {
    const binding = options.memory;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const capabilities = await Promise.race([binding.provider.capabilities(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Memory capabilities timed out.')), 2000);
      })]);
      options = { ...options, memory: !capabilities.connected || !capabilities.enabled ? false : { ...binding, readOnly: binding.readOnly || capabilities.readOnly } };
    } catch (error) { try { binding.onError?.(error); } catch {} }
    finally { clearTimeout(timer); }
  }
  const settings = getUserSettings();
  const configuration = getProjectConfiguration();
  const resolveHostModels = !options.pi && !options.modelResolved && (configuration !== undefined ||
    options.modelSource !== "project" && (options.modelSource === "user-settings" || !!settings.agent.models?.length));
  const original = options;
  const resolveModel = (input: AgentInput, signal?: AbortSignal) => withUserSettings(settings, () => configuration
    ? withProjectConfiguration(configuration, () => resolveAgentSystemAIInput(input, original, signal))
    : resolveAgentSystemAIInput(input, original, signal));
  const closers: (() => Promise<void>)[] = [];
  let resolveInput: ((input: AgentInput, signal?: AbortSignal) => Promise<AgentInput>) | undefined;
  if (resolveHostModels) {
    // Keep bridges and the host snapshot alive for durable and background tasks.
    // A later host update belongs to the next runtime, never to this one.
    const resolved = await resolveModel({} as AgentInput);
    closers.push(resolved.close);
    options = { ...options, ...resolved.input };
    resolveInput = async (input, signal) => {
      if (input.model === undefined && input.provider === undefined && input.baseUrl === undefined && input.apiKey === undefined) {
        return { ...input, ...resolved.input, modelAttributes: resolved.input.modelAttributes === undefined ? input.modelAttributes
          : { ...resolved.input.modelAttributes, ...input.modelAttributes,
            ...(resolved.input.modelAttributes.webSearch === undefined ? {} : { webSearch: resolved.input.modelAttributes.webSearch }) } };
      }
      const next = await resolveModel(input, signal);
      closers.push(next.close);
      return next.input;
    };
  }
  try {
    const pi = options.pi ?? await createPiRuntime(options);
    return new ProjectAgentRuntime(pi, options, resolveInput, closers, resolveHostModels ? settings : undefined);
  } catch (error) {
    await Promise.allSettled(closers.map(close => close()));
    throw error;
  }
}

class ProjectAgentRuntime implements AgentRuntime {
  async control(command: AgentSessionCommand): Promise<AgentSessionReceipt> {
    if (!this.options.session || !this.agent) throw Object.assign(new Error("The agent session is not running."), { code: "AGENT_NOT_READY" });
    return this.agent.control(command);
  }
  private readonly options: AgentRuntimeInternalOptions;
  private readonly toolDefinitions = readAgentToolDefinitions(undefined);
  private readonly allTools: PiAgentTool[];
  private agent: PiAgent | undefined;
  /** Connection the current pi runtime was built for, so it is only rebuilt when it changes. */
  private connection: AgentConnection;
  private externalTools: PiAgentTool[] = [];
  private externalCatalogs: readonly import("./extensions").AgentToolCatalog[] = [];
  /**
   * The transcript this process starts from, until the agent exists.
   *
   * Held rather than applied immediately because the agent is built lazily on
   * the first run, and applying it later would replace a transcript the runtime
   * is already carrying.
   */
  private restored: readonly AgentMessage[] | undefined;
  private contextWindow: number | undefined;
  private contextMeasurement: { usage: AgentContextUsage; estimated: number } | undefined;
  private publishContextUsage: (() => void) | undefined;

  constructor(
    private pi: PiRuntime,
    options: AgentRuntimeInternalOptions,
    private readonly resolveInput?: (input: AgentInput, signal?: AbortSignal) => Promise<AgentInput>,
    private readonly modelClosers: (() => Promise<void>)[] = [],
    private readonly userSettings?: UserSettings,
  ) {
    this.options = options;
    this.connection = readConnection(options);
    this.allTools = createAgentTools(pi, scopeFromOptions(options), resolveAgentPermissionPolicySetting(options.permissionPolicy));
    this.externalTools = [...(options.extraTools ?? []), ...(options.externalTools ?? [])];
  }

  get sessionId(): string | undefined {
    return this.options.sessionId;
  }

  /**
   * Replaces the caller-supplied tools.
   *
   * Called per run by the node: those tools close over the run's
   * `NodeContext`, so they cannot be built once alongside the runtime.
   */
  setExternalTools(tools: readonly PiAgentTool[], catalogs: readonly import("./extensions").AgentToolCatalog[] = []): void {
    this.externalTools = [...tools];
    this.externalCatalogs = catalogs;
    if (catalogs.length && !this.options.session?.toolSearch) throw new Error("Deferred tools require session.toolSearch.");
  }

  reset(): void {
    this.agent?.reset();
    this.restored = undefined;
    this.contextMeasurement = undefined;
    this.contextWindow = undefined;
  }

  restoreTranscript(messages: readonly AgentMessage[]): void {
    // A transcript is only ever *seeded*. The agent may already be carrying a
    // live one — the host runs several turns in one process when it can — and
    // replacing it with the copy the host loaded before the first run would
    // drop everything the later turns did.
    if (this.agent === undefined) {
      this.restored = messages;
    }
  }

  readTranscript(): readonly AgentMessage[] {
    return this.agent?.state.messages ?? this.restored ?? [];
  }

  getContextUsage(): AgentContextUsage | undefined {
    const estimated = this.readContextTokens();
    const measurement = this.contextMeasurement;
    return readAgentContextUsage({
      used: measurement === undefined ? estimated : measurement.usage.used + estimated - measurement.estimated,
      contextWindow: measurement?.usage.total ?? this.contextWindow ?? this.agent?.state.model.contextWindow ?? this.pi.model.contextWindow,
    });
  }

  updateContextUsage(usage: AgentContextUsage): void {
    if (!Number.isFinite(usage.used) || usage.used < 0 || !Number.isFinite(usage.total) || usage.total <= 0) {
      throw new HarnessError({ type: "input_validation", message: "Context usage requires finite used >= 0 and total > 0." });
    }
    this.contextMeasurement = { usage: { used: Math.round(usage.used), total: usage.total }, estimated: this.readContextTokens() };
    this.publishContextUsage?.();
  }

  async close(): Promise<void> {
    try { await this.agent?.close(); }
    finally {
      this.agent = undefined;
      await Promise.allSettled(this.modelClosers.splice(0).map(close => close()));
    }
  }

  private readContextTokens(): number {
    const messages = this.agent?.state.contextMessages ?? this.readTranscript();
    const streaming = this.agent?.state.streamingMessage;
    return estimateAgentContextTokens(withStreamingMessage(messages, streaming));
  }

  async *run(input: AgentInput, host?: AgentHost): AsyncIterable<AgentStreamEvent> {
    throwIfRunAborted(host?.abortSignal);
    const resolved = this.resolveInput ? await this.resolveInput(input, host?.abortSignal) : input;
    // A host-resolved connection and inherited permissions belong to one snapshot.
    // Explicit permissions on this input still take precedence.
    const parsed = this.userSettings
      ? withUserSettings(this.userSettings, () => parseAgentInput(resolved, this.options))
      : parseAgentInput(resolved, this.options);
    await this.applyConnection(parsed);
    const agent = this.ensureAgent();
    agent.state.contextWindow = parsed.contextWindow;
    await agent.open();
    this.contextWindow = parsed.contextWindow;
    const initialUsage = this.getContextUsage();
    if (initialUsage !== undefined) yield { type: "context_usage", usage: initialUsage };
    throwIfRunAborted(host?.abortSignal);

    if (parsed.compact) {
      if (!await agent.canCompact()) {
        throw new HarnessError({ type: "execution", message: "Cannot compact agent context while durable tasks are active." });
      }
      yield* this.runCompaction(agent, host, false);
      const usage = this.getContextUsage();
      if (usage !== undefined) { yield { type: "context_usage", usage }; }
      return;
    }

    yield* this.runPrompt(parsed, agent, input, host);
  }

  /**
   * Repoints the pi model at the connection this run uses.
   *
   * The host's system-AI bridge allocates a fresh port and path per run, so a
   * run that arrives with a different `baseUrl` cannot reuse the previous
   * provider. The `Agent` itself is kept: only its model and stream function
   * are swapped, which is what preserves the transcript across turns.
   */
  private async applyConnection(parsed: AgentParsedInput): Promise<void> {
    const next: AgentConnection = {
      provider: parsed.provider,
      model: parsed.model,
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      apiKind: parsed.apiKind,
      webSearch: parsed.webSearch,
      permissionPolicy: parsed.permissionPolicy,
      modelAttributesKey: stableModelAttributesKey(parsed.modelAttributes),
    };
    const modelChanged = !sameModelConnection(this.connection, next);
    const policyChanged = this.connection.permissionPolicy !== next.permissionPolicy;
    if (!modelChanged && !policyChanged) {
      return;
    }

    if (modelChanged) {
      // Only a different endpoint needs a different SDK runtime. A policy
      // change must not rebuild it: the injected runtime of a test, or a
      // caller's own provider collection, would be thrown away.
      this.pi = await createPiRuntime({
        provider: next.provider,
        model: next.model,
        baseUrl: next.baseUrl,
        apiKey: next.apiKey,
        apiKind: next.apiKind,
        webSearch: next.webSearch,
        // A per-run window wins over the attributes, which are the model's own
        // value from the catalogue. Both are absent for a model pi's catalogue
        // can answer, and the catalogue keeps that model's record either way.
        contextWindow: parsed.contextWindow,
        maxTokens: parsed.modelAttributes?.maxTokens,
        modelAttributes: parsed.modelAttributes,
        // The collection outlives the endpoint: it is where the caller, or a
        // test, registered the provider this run is meant to use.
        models: this.options.models,
      });
      this.contextMeasurement = undefined;
    }

    // The tool set is rebuilt either way: its schemas come from the SDK
    // instance the runtime loaded, and its scope comes from the policy.
    this.allTools.splice(
      0,
      this.allTools.length,
      ...createAgentTools(this.pi, scopeFromOptions(this.options), next.permissionPolicy ?? DEFAULT_AGENT_PERMISSION_POLICY),
    );
    this.connection = next;

    if (this.agent !== undefined) {
      this.agent.state.model = this.pi.model;
      this.agent.models = this.pi.models;
      this.agent.state.tools = this.allTools;
    }
  }

  private ensureAgent(): PiAgent {
    if (this.agent === undefined) {
      this.agent = new DurableAgent({
        initialState: {
          systemPrompt: defaultAgentSystemPrompt(),
          model: this.pi.model,
          thinkingLevel: "off",
          tools: this.allTools,
          messages: [...(this.restored ?? [])],
          // The transcript the caller restored, if any. Without it the agent
          // starts blank — which is right for a one-shot run and wrong for
          // every turn after the first in a conversation.
        },
        models: this.pi.models,
        session: this.options.session && { ...this.options.session, ...(this.options.session.toolSearch ? {
          toolSearch: { catalogs: [...(this.options.session.toolSearch.catalogs ?? []), ...this.externalCatalogs] },
        } : {}) },
        sessionLease: this.options.sessionLease,
        sessionSuspend: this.options.sessionSuspend,
        resumeSession: this.options.resumeSession,
        workdir: this.options.workdir,
        databasePath: this.options.databasePath,
        memoryEnabled: !!this.options.memory,
        storage: this.options.storage,
        retryDelayMs: this.options.retryDelayMs,
        compaction: this.compactionSettings(),
        contextUsage: () => this.getContextUsage(),
      });
    }

    return this.agent;
  }

  /** A parked approval leaves the tool intent live in the durable Harness. */
  private attachApproval(
    agent: PiAgent,
    host: AgentHost | undefined,
    onPause: (error: HarnessError) => void,
    askResume?: AgentInput["askResume"],
  ): void {
    const approveToolCall = host?.approveToolCall;
    const askUser = this.options.askUser;
    if (approveToolCall === undefined && askUser === undefined) {
      agent.beforeToolCall = undefined;
      return;
    }

    agent.beforeToolCall = async ({ toolCall, args }) => {
      try {
        // A question the model asked is put to the user here rather than in the
        // tool's own execute: this is the one place a pause can be raised, and
        // the parked run is what makes the answer reach the next turn.
        if (askUser !== undefined && toolCall.name === AGENT_ASK_TOOL_NAME) {
          const questions = readAgentQuestions(args);
          if (questions.length === 0) {
            return { block: true, reason: "ask_user needs at least one question with text in it." };
          }
          if (askResume?.requestId !== createAgentAskRequestId(toolCall.id)) {
            await askUser({ requestId: createAgentAskRequestId(toolCall.id), questions });
          }
          return undefined;
        }
        if (approveToolCall !== undefined) {
          await approveToolCall({ callId: toolCall.id, toolName: toolCall.name, arguments: args });
        }
        return undefined;
      } catch (error) {
        if (error instanceof HarnessError && error.type === "user_input_required") {
          onPause(error);
          return { block: true, reason: error.message, pause: error };
        }
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    };
  }

  private async *runCompaction(
    agent: PiAgent,
    host: AgentHost | undefined,
    auto: boolean,
  ): AsyncIterable<AgentStreamEvent> {
    const settings = this.compactionSettings();

    if (auto ? findCompactionSplitIndex(agent.state.messages, settings.keepRecentTokens) <= 0 : agent.state.messages.length === 0) {
      yield { type: "compaction", phase: "end", auto };
      return;
    }

    yield { type: "compaction", phase: "start", auto };
    const result = await this.compactTranscript(agent, settings, host, !auto);
    yield { type: "compaction", phase: "end", auto, summary: result.summary };
  }

  private compactionSettings(): AgentCompactionSettings {
    return this.options.compaction ?? DEFAULT_AGENT_COMPACTION_SETTINGS;
  }

  private async compactTranscript(
    agent: PiAgent,
    settings: AgentCompactionSettings,
    host: AgentHost | undefined,
    force = false,
  ): Promise<AgentCompactionResult> {
    const result = await compactAgentMessages({
      models: this.pi.models,
      model: { ...this.pi.model, contextWindow: this.contextWindow ?? this.pi.model.contextWindow },
      messages: agent.state.messages,
      settings,
      signal: host?.abortSignal,
      onUsage: usage => host?.reportUsage?.(sumAgentUsage([usage])!),
      force,
    }).catch(error => {
      throwIfRunAborted(host?.abortSignal);
      throw error;
    });
    throwIfRunAborted(host?.abortSignal);
    agent.state.messages = result.messages;
    await agent.checkpoint();
    if (result.removed > 0) this.contextMeasurement = undefined;
    return result;
  }

  private async *runPrompt(
    parsed: AgentParsedInput,
    agent: PiAgent,
    input: AgentInput,
    host?: AgentHost,
  ): AsyncIterable<AgentStreamEvent> {
    throwIfRunAborted(host?.abortSignal);
    const resume = input.planResume;
    const askResume = input.askResume;
    const prompt = askResume !== undefined
      ? createAgentAskResumePrompt({
          prompt: parsed.prompt,
          questions: askResume.questions,
          answers: askResume.answers,
        })
      : resume === undefined
        ? parsed.prompt
        : createAgentPlanResumePrompt({ plan: parsed.prompt, resume });
    const mode = resume === undefined ? parsed.agent : resume.approved ? "build" : "plan";

    applyRunConfiguration(
      agent,
      this.pi,
      { ...parsed, agent: mode },
      this.toolDefinitions,
      this.externalTools,
      this.options,
    );
    const memory = this.options.memory;
    if (memory) {
      if (mode !== "plan" && parsed.permissionPolicy !== "read-only" && !memory.readOnly) void flushAgentMemoryOutbox(memory);
      const recalled = await recallAgentMemory(memory, parsed.prompt);
      agent.state.systemPrompt += "\n\n" + AGENT_MEMORY_SKILL_PROMPT + (recalled ? "\n\n" + recalled : "");
    }
    let parkedApproval: HarnessError | undefined;
    agent.askResume = input.askResume;
    this.attachApproval(agent, host, (error) => {
      parkedApproval = error;
    }, input.askResume);

    const queue: AgentStreamEvent[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    let failure: unknown;
    let answer = "";
    let usageFailure: unknown;
    let lastContextUsage = this.getContextUsage();
    let lastDeltaUpdate = 0;
    let sessionContext: string | undefined;
    const publishContextUsage = (): void => {
      const usage = this.getContextUsage();
      if (usage === undefined || (usage.used === lastContextUsage?.used && usage.total === lastContextUsage.total)) return;
      lastContextUsage = usage;
      queue.push({ type: "context_usage", usage });
      notify?.();
      notify = undefined;
    };
    this.publishContextUsage = publishContextUsage;

    const unsubscribe = agent.subscribe(async (event) => {
      try {
        for (const normalized of normalizeAgentEvent(event as never)) {
          if (normalized.type === "compaction" && normalized.phase === "end" && normalized.summary !== undefined) this.contextMeasurement = undefined;
          if (normalized.type === "session") {
            const snapshot = normalized.snapshot;
            const key = JSON.stringify([snapshot.epoch, snapshot.configuration.version, snapshot.records.filter(record =>
              record.conversationId === snapshot.conversationId && record.kind === "pi.compaction").at(-1)?.id]);
            if (sessionContext !== undefined && sessionContext !== key) this.contextMeasurement = undefined;
            sessionContext = key;
            const currentUsage = this.getContextUsage();
            if (currentUsage) normalized.snapshot = { ...snapshot, contexts: snapshot.contexts.map(scope =>
              scope.conversationId === snapshot.conversationId ? { ...scope, contextUsage: currentUsage } : scope) };
          }
          if (normalized.type === "text_delta") {
            answer += normalized.delta;
          } else if (normalized.type === "tool" && normalized.phase === "start") {
            // Only the text after the final tool call is the completed plan.
            answer = "";
          }
          queue.push(normalized);
        }
        if (event.type === "message_start") lastDeltaUpdate = 0;
        const usage = readEventUsage(event as never);
        const reportedTokens = usage === undefined ? 0 : usage.totalTokens ||
          usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (usage !== undefined && event.type === "message_end" &&
            event.message.role === "assistant" && event.message.stopReason !== "error" &&
            event.message.stopReason !== "aborted" && event.message.stopReason !== "pending" &&
            Number.isFinite(reportedTokens) && reportedTokens > 0) {
          this.contextMeasurement = undefined;
        }
        if (event.type === "message_update") {
          const now = Date.now();
          if (lastDeltaUpdate === 0 || now - lastDeltaUpdate >= 100) {
            publishContextUsage();
            lastDeltaUpdate = now;
          }
        } else if (event.type === "message_start" || event.type === "message_end" || event.type === "agent_end" ||
            (event as { type: string }).type === "project_session" || (event as { type: string }).type === "project_compaction") {
          publishContextUsage();
        }
        const durableUsage = event as unknown as { type: string; usage?: Usage; recordId?: string };
        if (durableUsage.type === "project_usage" && durableUsage.usage !== undefined && host?.reportUsage !== undefined) {
          try {
            await host.reportUsage({ ...sumAgentUsage([durableUsage.usage])!, recordId: durableUsage.recordId });
          } catch (error) {
            usageFailure ??= error;
          }
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        notify?.();
        notify = undefined;
      }
    });

    // A cancelled run has to stop the turn, not just stop being read: the
    // agent keeps calling tools and the model until it is told to stop, and a
    // cancelled turn that keeps writing files is the worst of both worlds.
    const signal = host?.abortSignal;
    const stopOnAbort = () => {
      agent.abort();
    };
    if (signal?.aborted !== true) {
      signal?.addEventListener("abort", stopOnAbort, { once: true });
    }

    const call = toPiPrompt(prompt, parsed.images);
    let activeRun: Promise<void> | undefined;

    try {
      agent.requestId = input.requestId;
      activeRun = (call.messages === undefined ? agent.prompt(call.prompt, call.images) : agent.prompt(call.messages))
        .catch((error: unknown) => { failure = error; })
        .finally(() => { done = true; notify?.(); notify = undefined; });
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>(resolve => { notify = resolve; });
          continue;
        }
        const event = queue.shift();
        if (event !== undefined) yield event;
      }
      await activeRun;
      if (usageFailure !== undefined) throw usageFailure;
      if (failure !== undefined) throw failure;
    } finally {
      if (!done) agent.abort();
      await activeRun;
      signal?.removeEventListener("abort", stopOnAbort);
      unsubscribe();
      this.publishContextUsage = undefined;
    }

    throwIfRunAborted(signal);

    // pi records a failed turn on the agent instead of rejecting: the run
    // resolves with an assistant message that carries the provider's error and
    // nothing else. Left there, the turn reads as a success that produced no
    // output at all — the host has nothing to show, and the caller has no idea
    // the model was never reached.
    const agentFailure = readAgentFailure(agent);
    if (agentFailure !== undefined) {
      throw new HarnessError({
        type: "execution",
        message: agentFailure,
      });
    }

    // The turn is over and the tool never ran, so the run parks here — after
    // the usage it did spend has been reported.
    if (parkedApproval !== undefined) {
      throw parkedApproval;
    }

    const finalMessage = agent.state.messages.at(-1);
    const memoryAnswer = finalMessage?.role === 'assistant' ? finalMessage.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
    if (memory && !memory.readOnly && mode !== "plan" && parsed.permissionPolicy !== "read-only" && memoryAnswer.trim() && (this.options.databasePath || this.options.storage)) {
      const turnId = createHash('sha256').update(agent.memoryTurnId ?? input.requestId ?? randomUUID()).digest('hex');
      await submitAgentMemoryTurn(memory, {turnId, messages:[
        {id:`${turnId}:user`,role:"user",content:parsed.prompt,timestamp:Date.now()},
        {id:`${turnId}:assistant`,role:"assistant",content:memoryAnswer,timestamp:Date.now()},
      ]});
    }
    if (mode === "plan" && answer.trim() !== "") {
      yield* this.requestPlanApproval(parsed, answer, host);
    }
  }

  private async *requestPlanApproval(
    parsed: AgentParsedInput,
    plan: string,
    host?: AgentHost,
  ): AsyncIterable<AgentStreamEvent> {
    yield { type: "plan", phase: "start", text: plan };
    yield { type: "plan", phase: "end", text: plan };

    if (host?.approvePlan === undefined) {
      return;
    }

    // A revised plan needs its own decision, even when its text is unchanged.
    const requestId = `${createAgentPlanRequestId(parsed.sessionId ?? this.options.sessionId ?? "agent")}:${this.agent?.lastAssistantEntryId ?? randomUUID()}`;
    const decision = await host.approvePlan({ requestId, plan });
    yield {
      type: "approval",
      kind: "plan",
      approved: decision.approved,
      requestId: decision.requestId ?? requestId,
    };
  }
}

function createAgentTools(
  pi: PiRuntime,
  scope: AgentToolScope,
  policy: AgentPermissionPolicy,
): PiAgentTool[] {
  return createBuiltinAgentTools({
    Type: pi.Type as TypeboxLike,
    scope: resolveAgentToolScope(policy, scope),
  }) as unknown as PiAgentTool[];
}

/** The scope a runtime is built with, used before any run names its own. */
function scopeFromOptions(options: AgentRuntimeOptions): AgentToolScope {
  const workdir = path.resolve(options.workdir ?? process.cwd());
  return { workdir, allowedDirectories: resolveAllowedDirectories(options.allowedDirectories, workdir) };
}

function resolveAllowedDirectories(value: readonly string[] | undefined, workdir: string): string[] {
  const roots = (value ?? []).filter((entry) => typeof entry === "string" && entry.trim() !== "");
  return roots.length === 0 ? [workdir] : roots.map((entry) => path.resolve(workdir, entry));
}

interface AgentConnection {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKind?: AgentApiKind;
  webSearch?: boolean;
  /** Decides the tool scope, so a change rebuilds the tool set too. */
  permissionPolicy?: AgentPermissionPolicy;
  /**
   * Attributes the pi runtime was built from, folded into one comparable key.
   *
   * The model id alone cannot tell two builds apart: the same id reached
   * through a custom endpoint carries whatever the caller knew about it, and a
   * run whose catalogue entry changed must rebuild rather than keep streaming
   * on a model record with the previous window.
   */
  modelAttributesKey?: string;
}

function stableModelAttributesKey(attributes: AgentModelAttributes | undefined): string | undefined {
  return attributes === undefined ? undefined : JSON.stringify(sortJsonValue(attributes));
}

/** Object keys sorted so two equal records always serialize identically. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function readConnection(options: AgentRuntimeOptions): AgentConnection {
  return {
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    apiKind: options.apiKind,
    webSearch: options.webSearch,
    // Mirrors the default `parseAgentInput` applies, so a run that names no
    // policy is not mistaken for a change.
    permissionPolicy: resolveAgentPermissionPolicySetting(options.permissionPolicy),
    modelAttributesKey: stableModelAttributesKey(options.modelAttributes),
  };
}

function sameModelConnection(left: AgentConnection, right: AgentConnection): boolean {
  return left.provider === right.provider &&
    left.model === right.model &&
    left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey &&
    left.apiKind === right.apiKind &&
    left.webSearch === right.webSearch &&
    left.modelAttributesKey === right.modelAttributesKey;
}

/** pi wants the discriminator; the caller-facing shape deliberately omits it. */
function toPiImages(images: readonly AgentImageInput[]) {
  return images.length === 0
    ? undefined
    : images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
}

interface PiPromptCall {
  /** The turn's text; empty only when `messages` is set instead. */
  prompt: string;
  images: ReturnType<typeof toPiImages>;
  /** Set for an image-only turn, where the message is assembled here. */
  messages?: AgentMessage[];
}

/**
 * The arguments for `agent.prompt`, in whichever form fits this turn.
 *
 * A text prompt is handed over as a string so pi builds the message itself.
 * An image-only turn cannot use that form: pi would build
 * `[{ type: "text", text: "" }, ...images]`, and an empty text block is a part
 * several providers reject outright. The message is assembled here instead, so
 * the model receives exactly the images and no invented text.
 */
function toPiPrompt(prompt: string, images: readonly AgentImageInput[]): PiPromptCall {
  const piImages = toPiImages(images);
  if (prompt.trim() !== "" || piImages === undefined) {
    return { prompt, images: piImages };
  }

  return { prompt, images: piImages, messages: [{ role: "user", content: piImages, timestamp: Date.now() }] };
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function applyRunConfiguration(
  agent: PiAgent,
  pi: PiRuntime,
  parsed: AgentParsedInput,
  definitions: ReturnType<typeof readAgentToolDefinitions>,
  externalTools: readonly PiAgentTool[],
  options: AgentRuntimeOptions,
): void {
  agent.state.thinkingLevel = clampThinkingLevel(pi, parsed.effort);
  // Plan mode leads: its read-only contract must not be talked out of by a
  // caller's persona, so the persona is appended rather than substituted.
  const systemPrompt = parsed.agent === "plan"
    ? [AGENT_PLAN_SYSTEM_PROMPT, parsed.systemPrompt].filter(isNonEmpty).join("\n\n")
    : parsed.systemPrompt ?? options.systemPrompt ?? defaultAgentSystemPrompt();
  agent.state.systemPrompt = [systemPrompt, BUILTIN_AGENT_SKILLS_PROMPT].filter(isNonEmpty).join("\n\n");

  // The policy decides which tools exist at all; a caller-supplied list can
  // only narrow that further, never widen it.
  const allowed = new Set(listEnabledAgentToolNames(parsed.permissionPolicy, definitions));
  const requested = parsed.tools?.filter((name) => allowed.has(name)) ?? [...allowed];
  const active = new Set(requested.length === 0 ? [...allowed] : requested);

  // Built from the run's own scope rather than from the runtime's: a run that
  // names its own `workdir` or `allowedDirectories` means those to be what its
  // tools may touch, and a set built once at construction would ignore both.
  const allTools = createAgentTools(pi, {
    workdir: parsed.workdir,
    allowedDirectories: parsed.allowedDirectories,
  }, parsed.permissionPolicy);

  // Asking the user is planning's own tool: the answer to "which approach?"
  // is what a plan is for, and a build turn is running a plan that was already
  // agreed. A host that cannot pause never offers it.
  const askTool = parsed.agent === "plan" && options.askUser !== undefined
    ? [createAskUserTool({ Type: pi.Type as TypeboxLike })]
    : [];

  // Caller-supplied tools are appended unfiltered: the host declared them, and
  // the approval gate already knows whether each one may run.
  agent.state.tools = [
    ...allTools.filter((tool) => active.has(tool.name)),
    ...askTool,
    ...(options.memory ? [createAgentMemoryTool(pi.Type as TypeboxLike, options.memory, parsed.agent === "plan" || parsed.permissionPolicy === "read-only")] : []),
    ...externalTools.filter(tool => !options.memory || tool.name !== 'memory'),
  ];
}

function clampThinkingLevel(pi: PiRuntime, effort: AgentParsedInput["effort"]): AgentThinkingLevel {
  const requested = toThinkingLevel(effort);
  if (pi.supportedThinkingLevels.includes(requested)) {
    return requested;
  }

  try {
    return pi.clampThinkingLevel(requested);
  } catch {
    return pi.supportedThinkingLevels[pi.supportedThinkingLevels.length - 1] ?? "off";
  }
}

function defaultAgentSystemPrompt(): string {
  return [
    "You are a coding agent running inside a SteamHarness project.",
    "Use the provided tools to inspect and modify the working directory.",
    "Answer concisely, in the user's language.",
  ].join(" ");
}

export function parseAgentInput(
  input: AgentInput,
  options: AgentRuntimeOptions,
): AgentParsedInput {
  const rawPrompt = typeof input.prompt === "string" ? input.prompt : "";
  const compact = input.compact === true || COMPACT_COMMANDS.has(rawPrompt.trim().toLowerCase());
  const workdir = resolveAgentWorkdir(input, options);

  return {
    prompt: rawPrompt,
    workdir,
    allowedDirectories: resolveAllowedDirectories(input.allowedDirectories ?? options.allowedDirectories, workdir),
    images: normalizeImages(input.images),
    provider: readOptionalString(input.provider) ?? options.provider,
    model: readOptionalString(input.model) ?? options.model,
    baseUrl: readOptionalString(input.baseUrl) ?? options.baseUrl,
    apiKey: readOptionalString(input.apiKey) ?? options.apiKey,
    apiKind: input.apiKind ?? options.apiKind,
    webSearch: parseAgentWebSearch(input.webSearch ?? options.webSearch),
    systemPrompt: readOptionalString(input.systemPrompt) ?? options.systemPrompt,
    effort: resolveRunEffort(input.effort, options.effort),
    agent: parseAgentMode(input.agent ?? options.mode ?? DEFAULT_AGENT_MODE),
    permissionPolicy: resolveAgentPermissionPolicySetting(
      input.permissionPolicy ?? options.permissionPolicy ?? DEFAULT_AGENT_PERMISSION_POLICY,
    ),
    contextWindow: input.contextWindow,
    modelAttributes: input.modelAttributes ?? options.modelAttributes,
    compact,
    tools: options.tools,
    sessionId: options.sessionId,
  };
}

/**
 * The working directory a run actually uses.
 *
 * Shared with the node's payload so what it reports and what the tools touched
 * cannot come from two different readings of the same input.
 */
export function resolveAgentWorkdir(input: AgentInput, options: AgentRuntimeOptions): string {
  const base = options.workdir ?? process.cwd();
  return path.resolve(base, readOptionalString(input.workdir) ?? ".");
}

export function normalizeAgentEvent(event: {
  type: string;
  [key: string]: unknown;
}): AgentStreamEvent[] {
  if (event.type === "project_web_search") return [{ type: "web_search", search: event["search"] as import("./types").AgentWebSearch }];
  if (event.type === "message_end") {
    const message = event["message"] as AgentSearchMessage | undefined;
    const sources = message?.projectWebSearch?.sources;
    return sources?.length ? [{ type: "sources", sources }] : [];
  }
  if (event.type === "project_compaction") return [{ type: "compaction", phase: event["phase"] as "start" | "end",
    auto: event["auto"] === true, ...(typeof event["summary"] === "string" ? { summary: event["summary"] } : {}) }];
  if (event.type === "project_session") return [{ type: "session", snapshot: event["snapshot"] as import("./session-types").AgentSessionSnapshot }];
  if (event.type === "project_retry") return [{ type: "retry", attempt: Number(event["attempt"]),
    maxAttempts: Number(event["maxAttempts"] ?? AGENT_PROVIDER_MAX_RETRIES), reason: String(event["reason"]),
    kind: (event["kind"] ?? "dropped") as AgentTurnContinuationKind }];
  if (event.type === "message_update") {
    const update = isRecord(event["assistantMessageEvent"]) ? event["assistantMessageEvent"] : undefined;
    if (update === undefined) {
      return [];
    }
    if (update["type"] === "text_delta" && typeof update["delta"] === "string") {
      return [{ type: "text_delta", delta: update["delta"] }];
    }
    if (update["type"] === "thinking_delta" && typeof update["delta"] === "string") {
      return [{ type: "thinking_delta", delta: update["delta"] }];
    }
    return [];
  }

  if (event.type === "tool_execution_start") {
    return [{
      type: "tool",
      phase: "start",
      toolCallId: String(event["toolCallId"] ?? ""),
      toolName: String(event["toolName"] ?? ""),
      args: event["args"],
    }];
  }

  if (event.type === "tool_execution_update") {
    return [{
      type: "tool",
      phase: "update",
      toolCallId: String(event["toolCallId"] ?? ""),
      toolName: String(event["toolName"] ?? ""),
      args: event["args"],
      result: event["partialResult"],
    }];
  }

  if (event.type === "tool_execution_end") {
    return [{
      type: "tool",
      phase: "end",
      toolCallId: String(event["toolCallId"] ?? ""),
      toolName: String(event["toolName"] ?? ""),
      result: event["result"],
      isError: event["isError"] === true,
    }];
  }

  return [];
}

function readEventUsage(event: { type: string; [key: string]: unknown }): Usage | undefined {
  if (event.type !== "message_end") {
    return undefined;
  }

  const message = event["message"];
  if (!isRecord(message) || message["role"] !== "assistant") {
    return undefined;
  }

  const usage = message["usage"];
  return isRecord(usage) ? (usage as unknown as Usage) : undefined;
}

export function sumAgentUsage(usages: readonly Usage[]): AgentUsage | undefined {
  if (usages.length === 0) {
    return undefined;
  }

  return usages.reduce<AgentUsage>((total, usage) => ({
    inputTokens: total.inputTokens + (usage.input ?? 0),
    outputTokens: total.outputTokens + (usage.output ?? 0),
    totalTokens: total.totalTokens + (usage.totalTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (usage.cacheRead ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (usage.cacheWrite ?? 0),
    reasoningTokens: total.reasoningTokens + (usage.reasoning ?? 0),
  }), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
}

/**
 * The effort this run asks the model for.
 *
 * An empty value is the built-in param's "let the model decide" — pi asks for
 * that by naming no level at all, which is its `off`. A caller that never named
 * one keeps the runtime's own effort, and one that named a level this runtime
 * cannot parse (a typo, or OpenCode's `ultra` passed through by mistake) lands
 * there too rather than silently running at some invented middle.
 */
function resolveRunEffort(requested: unknown, fallback: AgentEffort | undefined): AgentEffort {
  const fallbackEffort = fallback ?? DEFAULT_AGENT_EFFORT;
  if (requested === undefined) {
    return fallbackEffort;
  }

  return readOptionalString(requested) === undefined
    ? "off"
    : resolveAgentEffort(requested, fallbackEffort);
}

/** The message pi left on the agent when the turn itself failed. */
function readAgentFailure(agent: PiAgent): string | undefined {
  const error = (agent.state as { errorMessage?: unknown }).errorMessage;
  return typeof error === "string" && error.trim() !== "" ? error.trim() : undefined;
}

/** Fails a run the way the workflow runtime expects an aborted node to fail. */
function throwIfRunAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined || !signal.aborted) {
    return;
  }

  throw new HarnessError({
    type: "execution_aborted",
    message: signal.reason instanceof Error
      ? signal.reason.message
      : "The agent run was aborted.",
    cause: signal.reason,
  });
}

function normalizeImages(value: unknown): AgentImageInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const data = readOptionalString(entry["data"]);
    const mimeType = readOptionalString(entry["mimeType"]);
    return data === undefined || mimeType === undefined ? [] : [{ data, mimeType }];
  });
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
