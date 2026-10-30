import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { Type, clampThinkingLevel, type AssistantMessage, type Models, type Usage } from "@earendil-works/pi-ai";
import {
  AgentDoc, CompactionTask, InboxDoc, LiveDoc, ProviderDoc, UsageDoc, configure, defineDoc, defineExtension, defineTask,
  type Conversation, type ConversationId, type ConversationWatch, type EntryId, type EntryRecord,
  type Harness, type JsonObject, type Registry, type TaskId, type Storage, type SubmissionRecord,
  type ToolRegistration, type TaskGraphWatch, type Cursor, type Tx, type AgentChange, type TaskRecord, type RegistryReader, type TaskOutcome,
} from "@earendil-works/pi-durable";
import type { RunOutputItemInput } from "../node/output/index";
import type { TokenUsageAggregate } from "../token-usage/index";
import { estimateAgentContextTokens, readAgentContextUsage } from "./compaction";
import { durableContextMessages } from "./durable-context";
import { createAgentRetryChunks, formatAgentSearchSources } from "./output-items";
import { createAgentStreamRetryText } from "./plan";
import type { AgentTurnContinuationKind } from "./types";
import type { AgentSearchMessage } from "./web-search";
import type { AgentDefinition, AgentPlanItem, AgentSessionCommand, AgentSessionOptions, AgentSessionReceipt, AgentSessionResources, AgentSessionSnapshot, AgentSessionTask, AgentSessionTurn, AgentSubagentAction, AgentWorkInfo } from "./session-types";
import { AgentDefinitionsDoc, AgentRoleDoc, AgentWorkProgressDoc, AgentWorkRetryDoc, AgentSessionLifecycleDoc, enqueueAgentWork, waitForAgentWorkChange, type DelegationInput, type DelegationState } from "./subagents";
import { pageJsonResult, RESULT_PAGE_DESCRIPTION, RESULT_PAGE_PROPERTIES, validateResultPageArgs, type ResultPageArgs } from "./result-pages";

