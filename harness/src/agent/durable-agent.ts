import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, awaitWithContext, type Context } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
  Harness, MemoryStorage, ToolTask, GenerationTask, CompactionTask, LiveDoc, ConversationBusy, createRegistry, defineDocFamily,
  defineExtension, hook, section, watchEvents,
  type AgentEvent as DurableEvent, type AgentEventStream, type Conversation,
  type EntryRecord, type JsonObject, type Storage, type ToolRegistration, type HookApi,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model, Models, ToolCall, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { HarnessError } from "../workflow/errors";
import type { AgentAskResume, AgentContextUsage, AgentWebSearch } from "./types";
import type { AgentSearchMessage, AgentSearchStreamOptions } from "./web-search";
import { AGENT_SEARCH_RESUME_PROMPT } from "./web-search";
import { DEFAULT_AGENT_COMPACTION_SETTINGS, estimateAgentContextTokens, readAgentContextUsage,
  findCompactionSplitIndex, shouldCompactAgent, summarizeAgentMessages, type AgentCompactionSettings } from "./compaction";
import { createAgentStreamResumePrompt } from "./plan";
import { openAgentStorage, type AgentStorageFactory } from "./storage";
import { AgentExtensionResources, mergeAgentRegistries } from "./extensions";
import { DurableAgentSession } from "./session";
import { durableContextMessages } from "./durable-context";
import type { AgentSessionCommand, AgentSessionOptions, AgentSessionReceipt } from "./session-types";

const context = BACKGROUND_CONTEXT;
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};

const RunDoc = defineDocFamily({
  kind: "project.agent.run", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  initial: () => ({ cutoff: 0, initialized: false as boolean, approvals: {} as JsonObject, usage: {} as JsonObject,
    retries: {} as JsonObject, continuations: {} as JsonObject, pendingRetries: {} as JsonObject, failure: "", end: 0 }),
});

export interface DurableAgentState {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: string;
  tools: AgentTool[];
  messages: AgentMessage[];
  contextMessages?: readonly AgentMessage[];
  contextWindow?: number;
  streamingMessage?: AssistantMessage;
  errorMessage?: string;
}

export interface DurableAgentOptions {
  sessionLease?: Promise<void>;
  /** Reattach the host and scheduler without submitting the workflow's bootstrap prompt. */
  resumeSession?: boolean;
  workdir?: string;
  session?: AgentSessionOptions;
  initialState: DurableAgentState;
  models: Models;
  databasePath?: string;
  storage?: AgentStorageFactory;
  retryDelayMs?: number;
  compaction?: AgentCompactionSettings;
  contextUsage?: () => AgentContextUsage | undefined;
}

type ApprovalResult = { block: true; reason: string; pause?: HarnessError } | undefined;

/** One Harness owns the transcript. `state` is a disposable projection for Workflow's run policy. */
export class DurableAgent {
  readonly state: DurableAgentState;
  models: Models;
  requestId?: string;
  askResume?: AgentAskResume;
  lastAssistantEntryId?: number;
  beforeToolCall?: (call: { toolCall: ToolCall; args: unknown }) => Promise<ApprovalResult>;
  private harness?: Harness;
  private root?: Conversation;
  private releaseOwner?: () => void | Promise<void>;
  private resources?: AgentExtensionResources;
  private memoryStorage?: MemoryStorage;
  private session?: DurableAgentSession;
  private commandReady = deferred();
  private prompting = false;
  private readonly modelAttempts = new Map<string, string>();
  private rootModelSessionId?: string;
  private readonly registry = createRegistry();
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private projected: AgentMessage[];
  private watch?: AgentEventStream;
  private aborting?: Promise<void>;
  private park?: () => void;
  private activeRequest = "";
  private message?: AssistantMessage;
  private text = new Map<number, string>();
  private readonly entries = new Set<number>();
  private readonly toolsStarted = new Set<string>();
  private readonly toolsEnded = new Set<string>();
  private readonly compactionsStarted = new Set<number>();
  private readonly compactionsEnded = new Set<number>();
  private readonly projectedCalls = new Map<string, { id: string; arguments: unknown }>();
  private delivery: Promise<void> = Promise.resolve();
  private attemptId = "";
  private readonly usageEmitted = new Set<string>();
  private readonly approvedCalls = new Set<string>();
  private readonly searchStates = new Map<string, string>();
  private seeded = false;
  private fatalFailure?: unknown;
  private failActive?: (error: unknown) => void;

  constructor(private readonly options: DurableAgentOptions) {
    this.state = options.initialState;
    this.models = options.models;
    this.projected = this.state.messages;
  }

