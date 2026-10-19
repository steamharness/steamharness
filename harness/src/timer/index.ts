import { BaseNode } from "../node/base";
import type { NodeContext, NodeMetadataInput } from "../types/index";
import { HarnessError } from "../workflow/errors";

export type TimerStatus = "running" | "success" | "failed" | "cleared";
export type TimerFinishStatus = "success" | "failed";
type TimerTerminalStatus = Exclude<TimerStatus, "running">;

export interface TimerPayload {
  errCode: number;
  errMessage: string;
  timerId: string;
  title: string;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

export interface TimerRecord extends TimerPayload {
  status: TimerStatus;
  endedAt?: string;
  durationMs?: number;
  message?: string;
}

export interface TimerStartEvent {
  timer: TimerRecord;
}

export interface TimerFinishEvent {
  timer: TimerRecord;
}

export interface TimerContext {
  start(input?: TimerNodeInput): Promise<TimerPayload>;
  finish(input: TimerFinishInput): Promise<TimerRecord>;
  clearRunningTimers(): Promise<TimerRecord[]>;
  getTimers(): TimerRecord[];
}

export interface TimerNodeInput {
  title?: string;
  timerId?: string;
  metadata?: Record<string, unknown>;
}

export interface TimerFinishOptions {
  status?: TimerFinishStatus;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface TimerFinishInput {
  timer: TimerPayload | string;
  status?: TimerTerminalStatus;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface TimerNodeOptions {
  name?: string;
  title?: string;
  historyLimit?: number;
  metadata?: NodeMetadataInput;
}

export function createTimerNode(
  options: TimerNodeOptions = {},
): BaseNode<TimerNodeInput | undefined, TimerPayload> {
  return new TimerNode(options);
}

export function endTimer(
  timer: TimerPayload | string,
  context: NodeContext,
  options: TimerFinishOptions = {},
): Promise<TimerRecord> {
  if (context.timers === undefined) {
    throw new HarnessError({
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

class TimerNode extends BaseNode<TimerNodeInput | undefined, TimerPayload> {
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
    input: TimerNodeInput | undefined,
    context: NodeContext,
  ): Promise<TimerPayload> {
    if (context.timers === undefined) {
      throw new HarnessError({
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
  onTimerStart?(event: TimerStartEvent): Promise<void> | void;
  onTimerFinish?(event: TimerFinishEvent): Promise<void> | void;
  now?: () => Date;
} = {}): TimerContext {
  const timers = new Map<string, TimerRecord>();
  const order: string[] = [];
  const now = options.now ?? (() => new Date());

  function cloneTimer(timer: TimerRecord): TimerRecord {
    return {
      ...timer,
      metadata: timer.metadata === undefined ? undefined : { ...timer.metadata },
    };
  }

  function readTimer(timer: TimerPayload | string): string {
    return typeof timer === "string" ? timer : timer.timerId;
  }

  async function finishTimer(input: TimerFinishInput): Promise<TimerRecord> {
    const timerId = readTimer(input.timer);
    const existing = timers.get(timerId);

    if (existing === undefined) {
      throw new HarnessError({
        type: "workflow_execution",
        message: `Workflow timer "${timerId}" was not started.`,
        metadata: {
          timerId,
        },
      });
    }

    if (existing.status !== "running") {
      throw new HarnessError({
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
    const next: TimerRecord = {
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
        throw new HarnessError({
          type: "workflow_execution",
          message: `Workflow timer "${timerId}" already exists.`,
          metadata: {
            timerId,
          },
        });
      }

      const timer: TimerRecord = {
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
      const cleared: TimerRecord[] = [];

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
        .filter((timer): timer is TimerRecord => timer !== undefined)
        .map(cloneTimer);
    },
  };
}

function createTimerPayload(timer: TimerRecord): TimerPayload {
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
  value: TimerTerminalStatus | undefined,
): TimerTerminalStatus {
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