const SessionDoc = defineDoc({
  kind: "project.session", version: 1, scope: "conversation", history: "rewindable", fork: "initial",
  initial: () => ({ configurationVersion: 0, promptHash: "", promptVersion: 0,
    commands: {} as Record<string, JsonObject>, title: "", background: false as boolean, deleted: false as boolean, hostConfigurationHash: "" }),
});
const initialPlan = () => ({ version: 0, items: [] as { id: string; text: string; status: string }[] });
const PlanAsOf = defineDoc({ kind: "project.plan.as-of", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", initial: initialPlan });
const PlanCurrent = defineDoc({ kind: "project.plan.current", version: 1, scope: "conversation", history: "rewindable", fork: "current", initial: initialPlan });
const PlanInitial = defineDoc({ kind: "project.plan.initial", version: 1, scope: "conversation", history: "rewindable", fork: "initial", initial: initialPlan });
const DelegationDoc = defineDoc({ kind: "project.delegation", version: 1, scope: "task", initial: () => ({ taskId: 0 }) });

const plain = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textOf = (message: AssistantMessage | undefined): string => message?.content.flatMap(block => block.type === "text" ? [block.text] : []).join("") ?? "";
const validWorkRetry = (retry: AgentDefinition["retry"]) => !retry || Number.isSafeInteger(retry.maxAttempts)
  && retry.maxAttempts >= 1 && retry.maxAttempts <= 10 && Number.isSafeInteger(retry.delayMs ?? 1000)
  && (retry.delayMs ?? 1000) >= 0 && (retry.delayMs ?? 1000) <= 60_000;

function delegationOutput(taskId: number, outcome: TaskOutcome<unknown>, args: ResultPageArgs) {
  const answer = outcome.status === "completed" ? String(outcome.result)
    : `Subagent ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? "no result"}`;
  const result = pageJsonResult({ taskId, status: outcome.status, answer }, args, { taskId });
  const paged = result as { paged?: boolean };
  const text = paged.paged || Object.values(args).some(value => value !== undefined) || answer.split("\n").length >= 1800
    ? JSON.stringify(result) : answer;
  return { output: [{ type: "text" as const, text }], isError: outcome.status !== "completed" };
}

/** A projection and command adapter over the one executing Harness. No second queue or task scheduler. */
export class DurableAgentSession {
  readonly ownerId = randomUUID();
  private revision = 0;
  private graph?: TaskGraphWatch;
  private readonly watches = new Map<number, ConversationWatch>();
  private snapshots = Promise.resolve();
  private commands = Promise.resolve();
  private readonly workMutations = new Map<number, Promise<void>>();
  private stopped = false;
  private pending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private notify?: () => void;
  private readonly planDoc;
  private readonly delegation;
  private readonly replays = new Map<string, "safe" | "never">();
  private readonly submissions = new Map<number, SubmissionRecord>();
  private readonly tables = new Map<number, { entries: Map<number, EntryRecord>; tasks: Map<number, TaskRecord<JsonValue, JsonValue, JsonValue>> }>();
  private unsubscribe?: () => void;
  private unsubscribeRegistry?: () => void;
  tools: ToolRegistration[] = [];

  constructor(private readonly harness: Harness, private readonly root: Conversation, private readonly options: AgentSessionOptions,
    private readonly publish: (snapshot: AgentSessionSnapshot) => Promise<void>, private readonly report: (error: unknown) => void,
    private readonly models: Models, private readonly storage: Storage, private readonly registry: RegistryReader,
    private readonly resources: (loaded: readonly string[]) => AgentSessionResources,
    private readonly contextWindow: (provider: string, model: string) => number | undefined = (provider, model) => models.getModel(provider, model)?.contextWindow) {
    this.planDoc = options.planFork === "initial" ? PlanInitial : options.planFork === "current" ? PlanCurrent : PlanAsOf;
    this.delegation = this.createDelegationTask();
  }

  install(registry: Registry): void {
    if (this.options.subagents && (!Number.isSafeInteger(this.options.subagents.maxAgents ?? 4) || (this.options.subagents.maxAgents ?? 4) < 1)) throw new Error("maxAgents must be a positive integer.");
    if (this.options.subagents?.model && !this.allowedChildModel(this.options.subagents.model)) throw this.childModelError();
    if (!validWorkRetry(this.options.subagents?.retry)) throw new Error("Agent work retry requires maxAttempts (1-10) and delayMs (0-60000).");
    const definitions = this.options.subagents?.definitions ?? [];
    if (new Set(definitions.map(item => item.id)).size !== definitions.length) throw new Error("Agent role ids must be unique.");
    for (const definition of definitions) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(definition.id) || !definition.description?.trim() || !definition.systemPrompt?.trim()
        || definition.systemPrompt.length > 100_000 || !Array.isArray(definition.tools)
        || definition.tools.some(name => !this.options.subagents!.tools.includes(name) || ["subagent", "update_plan"].includes(name))
        || !Number.isSafeInteger(definition.maxConcurrency ?? 1) || (definition.maxConcurrency ?? 1) < 1
        || !validWorkRetry(definition.retry) || definition.requireProgress !== undefined && typeof definition.requireProgress !== "boolean"
        || !this.options.subagents?.model && definition.model && !this.allowedChildModel(definition.model)
        || definition.effort && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(definition.effort)) {
        throw new Error(`Invalid agent role definition: ${definition.id}`);
      }
    }
    const names = this.options.nativeTools?.map(tool => tool.name) ?? [];
    if (new Set(names).size !== names.length || names.some(name => name === "subagent" || name === "update_plan")) throw new Error("Native session tool names must be unique and cannot replace session tools.");
    const tools: ToolRegistration[] = [...(this.options.nativeTools ?? []), {
      name: "update_plan", description: "Save the current task plan and its progress.", replay: "safe",
      parameters: Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), status: Type.Union([
        Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"),
      ]) }), { maxItems: 100 }) }),
      execute: async (args, api, ctx) => {
        const items = validatePlan((args as { items: AgentPlanItem[] }).items);
        await api.commit(async tx => {
          const plan = await tx.doc(this.planDoc, api.conversationId);
          plan.items = items; plan.version++;
          await tx.appendEntry(api.conversationId, { kind: "project.plan", data: { version: plan.version, count: items.length } });
        }, ctx);
        return { output: [{ type: "text", text: "Plan saved." }] };
      },
    }];
    const childModels = this.options.subagents?.model ? [] : this.options.subagents?.models?.filter(model => this.models.getModel(model.provider, model.modelId)) ?? [];
    if (this.options.subagents) tools.push({
      name: "subagent", description: [
        "Delegate a focused task. Background results return to this conversation. Subagents cannot delegate again.",
        ...(definitions.length ? ["Named work: action=spawn, agentId, stable workId, task, background=true. Capacity limits queue work durably.",
          "Management actions: list; get/wait/stop/retry with taskId; send with taskId, task and mode (steer/followUp). Retry continues committed context and requires reconciliation of uncertain side effects.",
          "Project-configured automatic work retries are bounded. Wait while they run; after the budget is exhausted, report the failure and stop retrying. Do not create a new workId or batch to bypass the limit.",
          "Send only to running work. A not_running delivery receipt returns its current state without starting work: get completed results, wait for queued work, or explicitly retry failed/cancelled work. Batch task IDs are not subagent task IDs; use the project's batch tools for batch controls.",
          `Roles: ${definitions.map(item => `${item.id}: ${item.description}`).join("; ")}`] : []),
        `Child tools are restricted to the parent's enabled tools intersected with: ${this.options.subagents.tools.join(", ") || "(none)"}. Only delegate tasks those tools can perform.`,
        this.options.subagents.model ? "Omit model. The project has selected a shared model for all subagents."
          : "Omit model to inherit the current parent's model and credentials, unless the role defines its own default.",
        "To read an existing delegation result, provide resultTaskId=taskId without task, background or model. This never starts another child. For a paged result, keep resultTaskId and continue with resultOffset=nextOffset and resultHash.",
        RESULT_PAGE_DESCRIPTION,
        childModels.length ? `Allowed model overrides: ${childModels.map(model => `${model.provider}/${model.modelId}`).join(", ")}. Use only these exact provider/modelId pairs.`
          : "Model overrides are disabled for this project; do not supply model or guess model names.",
      ].join("\n"), replay: "safe",
      parameters: Type.Object({ task: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })), background: Type.Optional(Type.Boolean()),
        ...(definitions.length ? {
          action: Type.Optional(Type.Union(["spawn", "list", "get", "wait", "send", "stop", "retry"].map(value => Type.Literal(value)))),
          agentId: Type.Optional(Type.String()), workId: Type.Optional(Type.String()), taskId: Type.Optional(Type.Integer({ minimum: 1 })),
          mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
        } : {}),
        resultTaskId: Type.Optional(Type.Integer({ minimum: 1 })),
        ...Object.fromEntries(Object.entries(RESULT_PAGE_PROPERTIES).map(([name, schema]) => [name, Type.Optional(Type.Unsafe(schema))])),
        ...(childModels.length ? { model: Type.Optional(Type.Union(childModels.map(model => Type.Object({
          provider: Type.Literal(model.provider), modelId: Type.Literal(model.modelId),
        })))) } : {}) }),
      execute: async (args, api, ctx) => {
        const parent = await this.harness.commit(tx => tx.conversation(api.conversationId), ctx);
        if (!parent || parent.owner !== undefined) throw new Error("Subagents cannot delegate again.");
        const input = args as ResultPageArgs & { task?: string; background?: boolean; model?: { provider: string; modelId: string }; resultTaskId?: number };
        const managed = args as { action?: AgentSubagentAction["action"]; agentId?: string; workId?: string; taskId?: number; task?: string; background?: boolean; mode?: "steer" | "followUp" };
        if (managed.action || managed.agentId) {
          // An explicit action selects the managed command. Models sometimes
          // populate every optional legacy result field; those fields must not
          // redirect or reject a named operation. Model overrides remain forbidden.
          if (input.model != null) throw new Error("Named agent management cannot override the role model.");
          const action = managed.action ?? "spawn";
          const command = action === "spawn" ? { action, agentId: managed.agentId!, workId: managed.workId!, prompt: managed.task!, background: managed.background,
            reportToParent: true } : action === "send" ? { action, taskId: managed.taskId!, prompt: managed.task!, mode: managed.mode }
            : action === "list" ? { action } : { action, taskId: managed.taskId! };
          const result = await this.manageAgents(api.conversationId, command as AgentSubagentAction, `tool:${api.taskId}`, ctx,
            managed.background ? undefined : api.taskId);
          await api.details({ agents: plain(result) } as unknown as JsonObject, ctx);
          const wait = action === "wait" || action === "spawn" && !managed.background;
          if (wait && result[0]) {
            const settled = await api.waitForTask(result[0].taskId as TaskId<string>, ctx);
            return delegationOutput(result[0].taskId, settled.state.outcome, {});
          }
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        }
        validateResultPageArgs(input, input.resultTaskId !== undefined);
        if (input.resultTaskId !== undefined) {
          if (input.task !== undefined || input.background !== undefined || input.model !== undefined) throw new Error("Read an existing result with resultTaskId only; omit task, background and model.");
          const result = await api.getTask(input.resultTaskId as TaskId<string>, ctx);
          if (!result || result.kind !== "project.delegation" || result.conversationId !== api.conversationId) throw new Error("Unknown subagent result for this conversation.");
          if (result.state.status !== "terminal") throw new Error("The subagent is still running; read its result after it settles.");
          return delegationOutput(input.resultTaskId, result.state.outcome, input);
        }
        if (typeof input.task !== "string" || input.task.trim() === "") throw new Error("A subagent task is required to start a child; use resultTaskId to read an existing result.");
        const prompt = input.task;
        if (input.model && !this.allowedChildModel(input.model)) throw this.childModelError();
        const id = await api.commit(async tx => {
          const memo = await tx.doc(DelegationDoc, api.taskId);
          if (memo.taskId) return memo.taskId;
          memo.taskId = await tx.createTask(this.delegation, { prompt, background: input.background === true, model: input.model ?? null, sourceId: api.callId,
            ...(this.options.subagents?.retry ? { retry: this.options.subagents.retry } : {}) },
            { conversationId: api.conversationId, ownership: input.background ? { kind: "conversation" } : { kind: "task", taskId: api.taskId }, background: input.background === true });
          return memo.taskId;
        }, ctx);
        await api.details({ taskId: id, background: input.background === true }, ctx);
        if (input.background) return { output: [{ type: "text", text: `Background task ${id} started. Its result will return here.` }] };
        const result = await api.waitForTask(id as TaskId<string>, ctx);
        return delegationOutput(id, result.state.outcome, {});
      },
    });
    registry.install(defineExtension({ name: "project.session", tools, tasks: [this.delegation] }));
    this.tools = tools;
    this.setTools(tools);
  }

  setTools(tools: readonly ToolRegistration[]): void {
    for (const tool of tools) this.replays.set(tool.name, tool.replay === "safe" ? "safe" : "never");
  }

  private allowedChildModel(model: { provider: string; modelId: string }): boolean {
    return !!this.models.getModel(model.provider, model.modelId) && !!this.options.subagents?.models?.some(allowed => allowed.provider === model.provider && allowed.modelId === model.modelId);
  }

  private childModelError(): Error {
    const allowed = this.options.subagents?.models?.filter(model => this.models.getModel(model.provider, model.modelId)) ?? [];
    return new Error(`The subagent model is not allowed by the project. Omit model to inherit the parent's model and credentials.${allowed.length
      ? ` Allowed overrides: ${allowed.map(model => `${model.provider}/${model.modelId}`).join(", ")}.`
      : " Model overrides are disabled."}`);
  }

  /** Re-check restored children against today's project and parent authorization. */
  async authorizeChild(conversationId: ConversationId, toolName?: string): Promise<void> {
    const record = await this.harness.commit(tx => tx.conversation(conversationId), context);
    if (!record?.owner) return;
    if (!this.options.subagents) throw new Error("Delegation is no longer enabled for this project.");
    const role = await this.harness.snapshot(AgentRoleDoc, conversationId, context);
    const definition = role?.definition as unknown as AgentDefinition | null;
    const current = definition && this.options.subagents.definitions?.find(item => item.id === definition.id);
    if (definition && !current) throw new Error("The agent role is no longer authorized by this project.");
    if (!this.options.subagents.model && definition?.model && !this.allowedChildModel(definition.model)) throw this.childModelError();
    if (toolName) {
      const parent = await this.harness.conversation(record.owner.conversationId, context);
      const tools = (await parent?.agent(context))?.tools ?? [];
      if (toolName === "subagent" || !tools.some(tool => tool.name === toolName)
        || !(this.options.subagents.tools.includes(toolName) || !definition && toolName === "memory")
        || definition && (!definition.tools.includes(toolName) || !current?.tools.includes(toolName))) {
        throw new Error(`Tool is not authorized for this agent role: ${toolName}`);
      }
    }
  }

  private async mutateWork<T>(taskId: number, change: () => Promise<T>): Promise<T> {
    const previous = this.workMutations.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = previous.then(() => gate);
    this.workMutations.set(taskId, current);
    await previous;
    try { return await change(); }
    finally { release(); if (this.workMutations.get(taskId) === current) this.workMutations.delete(taskId); }
  }

  private submitManagedInput(child: Conversation, input: Parameters<Conversation["submit"]>[0], ctx: typeof context): ReturnType<Conversation["submit"]>;
  private submitManagedInput(child: Conversation, input: Parameters<Conversation["submit"]>[0], ctx: typeof context, returnSettled: true): Promise<Awaited<ReturnType<Conversation["submit"]>> | undefined>;
  private async submitManagedInput(child: Conversation, input: Parameters<Conversation["submit"]>[0], ctx: typeof context, returnSettled = false) {
    const record = await this.harness.commit(tx => tx.conversation(child.id), ctx);
    const role = record?.owner && await this.harness.snapshot(AgentRoleDoc, child.id, ctx);
    if (!record?.owner || !role?.workId) return child.submit(input, ctx);
    return this.mutateWork(record.owner.taskId, async () => {
      // A tool replay after settlement must still acknowledge a message that
      // was already admitted, rather than turn its successful delivery red.
      if (input.requestId && await this.harness.commit(tx => tx.submissionByRequest(child.id, input.requestId!), ctx)) return child.submit(input, ctx);
      const task = await this.harness.commit(tx => tx.task(record.owner!.taskId), ctx);
      if (!task || task.abortRequested || !["running", "waiting", "pending"].includes(task.state.status)
        || object(task.state.checkpoint).phase !== "wait") {
        if (returnSettled) return undefined;
        throw new Error("The agent is settling or stopped. Retry settled work before sending more input.");
      }
      return child.submit(input, ctx);
    });
  }

  private createDelegationTask() {
    return defineTask<DelegationInput, DelegationState, string>({
      name: "project.delegation", version: 1, initial: () => ({ phase: "create" }),
      phases: {
        create: async (task, runtime, ctx) => {
          const parent = await this.harness.conversation(task.conversationId, ctx);
          if (!parent || !this.options.subagents) throw new Error("Delegation is not enabled for this conversation.");
          const parentAgent = await parent.agent(ctx);
          const definition = task.input.definition as unknown as AgentDefinition | undefined;
          const currentDefinition = this.options.subagents.definitions?.find(item => item.id === definition?.id);
          const allowed = new Set((definition?.tools ?? this.options.subagents.tools).filter(name =>
            this.options.subagents!.tools.includes(name) && (!definition || currentDefinition?.tools.includes(name))));
          const tools = parentAgent.tools.filter(tool => (allowed.has(tool.name) || !definition && tool.name === "memory") && tool.name !== "subagent");
          if (definition && (!this.options.subagents.definitions?.some(item => item.id === definition.id)
            || definition.tools.some(name => !this.options.subagents!.tools.includes(name)))) throw new Error("The agent role is no longer authorized by this project.");
          const modelTools = tools.map(tool => tool.name === "memory" ? {...tool,parameters:Type.Object({
            action:Type.Union([Type.Literal("list"),Type.Literal("get"),Type.Literal("search")]),
            scope:Type.Optional(Type.Union([Type.Literal("global"),Type.Literal("current")])),
            id:Type.Optional(Type.String()),query:Type.Optional(Type.String()),cursor:Type.Optional(Type.String()),
          },{additionalProperties:false})} : tool);
          const model = this.options.subagents.model ?? definition?.model ?? task.input.model;
          if (model && !this.allowedChildModel(model)) throw this.childModelError();
          // Admission and child creation share the Session commit line. Waiters have
          // no slot until admitted; a restart reconstructs this queue from task IDs.
          while (true) {
            let admitted = false;
            let blockers: TaskId[] = [];
            await runtime.commit(async tx => {
              const live = (await scanAll(cursor => tx.scanTasks({ conversationId: task.conversationId, kind: "project.delegation" }, 100, cursor)))
                .filter(item => item.state.status !== "terminal").sort((left, right) => left.id - right.id);
              const active = live.filter(item => object(item.state.checkpoint).phase !== "create");
              const selected = [...active];
              for (const candidate of live.filter(item => object(item.state.checkpoint).phase === "create")) {
                const candidateInput = candidate.input as DelegationInput;
                const roleLimit = Number(this.options.subagents!.definitions?.find(item => item.id === candidateInput.agentId)?.maxConcurrency
                  ?? object(candidateInput.definition).maxConcurrency ?? this.options.subagents!.maxAgents ?? 4);
                if (selected.length < (this.options.subagents!.maxAgents ?? 4)
                  && selected.filter(item => (item.input as DelegationInput).agentId === candidateInput.agentId).length < roleLimit) selected.push(candidate);
              }
              if (!selected.some(item => item.id === task.id)) {
                blockers = selected.map(item => item.id);
                return;
              }
              const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
              let child = existing;
              if (!child && task.input.retryChildId) {
                const last = (await tx.scanEntries({ conversationId: task.input.retryChildId as ConversationId, order: "descending" }, 1)).items[0];
                if (last) child = await tx.forkConversation(task.input.retryChildId as ConversationId, last.id, { ownership: { kind: "task", taskId: task.id } });
              }
              child ??= await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
              const childModel = model ?? parentAgent.model!;
              const registered = this.models.getModel(childModel.provider, childModel.modelId);
              const effort = (definition?.effort ?? parentAgent.thinkingLevel ?? "off") as "medium";
              await configure(tx, child.id, { tools: tools as ToolRegistration[], modelTools: modelTools as ToolRegistration[],
                model: childModel, thinkingLevel: registered ? clampThinkingLevel(registered, effort) : effort,
                ...(parentAgent.cwd ? { cwd: parentAgent.cwd } : {}) });
              if (definition) {
                const role = await tx.doc(AgentRoleDoc, child.id);
                role.definition = task.input.definition!; role.workId = task.input.workId!; role.attempt = task.input.attempt ?? 1;
                role.metadata = task.input.metadata ?? {};
              }
              const info = await tx.doc(SessionDoc, child.id);
              info.title = task.input.label ?? task.input.prompt.slice(0, 120); info.background = task.input.background;
              admitted = true;
              const retries = await tx.doc(AgentWorkRetryDoc, task.conversationId, String(task.id), null);
              retries.attempt = task.input.attempt ?? 1;
              retries.maxAttempts = this.workRetryPolicy(task.input).maxAttempts;
              return { status: "running", checkpoint: { phase: "wait", childId: child.id, attempt: retries.attempt } };
            }, ctx);
            if (admitted) break;
            if (!blockers.length) throw new Error("Agent work cannot acquire a concurrency slot.");
            await waitForAgentWorkChange(blockers, (id, waitContext) => runtime.waitForTask(id, waitContext), ctx);
          }
        },
        wait: async (task, runtime, ctx) => {
          const child = (await runtime.conversation(task.state.checkpoint.childId as ConversationId, ctx))!;
          const attempt = task.state.checkpoint.attempt ?? task.input.attempt ?? 1;
          const content = task.input.retryOf || attempt > (task.input.attempt ?? 1) ? `Continue the previous work from its committed context. Inspect uncertain external writes before repeating them. Do not repeat completed actions. Complete and verify the remaining work.\n\n${task.input.prompt}` : task.input.prompt;
          const requestId = attempt === (task.input.attempt ?? 1) ? `delegate:${task.id}` : `delegate:${task.id}:attempt:${attempt}`;
          const settled = await (await child.submit({ type: "input", content, requestId,
            entry: { kind: "project.input", data: { requestId, mode: "followUp" } } }, ctx)).wait(ctx);
          while (true) {
            await child.waitForIdle(ctx);
            // Message admission and settlement share a short lock. A message
            // accepted at the idle boundary must finish before releasing its slot.
            const closed = await this.mutateWork(task.id, async () => {
              const submissions = await scanAll(cursor => this.storage.scanSubmissions({ conversationId: child.id }, 100, cursor, ctx));
              if (submissions.some(input => input.status === "queued" || input.status === "placed")) return false;
              const history = await runtime.context(child.id, ctx);
              const message = [...history.messages].reverse().find(message => message.role === "assistant");
              const progress = await runtime.snapshot(AgentWorkProgressDoc, task.conversationId, String(task.id), ctx);
              const unanswered = [...submissions].reverse().find(input => input.id >= settled.id && input.type === "input" && input.status === "unanswered");
              const failure = unanswered?.status === "unanswered" ? unanswered : settled.status !== "done" ? settled : undefined;
              const incomplete = (task.input.requireProgress === true || object(task.input.definition).requireProgress === true)
                && !(progress && progress.total > 0 && progress.completed >= progress.total);
              const failed = !!failure || !!progress?.error || incomplete;
              const answer = failure ? `Subagent failed: ${failure.reason}${failure.detail ? `: ${String(failure.detail)}` : ""}` : progress?.error
                || (incomplete ? "Subagent ended without verified progress completion. Save the required evidence/result and its completion receipt." : textOf(message));
              const retryable = progress?.retryable !== false && !/^(aborted|cancelled|interrupted|orphaned)$/.test(failure?.reason ?? "")
                && !/\bHTTP (?:400|401|403|404|402)\b|not authorized|not allowed|permission denied|invalid api key|insufficient (?:quota|balance)/i.test(answer);
              await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", childId: child.id, answer, failed, retryable, attempt } }), ctx);
              return true;
            });
            if (closed) break;
          }
        },
        report: async (task, runtime, ctx) => {
          const { childId, failed } = task.state.checkpoint;
          const attempt = task.state.checkpoint.attempt ?? task.input.attempt ?? 1;
          const policy = this.workRetryPolicy(task.input);
          let answer = task.state.checkpoint.answer;
          if (failed && task.state.checkpoint.retryable !== false && attempt < policy.maxAttempts) {
            await runtime.commit(async tx => {
              const retries = await tx.doc(AgentWorkRetryDoc, task.conversationId, String(task.id), null);
              if (!retries.failures.some(item => item.attempt === attempt)) retries.failures.push({ attempt, error: answer });
              await tx.appendEntry(task.conversationId, { kind: "project.subagent-retry", data: { taskId: task.id, attempt: attempt+1, maxAttempts: policy.maxAttempts, error: answer } });
              return { status: "running", checkpoint: { phase: "retry", childId, attempt: attempt+1,
                wakeAt: runtime.now() + Math.min((policy.delayMs ?? 1000) * 2 ** (attempt-1), 60_000), error: answer } };
            }, ctx);
            return;
          }
          if (failed) await runtime.commit(async tx => {
            const retries = await tx.doc(AgentWorkRetryDoc, task.conversationId, String(task.id), null);
            if (!retries.failures.some(item => item.attempt === attempt)) retries.failures.push({ attempt, error: answer });
          }, ctx);
          if (failed && task.input.retry && attempt >= policy.maxAttempts) answer = `Retry limit reached (${attempt}/${policy.maxAttempts}). Stop retrying and report this failure. ${answer}`;
          if (task.input.background && task.input.reportToParent !== false) {
            const parent = (await runtime.conversation(task.conversationId, ctx))!;
            const output = delegationOutput(task.id, failed ? { status: "failed", error: { message: answer } } : { status: "completed", result: answer }, {});
            await parent.submit({ type: "input", content: `Subagent ${failed ? "failed" : "result"} (${childId}, resultTaskId=${task.id}):\n${output.output[0]!.text}`, whenBusy: "followUp", requestId: `report:${task.id}`,
              entry: { kind: "project.child-result", data: { requestId: `report:${task.id}`, sourceId: childId, mode: "report" } } }, ctx);
          }
          await runtime.commit(() => ({ status: "terminal", outcome: failed ? { status: "failed", error: { message: answer } } : { status: "completed", result: answer } }), ctx);
        },
        retry: async (task, runtime, ctx) => {
          const { childId, attempt, wakeAt } = task.state.checkpoint;
          await runtime.sleep(wakeAt, ctx);
          await runtime.commit(async tx => {
            const progress = await tx.doc(AgentWorkProgressDoc, task.conversationId, String(task.id), null);
            if (attempt > this.workRetryPolicy(task.input).maxAttempts || progress.retryable === false) return {
              status: "running", checkpoint: { phase: "report", childId, attempt: attempt-1, failed: true, retryable: false, answer: task.state.checkpoint.error },
            };
            const retries = await tx.doc(AgentWorkRetryDoc, task.conversationId, String(task.id), null);
            retries.attempt = attempt;
            progress.error = ""; progress.retryable = null;
            if (task.input.agentId) (await tx.doc(AgentRoleDoc, childId as ConversationId)).attempt = attempt;
            return { status: "running", checkpoint: { phase: "wait", childId, attempt } };
          }, ctx);
        },
      },
      abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
    });
  }

  private workRetryPolicy(input: DelegationInput) {
    const current = this.options.subagents?.definitions?.find(role => role.id === input.agentId)?.retry ?? this.options.subagents?.retry;
    return { maxAttempts: Math.min(input.retry?.maxAttempts ?? 1, current?.maxAttempts ?? 1), delayMs: input.retry?.delayMs ?? 1000 };
  }

  private async agentWorks(conversationId: ConversationId): Promise<AgentWorkInfo[]> {
    const works = await this.harness.commit(async tx => {
      const records = await scanAll(cursor => tx.scanTasks({ conversationId, kind: "project.delegation" }, 100, cursor));
      const results: AgentWorkInfo[] = [];
      for (const task of records) {
        const input = task.input as DelegationInput;
        if (!input.agentId || !input.workId) continue;
        const child = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
        const outcome = task.state.status === "terminal" ? task.state.outcome : undefined;
        results.push({ taskId: task.id, workId: input.workId, agentId: input.agentId, label: input.label ?? input.prompt.slice(0, 120),
          status: outcome?.status ?? (object(task.state.checkpoint).phase === "create" ? "queued" : task.state.status),
          attempt: input.attempt ?? 1, ...(child ? { childConversationId: child.id } : {}),
          ...(input.retryOf ? { retryOf: input.retryOf } : {}), ...(input.metadata ? { metadata: plain(input.metadata) } : {}),
          ...(outcome?.status === "completed" ? { result: String(outcome.result) } : {}),
          ...(outcome && outcome.status !== "completed" ? { error: outcome.error?.message ?? outcome.reason ?? outcome.status } : {}) });
      }
      return results;
    }, context);
    // Task documents are immutable after settlement. Read their persisted projection
    // outside a write transaction so listing completed work cannot acquire it.
    return Promise.all(works.map(async work => {
      const progress = await this.harness.snapshot(AgentWorkProgressDoc, conversationId, String(work.taskId), context);
      const retries = await this.harness.snapshot(AgentWorkRetryDoc, conversationId, String(work.taskId), context);
      return { ...work, attempt: Math.max(work.attempt, retries?.attempt ?? 0), ...(work.status === "completed" && progress?.error ? { status: "failed", error: progress.error } : {}),
        ...(progress?.total ? { progress: { completed: progress.completed, total: progress.total,
          ...(progress.phase ? { phase: progress.phase } : {}) } } : {}) };
    }));
  }

  async interrupt(): Promise<void> {
    await this.root.commit(async tx => { (await tx.doc(AgentSessionLifecycleDoc, this.root.id)).interrupted = true; }, context);
    await this.control({ type: "cancel", scope: "all", requestId: `host-interrupted:${this.ownerId}` });
    await this.root.commit(async tx => { (await tx.doc(AgentSessionLifecycleDoc, this.root.id)).interrupted = false; }, context);
  }

  private async manageAgents(conversationId: ConversationId, action: AgentSubagentAction, requestId: string,
    ctx: typeof context = context, ownerTaskId?: TaskId): Promise<AgentWorkInfo[]> {
    const parent = await this.harness.commit(tx => tx.conversation(conversationId), ctx);
    if (!this.options.subagents || !parent || parent.owner) throw new Error("Only a parent agent with delegation enabled can manage subagents.");
    if (action.action === "spawn") {
      const id = await this.harness.commit(tx => enqueueAgentWork(tx, this.registry.snapshot(), action, {
        conversationId, ownership: ownerTaskId ? { kind: "task", taskId: ownerTaskId } : { kind: "conversation" },
        ...(ownerTaskId ? {} : { background: action.background !== false }),
      }), ctx);
      this.harness.resume();
      return (await this.agentWorks(conversationId)).filter(item => item.taskId === id);
    }
    const works = await this.agentWorks(conversationId);
    if (action.action === "list") return works;
    const work = works.find(item => item.taskId === action.taskId);
    if (!work) throw new Error("Unknown agent work for this parent conversation.");
    if (action.action === "stop") {
      await this.harness.abortTask(work.taskId as TaskId, ctx);
      await this.harness.waitForTask(work.taskId as TaskId, ctx);
    }
    if (action.action === "send") {
      if (!action.prompt?.trim() || action.prompt.length > 100_000 || action.mode && !["steer", "followUp"].includes(action.mode)) throw new Error("Invalid agent message.");
      const child = work.childConversationId ? await this.harness.conversation(work.childConversationId as ConversationId, ctx) : undefined;
      const submission = child && await this.submitManagedInput(child, { type: "input", content: action.prompt, whenBusy: action.mode ?? "followUp", requestId: `agent-message:${requestId}`,
        entry: { kind: "project.input", data: { requestId: `agent-message:${requestId}`, mode: action.mode ?? "followUp" } } }, ctx, true);
      const current = (await this.agentWorks(conversationId)).find(item => item.taskId === work.taskId)!;
      return [{ ...current, messageDelivery: submission ? { status: "accepted" } : { status: "not_running",
        nextAction: current.status === "queued" || ["running", "waiting", "pending"].includes(current.status) ? "wait" : current.status === "completed" ? "get" : "retry" } }];
    }
    if (action.action === "retry") {
      if (!["failed", "faulted", "aborted", "orphaned"].includes(work.status)) throw new Error("Only failed or cancelled agent work can be retried.");
      const id = await this.harness.commit(async tx => {
        const records = await scanAll(cursor => tx.scanTasks({ conversationId, kind: "project.delegation" }, 100, cursor));
        const existing = records.find(record => (record.input as DelegationInput).sourceId === `retry:${requestId}`);
        if (existing) return existing.id;
        const later = records.find(record => (record.input as DelegationInput).retryOf === work.taskId);
        if (later) return later.id;
        const originalRecord = records.find(record => record.id === work.taskId)!;
        const original = originalRecord.input as DelegationInput;
        if (original.retry && work.attempt >= this.workRetryPolicy(original).maxAttempts) throw new Error("Agent work retry limit reached. Stop retrying and report the failure; do not bypass it with a new workId.");
        if (originalRecord.owner && (await tx.task(originalRecord.owner))?.state.status === "terminal") throw new Error("Resume the owning batch before retrying this work.");
        return tx.createTask(this.delegation, { ...original, attempt: Math.max(...works.filter(item => item.workId === work.workId).map(item => item.attempt)) + 1,
          retryOf: work.taskId, ...(work.childConversationId ? { retryChildId: work.childConversationId } : {}), sourceId: `retry:${requestId}` },
        { conversationId, ownership: originalRecord.owner ? { kind: "task", taskId: originalRecord.owner } : { kind: "conversation" },
          ...(originalRecord.owner ? {} : { background: true }) });
      }, ctx);
      this.harness.resume();
      return (await this.agentWorks(conversationId)).filter(item => item.taskId === id);
    }
    return (await this.agentWorks(conversationId)).filter(item => item.taskId === work.taskId);
  }

  async start(prompt: string): Promise<void> {
    this.stopped = false;
    this.unsubscribe?.();
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = this.registry.subscribe(() => this.schedule());
    const changes = new Map<number, SubmissionRecord>();
    this.unsubscribe = this.harness.subscribeCommits(publication => {
      for (const change of publication.changes) {
        if (change.type === "submission") {
          this.submissions.set(change.value.id, change.value); changes.set(change.value.id, change.value);
        }
        if (change.type === "entry") this.tables.get(change.value.conversationId)?.entries.set(change.value.id, change.value);
        if (change.type === "task") this.tables.get(change.value.conversationId)?.tasks.set(change.value.id, change.value);
      }
      if (publication.changes.length) this.schedule();
    });
    for (const record of await scanAll(cursor => this.storage.scanSubmissions({}, 200, cursor, context))) {
      this.submissions.set(record.id, changes.get(record.id) ?? record);
    }
    await this.root.commit(async tx => {
      const roles = await tx.doc(AgentDefinitionsDoc, this.root.id);
      roles.definitions = Object.fromEntries((this.options.subagents?.definitions ?? []).map(item => [item.id, plain({ ...item,
        ...(item.retry ?? this.options.subagents?.retry ? { retry: item.retry ?? this.options.subagents?.retry } : {}) }) as unknown as JsonObject]));
      const doc = await tx.doc(SessionDoc, this.root.id);
      const hash = createHash("sha256").update(prompt).digest("hex");
      if (doc.promptHash !== hash) {
        doc.promptHash = hash; doc.promptVersion++;
        await tx.appendEntry(this.root.id, { kind: "project.prompt", data: { hash, version: doc.promptVersion } });
      }
      await tx.doc(this.planDoc, this.root.id);
    }, context);
    this.graph = await this.harness.watchTaskGraph(context);
    this.graph.start(async () => { this.notify?.(); this.schedule(); });
    await this.attach(this.root);
    await this.emit();
  }

  async configureRoot(change: AgentChange): Promise<void> {
    await this.root.commit(async tx => {
      const info = await tx.doc(SessionDoc, this.root.id);
      const hash = createHash("sha256").update(canonical({ model: change.model, thinkingLevel: change.thinkingLevel, cwd: change.cwd })).digest("hex");
      const changed = info.hostConfigurationHash !== hash;
      await configure(tx, this.root.id, changed ? change : { tools: change.tools, cwd: change.cwd });
      if (changed && info.hostConfigurationHash) {
        info.configurationVersion++;
        await tx.appendEntry(this.root.id, { kind: "project.configuration", data: { version: info.configurationVersion } });
      }
      info.hostConfigurationHash = hash;
    }, context);
  }

  async requestIdFor(id: ConversationId): Promise<string> {
    const live = await this.harness.snapshot(LiveDoc, id, context);
    const input = live?.run?.inputs[0];
    return input === undefined ? `conversation:${id}` : this.submissions.get(input)?.requestId ?? `submission:${input}`;
  }

  async recordCompactionUsage(sessionId: string | undefined, recordId: string, usage: Usage): Promise<void> {
    if (!sessionId) return;
    for (const id of this.watches.keys()) {
      const provider = await this.harness.snapshot(ProviderDoc, id as ConversationId, context);
      if (provider?.sessionId !== sessionId) continue;
      const requestId = await this.requestIdFor(id as ConversationId);
      await this.harness.commit(tx => tx.appendEntry(id as ConversationId, {
        kind: "project.compaction-usage", data: { requestId, recordId, usage: plain(usage) as unknown as JsonValue },
      }), context);
      return;
    }
  }

  private async attach(conversation: Conversation): Promise<void> {
    if (this.watches.has(conversation.id)) return;
    const watch = await conversation.watch(context);
    this.watches.set(conversation.id, watch);
    watch.start(async () => { this.notify?.(); this.schedule(); });
  }

  private schedule(): void {
    if (this.stopped || this.pending) return;
    this.pending = true;
    this.timer = setTimeout(() => {
      this.timer = undefined; this.pending = false;
      this.snapshots = this.snapshots.then(async () => { if (!this.stopped) await this.emit(); }).catch(error => this.report(error));
    }, 50);
  }

  async emit(): Promise<void> { await this.publish(await this.snapshot()); }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer); this.timer = undefined; this.pending = false;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.unsubscribeRegistry?.(); this.unsubscribeRegistry = undefined;
    await this.graph?.stop(); this.graph = undefined;
    for (const watch of this.watches.values()) await watch.stop();
    this.watches.clear();
    await this.snapshots;
  }

  async drain(): Promise<void> {
    while (true) {
      const live = await this.harness.inspect(context);
      if (live.tasks.length === 0) { await this.snapshots; await this.emit(); return; }
      if (live.tasks.some(task => task.state.kind === "blocked") && live.tasks.every(task => !["running", "ready"].includes(task.state.kind))) throw new Error("Agent tasks are blocked by an unavailable task definition. Inspect or stop the affected tasks.");
      await Promise.race(live.tasks.map(task => this.harness.waitForTask(task.record.id, context)));
    }
  }

  control(command: AgentSessionCommand): Promise<AgentSessionReceipt> {
    if (this.stopped) return Promise.reject(Object.assign(new Error("The agent session is closed."), { code: "AGENT_NOT_READY" }));
    const next = this.commands.catch(() => undefined).then(() => this.perform(command));
    this.commands = next.then(() => undefined, () => undefined);
    // Waiting for work must not hold the command line: stop/send remain usable.
    return next.then(async receipt => {
      if (command.type !== "subagent" || command.action !== "wait" || !receipt.taskId) return receipt;
      await this.harness.waitForTask(receipt.taskId as TaskId, context);
      return { ...receipt, agents: (await this.agentWorks(receipt.conversationId as ConversationId)).filter(item => item.taskId === receipt.taskId) };
    });
  }

  private async target(id?: number): Promise<Conversation> {
    const target = id ? await this.harness.conversation(id as ConversationId, context) : this.root;
    if (!target) throw new Error("The target conversation does not exist.");
    let record = await this.harness.commit(tx => tx.conversation(target.id), context);
    const seen = new Set<number>();
    while (record && record.id !== this.root.id && !seen.has(record.id)) {
      seen.add(record.id);
      const parent = record.owner?.conversationId ?? record.parent?.conversationId;
      record = parent ? await this.harness.commit(tx => tx.conversation(parent), context) : undefined;
    }
    if (record?.id !== this.root.id) throw new Error("The target belongs to another session.");
    return target;
  }

  private async perform(command: AgentSessionCommand): Promise<AgentSessionReceipt> {
    if (typeof command.requestId !== "string" || !command.requestId || command.requestId.length > 256 || ["__proto__", "constructor", "prototype"].includes(command.requestId)) throw new Error("A bounded stable requestId is required.");
    const target = await this.target(command.targetId);
    const previous = (await this.harness.snapshot(SessionDoc, target.id, context))?.commands[command.requestId];
    const fingerprint = createHash("sha256").update(canonical({ ...command, targetId: target.id })).digest("hex");
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("The requestId was already used for another command.");
      if (previous.receipt) return plain(previous.receipt) as unknown as AgentSessionReceipt;
    }
    if ((await this.harness.snapshot(SessionDoc, target.id, context))?.deleted) throw new Error("The target conversation was deleted.");
    const receipt: AgentSessionReceipt = { requestId: command.requestId, status: "accepted", conversationId: target.id };
    if (command.type !== "snapshot" && !previous) await target.commit(async tx => {
      (await tx.doc(SessionDoc, target.id)).commands[command.requestId] = { fingerprint };
    }, context);
    let saved = false;
    const save = async (tx: Tx) => {
      (await tx.doc(SessionDoc, target.id)).commands[command.requestId] = plain({ fingerprint, receipt }) as unknown as JsonObject;
      await tx.appendEntry(target.id, { kind: `workflow.command.${command.type}`, data: { requestId: command.requestId } });
      saved = true;
    };
    switch (command.type) {
      case "subagent": {
        receipt.agents = await this.manageAgents(target.id, command, command.requestId);
        receipt.taskId = receipt.agents[0]?.taskId;
        if (receipt.agents[0]?.messageDelivery?.status === "not_running") receipt.status = "settled";
        break;
      }
      case "task": {
        const task = this.options.registry?.snapshot().task(command.name);
        if (!task || /^(pi|project)\./.test(command.name)) throw new Error("The project has not registered this task.");
        await target.commit(async tx => {
          receipt.taskId = await tx.createTask(task as import("@earendil-works/pi-durable").Task<JsonValue, { phase: string }, JsonValue, object>, command.input,
            { conversationId: target.id, ownership: { kind: "conversation" }, background: command.background === true });
          await save(tx);
        }, context);
        this.harness.resume();
        break;
      }
      case "submit": {
        if (typeof command.prompt !== "string" || command.prompt.length > 100_000 || !["steer", "followUp", "reject"].includes(command.mode)) throw new Error("Invalid agent input.");
        const content = command.images?.length ? [{ type: "text" as const, text: command.prompt }, ...command.images.map(image => ({ type: "image" as const, ...image }))] : command.prompt;
        const submission = await this.submitManagedInput(target, { type: "input", content, requestId: command.requestId, whenBusy: command.mode,
          entry: { kind: "project.input", data: { requestId: command.requestId, mode: command.mode } } }, context);
        receipt.submissionId = submission.id;
        break;
      }
      case "withdraw": {
        const record = await this.harness.commit(tx => tx.submissionByRequest(target.id, command.inputId), context);
        if (!record) throw new Error("The queued input does not exist.");
        receipt.status = await this.harness.abortSubmission(record.id, context, target.id) as AgentSessionReceipt["status"];
        break;
      }
      case "promote": {
        await target.commit(async tx => {
          const record = await tx.submissionByRequest(target.id, command.inputId);
          if (!record || record.type !== "input") throw new Error("The queued input does not exist.");
          receipt.submissionId = record.id;
          if (record.status !== "queued") {
            receipt.status = record.status === "placed" ? "already_placed" : "settled";
          } else {
            const inbox = await tx.doc(InboxDoc, target.id);
            const item = inbox.items.find(item => item.id === record.id);
            if (!item || item.mode === "write") throw new Error("The queued input does not exist.");
            item.mode = "steer";
            item.entry ??= { kind: "project.input", data: { requestId: command.inputId } };
            item.entry.data = { ...object(item.entry.data) as JsonObject, mode: "steer" };
          }
          await save(tx);
        }, context);
        this.harness.resume();
        break;
      }
      case "reset": {
        const submission = await target.submit({ type: "write", requestId: command.requestId, entry: { kind: "pi.reset", head: "self",
          ...(command.handoff === undefined ? {} : { model: [{ role: "user" as const, content: command.handoff, timestamp: Date.now() }] }) } }, context);
        receipt.submissionId = submission.id;
        break;
      }
      case "compact": {
        await target.commit(async tx => {
          const id = await tx.createTask(CompactionTask, { reason: "manual" as const, ...(command.instructions ? { instructions: command.instructions } : {}) },
            { conversationId: target.id, ownership: { kind: "conversation" }, background: true });
          const live = await tx.doc(LiveDoc, target.id);
          (live.compactions ??= []).push({ taskId: id, reason: "manual", blocking: false, attempt: 1 });
          receipt.taskId = id; await save(tx);
        }, context);
        this.harness.resume();
        break;
      }
      case "fork": {
        if (!Number.isSafeInteger(command.entryId) || command.entryId < 1) throw new Error("A committed entry is required for a fork.");
        await target.commit(async tx => {
          const fork = await tx.forkConversation(target.id, command.entryId as EntryId, { ownership: { kind: "ownerless" } });
          const doc = await tx.doc(SessionDoc, fork.id); doc.title = "Fork";
          receipt.forkId = fork.id; await save(tx);
        }, context);
        await this.attach((await this.harness.conversation(receipt.forkId as ConversationId, context))!);
        break;
      }
      case "delete": {
        if (target.id === this.root.id) throw new Error("The host must delete the root session and its storage.");
        await target.abort(context, { background: true });
        await target.commit(async tx => { (await tx.doc(SessionDoc, target.id)).deleted = true; await save(tx); }, context);
        break;
      }
      case "configure": {
        const current = await this.harness.snapshot(SessionDoc, target.id, context);
        if (command.expectedVersion !== (current?.configurationVersion ?? 0)) throw new Error("The agent configuration changed. Refresh before editing.");
        if (command.effort && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(command.effort)) throw new Error("Invalid reasoning effort.");
        if (command.model && !this.models.getModel(command.model.provider, command.model.modelId)) throw new Error("Unknown agent model.");
        const record = await this.harness.commit(tx => tx.conversation(target.id), context);
        if (command.model && record?.owner) {
          const agent = await target.agent(context);
          if ((agent.model?.provider !== command.model.provider || agent.model.modelId !== command.model.modelId) && !this.allowedChildModel(command.model)) throw this.childModelError();
        }
        await target.commit(async tx => {
          await configure(tx, target.id, { ...(command.model ? { model: command.model } : {}), ...(command.effort ? { thinkingLevel: command.effort as "medium" } : {}) });
          (await tx.doc(SessionDoc, target.id)).configurationVersion++;
          await tx.appendEntry(target.id, { kind: "project.configuration", data: { version: command.expectedVersion + 1 } });
          await save(tx);
        }, context);
        break;
      }
      case "plan": {
        const items = validatePlan(command.items);
        await target.commit(async tx => {
          const doc = await tx.doc(this.planDoc, target.id);
          if (doc.version !== command.expectedVersion) throw new Error("The plan changed. Refresh before editing.");
          doc.items = items; doc.version++;
          await tx.appendEntry(target.id, { kind: "project.plan", data: { version: doc.version, count: items.length } });
          await save(tx);
        }, context);
        break;
      }
      case "cancel": {
        const current = (await this.harness.snapshot(SessionDoc, target.id, context))!.commands[command.requestId]!;
        let ids = current.taskIds as number[] | undefined, inputs = current.inputIds as number[] | undefined;
        if (!ids) {
          if (!["all", "foreground", "task"].includes(command.scope)) throw new Error("Unknown cancellation scope.");
          const frame = await this.snapshot();
          const owned = new Set([target.id as number]);
          let size = 0;
          while (size !== owned.size) {
            size = owned.size;
            for (const conversation of frame.conversations) if (conversation.parentId !== undefined && conversation.forkEntryId === undefined && owned.has(conversation.parentId)) owned.add(conversation.id);
          }
          const excluded = new Set<number>();
          if (command.scope === "foreground") {
            for (const task of frame.tasks) if (task.background) excluded.add(task.id);
            let count = -1;
            while (count !== excluded.size) { count = excluded.size; for (const task of frame.tasks) if (task.parentId !== undefined && excluded.has(task.parentId)) excluded.add(task.id); }
          }
          if (command.scope === "task") {
            const task = frame.tasks.find(task => task.id === command.taskId) ?? frame.history.find(task => task.id === command.taskId);
            if (!task || !owned.has(task.conversationId)) throw new Error("The task does not belong to the target conversation.");
            ids = [task.id]; inputs = [];
          } else {
            ids = frame.tasks.filter(task => owned.has(task.conversationId) && !excluded.has(task.id)).map(task => task.id);
            const scopes = new Set(frame.conversations.filter(conversation => owned.has(conversation.id) && (command.scope === "all" || !conversation.background)).map(conversation => conversation.id));
            inputs = [...this.submissions.values()].filter(input => scopes.has(input.conversationId) && input.status === "queued").map(input => input.id);
          }
          await target.commit(async tx => { const record = (await tx.doc(SessionDoc, target.id)).commands[command.requestId]!; record.taskIds = ids!; record.inputIds = inputs!; }, context);
        }
        for (const id of inputs ?? []) await this.harness.abortSubmission(id as import("@earendil-works/pi-durable").SubmissionId, context);
        for (const id of ids) await this.harness.abortTask(id as TaskId, context);
        for (const id of ids) await this.harness.waitForTask(id as TaskId, context);
        break;
      }
      case "snapshot": break;
      default: throw new Error("Unknown agent session command.");
    }
    if (command.type !== "snapshot" && !saved) await target.commit(save, context);
    await this.emit();
    return receipt;
  }

  async snapshot(): Promise<AgentSessionSnapshot> {
    const agents = await this.agentWorks(this.root.id);
    const workByTask = new Map(agents.map(item => [item.taskId, item]));
    // All table reads precede document creation and share the Session mutation line.
    const frame = await this.harness.commit(async tx => {
      // A final failure snapshot is read after live subscriptions have stopped.
      if (this.stopped) {
        this.tables.clear(); this.submissions.clear();
        for (const record of await scanAll(cursor => this.storage.scanSubmissions({}, 200, cursor, context))) this.submissions.set(record.id, record);
      }
      const conversations = await scanAll(cursor => tx.scanConversations({}, 100, cursor));
      const byId = new Map(conversations.map(record => [record.id, record]));
      const allowed = conversations.filter(record => {
        const seen = new Set<number>();
        let current: typeof record | undefined = record;
        while (current && !seen.has(current.id)) {
          if (current.id === this.root.id) return true;
          seen.add(current.id);
          const parent: ConversationId | undefined = current.owner?.conversationId ?? current.parent?.conversationId;
          current = parent === undefined ? undefined : byId.get(parent);
        }
        return false;
      });
      const tables = [];
      for (const record of allowed) {
        let cache = this.tables.get(record.id);
        if (!cache) {
          cache = { entries: new Map((await scanAll(cursor => tx.scanEntries({ conversationId: record.id, order: "ascending" }, 200, cursor))).map(entry => [entry.id, entry])),
            tasks: new Map((await scanAll(cursor => tx.scanTasks({ conversationId: record.id }, 200, cursor))).map(task => [task.id, task])) };
          this.tables.set(record.id, cache);
        }
        tables.push({ record, entries: [...cache.entries.values()].sort((a, b) => a.id - b.id), allTasks: [...cache.tasks.values()].sort((a, b) => a.id - b.id),
          submitted: [...this.submissions.values()].filter(submission => submission.conversationId === record.id) });
      }
      const rows = [];
      for (const table of tables) rows.push({ ...table,
        live: plain(await tx.doc(LiveDoc, table.record.id)), inbox: plain(await tx.doc(InboxDoc, table.record.id)),
        spend: plain(await tx.doc(UsageDoc, table.record.id)), info: plain(await tx.doc(SessionDoc, table.record.id)),
        agent: plain(await tx.doc(AgentDoc, table.record.id)), plan: plain(await tx.doc(this.planDoc, table.record.id)),
      });
      return { rows, agent: plain(await tx.doc(AgentDoc, this.root.id)), plan: plain(await tx.doc(this.planDoc, this.root.id)) };
    }, context);
    const inspections = new Map((await this.harness.inspect(context)).tasks.map(task => [task.record.id, task.state]));
    const tasks: AgentSessionTask[] = [], history: AgentSessionTask[] = [], turns: AgentSessionTurn[] = [], receipts: AgentSessionReceipt[] = [];
    const records: AgentSessionSnapshot["records"] = [], usage: AgentSessionSnapshot["usage"] = [], infos: AgentSessionSnapshot["conversations"] = [], contexts: AgentSessionSnapshot["contexts"] = [];
    let rootLive: unknown;
    let epoch = 0;
    const deleted = new Set(frame.rows.filter(row => row.info.deleted).map(row => row.record.id));
    let deletedCount = -1;
    while (deletedCount !== deleted.size) {
      deletedCount = deleted.size;
      for (const { record } of frame.rows) if (record.owner && deleted.has(record.owner.conversationId)) deleted.add(record.id);
    }
    const delegationChildren = new Map(frame.rows.filter(row => row.record.owner && !deleted.has(row.record.id))
      .map(row => [row.record.owner!.taskId, row.record.id]));
    for (const { record, live, inbox, spend, info, entries, submitted, allTasks, agent, plan } of frame.rows) {
      if (deleted.has(record.id)) continue;
      const conversation = (await this.harness.conversation(record.id, context))!;
      if (this.graph) await this.attach(conversation);
      if (record.id === this.root.id) { rootLive = live; epoch = entries.filter(entry => entry.kind === "pi.reset").length; }
      infos.push({ id: record.id, ...(record.owner ? { parentId: record.owner.conversationId } : record.parent ? { parentId: record.parent.conversationId, forkEntryId: record.parent.at } : {}),
        title: info?.title || (record.id === this.root.id ? "Main" : "Subagent"), background: info?.background ?? false });
      usage.push({ conversationId: record.id, ...(record.owner ? { parentId: record.owner.conversationId } : {}), models: plain(spend?.models ?? {}), tools: plain(spend?.tools ?? {}) });
      const view = await conversation.context(context);
      const contextUsage = readAgentContextUsage({
        used: estimateAgentContextTokens(durableContextMessages(view, live.generation?.message as AssistantMessage | undefined)),
        contextWindow: agent.model && this.contextWindow(agent.model.provider, agent.model.modelId),
      });
      contexts.push({ conversationId: record.id, foreground: !!live.run, backgroundCount: 0, epoch: entries.filter(entry => entry.kind === "pi.reset").length,
        configuration: { version: info.configurationVersion, provider: agent.model?.provider ?? "", model: agent.model?.modelId ?? "", effort: agent.thinkingLevel ?? "off", ...(agent.cwd ? { cwd: agent.cwd } : {}) },
        prompt: { hash: info.promptHash, version: info.promptVersion }, plan: { version: plan.version, items: plan.items as AgentPlanItem[] },
        ...(contextUsage ? { contextUsage } : {}) });
      const byId = new Map(entries.map(entry => [entry.id, entry]));
      for (const task of allTasks) {
        const slots = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])];
        const slot = slots.find(slot => slot.taskId === task.id);
        const input = object(task.input), call = input.kind === "nested" ? object(input.call)
          : byId.get(Number(input.assistant) as EntryId)?.model?.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : [])
            .find(block => block.id === input.callId);
        const tool = slot?.name ?? (typeof call?.name === "string" ? call.name : undefined);
        const model = task.state.status === "running" || task.state.status === "waiting" || task.state.status === "pending" ? task.state.checkpoint : undefined;
        const state = object(model);
        const inspected = inspections.get(task.id);
        const descriptor: AgentSessionTask = {
          id: task.id, conversationId: record.id, ...(task.owner === undefined ? {} : { parentId: task.owner }), kind: task.kind,
          ...(task.kind === "project.delegation" && delegationChildren.has(task.id) ? { childConversationId: delegationChildren.get(task.id)! } : {}),
          label: tool ?? (task.kind === "project.delegation" ? String(object(task.input).prompt ?? "Subagent").slice(0, 120) : task.kind),
          status: task.state.status === "terminal" ? task.state.outcome.status : inspected?.kind === "blocked" ? "blocked" : task.state.status,
          ...(state.phase ? { phase: String(state.phase) } : {}), background: task.background || info?.background === true,
          definitionVersion: task.version,
          ...(model === undefined || task.kind.startsWith("pi.") ? {} : { checkpoint: plain(model) }),
          ...(typeof state.wakeAt === "number" ? { wakeAt: state.wakeAt } : {}),
          ...(tool === "codemode" && typeof object(call?.arguments).code === "string" ? { script: String(object(call?.arguments).code) } : {}),
          stopping: task.state.status !== "terminal" && task.abortRequested, blockedOn: task.state.status === "waiting" ? [...task.state.on] : [],
          ...(inspected?.kind === "blocked" ? { blockedReason: inspected.reason } : {}),
          ...(tool ? { toolName: tool, callId: slot?.callId ?? String(call?.id ?? input.callId ?? ""),
            ...(call?.arguments === undefined ? {} : { arguments: plain(call.arguments) }),
            replay: state.replay === "safe" ? "safe" : this.replays.get(tool) ?? "never" } : {}),
          ...(slot && "details" in slot ? { details: plain(slot.details) } : task.state.status === "terminal" ? { details: plain(task.state.outcome) } : {}),
          ...(task.kind === "pi.generation" && typeof state.attempt === "number" ? { attempt: state.attempt } : {}),
          ...(workByTask.has(task.id) ? { agent: workByTask.get(task.id)!, status: workByTask.get(task.id)!.status,
            label: workByTask.get(task.id)!.label, attempt: workByTask.get(task.id)!.attempt } : {}),
        };
        const progress = await this.harness.snapshot(AgentWorkProgressDoc, record.id, String(task.id), context);
        if (progress?.total) descriptor.progress = { completed: progress.completed, total: progress.total, ...(progress.phase ? { phase: progress.phase } : {}) };
        (task.state.status === "terminal" ? history : tasks).push(descriptor);
      }
      for (const submission of submitted) {
        if (submission.type !== "input" || !submission.requestId) continue;
        const entry = submission.entry === undefined ? undefined : byId.get(submission.entry);
        const queued = inbox?.items.find(item => item.id === submission.id);
        const data = object(entry?.data ?? queued?.entry?.data);
        const prompt = entry?.model?.find(message => message.role === "user")?.content ?? (queued && "content" in queued ? queued.content : "");
        let mode = ["steer", "followUp", "reject", "report"].includes(String(data.mode)) ? String(data.mode) as AgentSessionTurn["mode"] : "followUp";
        if (mode === "steer" && (submission.status === "done" && !submitted.some(other => other.id < submission.id && other.type === "input" && other.status === "done" && other.answer === submission.answer)
          || submission.status === "placed" && live.run?.inputs[0] === submission.id)) mode = "followUp";
        const nextInput = entries.find(candidate => candidate.id > (submission.entry ?? Infinity) && ["project.input", "project.child-result", "pi.user"].includes(candidate.kind) && object(candidate.data).mode !== "steer");
        const end = submission.status === "done" ? submission.answer : nextInput?.id;
        const visible = submission.entry === undefined ? [] : entries.filter(candidate => candidate.id > submission.entry! && (end === undefined || candidate.id <= end));
        const partial = submission.status === "placed" ? live?.generation?.message as unknown as AssistantMessage | undefined : undefined;
        const failure = [...visible].reverse().find(entry => entry.kind === "project.failure");
        const detail = failure ? object(failure.data).message : submission.status === "unanswered" ? submission.detail : undefined;
        turns.push({ requestId: submission.requestId, conversationId: record.id, prompt: typeof prompt === "string" ? prompt : prompt.filter(block => block.type === "text").map(block => block.text).join(""), mode, status: failure ? "unanswered" : submission.status,
          epoch: entries.filter(entry => entry.kind === "pi.reset" && entry.id < (submission.entry ?? Infinity)).length,
          ...(submission.entry === undefined ? {} : { entryId: submission.entry }), ...(submission.status === "done" ? { answerId: submission.answer } : {}),
          ...(failure ? { reason: "model_error" } : submission.status === "unanswered" ? { reason: submission.reason } : {}),
          ...(typeof detail === "string" ? { detail } : {}), items: mode === "steer" ? [] : projectSessionEntries(visible, partial, submission.requestId),
          ...(mode === "steer" ? {} : { usage: projectSessionUsage(visible, submission.requestId) }) });
      }
      for (const entry of entries) if (entry.kind.startsWith("project.") || entry.kind === "pi.reset" || entry.kind === "pi.compaction") {
        records.push({ id: entry.id, conversationId: record.id, kind: entry.kind, label: entry.kind, ...(entry.data === undefined ? {} : { data: plain(entry.data) }) });
      }
      for (const command of Object.values(info.commands).slice(-200)) if (command.receipt) receipts.push(plain(command.receipt) as unknown as AgentSessionReceipt);
    }
    for (const scope of contexts) scope.backgroundCount = tasks.filter(task => task.background && task.parentId === undefined && task.conversationId === scope.conversationId).length;
    const agent = frame.agent, info = frame.rows.find(row => row.record.id === this.root.id)?.info, plan = frame.plan;
    const live = rootLive as unknown as { run?: unknown; compactionFailure?: { error: string } } | undefined;
    return { version: 1, ownerId: this.ownerId, revision: ++this.revision, conversationId: this.root.id, foreground: !!live?.run,
      backgroundCount: tasks.filter(task => task.background && task.parentId === undefined && task.conversationId === this.root.id).length, epoch,
      configuration: { version: info?.configurationVersion ?? 0, provider: agent.model?.provider ?? "", model: agent.model?.modelId ?? "", effort: agent.thinkingLevel ?? "off", ...(agent.cwd ? { cwd: agent.cwd } : {}) },
      prompt: { hash: info?.promptHash ?? "", version: info?.promptVersion ?? 0 }, plan: { version: plan?.version ?? 0, items: plain(plan?.items ?? []) as AgentPlanItem[] },
      tasks, history: [...history.filter(task => !task.kind.startsWith("pi.")), ...history.filter(task => task.kind.startsWith("pi.")).slice(-200)]
        .sort((a, b) => a.id - b.id), turns, conversations: infos, contexts, receipts, records: records.sort((a, b) => a.id - b.id).slice(-200), usage, agents,
      resources: this.resources([...new Set(frame.rows.flatMap(row => (row.agent.modelTools && !Array.isArray(row.agent.modelTools) ? row.agent.modelTools.add : row.agent.modelTools) ?? []))]),
      ...(live?.compactionFailure ? { compactionFailure: live.compactionFailure.error } : {}) };
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