  async open(): Promise<void> {
    if (this.harness !== undefined) return;
    let storage: Storage | undefined;
    try {
      if (this.options.storage) {
        if (this.options.databasePath !== undefined) throw new Error("Agent storage and databasePath are mutually exclusive.");
        const opened = await this.options.storage.open();
        storage = opened.storage; this.releaseOwner = opened.release;
      } else if (this.options.databasePath === undefined) {
        storage = this.memoryStorage ??= new AgentMemoryStorage();
      } else {
        const opened = await openAgentStorage(this.options.databasePath);
        storage = opened.storage; this.releaseOwner = opened.release;
      }
      const dynamicModels = new Proxy({} as Models, {
        get: (_target, key) => {
          if (key === "streamSimple") return this.streamModel.bind(this);
          if (key === "getModel") return (provider: string, modelId: string) => {
            const model = provider === this.state.model.provider && modelId === this.state.model.id
              ? this.state.model : this.models.getModel(provider, modelId);
            return model && provider === this.state.model.provider && modelId === this.state.model.id && this.state.contextWindow
              ? { ...model, contextWindow: this.state.contextWindow } : model;
          };
          if (key === "completeSimple") return this.summarize.bind(this);
          const value = Reflect.get(this.models, key, this.models);
          return typeof value === "function" ? value.bind(this.models) : value;
        },
      });
      this.resources = new AgentExtensionResources(this.options.session ?? {});
      await this.resources.install(this.registry, tool => this.adaptTool(tool));
      const registry = mergeAgentRegistries(this.registry, this.options.session?.registry);
      registry.snapshot();
      const compactionPolicy = () => {
        const settings = this.compactionSettings();
        const window = this.state.contextWindow ?? this.state.model.contextWindow;
        const split = findCompactionSplitIndex(this.state.messages, settings.keepRecentTokens);
        const recent = this.state.messages.slice(split).reduce((tokens, message) => tokens + estimateMessageTokens(message as Message), 0);
        // A very large older turn must not pin all history merely because the
        // safe suffix after it is smaller than the preferred recent budget.
        return { enabled: settings.enabled, keepRecentTokens: split > 0 ? Math.min(settings.keepRecentTokens, recent) : settings.keepRecentTokens,
          // Pi uses a strict `>` comparison; reserve one extra token to include 90%.
          reserveTokens: Math.max(window - Math.ceil(window * settings.threshold) + 1,
            this.options.session?.compaction?.reserveTokens ?? 0),
          backgroundTokens: this.options.session?.compaction?.backgroundTokens ?? 0 };
      };
      this.harness = await Harness.open(storage, {
        models: dynamicModels, registry,
        env: (target, ctx) => this.resources!.environment(target, ctx),
        onReport: error => {
          if (error instanceof Error && ["missing_task", "incompatible_task", "task_too_old", "migration_failed"].includes(String(error.cause))) return;
          this.fail(error);
        },
        settings: {
          retry: { enabled: true, maxRetries: 10, baseDelayMs: this.options.retryDelayMs ?? 500, maxAgentDelayMs: 8_000 },
          stream: { maxRetries: 0 }, get compaction() { return compactionPolicy(); },
          progress: { partialIntervalMs: 50, outputIntervalMs: 100 },
          toolExecution: "sequential",
        },
      }, context);
      this.root = await this.harness.root(context, { agent: { model: { provider: this.state.model.provider, modelId: this.state.model.id } } });
      await this.resources.restore(this.harness, this.root.id, context);
      if (this.options.session) {
        this.session = new DurableAgentSession(this.harness, this.root, this.options.session,
          async snapshot => {
            await this.refresh();
            this.state.model = this.models.getModel(snapshot.configuration.provider, snapshot.configuration.model) ?? this.state.model;
            this.state.thinkingLevel = snapshot.configuration.effort;
            await this.emit({ type: "project_session", snapshot } as unknown as AgentEvent);
          }, error => this.fail(error), this.models, storage, registry,
          (loaded) => this.resources!.snapshot(registry.snapshot(), loaded, this.options.storage?.label ?? (this.options.databasePath ? "SQLite" : "Memory")),
          (provider, model) => provider === this.state.model.provider && model === this.state.model.id
            ? this.state.contextWindow ?? this.state.model.contextWindow : this.models.getModel(provider, model)?.contextWindow);
        this.session.install(this.registry);
      }
      if (!this.seeded && this.state.messages.length && (await this.root.context(context)).entries.length === 0) await this.replaceContext();
      this.seeded = true;
      await this.refresh();
    } catch (error) {
      if (this.harness) await this.harness.close(context).catch(() => undefined);
      else await storage?.close(context).catch(() => undefined);
      await this.resources?.close(context).catch(() => undefined); this.resources = undefined;
      await this.releaseOwner?.(); this.releaseOwner = undefined;
      this.harness = undefined;
      throw error;
    }
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void { this.state.messages = []; this.state.contextMessages = undefined; this.state.streamingMessage = undefined; this.state.errorMessage = undefined; }

  async checkpoint(): Promise<void> {
    await this.open();
    if (this.state.messages !== this.projected) await this.replaceContext();
  }

  async canCompact(requestId?: string): Promise<boolean> {
    if (requestId && await this.root!.commit(tx => tx.submissionByRequest(this.root!.id, requestId), context)) return false;
    return (await this.harness!.inspect(context)).tasks.length === 0;
  }

  async close(): Promise<void> {
    this.commandReady.reject(Object.assign(new Error("The agent session is closed."), { code: "AGENT_NOT_READY" }));
    try {
      await this.session?.stop();
      try { await this.aborting; }
      finally {
        try { await this.watch?.stop(); await this.delivery; }
        finally { await this.harness?.close(context); }
      }
    } finally {
      this.watch = undefined; this.harness = undefined; this.root = undefined;
      this.session = undefined;
      try { await this.resources?.close(context); }
      finally { this.resources = undefined; await this.releaseOwner?.(); this.releaseOwner = undefined; }
    }
  }

  async control(command: AgentSessionCommand): Promise<AgentSessionReceipt> {
    if (!this.prompting) throw Object.assign(new Error("The agent session is not ready."), { code: "AGENT_NOT_READY" });
    if (command.type === "task") {
      let input: JsonValue;
      try { input = copyJson(command.input); }
      catch (cause) { throw new Error("Task input must contain only JSON values.", { cause }); }
      if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new Error("Task input is too large.");
      command = { ...command, input };
    }
    // Capture before readiness and command ordering can yield to the caller.
    const captured = copyJson(command, { omitUndefinedProperties: true }) as unknown as AgentSessionCommand;
    await this.commandReady.promise;
    if (!this.session) throw new Error("Durable session control is not enabled.");
    return this.session.control(captured);
  }

  abort(): void {
    if (this.root !== undefined) {
      this.aborting ??= this.root.abort(context);
      void this.aborting.catch(error => this.fail(error));
    }
  }

  private fail(error: unknown): void {
    this.fatalFailure ??= error;
    this.failActive?.(error);
  }

  async prompt(prompt: string | AgentMessage[], images?: ImageContent[]): Promise<void> {
    this.commandReady = deferred();
    this.prompting = true;
    try { await this.runPrompt(prompt, images); }
    catch (error) {
      this.prompting = false;
      this.commandReady.reject(error);
      // Admission rejection does not belong to the running turn. Preserve its
      // checkpoints and keep this request retryable after the current work ends.
      if (error instanceof ConversationBusy) {
        this.state.errorMessage = error.message;
        throw error;
      }
      try { await this.settleFailure(error); }
      catch (cleanup) { throw new AggregateError([error, cleanup], error instanceof Error ? error.message : String(error)); }
      throw error;
    }
    finally { this.prompting = false; }
  }

  private async settleFailure(error: unknown): Promise<void> {
    if (!this.harness || !this.root) return;
    this.fatalFailure ??= error;
    await this.watch?.stop(); this.watch = undefined;
    await this.delivery.catch(() => undefined); this.delivery = Promise.resolve();
    await this.session?.stop();
    const failure = error instanceof Error ? error.message : String(error);
    if (this.activeRequest) await this.root.commit(async tx => {
      (await tx.doc(RunDoc, this.root!.id, this.activeRequest, null)).failure = failure;
    }, context);
    // One owner runs every independent fork as well as the root's owned tasks.
    // A reported failure must settle them; only host shutdown preserves work.
    let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
    do {
      const page = await this.harness.commit(tx => tx.scanConversations({}, 100, cursor), context);
      for (const record of page.items) if (record.owner === undefined) {
        await (await this.harness.conversation(record.id, context))?.abort(context, { background: true });
      }
      cursor = page.next;
    } while (cursor);
    const final = await this.root.context(context);
    if (this.activeRequest) await this.root.commit(async tx => {
      const run = await tx.doc(RunDoc, this.root!.id, this.activeRequest, null);
      run.end ||= Math.max(0, ...final.entries.map(entry => entry.id));
    }, context);
    this.state.errorMessage = failure;
    await this.refresh();
    await this.session?.emit();
  }

  private async runPrompt(prompt: string | AgentMessage[], images?: ImageContent[]): Promise<void> {
    await this.open();
    await this.checkpoint();
    if (this.fatalFailure !== undefined) throw this.fatalFailure;
    const root = this.root!;
    const harness = this.harness!;
    const requestId = this.requestId ?? randomUUID();
    this.activeRequest = requestId;
    this.entries.clear(); this.toolsStarted.clear(); this.toolsEnded.clear(); this.projectedCalls.clear();
    this.searchStates.clear();
    this.compactionsStarted.clear(); this.compactionsEnded.clear();
    this.usageEmitted.clear();
    this.state.errorMessage = undefined;
    this.aborting = undefined;
    const remoteTools = this.options.session?.environment ? CodingTools.tools ?? [] : [];
    const localNames = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
    const tools = this.state.tools.filter(tool => !this.options.session?.environment || !localNames.has(tool.name)).map(tool => this.adaptTool(tool));
    tools.push(...remoteTools.filter(tool => this.state.tools.some(allowed => allowed.name === tool.name)));
    this.session?.setTools(tools);
    const promptSection = section("workflow", () => this.state.systemPrompt, { tag: false });
    this.registry.install(defineExtension({
      name: "workflow",
      sections: [promptSection],
      tools,
      hooks: [hook(GenerationTask, {
        afterResponse: message => {
          if (message.stopReason === "error" && isRetryableAssistantError(message) && message.content.length > 0) {
            // Continue from text already committed to the answer. Calls without a
            // result never become tool intents and must not reach the next request.
            message.content = message.content.filter(block => block.type !== "toolCall");
            message.stopReason = "stop";
            (message as InterruptedMessage).projectInterrupted = message.errorMessage ?? "Stream interrupted";
            (message as InterruptedMessage).projectContextUsageInvalid = true;
            delete message.errorMessage;
          }
        },
        onYield: async (message, api) => {
          const root = (await harness.conversation(api.conversationId, context))!;
          const logicalRequestId = this.session ? await this.session.requestIdFor(root.id) : requestId;
          if (message.rawStopReason === "pause_turn" && (message as AgentSearchMessage).projectWebSearch) {
            const continuation = await root.commit(async tx => {
              const run = await tx.doc(RunDoc, root.id, logicalRequestId, null);
              const existing = run.continuations[api.taskId];
              if (typeof existing === "string") return existing;
              if (existing === false) return;
              const attempt = Number(run.continuations["count:search"] ?? 0) + 1;
              run.continuations["count:search"] = attempt;
              if (attempt > 3) {
                run.continuations[api.taskId] = false;
                run.failure = "The provider paused web search more than 3 times. Retry or narrow the search.";
                for (const search of (message as AgentSearchMessage).projectWebSearch!.searches) if (search.status === "running") {
                  search.status = "failed"; search.error = run.failure;
                }
                return;
              }
              run.continuations[api.taskId] = AGENT_SEARCH_RESUME_PROMPT;
              return AGENT_SEARCH_RESUME_PROMPT;
            }, context);
            return continuation === undefined ? undefined : { continue: continuation };
          }
          const kind = (message as InterruptedMessage).projectInterrupted ? "dropped"
            : message.stopReason === "length" && message.content.length > 0 ? "length"
            : message.stopReason === "toolUse" && !message.content.some(block => block.type === "toolCall") ? "lost-call" : undefined;
          if (kind === undefined) return;
          const reason = kind === "length" ? "max output tokens" : kind === "lost-call" ? "tool call missing" : (message as InterruptedMessage).projectInterrupted ?? "Stream interrupted";
          const maxAttempts = kind === "length" ? 2 : 10;
          const continuation = await root.commit(async tx => {
            const run = await tx.doc(RunDoc, root.id, logicalRequestId, null);
            const existing = run.continuations[api.taskId];
            if (typeof existing === "string") return existing;
            if (existing === false) return;
            const countKey = kind === "length" ? "count:length" : "count:transport";
            const attempt = Number(run.continuations[countKey] ?? 0) + 1;
            run.continuations[countKey] = attempt;
            if (attempt > maxAttempts) {
              run.continuations[api.taskId] = false;
              run.failure = kind === "length" ? `The model ran out of output tokens mid-answer ${attempt} times in a row (${reason}). Raise maxTokens or split the request.`
                : kind === "lost-call" ? `A tool call the model made went missing ${attempt} times in a row (${reason}).`
                : `The model stream was cut off mid-answer ${attempt} times in a row (${reason}).`;
              return;
            }
            const prompt = createAgentStreamResumePrompt({ kind, reason, keptPartial: message.content.length > 0 });
            run.continuations[api.taskId] = prompt;
            // onYield precedes the assistant commit; its successor publishes the retry after that answer.
            (run.pendingRetries ??= {})[api.taskId] = { attempt, maxAttempts, reason, kind };
            return prompt;
          }, context);
          return continuation === undefined ? undefined : { continue: continuation };
        },
        beforeRequest: async (_request, api, requestContext) => {
          const root = (await harness.conversation(api.conversationId, context))!;
          const logicalRequestId = this.session ? await this.session.requestIdFor(root.id) : requestId;
          const history = await root.context(context);
          const last = [...history.entries].reverse().find(entry => entry.model?.[0]?.role === "assistant");
          const message = last?.model?.[0] as InterruptedMessage | undefined;
          const exhausted = await root.commit(async tx => {
            const run = await tx.doc(RunDoc, root.id, logicalRequestId, null);
            if (run.failure) return run.failure;
            // Reset only after a committed, complete model response. Promoted
            // interrupted text looks like a stop but must retain its budget.
            if (last !== undefined && last.id > run.cutoff && message !== undefined && !message.projectContextUsageInvalid
              && (message.stopReason === "stop" || message.stopReason === "toolUse" && message.content.some(block => block.type === "toolCall"))) {
              run.continuations["count:transport"] = 0;
              run.continuations["count:length"] = 0;
            }
            for (const [taskId, data] of Object.entries(run.pendingRetries ?? {})) {
              await tx.appendEntry(root.id, { kind: "project.retry", data });
              delete run.pendingRetries[taskId];
            }
          }, context);
          if (exhausted) throw new HarnessError({ type: "execution", message: exhausted });
          this.attemptId = `${api.taskId}:${randomUUID()}`;
          if (this.options.session) {
            const { ProviderDoc } = await import("@earendil-works/pi-durable");
            const identity = await harness.snapshot(ProviderDoc, root.id, context);
            if (identity?.sessionId) this.modelAttempts.set(identity.sessionId, this.attemptId);
            if (root.id === this.root!.id) this.rootModelSessionId = identity?.sessionId;
          }
          const partials = history.entries.filter(entry => entry.byTaskId === api.taskId &&
            entry.model?.[0]?.role === "assistant" && entry.model[0].stopReason === "aborted" &&
            entry.model[0].content.some(block => block.type === "text" || block.type === "thinking"));
          if (partials.length > 0) {
            // Durable excludes aborted partials from model context. Promote only
            // committed text/reasoning and persist the continuation atomically.
            const failure = await root.commit(async tx => {
              const run = await tx.doc(RunDoc, root.id, logicalRequestId, null);
              for (const entry of partials) {
                if (run.retries[entry.id] !== undefined) continue;
                const message = json(entry.model![0]) as unknown as InterruptedMessage;
                message.content = message.content.filter(block => block.type !== "toolCall");
                message.stopReason = "stop";
                message.projectContextUsageInvalid = true;
                const attempt = Number(run.continuations["count:transport"] ?? 0) + 1;
                run.continuations["count:transport"] = attempt;
                run.retries[entry.id] = attempt;
                if (attempt > 10) {
                  run.failure = `The model stream was cut off mid-answer ${attempt} times in a row (Model request interrupted).`;
                  break;
                }
                await tx.appendEntry(root.id, {
                  kind: "project.retry", data: { attempt, maxAttempts: 10, kind: "dropped", reason: "Model request interrupted" },
                  edits: [{ target: entry.id, action: "replace", messages: [message] }],
                  model: [{ role: "user", content: createAgentStreamResumePrompt({ kind: "dropped", reason: "Model request interrupted", keptPartial: true }), timestamp: Date.now() }],
                });
              }
              return run.failure;
            }, context);
            if (failure) throw new HarnessError({ type: "execution", message: failure });
          }
          if (last !== undefined && message?.role === "assistant" && message.stopReason === "error") {
            const failure = await root.commit(async tx => {
              const run = await tx.doc(RunDoc, root.id, logicalRequestId, null);
              if (last.id <= run.cutoff || run.retries[last.id] !== undefined) return;
              const attempt = Number(run.continuations["count:transport"] ?? 0) + 1;
              run.continuations["count:transport"] = attempt;
              run.retries[last.id] = attempt;
              if (attempt > 10) {
                run.failure = `The model request failed ${attempt} times in a row (${message.errorMessage ?? "Model request interrupted"}).`;
                return run.failure;
              }
              await tx.appendEntry(root.id, { kind: "project.retry", data: { attempt, maxAttempts: 10, kind: "dropped", reason: message.errorMessage ?? "Model request interrupted" } });
            }, context);
            if (failure) throw new HarnessError({ type: "execution", message: failure });
          }
          const compacted = await this.compactBeforeRequest(root, api, requestContext);
          if (compacted || partials.length > 0) return { messages: (await root.context(context)).messages };
        },
      }), hook(ToolTask, {
        beforeTool: async (call, api, callContext) => {
          const decision = await this.approve(call, callContext, `${api.conversationId}:${api.taskId}:`);
          return decision?.block ? { block: decision.reason } : undefined;
        },
      })],
    }));
    const change = { model: { provider: this.state.model.provider, modelId: this.state.model.id },
      thinkingLevel: this.state.thinkingLevel as never, cwd: this.options.workdir,
      tools: [...tools, ...(this.session?.tools ?? []), ...this.registry.snapshot().tools().filter(item => item.extension.name !== "workflow" && item.extension.name !== "project.session").map(item => item.tool),
        ...(this.options.session?.registry?.snapshot().tools().map(item => item.tool) ?? [])] };
    if (this.session) await this.session.configureRoot({ ...change, tools: null });
    else await root.configure(change, context);
    if (this.session) await this.session.start(this.state.systemPrompt);
    const view = await root.context(context);
    const resuming = this.options.resumeSession === true && this.session !== undefined;
    const run = resuming ? { cutoff: Math.max(0, ...view.entries.map(entry => entry.id)), end: 0, usage: {} as JsonObject } : await root.commit(async tx => {
      const record = await tx.doc(RunDoc, root.id, requestId, null);
      if (!record.initialized) {
        record.cutoff = Math.max(0, ...view.entries.map(entry => entry.id));
        record.initialized = true;
      }
      return { cutoff: record.cutoff, end: record.end, usage: json(record.usage) as JsonObject };
    }, context);
    let parked = false;
    const pause = new Promise<void>(resolve => { this.park = () => { parked = true; resolve(); }; });
    const fatal = new Promise<never>((_resolve, reject) => { this.failActive = reject; });
    void fatal.catch(() => undefined);
    this.watch = await watchEvents(harness, root.id, context);
    if (run.end) {
      const history = await root.context(context, { at: run.end as EntryRecord["id"] });
      for (const entry of history.entries) if (entry.id > run.cutoff && entry.id <= run.end) await this.entry(entry, true);
    } else await this.observe(this.watch.snapshot, run.cutoff);
    for (const [id, usage] of Object.entries(run.usage)) await this.emitUsage(id, usage);
    this.watch.start(async events => {
      this.delivery = (async () => { if (!run.end) for (const event of events) await this.observe(event, run.cutoff); })();
      await this.delivery;
    });
    const content = typeof prompt === "string"
      ? images?.length ? [...(prompt ? [{ type: "text" as const, text: prompt }] : []), ...images] : prompt
      : prompt.find(message => message.role === "user")?.content ?? "";
    try {
      // requestId remains the same after a worker crash or a lost submit acknowledgement.
      const submission = resuming ? undefined : await root.submit({ type: "input", content, requestId, whenBusy: "reject",
        ...(this.session ? { entry: { kind: "project.input", data: { requestId, mode: "reject" } } } : {}) }, context);
      this.commandReady.resolve();
      harness.resume();
      if (resuming) {
        await this.session!.emit();
        if (this.options.sessionLease) await Promise.race([this.options.sessionLease, pause, fatal]);
        await Promise.race([this.session!.drain(), pause, fatal]);
        await this.flushUsage();
        if (parked) { await this.refresh(); await this.close(); }
        return;
      }
      const settled = submission ? await Promise.race([submission.wait(context), pause, fatal]) : undefined;
      // A stopped watch drops queued frames. Reconcile the committed history
      // after its current delivery ends, including for an immediately ready model.
      await this.watch.stop(); this.watch = undefined;
      await this.delivery;
      const answerEnd = run.end || (settled && settled.status === "done" && settled.type === "input" ? settled.answer : undefined);
      const final = await root.context(context, answerEnd ? { at: answerEnd as EntryRecord["id"] } : undefined);
      for (const entry of final.entries) if (entry.id > run.cutoff && (!run.end || entry.id <= run.end)) await this.entry(entry, true);
      await this.flushUsage();
      if (parked) {
        await this.refresh();
        await this.close();
      } else if (settled?.status === "unanswered") {
        this.state.errorMessage = typeof settled.detail === "string" ? settled.detail : settled.reason;
      }
      if (!parked && !resuming) {
        if (!run.end) await root.commit(async tx => { (await tx.doc(RunDoc, root.id, requestId, null)).end = Math.max(0, ...final.entries.map(entry => entry.id)); }, context);
        await this.refresh();
        const failure = await root.commit(async tx => (await tx.doc(RunDoc, root.id, requestId, null)).failure, context);
        if (failure) this.state.errorMessage = failure;
      }
      if (this.session && !parked) {
        await this.session.emit();
        if (this.options.sessionLease) await Promise.race([this.options.sessionLease, pause, fatal]);
        await Promise.race([this.session.drain(), pause, fatal]);
        await this.flushUsage();
        if (parked) { await this.refresh(); await this.close(); }
      }
    } finally {
      this.park = undefined;
      this.failActive = undefined;
      await this.watch?.stop(); this.watch = undefined;
      await this.session?.stop();
      await this.aborting;
      await this.emit({ type: "agent_end", messages: [] });
    }
  }

  private adaptTool(tool: AgentTool): ToolRegistration {
    return {
      name: tool.name, description: tool.description, parameters: tool.parameters,
      constrainedSampling: tool.constrainedSampling,
      replay: tool.replay === "safe" ? "safe" : "unsafe",
      executionMode: tool.executionMode,
      prepareArguments: tool.prepareArguments,
      structuredOutputSchema: tool.outputSchema,
      execute: async (args, api, callContext) => {
        const prefix = `${api.conversationId}:${api.taskId}:`;
        if (!this.approvedCalls.has(`${prefix}${api.callId}`)) {
          const decision = await this.approve({ type: "toolCall", id: api.callId, name: tool.name, arguments: json(args) as JsonObject }, callContext, prefix);
          if (decision?.block) return { output: [{ type: "text", text: decision.reason }], isError: true };
        }
        if (tool.name === "ask_user" && this.askResume !== undefined) {
          return { output: [{ type: "text", text: JSON.stringify(this.askResume.answers) }] };
        }
        let progress = Promise.resolve();
        let result;
        try {
          result = await tool.execute(api.callId, args, callContext.abortSignal, update => {
            const snapshot = json(update);
            progress = progress.then(() => api.details(snapshot, callContext));
            void progress.catch(error => this.fail(error));
          });
        } finally { await progress; }
        return {
          output: result.content, isError: result.isError,
          ...(result.details === undefined ? {} : { details: json(result.details) }),
          ...(result.structuredContent === undefined ? {} : { structuredOutput: json(result.structuredContent) }),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.terminate ? { control: { terminate: true as const } } : {}),
        };
      },
    };
  }

