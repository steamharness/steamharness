import { createHash, randomUUID } from "node:crypto";
import { agentConversationDirectory } from "./storage";
import { agentSessionLease, bindAgentSessionControl } from "./session-control";
import path from "node:path";
import { BaseStreamNode } from "../node/base";
import {
  createOutputStreamAccumulator,
  createOutputItemChunk,
  type OutputItemStreamChunk,
  type WorkflowOutputItemInput,
  type WorkflowRingContent,
} from "../node/output/index";
import type { NodeContext, WorkflowUserInputRequest } from "../types/index";
import { createToolApprovalGate } from "../tool-permissions/index";
import { WorkflowError } from "../workflow/errors";
import { createAgentAskRequest, readAgentAskAnswers, readAgentQuestions } from "./ask";
import { parseAgentPermissionPolicy } from "./permission";
import {
  createAgentCompactionChunks,
  createAgentErrorChunks,
  createAgentNoticeChunks,
  createAgentOutputItemId,
  createAgentReasoningChunks,
  createAgentRetryChunks,
  createAgentTextChunks,
  createAgentToolChunks,
  createAgentPlanChunks,
  orderAgentOutputItems,
  AGENT_OUTPUT_KINDS,
  AGENT_ANSWER_ITEM_ID,
} from "./output-items";
import {
  createAgentEmptyTurnText,
  createAgentPlanApprovalHandoffText,
  createAgentPlanApprovalRequest,
  createAgentStreamRetryText,
  parseAgentMode,
  readAgentPlanDecision,
  readRuntimeLocaleSafe,
} from "./plan";
import {
  readAgentSystemCredentials,
  shouldFallbackFromSystemAI,
  startAgentSystemLLMRuntime,
} from "./system-llm";
import { createAgentRuntime, resolveAgentWorkdir, type AgentRuntimeInternalOptions } from "./runtime";
import { DEFAULT_AGENT_EFFORT, DEFAULT_AGENT_MODE } from "./types";
import type {
  AgentContextUsage,
  AgentHost,
  AgentMode,
  AgentInput,
  AgentNodeOptions,
  AgentOutputPayload,
  AgentPendingApproval,
  AgentQuestion,
  AgentRuntime,
  AgentStreamEvent,
  AgentToolSet,
} from "./types";
import type { WorkflowUserInputContext } from "../types/context";

/**
 * What a run learned about itself, keyed by that run's input object.
 *
 * `finalize` and the project's `format` are handed the input the caller
 * passed, while the node may have run with a derived one — a rewritten
 * connection, or a plan resume that switched the mode. Keying a WeakMap by the
 * caller's input keeps these reachable without putting them on the node
 * instance, where two concurrent runs would overwrite each other, or on the
 * caller's object, which this layer does not own.
 */
interface AgentRunState {
  contextUsage?: AgentContextUsage;
  mode?: AgentMode;
  /** The order this run's rows read in, by where each one finished. */
  itemOrder?: string[];
}

const runStates = new WeakMap<object, AgentRunState>();

function updateAgentRunState(input: object, patch: AgentRunState): void {
  runStates.set(input, { ...runStates.get(input), ...patch });
}

export function readAgentRunState(input: object | undefined): AgentRunState | undefined {
  return input === undefined ? undefined : runStates.get(input);
}

export function recordAgentRunContextUsage(input: object, usage: AgentContextUsage): void {
  updateAgentRunState(input, { contextUsage: usage });
}

export function readAgentRunContextUsage(input: object | undefined): AgentContextUsage | undefined {
  return readAgentRunState(input)?.contextUsage;
}

export function recordAgentRunMode(input: object, mode: AgentMode): void {
  updateAgentRunState(input, { mode });
}

export function recordAgentRunItemOrder(input: object, order: string[]): void {
  updateAgentRunState(input, { itemOrder: order });
}

export function readAgentRunItemOrder(input: object | undefined): string[] | undefined {
  return readAgentRunState(input)?.itemOrder;
}

export function readAgentRunMode(input: object | undefined): AgentMode | undefined {
  return readAgentRunState(input)?.mode;
}

/**
 * The plan a paused turn is waiting on.
 *
 * Kept in the conversation so the run that resumes the approval still has the
 * plan text: the resumed run starts from the user's original message, and a
 * compaction or a long session may already have pushed the plan out of the
 * transcript.
 */
