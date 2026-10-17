import { BaseNode } from "../node/base";
import type { NodeContext, WorkflowNodeMetadataInput } from "../types/index";
import { WorkflowError } from "../workflow/errors";

export type WorkflowTimerStatus = "running" | "success" | "failed" | "cleared";
export type WorkflowTimerFinishStatus = "success" | "failed";
type WorkflowTimerTerminalStatus = Exclude<WorkflowTimerStatus, "running">;

export interface WorkflowTimerPayload {
  errCode: number;
  errMessage: string;
  timerId: string;
  title: string;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTimerRecord extends WorkflowTimerPayload {
  status: WorkflowTimerStatus;
  endedAt?: string;
  durationMs?: number;
  message?: string;
}

export interface WorkflowTimerStartEvent {
  timer: WorkflowTimerRecord;
}

export interface WorkflowTimerFinishEvent {
  timer: WorkflowTimerRecord;
}

export interface WorkflowTimerContext {
  start(input?: WorkflowTimerNodeInput): Promise<WorkflowTimerPayload>;
  finish(input: WorkflowTimerFinishInput): Promise<WorkflowTimerRecord>;
  clearRunningTimers(): Promise<WorkflowTimerRecord[]>;
  getTimers(): WorkflowTimerRecord[];
}

export interface WorkflowTimerNodeInput {
  title?: string;
  timerId?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTimerFinishOptions {
  status?: WorkflowTimerFinishStatus;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTimerFinishInput {
  timer: WorkflowTimerPayload | string;
  status?: WorkflowTimerTerminalStatus;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface TimerNodeOptions {
  name?: string;
  title?: string;
  historyLimit?: number;
  metadata?: WorkflowNodeMetadataInput;
}

export function createTimerNode(
  options: TimerNodeOptions = {},
): BaseNode<WorkflowTimerNodeInput | undefined, WorkflowTimerPayload> {
  return new TimerNode(options);
}

export function endTimer(
  timer: WorkflowTimerPayload | string,
  context: NodeContext,
  options: WorkflowTimerFinishOptions = {},
): Promise<WorkflowTimerRecord> {
  if (context.timers === undefined) {
    throw new WorkflowError({
      type: "workflow_execution",
      message: "Workflow timer context is not configured.",
    });
  }

  return context.timers.finish({
    timer,
    status: options.status ?? "success",
    message: options.message,
    metadata: options.metadata,
  });
}

class TimerNode extends BaseNode<WorkflowTimerNodeInput | undefined, WorkflowTimerPayload> {
  private readonly title: string;

  constructor(options: TimerNodeOptions) {
    super({
      name: options.name ?? "timer",
      standardName: "timer",
      historyLimit: options.historyLimit,
      metadata: {
        type: "timer",
        title: options.title ?? options.name ?? "Timer",
        ...options.metadata,
      },
    });
    this.title = options.title ?? options.name ?? "Timer";
  }

  protected async execute(
    input: WorkflowTimerNodeInput | undefined,
    context: NodeContext,
  ): Promise<WorkflowTimerPayload> {
    if (context.timers === undefined) {
      throw new WorkflowError({
        type: "workflow_execution",
        message: `Timer node "${this.name}" is used, but no workflow timer context was configured.`,
        nodeName: this.name,
      });
    }

    return context.timers.start({
      timerId: input?.timerId,
      title: input?.title ?? this.title,
      metadata: input?.metadata,
    });
  }
}

export function createWorkflowTimerContext(options: {
  onTimerStart?(event: WorkflowTimerStartEvent): Promise<void> | void;
  onTimerFinish?(event: WorkflowTimerFinishEvent): Promise<void> | void;
  now?: () => Date;
} = {}): WorkflowTimerContext {
  const timers = new Map<string, WorkflowTimerRecord>();
  const order: string[] = [];
  const now = options.now ?? (() => new Date());

  function cloneTimer(timer: WorkflowTimerRecord): WorkflowTimerRecord {
    return {
      ...timer,
      metadata: timer.metadata === undefined ? undefined : { ...timer.metadata },
    };
  }

  function readTimer(timer: WorkflowTimerPayload | string): string {
    return typeof timer === "string" ? timer : timer.timerId;
  }

  async function finishTimer(input: WorkflowTimerFinishInput): Promise<WorkflowTimerRecord> {
    const timerId = readTimer(input.timer);
    const existing = timers.get(timerId);

    if (existing === undefined) {
      throw new WorkflowError({
        type: "workflow_execution",
        message: `Workflow timer "${timerId}" was not started.`,
        metadata: {
          timerId,
        },
      });
    }

    if (existing.status !== "running") {
      throw new WorkflowError({
        type: "workflow_execution",
        message: `Workflow timer "${timerId}" already finished with status "${existing.status}".`,
        metadata: {
          timerId,
          status: existing.status,
        },
      });
    }

    const endedAt = now();
    const status = normalizeTimerFinishStatus(input.status);
    const next: WorkflowTimerRecord = {
      ...existing,
      status,
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - new Date(existing.startedAt).getTime()),
      message: input.message,
      metadata: {
        ...existing.metadata,
        ...input.metadata,
      },
    };

    timers.set(timerId, next);
    await options.onTimerFinish?.({ timer: cloneTimer(next) });
    return cloneTimer(next);
  }

  return {
    async start(input = {}) {
      const startedAt = now();
      const timerId = normalizeTimerId(input.timerId) ?? createWorkflowTimerId();
      if (timers.has(timerId)) {
        throw new WorkflowError({
          type: "workflow_execution",
          message: `Workflow timer "${timerId}" already exists.`,
          metadata: {
            timerId,
          },
        });
      }

      const timer: WorkflowTimerRecord = {
        errCode: 0,
        errMessage: "",
        timerId,
        title: normalizeTimerTitle(input.title),
        startedAt: startedAt.toISOString(),
        status: "running",
        metadata: input.metadata === undefined ? undefined : { ...input.metadata },
      };
      timers.set(timerId, timer);
      order.push(timerId);
      await options.onTimerStart?.({ timer: cloneTimer(timer) });
      return createTimerPayload(timer);
    },
    finish: finishTimer,
    async clearRunningTimers() {
      const cleared: WorkflowTimerRecord[] = [];

      for (const timer of timers.values()) {
        if (timer.status !== "running") {
          continue;
        }

        cleared.push(await finishTimer({
          timer,
          status: "cleared",
          message: "Workflow finished before this timer was ended.",
        }));
      }

      return cleared;
    },
    getTimers() {
      return order
        .map((timerId) => timers.get(timerId))
        .filter((timer): timer is WorkflowTimerRecord => timer !== undefined)
        .map(cloneTimer);
    },
  };
}

function createTimerPayload(timer: WorkflowTimerRecord): WorkflowTimerPayload {
  return {
    errCode: timer.errCode,
    errMessage: timer.errMessage,
    timerId: timer.timerId,
    title: timer.title,
    startedAt: timer.startedAt,
    metadata: timer.metadata === undefined ? undefined : { ...timer.metadata },
  };
}

function normalizeTimerFinishStatus(
  value: WorkflowTimerTerminalStatus | undefined,
): WorkflowTimerTerminalStatus {
  if (value === "failed" || value === "cleared") {
    return value;
  }

  return "success";
}

function normalizeTimerId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

function normalizeTimerTitle(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? "Timer" : normalized;
}

function createWorkflowTimerId(): string {
  return `timer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