async function scanAll<T>(read: (cursor: Cursor | undefined) => Promise<{ items: readonly T[]; next?: Cursor }>): Promise<T[]> {
  const items: T[] = []; let cursor: Cursor | undefined;
  do { const page = await read(cursor); items.push(...page.items); cursor = page.next; } while (cursor);
  return items;
}

function validatePlan(items: AgentPlanItem[]): AgentPlanItem[] {
  if (!Array.isArray(items) || items.length > 100 || items.some(item => typeof item?.id !== "string" || !item.id || item.id.length > 128 || typeof item.text !== "string" || item.text.length > 10_000 || !["pending", "in_progress", "completed"].includes(item.status)) || new Set(items.map(item => item.id)).size !== items.length) throw new Error("Invalid task plan.");
  return plain(items);
}

export function projectSessionUsage(entries: readonly EntryRecord[], requestId: string): TokenUsageAggregate {
  const usages = entries.flatMap(entry => entry.kind === "pi.assistant"
    ? (entry.model ?? []).flatMap(message => message.role === "assistant" ? [message.usage] : [])
    : entry.kind === "project.compaction-usage" && object(entry.data).requestId === requestId
      ? [object(entry.data).usage as unknown as Usage] : []);
  return usages.reduce<TokenUsageAggregate>((total, usage) => ({
    inputTokens: total.inputTokens + (usage.input ?? 0),
    outputTokens: total.outputTokens + (usage.output ?? 0),
    totalTokens: total.totalTokens + (usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)),
    cachedInputTokens: total.cachedInputTokens + (usage.cacheRead ?? 0),
    cacheCreationTokens: total.cacheCreationTokens + (usage.cacheWrite ?? 0),
    reasoningTokens: total.reasoningTokens + (usage.reasoning ?? 0),
    calls: total.calls + 1,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, calls: 0 });
}