const PENDING_PLAN_STATE_KEY = "agent.pendingPlanApproval";

interface PendingPlanState {
  runId?: string;
  requestId: string;
  plan: string;
  /**
   * The approval the user is answering.
   *
   * Kept with the plan so the turn that resumes can hand it back while reading
   * the answer: it is what gives the recorded answer its labels, and a host
   * that shows the user what they chose has nothing but the request's own
   * wording to show.
   */
  request?: WorkflowUserInputRequest;
}

const PENDING_ASK_STATE_KEY = "agent.pendingAskUser";

interface PendingAskState {
  runId?: string;
  requestId: string;
  questions: AgentQuestion[];
  /** The form the user answered, so the answer keeps its labels. */
  request?: WorkflowUserInputRequest;
}

async function readPendingAskState(context: NodeContext): Promise<PendingAskState | undefined> {
  const state = await context.conversation?.getValue();
  const value = state?.values?.[PENDING_ASK_STATE_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as PendingAskState;
  if (typeof context.metadata?.["runId"] === "string" && record.runId !== context.metadata["runId"]) return;
  if (typeof record.requestId !== "string") {
    return undefined;
  }

  const questions = readAgentQuestions({ questions: record.questions });
  if (questions.length === 0) {
    return undefined;
  }

  const request = readPendingPlanRequest(record.request);
  return {
    requestId: record.requestId,
    questions,
    ...(request === undefined ? {} : { request }),
  };
}

async function readPendingPlanState(context: NodeContext): Promise<PendingPlanState | undefined> {
  const state = await context.conversation?.getValue();
  const value = state?.values?.[PENDING_PLAN_STATE_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as PendingPlanState;
  if (typeof context.metadata?.["runId"] === "string" && record.runId !== context.metadata["runId"]) return;
  if (typeof record.requestId !== "string" || typeof record.plan !== "string") {
    return undefined;
  }

  const request = readPendingPlanRequest(record.request);
  return {
    requestId: record.requestId,
    plan: record.plan,
    ...(request === undefined ? {} : { request }),
  };
}

function readPendingPlanRequest(value: unknown): WorkflowUserInputRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as { requestId?: unknown; nodeName?: unknown; title?: unknown; params?: unknown };
  return typeof record.requestId === "string" &&
    typeof record.nodeName === "string" &&
    typeof record.title === "string" &&
    Array.isArray(record.params)
    ? value as WorkflowUserInputRequest
    : undefined;
}

/**
 * Runs an agent as a workflow node.
 *
 * Everything workflow-shaped lives here — approval pauses, output items, token
 * usage — so the runtime above stays a plain programmatic agent and a project
 * only has to declare *what* it wants, never *how* a run is driven.
 */
export function createAgentNode(
  options: AgentNodeOptions = {},
): BaseStreamNode<AgentInput, OutputItemStreamChunk, AgentOutputPayload> {
  return new AgentStreamNode(options);
}

class AgentStreamNode extends BaseStreamNode<AgentInput, OutputItemStreamChunk, AgentOutputPayload> {
  private readonly options: AgentNodeOptions;

  constructor(options: AgentNodeOptions) {
    super({
      name: options.name ?? "agent",
      standardName: "agent",
      historyLimit: options.historyLimit,
    });
    this.options = options;
  }

  protected async *createStream(
    input: AgentInput,
    context: NodeContext,
  ): AsyncIterable<OutputItemStreamChunk> {
    // Resolve the connection before creating the runtime: a project whose
    // provider and model come from the host's catalogue names a credential,
    // not a provider the SDK knows, so building the runtime from the raw input
    // would fail on an "unknown model" before the bridge is ever considered.
    const system = await resolveAgentSystemAIInput({ ...input,
      requestId: input.requestId ?? `${String(context.metadata?.["runId"] ?? randomUUID())}:${this.name}`,
    }, this.options, context.abortSignal);
    const planResume = await resolvePlanResume(context, system.input);
    // A run parks on one thing at a time: a plan awaiting approval, or a
    // question awaiting an answer.
    const askResume = planResume === undefined
      ? await resolveAskResume(context, system.input)
      : undefined;
    const runInput: AgentInput = planResume ?? askResume ?? system.input;
    if (planResume?.planResume !== undefined) runInput.requestId = `${system.input.requestId}:plan:${planResume.planResume.requestId}`;
    let runtime: AgentRuntime;
    try { runtime = await this.resolveRuntime(runInput, context); }
    catch (error) { await system.close(); throw error; }
    let toolSet: AgentToolSet | undefined;
    let unbind: (() => void) | undefined;
    try {
      if (this.options.createTools !== undefined) {
        const created = await this.options.createTools(context);
        toolSet = Array.isArray(created) ? { tools: created } : created;
        runtime.setExternalTools(toolSet.tools, toolSet.catalogs);
      }
      unbind = this.options.session && context.conversation?.conversationId && runtime.control
        ? bindAgentSessionControl(context.conversation.conversationId, command => runtime.control!(command)) : undefined;
    } catch (error) {
      try { await runtime.close(); }
      finally { await closeIgnoringFailure(() => system.close()); await closeIgnoringFailure(toolSet?.close); }
      throw error;
    }
    const host = createNodeAgentHost(context, this.name, runInput);

    const mode = parseAgentMode(runInput.agent ?? this.options.mode ?? DEFAULT_AGENT_MODE);
    // A plan resume switches this run to build, which the caller's input does
    // not say, so the effective mode is recorded for the payload to read back.
    recordAgentRunMode(input, mode);
    // Planning is where a run confirms what it is about to do, so it is the
    // only mode that stops a tool call to ask the user. A build turn executes
    // the plan it was handed, and a tool that would have asked runs instead.
    if (context.toolPermissions !== undefined) {
      context.toolPermissions.requiresUserApproval = mode === "plan";
    }
    // The declared id wins over the derived one: a host that reads the answer
    // out of the report by id — every OpenAI/Responses adapter does — can only
    // find it under the id the project published.
    const answerId = this.options.outputItemId ?? createAgentOutputItemId(answerSummaryId(context));
    // Resuming the same run appends output, so earlier rows must keep their IDs.
    const outputScopeId = `${answerSummaryId(context)}:${runInput.requestId}`;
    const planId = createAgentOutputItemId(`plan-${outputScopeId}`);
    // A host-driven run streams its text into that one item, because the item
    // *is* the response text the host reads back. A conversation writes each
    // run of text between two activity rows as its own row instead: the text
    // belongs where it was spoken, and one item carrying the whole turn could
    // only ever sit in one place. The rows' text is the same text, so both
    // modes produce the same words.
    const hostDriven = input.hostInput !== undefined;
    // Conversation text is buffered until the runtime distinguishes the final
    // plan from introductions and questions. Host-driven runs need their text
    // streamed into the declared answer item regardless of the mode.
    let planText = "";
    let planWritten = false;
    // Reasoning arrives as bare deltas interleaved with the answer. Each block
    // opens its own row on the first delta and streams into it, the way the
    // answer does: a high-effort model can think for minutes, and buffering the
    // block until the next text or tool call left a host with nothing at all to
    // show for it — the row appeared only once the thinking was over.
    let reasoningText = "";
    let reasoningItemId: string | undefined;
    let reasoningStartedAt = 0;
    let reasoningIndex = 0;
    let textOpen = false;
    let textIndex = 0;
    // Whether this turn put anything at all in front of the host. A turn that
    // did not has to say so, or a host waiting for output waits forever. A
    // failed turn is the exception: it is explained by its error row.
    let produced = false;
    let failed = false;
    const toolInputs = new Map<string, unknown>();

    // The row the current run of text is written into. Host-driven runs keep
    // one id for the whole turn; a conversation gets a new one each time an
    // activity row interrupts the text.
    const textItemId = (): string => hostDriven
      ? answerId
      : createAgentOutputItemId(`text-${outputScopeId}-${textIndex}`);

    // Ends the current row, so the next text — and the activity row that
    // interrupted it — takes its own place in the transcript.
    const closeText = function* (): Generator<OutputItemStreamChunk> {
      if (!textOpen || hostDriven) return;
      textOpen = false;
      yield* createAgentTextChunks({
        itemId: textItemId(),
        delta: "",
        started: true,
        completed: true,
        part: true,
      });
      textIndex += 1;
    };

    const flushPlanText = function* (): Generator<OutputItemStreamChunk> {
      if (planText === "") return;
      yield* createAgentTextChunks({
        itemId: textItemId(),
        delta: planText,
        started: textOpen,
        completed: false,
        part: !hostDriven,
      });
      textOpen = true;
      planText = "";
    };

    const flushReasoning = function* (): Generator<OutputItemStreamChunk> {
      if (reasoningItemId === undefined) return;
      // Thinking that interrupted the text ends its row: what the model says
      // next was written after the thought, not before it.
      yield* closeText();
      produced = true;
      const itemId = reasoningItemId;
      reasoningItemId = undefined;
      yield* createAgentReasoningChunks({
        itemId,
        text: reasoningText,
        status: "success",
        startedAt: reasoningStartedAt,
        endedAt: Date.now(),
        started: true,
      });
      reasoningText = "";
    };

    let compacting = false;
    try {
      for await (const event of runtime.run(runInput, host)) {
        switch (event.type) {
          case "session": {
            const snapshot = { ...event.snapshot, contexts: event.snapshot.contexts.map(scope => ({ ...scope,
              outputs: scope.contextUsage ? [createContextUsageItem(scope.contextUsage, readSessionKey(this.options, context))] : [],
            })) };
            yield createOutputItemChunk({ type: "output_item_start", item: { id: "agent-session", title: "Agent session", content: snapshot,
              contentType: "json", collapsed: true, metadata: { kind: "agent-session" } } });
            yield createOutputItemChunk({ type: "output_item_end", itemId: "agent-session" });
            break;
          }
          case "thinking_delta": {
            if (event.delta === "") break;
            // The row opens on the first delta, so the host sees the model
            // thinking from the moment it starts rather than after the fact.
            reasoningText += event.delta;
            const opening = reasoningItemId === undefined;
            let itemId = reasoningItemId;
            if (itemId === undefined) {
              yield* closeText();
              itemId = createAgentOutputItemId(`reasoning-${outputScopeId}-${reasoningIndex}`);
              reasoningItemId = itemId;
              reasoningIndex += 1;
              reasoningStartedAt = Date.now();
              produced = true;
            }
            yield* createAgentReasoningChunks({
              itemId,
              text: reasoningText,
              status: "running",
              startedAt: reasoningStartedAt,
              ...(opening ? {} : { started: true }),
            });
            break;
          }

          case "text_delta": {
            yield* flushReasoning();
            if (mode === "plan" && !hostDriven) {
              if (event.delta !== "") produced = true;
              planText += event.delta;
              break;
            }
            if (event.delta !== "") produced = true;

            const chunks = createAgentTextChunks({
              itemId: textItemId(),
              delta: event.delta,
              started: textOpen,
              completed: false,
              part: !hostDriven,
            });
            textOpen = textOpen || chunks.length > 0;
            yield* chunks;
            break;
          }

          case "tool": {
            yield* flushPlanText();
            yield* closeText();
            yield* flushReasoning();
            produced = true;
            const itemId = event.toolCallId === ""
              ? createAgentOutputItemId(`tool-${outputScopeId}-${event.toolName}`)
              : createAgentOutputItemId(event.toolCallId);
            if (event.args !== undefined) toolInputs.set(itemId, event.args);
            const toolInput = event.args ?? toolInputs.get(itemId);
            if (event.phase === "end") toolInputs.delete(itemId);
            yield* createAgentToolChunks({
              itemId,
              toolName: event.toolName,
              status: event.phase === "end" ? (event.isError === true ? "failed" : "success") : "running",
              input: toolInput,
              ...(event.phase === "end" ? { output: event.result, error: event.isError === true ? event.result : undefined } : {}),
              started: event.phase === "update",
            });
            break;
          }

          case "plan": {
            if (event.phase !== "end" || planWritten || hostDriven) {
              break;
            }
            planWritten = true;
            produced = true;
            yield* closeText();
            yield* createAgentPlanChunks({ itemId: planId, delta: event.text, completed: true });
            planText = "";
            break;
          }

          case "compaction": {
            produced = true;
            const started = compacting;
            compacting = event.phase === "start";
            yield* closeText();
            yield* createAgentCompactionChunks({
              itemId: createAgentOutputItemId(`compaction-${outputScopeId}`),
              status: event.phase === "start" ? "running" : "success",
              auto: event.auto,
              ...(event.summary === undefined ? {} : { summary: event.summary }),
              started: event.phase === "end" && started,
            });
            break;
          }

          case "retry": {
            produced = true;
            yield* closeText();
            const retry = createAgentStreamRetryText({
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              kind: event.kind,
            });
            yield* createAgentRetryChunks({
              itemId: createAgentOutputItemId(`retry-${outputScopeId}-${event.attempt}`),
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              reason: event.reason,
              title: retry.title,
              message: retry.content,
            });
            break;
          }

          case "approval": {
            produced = true;
            yield* closeText();
            const handoff = createAgentPlanApprovalHandoffText();
            yield* createAgentNoticeChunks({
              id: `approval-${outputScopeId}`,
              title: event.approved ? handoff.title : "Plan declined",
              content: event.approved ? handoff.content : "The plan was declined and stays in the session.",
            });
            break;
          }

          case "context_usage": {
            recordAgentRunContextUsage(input, event.usage);
            const item = createContextUsageItem(event.usage, readSessionKey(this.options, context));
            yield createOutputItemChunk({
              type: "output_item_start",
              item,
            });
            yield createOutputItemChunk({ type: "output_item_end", itemId: item.id! });
            break;
          }

          default:
            break;
        }
      }
    } catch (error) {
      if (compacting && !isAbortedRun(error)) {
        yield* createAgentCompactionChunks({ itemId: createAgentOutputItemId(`compaction-${outputScopeId}`),
          status: "failed", auto: false, started: true });
      }
      // A pause and an abort are outcomes rather than failures: the run ends
      // the way the caller asked it to, with no error row to explain.
      if (isAgentPause(error) || isAbortedRun(error)) {
        throw error;
      }
      failed = true;
      yield* createAgentErrorChunks({
        id: outputScopeId,
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? { name: error.name, message: error.message } : undefined,
      });
      throw error;
    } finally {
      unbind?.();
      try { await runtime.close(); }
      // Releasing a resource must not decide the run's outcome. A pause is
      // travelling out of here as a throw, and a child process that fails to
      // exit would replace it — turning an approval into a run error, and
      // skipping the rows below on the way out.
      finally {
        await closeIgnoringFailure(() => system.close());
        await closeIgnoringFailure(toolSet?.close);
      }
      yield* flushReasoning();
      // A question, failure or cancellation can end before a plan exists.
      // Keep its text visible without claiming it is an approvable plan.
      yield* flushPlanText();
      if (textOpen) {
        yield* createAgentTextChunks({
          itemId: textItemId(),
          delta: "",
          started: true,
          completed: true,
          part: !hostDriven,
        });
      }
      // Nothing was produced at all: the model answered with an empty turn
      // (a failed one has already thrown). Saying so is the difference between
      // a turn the host can close and one it waits on forever.
      if (!produced && !failed) {
        const notice = createAgentEmptyTurnText();
        yield* createAgentNoticeChunks({
          id: `empty-${outputScopeId}`,
          title: notice.title,
          content: notice.content,
        });
      }
    }
  }

  finalize(
    chunks: OutputItemStreamChunk[],
    _context: NodeContext,
    input?: AgentInput,
  ): AgentOutputPayload {
    const accumulator = createOutputStreamAccumulator(chunks);
    const tools = chunks.filter((chunk) => chunk.type === "output_item_start" && isToolItem(chunk.item));
    const contextUsage = readAgentRunContextUsage(input);

    // Reported from the run's own input, not from the runtime options: a run
    // may name its own working directory, effort and connection, and the host
    // renders what this turn actually used.
    const provider = input?.provider ?? this.options.provider;
    const model = input?.model ?? this.options.model;
    const sessionId = this.options.sessionId;
    const workdir = input === undefined ? this.options.workdir ?? "" : resolveAgentWorkdir(input, this.options);

    return {
      ...(contextUsage === undefined ? {} : { contextUsage }),
      errCode: 0,
      errMessage: "",
      items: orderAgentOutputItems(accumulator.items, chunks) as typeof accumulator.items,
      prompt: typeof input?.prompt === "string" ? input.prompt : "",
      workdir,
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      effort: input?.effort ?? this.options.effort ?? DEFAULT_AGENT_EFFORT,
      // A plan resume switches the run to build, which the caller's input does
      // not say; the mode recorded for this input is what actually ran.
      agent: readAgentRunMode(input) ?? input?.agent ?? this.options.mode ?? DEFAULT_AGENT_MODE,
      ...(sessionId === undefined ? {} : { sessionId }),
      toolCallCount: tools.length,
    };
  }

  private resolveRuntime(input: AgentInput, context: NodeContext): Promise<AgentRuntime> {
    const key = readSessionKey(this.options, context);
    const directory = typeof context.metadata?.["agentStoreDir"] === "string"
      ? context.metadata["agentStoreDir"] : path.join(input.workdir ?? this.options.workdir ?? process.cwd(), ".workflow", "agents");
    const sessionDirectory = agentConversationDirectory(directory, context.conversation?.conversationId ?? "ephemeral");
    const identity = JSON.stringify([context.metadata?.["workflow"], key]);
    const runtimeOptions: AgentRuntimeInternalOptions = {
      ...this.options,
      session: input.hostInput === undefined ? this.options.session : undefined,
      sessionLease: context.conversation?.conversationId && (input.agent ?? this.options.mode) !== "plan" ? agentSessionLease(context.conversation.conversationId) : undefined,
      databasePath: this.options.databasePath ?? (!this.options.storage && context.conversation?.enabled && input.hostInput === undefined
        ? path.join(sessionDirectory, `${createHash("sha256").update(identity).digest("hex")}.sqlite`) : undefined),
      workdir: input.workdir ?? this.options.workdir,
      provider: input.provider ?? this.options.provider,
      model: input.model ?? this.options.model,
      baseUrl: input.baseUrl ?? this.options.baseUrl,
      apiKey: input.apiKey ?? this.options.apiKey,
      apiKind: input.apiKind ?? this.options.apiKind,
      // The run's own attributes are resolved before this (system AI attaches
      // the catalogue's record), so a runtime built for this turn starts on
      // the right model rather than being rebuilt on the first `applyConnection`.
      modelAttributes: input.modelAttributes ?? this.options.modelAttributes,
      sessionId: key,
      permissionPolicy: parseAgentPermissionPolicy(input.permissionPolicy ?? this.options.permissionPolicy),
    };

    return createAgentRuntime({
      ...runtimeOptions,
      // The runtime offers the asking tool only while planning, and only when
      // this hook is present: without a host that can park a run there is
      // nothing to ask with.
      askUser: (request) => requestAgentAskAnswers(context, request),
    });
  }
}

/**
 * Points a run at the host's system AI when there is one.
 *
 * The SteamHarness Server hands out a loopback bridge rather than the upstream key,
 * and that bridge only lives for one run, so it is started here and closed by
 * the caller's `finally`.
 *
 * Two situations deliberately skip it: a caller that supplied its own endpoint,
 * and one that supplied its own model or provider collection. The second is how
 * a test, an embedding host, or a self-hosted setup says "I already decided
 * where this runs" — probing the host there would make offline runs reach the
 * network.
 */
export async function resolveAgentSystemAIInput(
  input: AgentInput,
  options: AgentNodeOptions,
  signal: AbortSignal | undefined,
): Promise<{ input: AgentInput; close: () => Promise<void> }> {
  const passthrough = { input, close: async () => undefined };
  if (
    input.baseUrl !== undefined ||
    input.apiKey !== undefined ||
    options.baseUrl !== undefined ||
    options.apiKey !== undefined ||
    options.models !== undefined ||
    options.resolvedModel !== undefined
  ) {
    return passthrough;
  }

  let credentials;
  try {
    credentials = await readAgentSystemCredentials(signal);
  } catch (error) {
    // An unconfigured host (or an older runtime without this capability) keeps
    // the runtime's own provider resolution. A configured service that cannot
    // be reached must stay an explicit error: silently falling through would
    // turn an internal AI outage into an unrelated provider/model failure.
    if (shouldFallbackFromSystemAI(error)) return passthrough;
    throw error;
  }

  if (credentials.length === 0) {
    return passthrough;
  }

  // The host has system AI, so this run belongs on it. A failure from here on
  // is a real one: swallowing it would send the run to the built-in catalogue
  // instead, where a host credential id and model can never resolve and the
  // caller sees a misleading "unknown model" error.
  const runtime = await startAgentSystemLLMRuntime({
    provider: input.provider ?? options.provider,
    model: input.model ?? options.model,
    credentials,
    signal,
  });

  return {
    input: {
      ...input,
      provider: runtime.providerId,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      apiKind: runtime.protocol === "anthropic" ? "anthropic-messages" : "openai-responses",
      // The catalogue fills this in for the model it resolved. A caller that
      // named its own attributes keeps them: it decided on purpose, and the
      // catalogue is only ever a better-informed default.
      ...(input.modelAttributes === undefined && runtime.modelAttributes !== undefined
        ? { modelAttributes: runtime.modelAttributes }
        : {}),
    },
    close: () => runtime.close(),
  };
}

/**
 * Binds the runtime's host hooks to the workflow context.
 *
 * A tool denial is turned into a plain rejection so the runtime reports it to
 * the model as a failed tool call; a pause throws `user_input_required`, which
 * the workflow runtime understands and parks the run on.
 */
export function createNodeAgentHost(
  context: NodeContext,
  nodeName: string,
  input: AgentInput,
): AgentHost {
  const gate = createToolApprovalGate();

  return {
    async approveToolCall(request) {
      // The built-in tools are declared auto-approved, so this only asks when a
      // host has explicitly marked one as needing approval — and refuses
      // outright when the host disabled it.
      await gate.approve({
        name: request.toolName,
        label: request.label,
        description: request.description,
        arguments: request.arguments,
        callId: request.callId,
      }, context);
    },

    async approvePlan(request) {
      const userInput = context.userInput;
      if (userInput === undefined) {
        return { approved: true, requestId: request.requestId };
      }

      const approval = await requestAgentPlanApproval(userInput, {
        requestId: request.requestId,
        plan: request.plan,
        context,
      });

      return approval;
    },

    async reportUsage(usage) {
      await context.tokenUsage.report({
        recordId: usage.recordId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheWriteTokens,
        nodeName,
        providerName: "pi",
      });
    },

    ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
  };
}

/**
 * Puts the model's own question to the user and parks the run.
 *
 * The questions are persisted before the pause, because the wording is the
 * model's and the turn that resumes has to read the answers back against it.
 * Like every other pause it leaves through `user_input_required`, which the
 * workflow runtime turns into the run's waiting state.
 */
async function requestAgentAskAnswers(
  context: NodeContext,
  request: { requestId: string; questions: AgentQuestion[] },
): Promise<never> {
  const userInput = context.userInput;
  const ask = createAgentAskRequest({ requestId: request.requestId, questions: request.questions });

  await context.conversation?.setValue(PENDING_ASK_STATE_KEY, {
    runId: typeof context.metadata?.["runId"] === "string" ? context.metadata["runId"] : undefined,
    requestId: request.requestId,
    questions: request.questions,
    request: ask,
  } satisfies PendingAskState);

  if (userInput === undefined) {
    throw new WorkflowError({
      type: "user_input_required",
      message: "The agent asked the user a question, but this run cannot pause for an answer.",
      nodeName: ask.nodeName,
      metadata: { request: ask },
    });
  }

  await userInput.requestInput(ask);
  throw new WorkflowError({
    type: "user_input_required",
    message: "The agent is waiting for the user's answers.",
    nodeName: ask.nodeName,
    metadata: { request: ask },
  });
}

/**
 * Turns an answered question into the plan turn that carries on.
 *
 * The run comes back in plan mode with the answers as its prompt: the paused
 * turn ended in a tool call that never returned, so words are the only way the
 * answers can reach the model, and they travel with the request that asked for
 * them so the plan continues where it stopped.
 */
async function resolveAskResume(
  context: NodeContext,
  input: AgentInput,
): Promise<AgentInput | undefined> {
  const pending = await readPendingAskState(context);
  if (pending === undefined) {
    return undefined;
  }

  const resolved = await context.userInput?.getResolvedInput(pending.requestId, pending.request);
  if (resolved === undefined) {
    return undefined;
  }

  return {
    ...input,
    agent: "plan",
    askResume: {
      requestId: pending.requestId,
      questions: pending.questions,
      answers: readAgentAskAnswers(resolved, pending.questions),
    },
  };
}

async function requestAgentPlanApproval(
  userInput: WorkflowUserInputContext,
  options: { requestId: string; plan: string; context: NodeContext },
) {
  const request = createAgentPlanApprovalRequest({ requestId: options.requestId, plan: options.plan });
  const resolved = await userInput.getResolvedInput(options.requestId, request);
  if (resolved !== undefined) {
    return readAgentPlanDecision(resolved);
  }

  // Persisted before the pause, so the run that resumes still has the plan.
  await options.context.conversation?.setValue(PENDING_PLAN_STATE_KEY, {
    runId: typeof options.context.metadata?.["runId"] === "string" ? options.context.metadata["runId"] : undefined,
    requestId: options.requestId,
    plan: options.plan,
    request,
  } satisfies PendingPlanState);

  await userInput.requestInput(request);
  throw new WorkflowError({
    type: "user_input_required",
    message: "The agent is waiting for plan approval.",
    nodeName: request.nodeName,
    metadata: { request },
  });
}

/**
 * Turns an already-answered plan approval into the build turn that runs it.
 *
 * Without this the resumed run would plan all over again and then stop: the
 * user approves, and nothing executes. The plan comes back from the
 * conversation because the resumed run starts from the original message.
 */
async function resolvePlanResume(
  context: NodeContext,
  input: AgentInput,
): Promise<AgentInput | undefined> {
  const pending = await readPendingPlanState(context);
  if (pending === undefined) {
    return undefined;
  }

  // The request travels back to the user-input context so the answer it
  // records carries the questions it answered.
  const resolved = await context.userInput?.getResolvedInput(pending.requestId, pending.request);
  if (resolved === undefined) {
    return undefined;
  }

  const decision = readAgentPlanDecision(resolved);
  return {
    ...input,
    prompt: pending.plan,
    agent: decision.approved ? "build" : "plan",
    planResume: decision,
  };
}

function createContextUsageItem(usage: AgentContextUsage, sessionKey: string): WorkflowOutputItemInput {
  const contextId = /^[A-Za-z0-9_.:-]*$/.test(sessionKey) ? `context-${sessionKey}`
    : `context:${Buffer.from(sessionKey, "utf16le").toString("base64url")}`;
  return {
    id: createAgentOutputItemId(contextId),
    title: readRuntimeLocaleSafe() === "en" ? "Context window" : "上下文窗口",
    content: { value: usage.used, total: usage.total, unit: "tokens" } satisfies WorkflowRingContent,
    contentType: "json", display: { type: "ring", placement: "composer-right" },
  };
}

function readSessionKey(options: AgentNodeOptions, context: NodeContext): string {
  void context;
  return options.sessionKey ?? options.sessionId ?? "agent";
}

function answerSummaryId(context: NodeContext): string {
  const conversation = context as unknown as { conversation?: { conversationId?: unknown } };
  const id = conversation.conversation?.conversationId;
  return typeof id === "string" && id !== "" ? id : AGENT_ANSWER_ITEM_ID;
}

function isToolItem(item: WorkflowOutputItemInput): boolean {
  return item.metadata?.["kind"] === AGENT_OUTPUT_KINDS.part && item.metadata["partType"] === "tool";
}

/**
 * Runs a cleanup step without letting it fail the run.
 *
 * A resource that will not release is worth knowing about, but it is not the
 * run's result: the caller is about to see whatever the run produced,
 * including a pause the user still has to answer.
 */
async function closeIgnoringFailure(close: (() => Promise<void>) | undefined): Promise<void> {
  try {
    await close?.();
  } catch {
    // Nothing to do with it here, and nowhere to say it without becoming the
    // outcome this exists to protect.
  }
}

function isAgentPause(error: unknown): boolean {
  return error instanceof WorkflowError && error.type === "user_input_required";
}

function isAbortedRun(error: unknown): boolean {
  return error instanceof WorkflowError && error.type === "execution_aborted";
}

export type { AgentPendingApproval, AgentContextUsage };
