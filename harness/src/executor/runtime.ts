import type {
  NodeExecutionHooks,
  UserInputRequest,
  UserInputResolved,
} from "../types/index";
import {
  createProjectTimerContext,
  type TimerContext,
} from "../timer/index";
import {
  createProjectFailure,
  HarnessError,
  type RunResult,
} from "../workflow/index";
import {
  combineNodeExecutionHooks,
  createNodeExecutionReporter,
  createProjectExecutionReport,
  resolveProjectResultStatus,
  type OutputReport,
  type ExecutionReport,
  type RuntimeEvent,
  type RunStatus,
  type ExecutionReportTokenUsage,
} from "./report";
import type { NodeRegistryItem } from "./types";
import type { DefinedNode } from "./rules";

export interface RuntimeLayer {
  name?: string;
  onBeforeRun?(runtime: Runtime): Promise<void> | void;
  onRuntimeEvent?(
    event: RuntimeEvent,
    runtime: Runtime,
  ): Promise<void> | void;
  createNodeHooks?(runtime: Runtime): NodeExecutionHooks | undefined;
  onAfterRun?(
    report: ExecutionReport<unknown>,
    runtime: Runtime,
  ): Promise<void> | void;
}

export interface RuntimeOptions {
  projectName: string;
  runId?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  nodeHooks?: NodeExecutionHooks;
  onRuntimeEvent?(event: RuntimeEvent): Promise<void> | void;
  layers?: RuntimeLayer[];
}

export interface RuntimeFinishOptions<Output> {
  definedNodes?: DefinedNode[];
  registry?: NodeRegistryItem[];
  entrypointId?: string;
  entrypointTitle?: string;
  conversationId?: string;
  tokenUsage?: ExecutionReportTokenUsage;
  result: RunResult<Output>;
}

export interface ExecutionLimitLayerOptions {
  maxNodeExecutions?: number;
}

export interface RuntimePersistenceLayerOptions {
  name?: string;
  onEvent?(event: RuntimeEvent): Promise<void> | void;
  onReport?(report: ExecutionReport<unknown>): Promise<void> | void;
}

export class Runtime {
  readonly runId: string;
  readonly projectName: string;
  readonly startedAt: Date;
  readonly abortController: AbortController;
  readonly timers: TimerContext;

  private readonly reporter;
  private readonly timeout?: ReturnType<typeof setTimeout>;
  private readonly layers: RuntimeLayer[];
  private readonly nodeHooks?: NodeExecutionHooks;
  private readonly onRuntimeEvent?: (event: RuntimeEvent) => Promise<void> | void;
  private endedAt?: Date;
  private prepared = false;
  private started = false;
  private status: RunStatus = "running";

