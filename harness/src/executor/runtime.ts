import type {
  NodeExecutionHooks,
  WorkflowUserInputRequest,
  WorkflowUserInputResolved,
} from "../types/index";
import {
  createWorkflowTimerContext,
  type WorkflowTimerContext,
} from "../timer/index";
import {
  createWorkflowFailure,
  WorkflowError,
  type WorkflowResult,
} from "../workflow/index";
import {
  combineNodeExecutionHooks,
  createNodeExecutionReporter,
  createWorkflowExecutionReport,
  resolveWorkflowResultStatus,
  type WorkflowOutputReport,
  type WorkflowExecutionReport,
  type WorkflowRuntimeEvent,
  type WorkflowRunStatus,
  type WorkflowExecutionReportTokenUsage,
} from "./report";
import type { WorkflowNodeRegistryItem } from "./types";
import type { WorkflowDefinedNode } from "./rules";

export interface WorkflowRuntimeLayer {
  name?: string;
  onBeforeRun?(runtime: WorkflowRuntime): Promise<void> | void;
  onRuntimeEvent?(
    event: WorkflowRuntimeEvent,
    runtime: WorkflowRuntime,
  ): Promise<void> | void;
  createNodeHooks?(runtime: WorkflowRuntime): NodeExecutionHooks | undefined;
  onAfterRun?(
    report: WorkflowExecutionReport<unknown>,
    runtime: WorkflowRuntime,
  ): Promise<void> | void;
}

export interface WorkflowRuntimeOptions {
  workflowName: string;
  runId?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  nodeHooks?: NodeExecutionHooks;
  onRuntimeEvent?(event: WorkflowRuntimeEvent): Promise<void> | void;
  layers?: WorkflowRuntimeLayer[];
}

export interface WorkflowRuntimeFinishOptions<Output> {
  definedNodes?: WorkflowDefinedNode[];
  registry?: WorkflowNodeRegistryItem[];
  entrypointId?: string;
  entrypointTitle?: string;
  conversationId?: string;
  tokenUsage?: WorkflowExecutionReportTokenUsage;
  result: WorkflowResult<Output>;
}

export interface ExecutionLimitLayerOptions {
  maxNodeExecutions?: number;
}

export interface RuntimePersistenceLayerOptions {
  name?: string;
  onEvent?(event: WorkflowRuntimeEvent): Promise<void> | void;
  onReport?(report: WorkflowExecutionReport<unknown>): Promise<void> | void;
}

export class WorkflowRuntime {
  readonly runId: string;
  readonly workflowName: string;
  readonly startedAt: Date;
  readonly abortController: AbortController;
  readonly timers: WorkflowTimerContext;

  private readonly reporter;
  private readonly timeout?: ReturnType<typeof setTimeout>;
  private readonly layers: WorkflowRuntimeLayer[];
  private readonly nodeHooks?: NodeExecutionHooks;
  private readonly onRuntimeEvent?: (event: WorkflowRuntimeEvent) => Promise<void> | void;
  private endedAt?: Date;
  private prepared = false;
  private started = false;
  private status: WorkflowRunStatus = "running";