/** Reuse the existing output contract: answers stay flat; reasoning and tools stay details. */
export function projectSessionEntries(entries: readonly EntryRecord[], partial: AssistantMessage | undefined, scope: string): RunOutputItemInput[] {
  const items: RunOutputItemInput[] = [];
  const calls = new Map<string, RunOutputItemInput>();
  const append = (message: AssistantMessage, id: string) => {
    const search = (message as AgentSearchMessage).projectWebSearch;
    for (const activity of search?.searches ?? []) items.push({ id: `agent-session-${scope}-${id}-search-${activity.id}`,
      title: "Web search", content: { tool: "web_search", input: activity.query ? { query: activity.query } : {},
        output: { sources: activity.sources }, status: activity.status, ...(activity.error ? { error: activity.error } : {}) },
      contentType: "json", collapsed: true, metadata: { kind: "agent-part", partType: "tool", status: activity.status } });
    for (const [index, block] of message.content.entries()) {
      const itemId = `agent-session-${scope}-${id}-${index}`;
      if (block.type === "text") items.push({ id: itemId, title: "Output", content: block.text, contentType: "markdown", collapsed: false, metadata: { kind: "agent-part", partType: "text" } });
      else if (block.type === "thinking") items.push({ id: itemId, title: "Thinking", content: { text: block.thinking }, contentType: "json", collapsed: true, metadata: { kind: "agent-part", partType: "reasoning" } });
      else if (block.type === "toolCall" && message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "pending") {
        const item: RunOutputItemInput = { id: itemId, title: block.name, content: { tool: block.name, input: block.arguments, status: "running" }, contentType: "json", collapsed: true, metadata: { kind: "agent-part", partType: "tool", status: "running" } };
        calls.set(block.id, item); items.push(item);
      }
    }
    if (search?.sources.length) items.push({ id: `agent-session-${scope}-${id}-sources`, title: "Search sources",
      content: formatAgentSearchSources(search.sources), contentType: "markdown", collapsed: false, metadata: { kind: "agent-notice", status: "success" } });
  };
  for (const entry of entries) {
    if (entry.kind === "project.retry") {
      const data = object(entry.data), attempt = Number(data.attempt), maxAttempts = Number(data.maxAttempts ?? 10);
      const retry = createAgentStreamRetryText({ attempt, maxAttempts, kind: data.kind as AgentTurnContinuationKind | undefined });
      for (const chunk of createAgentRetryChunks({ itemId: `agent-session-${scope}-${entry.id}-retry`, attempt, maxAttempts,
        reason: String(data.reason), kind: data.kind as AgentTurnContinuationKind | undefined, title: retry.title, message: retry.content })) {
        if (chunk.type === "output_item_start") items.push(chunk.item);
      }
    }
    for (const message of entry.model ?? []) {
      if (message.role === "assistant") append(message, String(entry.id));
      if (message.role === "toolResult") {
        const item = calls.get(message.toolCallId);
        if (item) { item.content = { ...object(item.content), output: { content: message.content, details: message.details }, status: message.isError ? "failed" : "success" }; item.metadata!.status = message.isError ? "failed" : "success"; }
      }
    }
  }
  if (partial) append(partial, "partial");
  return items;
}