  constructor(options: RuntimeOptions) {
    this.runId = options.runId ?? createProjectRunId();
    this.projectName = options.projectName;
    this.startedAt = new Date();
    this.abortController = createProjectAbortController(options.abortSignal);
    this.layers = options.layers ?? [];
    this.onRuntimeEvent = options.onRuntimeEvent;
    this.reporter = createNodeExecutionReporter({
      runId: this.runId,
      projectName: this.projectName,
      onRuntimeEvent: (event) => this.emitRuntimeEvent(event),
    });
    this.timers = createProjectTimerContext({
      onTimerStart: (event) =>
        this.reporter.emitTimerStarted({
          runId: this.runId,
          projectName: this.projectName,
          timer: event.timer,
        }),
      onTimerFinish: (event) =>
        this.reporter.emitTimerFinished({
          runId: this.runId,
          projectName: this.projectName,
          timer: event.timer,
        }),
    });
    this.timeout = createProjectTimeout(options.timeoutMs, this.abortController);
    this.nodeHooks = combineNodeExecutionHooks(
      this.reporter.hooks,
      ...this.layers.map((layer) => layer.createNodeHooks?.(this)),
      options.nodeHooks,
    );
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  get currentStatus(): RunStatus {
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
    throwIfAborted(this.abortSignal, this.projectName);
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

    await this.reporter.emitProjectStarted({
      runId: this.runId,
      projectName: this.projectName,
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
      projectName: this.projectName,
      conversationId: event.conversationId,
      title: event.title,
      updatedAt: event.updatedAt,
    });
  }

  async emitTokenUsageUpdated(event: {
    conversationId?: string;
    usage: ExecutionReportTokenUsage["run"];
    updatedAt: Date;
  }): Promise<void> {
    await this.reporter.emitTokenUsageUpdated({
      runId: this.runId,
      projectName: this.projectName,
      conversationId: event.conversationId,
      usage: event.usage,
      updatedAt: event.updatedAt,
    });
  }

  async emitUserInputRequested(event: UserInputRequest): Promise<void> {
    await this.reporter.emitUserInputRequested(event);
  }

  async emitUserInputResolved(event: UserInputResolved): Promise<void> {
    await this.reporter.emitUserInputResolved(event);
  }

  async finish<Output>(
    options: RuntimeFinishOptions<Output>,
  ): Promise<ExecutionReport<Output>> {
    clearProjectTimeout(this.timeout);
    this.endedAt = new Date();
    const outputs = this.reporter.getOutputs();
    const pendingUserInput = this.reporter.getPendingUserInput();
    const resolvedUserInputs = this.reporter.getResolvedUserInputs();
    this.status = pendingUserInput === undefined
      ? resolveProjectRunStatus(options.result, this.abortSignal, outputs)
      : "waiting_for_input";

    // Timers can outlive business code when a workflow aborts or
    // returns early; close them before the terminal workflow event/report.
    await this.timers.clearRunningTimers();

    await this.reporter.emitProjectFinished({
      runId: this.runId,
      projectName: this.projectName,
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

    const report = createProjectExecutionReport({
      runId: this.runId,
      projectName: this.projectName,
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
      await layer.onAfterRun?.(report as ExecutionReport<unknown>, this);
    }

    return report;
  }

  private async emitRuntimeEvent(event: RuntimeEvent): Promise<void> {
    for (const layer of this.layers) {
      await layer.onRuntimeEvent?.(event, this);
    }

    await this.onRuntimeEvent?.(event);
  }
}

export function createProjectRuntime(
  options: RuntimeOptions,
): Runtime {
  return new Runtime(options);
}

export function createExecutionLimitLayer(
  options: ExecutionLimitLayerOptions,
): RuntimeLayer {
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
            runtime.abort(new HarnessError({
              type: "execution_aborted",
              message: `Workflow "${runtime.projectName}" exceeded node execution limit of ${maxNodeExecutions}.`,
              metadata: {
                workflow: runtime.projectName,
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
): RuntimeLayer {
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

export function createProjectRunId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function createProjectAbortError(
  signal: AbortSignal,
  projectName: string,
): HarnessError {
  const reason = signal.reason;

  if (reason instanceof TimeoutError) {
    return new HarnessError({
      type: "execution_aborted",
      message: `Workflow "${projectName}" timed out after ${reason.timeoutMs}ms.`,
      metadata: {
        project: projectName,
        reason: "timeout",
        timeoutMs: reason.timeoutMs,
      },
    });
  }

  if (reason instanceof HarnessError) {
    return reason;
  }

  return new HarnessError({
    type: "execution_aborted",
    message: reason instanceof Error
      ? reason.message
      : `Workflow "${projectName}" execution was aborted.`,
    metadata: {
      project: projectName,
      reason: "abort",
    },
    cause: reason,
  });
}

export function createAbortedProjectResult(
  signal: AbortSignal,
  projectName: string,
): RunResult<never> {
  return createProjectFailure(createProjectAbortError(signal, projectName));
}

function createProjectAbortController(abortSignal: AbortSignal | undefined): AbortController {
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

function createProjectTimeout(
  timeoutMs: number | undefined,
  controller: AbortController,
): ReturnType<typeof setTimeout> | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }

  return setTimeout(() => {
    controller.abort(new TimeoutError(timeoutMs));
  }, timeoutMs);
}

function clearProjectTimeout(timeout: ReturnType<typeof setTimeout> | undefined): void {
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
}

function throwIfAborted(signal: AbortSignal, projectName: string): void {
  if (!signal.aborted) {
    return;
  }

  throw createProjectAbortError(signal, projectName);
}

function resolveProjectRunStatus(
  result: RunResult<unknown>,
  signal: AbortSignal,
  outputs: OutputReport[] = [],
): RunStatus {
  if (result.ok) {
    return resolveProjectResultStatus(result, outputs);
  }

  if (signal.aborted && signal.reason instanceof TimeoutError) {
    return "timed_out";
  }

  if (result.error.type === "execution_aborted") {
    return signal.reason instanceof TimeoutError ? "timed_out" : "aborted";
  }

  return "failed";
}

function readTimeoutMs(signal: AbortSignal): number | undefined {
  return signal.reason instanceof TimeoutError ? signal.reason.timeoutMs : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Workflow timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