  constructor(options: WorkflowRuntimeOptions) {
    this.runId = options.runId ?? createWorkflowRunId();
    this.workflowName = options.workflowName;
    this.startedAt = new Date();
    this.abortController = createWorkflowAbortController(options.abortSignal);
    this.layers = options.layers ?? [];
    this.onRuntimeEvent = options.onRuntimeEvent;
    this.reporter = createNodeExecutionReporter({
      runId: this.runId,
      workflowName: this.workflowName,
      onRuntimeEvent: (event) => this.emitRuntimeEvent(event),
    });
    this.timers = createWorkflowTimerContext({
      onTimerStart: (event) =>
        this.reporter.emitTimerStarted({
          runId: this.runId,
          workflowName: this.workflowName,
          timer: event.timer,
        }),
      onTimerFinish: (event) =>
        this.reporter.emitTimerFinished({
          runId: this.runId,
          workflowName: this.workflowName,
          timer: event.timer,
        }),
    });
    this.timeout = createWorkflowTimeout(options.timeoutMs, this.abortController);
    this.nodeHooks = combineNodeExecutionHooks(
      this.reporter.hooks,
      ...this.layers.map((layer) => layer.createNodeHooks?.(this)),
      options.nodeHooks,
    );
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  get currentStatus(): WorkflowRunStatus {
    return this.status;
  }

  get runtimeNodeHooks(): NodeExecutionHooks | undefined {
    return this.nodeHooks;
  }

  get conversationTitle(): string | undefined {
    return this.reporter.getConversationTitle();
  }

  abort(reason?: unknown): void {
    if (!this.abortSignal.aborted) {
      this.abortController.abort(reason);
    }
  }

  throwIfAborted(): void {
    throwIfAborted(this.abortSignal, this.workflowName);
  }

  async prepare(): Promise<void> {
    if (this.prepared) return;
    this.prepared = true;
    for (const layer of this.layers) {
      await layer.onBeforeRun?.(this);
    }
  }

  async start(entrypoint?: { id?: string; title?: string }): Promise<void> {
    await this.prepare();
    if (this.started) return;
    this.started = true;

    await this.reporter.emitWorkflowStarted({
      runId: this.runId,
      workflowName: this.workflowName,
      entrypointId: entrypoint?.id,
      entrypointTitle: entrypoint?.title,
      startedAt: this.startedAt,
    });
  }

  async emitConversationTitleUpdated(event: {
    conversationId: string;
    title?: string;
    updatedAt: Date;
  }): Promise<void> {
    await this.reporter.emitConversationTitleUpdated({
      runId: this.runId,
      workflowName: this.workflowName,
      conversationId: event.conversationId,
      title: event.title,
      updatedAt: event.updatedAt,
    });
  }

  async emitTokenUsageUpdated(event: {
    conversationId?: string;
    usage: WorkflowExecutionReportTokenUsage["run"];
    updatedAt: Date;
  }): Promise<void> {
    await this.reporter.emitTokenUsageUpdated({
      runId: this.runId,
      workflowName: this.workflowName,
      conversationId: event.conversationId,
      usage: event.usage,
      updatedAt: event.updatedAt,
    });
  }

  async emitUserInputRequested(event: WorkflowUserInputRequest): Promise<void> {
    await this.reporter.emitUserInputRequested(event);
  }

  async emitUserInputResolved(event: WorkflowUserInputResolved): Promise<void> {
    await this.reporter.emitUserInputResolved(event);
  }

  async finish<Output>(
    options: WorkflowRuntimeFinishOptions<Output>,
  ): Promise<WorkflowExecutionReport<Output>> {
    clearWorkflowTimeout(this.timeout);
    this.endedAt = new Date();
    const outputs = this.reporter.getOutputs();
    const pendingUserInput = this.reporter.getPendingUserInput();
    const resolvedUserInputs = this.reporter.getResolvedUserInputs();
    this.status = pendingUserInput === undefined
      ? resolveWorkflowRunStatus(options.result, this.abortSignal, outputs)
      : "waiting_for_input";

    // Timers can outlive business code when a workflow aborts or
    // returns early; close them before the terminal workflow event/report.
    await this.timers.clearRunningTimers();

    await this.reporter.emitWorkflowFinished({
      runId: this.runId,
      workflowName: this.workflowName,
      entrypointId: options.entrypointId,
      entrypointTitle: options.entrypointTitle,
      conversationId: options.conversationId,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      result: options.result,
      timeoutMs: readTimeoutMs(this.abortSignal),
      outputs,
    });

    const report = createWorkflowExecutionReport({
      runId: this.runId,
      workflowName: this.workflowName,
      entrypointId: options.entrypointId,
      entrypointTitle: options.entrypointTitle,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      definedNodes: options.definedNodes,
      registry: options.registry,
      conversationId: options.conversationId,
      conversationTitle: this.reporter.getConversationTitle(),
      pendingUserInput,
      resolvedUserInputs,
      tokenUsage: options.tokenUsage,
      result: options.result,
      nodes: this.reporter.getReports(),
      outputs,
      timers: this.timers.getTimers(),
    });

    for (const layer of this.layers) {
      await layer.onAfterRun?.(report as WorkflowExecutionReport<unknown>, this);
    }

    return report;
  }

  private async emitRuntimeEvent(event: WorkflowRuntimeEvent): Promise<void> {
    for (const layer of this.layers) {
      await layer.onRuntimeEvent?.(event, this);
    }

    await this.onRuntimeEvent?.(event);
  }
}

export function createWorkflowRuntime(
  options: WorkflowRuntimeOptions,
): WorkflowRuntime {
  return new WorkflowRuntime(options);
}

export function createExecutionLimitLayer(
  options: ExecutionLimitLayerOptions,
): WorkflowRuntimeLayer {
  const maxNodeExecutions = normalizePositiveInteger(options.maxNodeExecutions);

  return {
    name: "execution-limit",
    createNodeHooks(runtime) {
      if (maxNodeExecutions === undefined) {
        return undefined;
      }

      let nodeExecutions = 0;

      return {
        onNodeStart() {
          nodeExecutions += 1;

          if (nodeExecutions > maxNodeExecutions) {
            runtime.abort(new WorkflowError({
              type: "execution_aborted",
              message: `Workflow "${runtime.workflowName}" exceeded node execution limit of ${maxNodeExecutions}.`,
              metadata: {
                workflow: runtime.workflowName,
                reason: "node_limit",
                maxNodeExecutions,
              },
            }));
          }
        },
      };
    },
  };
}

export function createRuntimePersistenceLayer(
  options: RuntimePersistenceLayerOptions,
): WorkflowRuntimeLayer {
  return {
    name: options.name ?? "runtime-persistence",
    onRuntimeEvent(event) {
      return options.onEvent?.(event);
    },
    onAfterRun(report) {
      return options.onReport?.(report);
    },
  };
}

export function createWorkflowRunId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function createWorkflowAbortError(
  signal: AbortSignal,
  workflowName: string,
): WorkflowError {
  const reason = signal.reason;

  if (reason instanceof WorkflowTimeoutError) {
    return new WorkflowError({
      type: "execution_aborted",
      message: `Workflow "${workflowName}" timed out after ${reason.timeoutMs}ms.`,
      metadata: {
        workflow: workflowName,
        reason: "timeout",
        timeoutMs: reason.timeoutMs,
      },
    });
  }

  if (reason instanceof WorkflowError) {
    return reason;
  }

  return new WorkflowError({
    type: "execution_aborted",
    message: reason instanceof Error
      ? reason.message
      : `Workflow "${workflowName}" execution was aborted.`,
    metadata: {
      workflow: workflowName,
      reason: "abort",
    },
    cause: reason,
  });
}

export function createAbortedWorkflowResult(
  signal: AbortSignal,
  workflowName: string,
): WorkflowResult<never> {
  return createWorkflowFailure(createWorkflowAbortError(signal, workflowName));
}

function createWorkflowAbortController(abortSignal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();

  if (abortSignal === undefined) {
    return controller;
  }

  if (abortSignal.aborted) {
    controller.abort(abortSignal.reason);
    return controller;
  }

  abortSignal.addEventListener(
    "abort",
    () => {
      controller.abort(abortSignal.reason);
    },
    { once: true },
  );

  return controller;
}

function createWorkflowTimeout(
  timeoutMs: number | undefined,
  controller: AbortController,
): ReturnType<typeof setTimeout> | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }

  return setTimeout(() => {
    controller.abort(new WorkflowTimeoutError(timeoutMs));
  }, timeoutMs);
}

function clearWorkflowTimeout(timeout: ReturnType<typeof setTimeout> | undefined): void {
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
}

function throwIfAborted(signal: AbortSignal, workflowName: string): void {
  if (!signal.aborted) {
    return;
  }

  throw createWorkflowAbortError(signal, workflowName);
}

function resolveWorkflowRunStatus(
  result: WorkflowResult<unknown>,
  signal: AbortSignal,
  outputs: WorkflowOutputReport[] = [],
): WorkflowRunStatus {
  if (result.ok) {
    return resolveWorkflowResultStatus(result, outputs);
  }

  if (signal.aborted && signal.reason instanceof WorkflowTimeoutError) {
    return "timed_out";
  }

  if (result.error.type === "execution_aborted") {
    return signal.reason instanceof WorkflowTimeoutError ? "timed_out" : "aborted";
  }

  return "failed";
}

function readTimeoutMs(signal: AbortSignal): number | undefined {
  return signal.reason instanceof WorkflowTimeoutError ? signal.reason.timeoutMs : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

class WorkflowTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Workflow timed out after ${timeoutMs}ms.`);
    this.name = "WorkflowTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