  private async approve(raw: ToolCall, callContext: Context, prefix = ""): Promise<ApprovalResult> {
    const call = prefix ? { ...raw, id: `${prefix}${raw.id}` } : raw;
    const decision = await this.beforeToolCall?.({ toolCall: call, args: call.arguments });
    const request = decision?.pause?.metadata?.["request"];
    await this.root!.commit(async tx => {
      const run = await tx.doc(RunDoc, this.root!.id, this.activeRequest, null);
      run.approvals[call.id] = json({ toolName: call.name, arguments: call.arguments,
        status: decision?.pause ? "waiting" : decision?.block ? "denied" : "approved",
        ...(request === undefined ? {} : { request }) });
    }, context);
    if (decision?.pause !== undefined) {
      this.park?.();
      await awaitWithContext(new Promise<never>(() => undefined), callContext);
    }
    if (!decision?.block) this.approvedCalls.add(call.id);
    return decision;
  }

  private compactionSettings(): AgentCompactionSettings {
    return { ...(this.options.compaction ?? DEFAULT_AGENT_COMPACTION_SETTINGS), ...this.options.session?.compaction };
  }

  private async compactBeforeRequest(root: Conversation, api: HookApi, requestContext: Context): Promise<boolean> {
    const settings = this.compactionSettings();
    if (!settings.enabled) return false;
    const generation = await this.harness!.getTask(api.taskId, requestContext);
    const checkpoint = generation?.state.checkpoint;
    if (checkpoint && typeof checkpoint === "object" && "compacted" in checkpoint) return false;
    const view = await root.context(requestContext);
    if (findCompactionSplitIndex(view.messages.filter(message => message.role !== "system") as AgentMessage[], settings.keepRecentTokens) <= 0) return false;
    if (root.id === this.root!.id) await this.refresh();
    const model = (await root.agent(requestContext)).model;
    const measurement = root.id === this.root!.id ? this.options.contextUsage?.() : undefined;
    const usage = readAgentContextUsage({
      used: measurement?.used ?? estimateAgentContextTokens(durableContextMessages(view)),
      contextWindow: model && api.models.getModel(model.provider, model.modelId)?.contextWindow,
    });
    if (!shouldCompactAgent(usage, settings)) return false;
    const requestId = this.session ? await this.session.requestIdFor(root.id) : this.activeRequest;
    // The child identity is committed with its status. Recovery joins it instead
    // of starting another summary; a no-op cannot create an unbounded loop.
    const taskId = await root.commit(async tx => {
      const run = await tx.doc(RunDoc, root.id, requestId, null);
      const key = `compaction:${api.taskId}`;
      if (typeof run.continuations[key] === "number") return run.continuations[key] as number;
      const id = await tx.createTask(CompactionTask, { reason: "threshold" as const },
        { conversationId: root.id, ownership: { kind: "task", taskId: api.taskId } });
      const live = await tx.doc(LiveDoc, root.id);
      (live.compactions ??= []).push({ taskId: id, reason: "threshold", blocking: true, attempt: 1 });
      run.continuations[key] = id;
      return id;
    }, requestContext);
    if (root.id === this.root!.id) await this.projectCompaction(taskId, "start", true);
    const settled = await this.harness!.waitForTask(taskId as import("@earendil-works/pi-durable").TaskId<import("@earendil-works/pi-durable").CompactionResult>, requestContext);
    const outcome = settled.state.outcome;
    if (outcome.status !== "completed") {
      const reason = outcome.status === "failed" || outcome.status === "faulted" ? outcome.error.message
        : outcome.status === "orphaned" ? outcome.reason : "aborted";
      throw new HarnessError({ type: "execution", message: `Context compaction ${outcome.status}: ${reason}` });
    }
    if (root.id === this.root!.id) await this.refresh();
    const entry = outcome.result.entryId === undefined ? undefined : (await root.context(requestContext)).entries.find(entry => entry.id === outcome.result.entryId);
    if (root.id === this.root!.id) await this.projectCompaction(taskId, "end", true, readCompactionSummary(entry));
    return outcome.result.entryId !== undefined;
  }

  private async projectCompaction(taskId: number, phase: "start" | "end", auto: boolean, summary?: string): Promise<void> {
    const emitted = phase === "start" ? this.compactionsStarted : this.compactionsEnded;
    if (emitted.has(taskId)) return;
    emitted.add(taskId);
    await this.emit({ type: "project_compaction", phase, auto, summary } as unknown as AgentEvent);
  }

  /** Native compaction uses the same bounded summarizer as explicit /compact. */
  private async summarize(...args: Parameters<Models["completeSimple"]>): ReturnType<Models["completeSimple"]> {
    let last: AssistantMessage | undefined;
    let total: Usage | undefined;
    const onUsage = async (usage: Usage): Promise<void> => {
      if (!total) total = structuredClone(usage);
      else {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning", "cacheWrite1h"] as const) {
          if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
        }
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
      }
      const id = `compaction:${randomUUID()}`;
      await this.root!.commit(async tx => { (await tx.doc(RunDoc, this.root!.id, this.activeRequest, null)).usage[id] = json(usage); }, context);
      await this.session?.recordCompactionUsage(args[2]?.sessionId, id, usage);
      await this.emitUsage(id, usage);
    };
    const nativeSummary = args[1].messages.some(message => message.role === "system" &&
      typeof message.content === "string" && message.content.startsWith("You are a context summarization assistant."));
    if (!nativeSummary) {
      const message = await this.models.completeSimple(...args);
      await onUsage(message.usage);
      return message;
    }
    let instructions = args[1].systemPrompt;
    const messages = args[1].messages.filter(message => message.role !== "system").map(message => {
      if (message.role !== "user") return message;
      const text = typeof message.content === "string" ? message.content
        : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
      const source = text.match(/^<conversation>\n([\s\S]*)\n<\/conversation>\n\n([\s\S]*)$/);
      const focus = source?.[2]?.match(/\n\nAdditional focus: ([\s\S]*)$/)?.[1];
      if (focus) instructions = [instructions, focus].filter(Boolean).join("\n\n");
      return source ? { ...message, content: source[1]! } : message;
    }) as AgentMessage[];
    const summary = await summarizeAgentMessages({
      models: { completeSimple: async (model, summaryContext, options) => {
        last = await this.models.completeSimple(model, summaryContext, { ...args[2], ...options });
        return last;
      } },
      model: args[0], messages, instructions, signal: args[2]?.signal,
      reserveTokens: Math.min(args[2]?.maxTokens ?? this.compactionSettings().reserveTokens, this.compactionSettings().reserveTokens),
      onUsage,
    }).catch(error => {
      // Let Durable apply its persisted retry policy to an incomplete provider
      // response. A cancelled invocation must never place a late summary.
      if (!args[2]?.signal?.aborted && last && last.stopReason !== "stop") return undefined;
      throw error;
    });
    if (summary === undefined) return { ...last!, usage: total! };
    return { ...last!, content: [{ type: "text", text: summary }], usage: total! };
  }

  private streamModel(...args: Parameters<Models["streamSimple"]>): ReturnType<Models["streamSimple"]> {
    if (this.fatalFailure !== undefined) throw this.fatalFailure;
    const source = this.models.streamSimple(args[0], args[1], { ...args[2],
      onAgentWebSearch: (search: AgentWebSearch) => {
        if (!this.options.session || args[2]?.sessionId === this.rootModelSessionId) return this.emitWebSearch(search);
      },
    } as AgentSearchStreamOptions);
    const stream = createAssistantMessageEventStream();
    const requestId = this.activeRequest;
    const recordId = this.options.session ? this.modelAttempts.get(args[2]?.sessionId ?? "") ?? `aux:${randomUUID()}` : this.attemptId;
    void (async () => {
      try {
        for await (const event of source) {
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            const usage = json(message.usage);
            await this.root!.commit(async tx => {
              (await tx.doc(RunDoc, this.root!.id, requestId, null)).usage[recordId] = usage;
            }, context);
            if (this.options.session) await this.emitUsage(recordId, usage);
          }
          stream.push(event);
        }
        stream.end(await source.result());
      } catch (cause) {
        this.fail(cause);
        // Fail the consumer as well: otherwise a storage failure strands the model task.
        const model = args[0];
        const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider,
          model: model.id, timestamp: Date.now(), stopReason: "error", errorMessage: String(cause),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "error", reason: "error", error: message }); stream.end(message);
      }
    })();
    return stream;
  }

  private async emitUsage(recordId: string, usage: unknown): Promise<void> {
    if (this.usageEmitted.has(recordId)) return;
    this.usageEmitted.add(recordId);
    await this.emit({ type: "project_usage", recordId, usage } as unknown as AgentEvent);
  }

  private async emitWebSearch(search: AgentWebSearch): Promise<void> {
    const key = JSON.stringify(search);
    if (this.searchStates.get(search.id) === key) return;
    this.searchStates.set(search.id, key);
    await this.emit({ type: "project_web_search", search } as unknown as AgentEvent);
  }

  private async flushUsage(): Promise<void> {
    const usage = await this.root!.commit(async tx => json((await tx.doc(RunDoc, this.root!.id, this.activeRequest, null)).usage) as JsonObject, context);
    for (const [id, value] of Object.entries(usage)) await this.emitUsage(id, value);
  }

  private async replaceContext(): Promise<void> {
    if ((await this.harness!.inspect(context)).tasks.length > 0) {
      throw new HarnessError({ type: "execution", message: "Cannot replace agent context while durable tasks are active." });
    }
    const messages = this.state.messages;
    await this.root!.commit(async tx => {
      // Per-message entries let Durable cut a restored transcript at a safe
      // turn boundary instead of treating all restored history as one entry.
      await tx.appendEntry(this.root!.id, { kind: "project.context", head: "self", model: [] });
      for (const message of messages) await tx.appendEntry(this.root!.id, {
        kind: "project.context", model: [json(message) as unknown as AgentMessage],
      });
    }, context);
    this.projected = messages;
  }

  private async refresh(): Promise<void> {
    if (this.root === undefined) return;
    const view = await this.root.context(context);
    this.state.contextMessages = durableContextMessages(view);
    this.state.messages = this.state.contextMessages.filter(message => message.role !== "system");
    if (this.session) this.state.streamingMessage = (await this.harness!.snapshot(LiveDoc, this.root.id, context))?.generation?.message as unknown as AssistantMessage | undefined;
    this.projected = this.state.messages;
  }

  private async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }

  private async startMessage(message: AssistantMessage): Promise<void> {
    this.message = message; this.text.clear(); this.state.streamingMessage = message;
    await this.emit({ type: "message_start", message });
    await this.replaceMessage(message);
  }

  private async replaceMessage(message: AssistantMessage): Promise<void> {
    if (this.message === undefined) await this.startMessage(message);
    this.message = message; this.state.streamingMessage = message;
    for (const [index, block] of message.content.entries()) {
      if (block.type !== "text" && block.type !== "thinking") continue;
      const text = block.type === "text" ? block.text : block.thinking;
      const previous = this.text.get(index) ?? "";
      if (text.startsWith(previous) && text.length > previous.length) {
        await this.emitDelta(block.type, index, text.slice(previous.length));
      }
      this.text.set(index, text);
    }
  }

  private async emitDelta(kind: "text" | "thinking", index: number, delta: string): Promise<void> {
    await this.emit({ type: "message_update", message: this.message!, assistantMessageEvent: {
      type: `${kind}_delta`, contentIndex: index, delta, partial: this.message!,
    } } as AgentEvent);
  }

  private async entry(entry: EntryRecord, replay: boolean): Promise<void> {
    if (this.entries.has(entry.id)) return;
    this.entries.add(entry.id);
    if (entry.kind === "pi.compaction") {
      const taskId = entry.byTaskId ?? entry.id;
      const data = entry.data;
      const auto = !data || typeof data !== "object" || Array.isArray(data) || data["reason"] !== "manual";
      await this.projectCompaction(taskId, "start", auto);
      await this.projectCompaction(taskId, "end", auto, readCompactionSummary(entry));
    }
    if (entry.kind === "project.retry") {
      await this.emit({ type: "project_retry", ...entry.data as JsonObject } as unknown as AgentEvent);
      return;
    }
    for (const original of entry.model ?? []) {
      const message = original.role === "assistant" && original.stopReason === "aborted"
        ? { ...original, content: original.content.filter(block => block.type !== "toolCall") } : original;
      if (message.role === "assistant") {
        for (const search of (message as AgentSearchMessage).projectWebSearch?.searches ?? []) await this.emitWebSearch(search);
        for (const call of message.content) if (call.type === "toolCall") {
          this.projectedCalls.set(call.id, { id: `${entry.id}:${call.id}`, arguments: call.arguments });
        }
        await this.replaceMessage(message);
        this.lastAssistantEntryId = entry.id;
        await this.emit({ type: "message_end", message });
        await this.flushUsage();
        this.state.streamingMessage = undefined; this.message = undefined;
        for (const call of message.content) if (call.type === "toolCall") {
          await this.toolStart(call.id, call.name, call.arguments);
        }
      } else if (message.role === "toolResult" && replay) {
        const toolCallId = this.projectedCalls.get(message.toolCallId)?.id ?? message.toolCallId;
        if (this.toolsEnded.has(toolCallId)) continue;
        this.toolsEnded.add(toolCallId);
        await this.emit({ type: "tool_execution_end", toolCallId, toolName: message.toolName,
          result: { content: message.content, details: message.details }, isError: message.isError });
      }
    }
  }

  private async toolStart(toolCallId: string, toolName: string, args: unknown): Promise<void> {
    const call = this.projectedCalls.get(toolCallId);
    if (call) { toolCallId = call.id; args = call.arguments; }
    if (this.toolsStarted.has(toolCallId)) return;
    this.toolsStarted.add(toolCallId);
    // A coalesced watch can outlive the tool checkpoint. Its committed intent
    // still contains the arguments, even when the live event only carries {}.
    for (const message of call ? [] : [...this.state.messages].reverse()) {
      if (message.role !== "assistant") continue;
      const call = message.content.find(block => block.type === "toolCall" && block.id === toolCallId);
      if (call?.type === "toolCall") { args = call.arguments; break; }
    }
    await this.emit({ type: "tool_execution_start", toolCallId, toolName, args });
  }

  private async observe(event: DurableEvent, cutoff: number): Promise<void> {
    // Nested calls live in the durable task tree; only transcript calls become main tool rows.
    if ("parentTaskId" in event && event.parentTaskId !== undefined) return;
    await this.refresh();
    switch (event.type) {
      case "compaction_start":
        await this.projectCompaction(event.taskId, "start", event.reason !== "manual");
        break;
      case "compaction_end": {
        if (event.error) break;
        const view = await this.root!.context(context);
        const entry = [...view.entries].reverse().find(entry => entry.kind === "pi.compaction" && entry.byTaskId === event.taskId);
        await this.projectCompaction(event.taskId, "end", event.reason !== "manual", readCompactionSummary(entry));
        break;
      }
      case "snapshot":
        for (const entry of event.entries) if (entry.id > cutoff) await this.entry(entry, true);
        if (event.generation?.message) await this.replaceMessage(event.generation.message);
        break;
      case "message_start":
        if (event.message.role === "assistant") await this.startMessage(event.message);
        else await this.emit({ type: "message_start", message: event.message as AgentMessage });
        break;
      case "message_update": {
        let message = this.message;
        for (const change of event.changes) {
          if (change.type === "message") message = change.message;
          else if (message !== undefined) {
            if ("block" in change) {
              const content = [...message.content]; content[change.contentIndex] = change.block;
              message = { ...message, content };
            } else {
              const field = change.type === "toolcall_delta" ? ["arguments", ...change.path] : [change.type === "text_delta" ? "text" : "thinking"];
              message = applyImmutable(message, [["a", ["content", change.contentIndex, ...field], change.delta]]);
            }
          }
        }
        if (message !== undefined) await this.replaceMessage({ ...message, usage: event.usage });
        break;
      }
      case "message_end": if (event.entry.id > cutoff) await this.entry(event.entry, false); break;
      case "entry_appended":
        if (event.entry.id > cutoff && event.entry.kind === "project.retry") await this.entry(event.entry, false);
        break;
      case "tool_execution_start": await this.toolStart(event.toolCallId, event.toolName, event.args); break;
      case "tool_execution_update": await this.emit({ ...event, toolCallId: this.projectedCalls.get(event.toolCallId)?.id ?? event.toolCallId, partialResult: event.details } as AgentEvent); break;
      case "tool_execution_end": {
        const toolCallId = this.projectedCalls.get(event.toolCallId)?.id ?? event.toolCallId;
        if (this.toolsEnded.has(toolCallId)) break;
        this.toolsEnded.add(toolCallId);
        const result = event.entry?.model?.find(message => message.role === "toolResult");
        await this.emit({ type: "tool_execution_end", toolCallId, toolName: event.toolName,
          result: result ? { content: result.content, details: result.details } : event.result,
          isError: result?.isError ?? event.result?.isError ?? true });
        break;
      }
    }
  }
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function readCompactionSummary(entry: EntryRecord | undefined): string | undefined {
  const content = entry?.model?.[0]?.content;
  const text = typeof content === "string" ? content : content?.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  return text?.match(/<summary>\n([\s\S]*)\n<\/summary>/)?.[1];
}

type InterruptedMessage = AssistantMessage & { projectInterrupted?: string; projectContextUsageInvalid?: boolean };

// The agent owns this store across Harness suspensions; it holds no external resources.
class AgentMemoryStorage extends MemoryStorage {
  override async close(_context: Context): Promise<void> {}
}
