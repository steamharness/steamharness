import { clearInterval, setInterval } from 'node:timers';
import type { ScheduleFireStatus } from '../../../../shared/workflow-schedules/index';
import { fireActive, type LocalSchedule, type LocalFire, type WorkflowScheduleStore } from './workflow-schedule-store';

export interface FireOutcome { status: ScheduleFireStatus; reason?: string; runId?: string }
export interface ScheduleExecutor {
  start(plan: LocalSchedule, fire: LocalFire, deadline: number, signal: AbortSignal): Promise<FireOutcome | undefined>;
  status(plan: LocalSchedule, fire: LocalFire, signal: AbortSignal): Promise<FireOutcome | undefined>;
}

const POLL_MS = 1_500;
const TOLERANCE_MS = 5_000;
const START_TIMEOUT_MS = 40_000;

export class WorkflowScheduler {
  private readonly lifetime = new AbortController();
  private readonly tasks = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private lastTick?: number;
  private missedThrough = -Infinity;
  private lastObserved?: string;
  constructor(readonly store: WorkflowScheduleStore, private readonly executor: ScheduleExecutor,
    private readonly log: (error: unknown) => void, private readonly clock = Date.now) {}

  start(): void {
    if (this.timer || this.lifetime.signal.aborted) return;
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.timer.unref();
    this.tick();
  }
  tick(): void {
    if (this.lifetime.signal.aborted) return;
    try {
      if (!this.store.lead()) return;
      const now = this.clock(), prior = this.lastTick;
      const continuous = prior !== undefined && now >= prior && now - prior < TOLERANCE_MS;
      this.lastTick = now;
      if (!continuous) this.missedThrough = now;
      this.store.collect(now, this.missedThrough, TOLERANCE_MS);
      for (const fire of this.store.dispatchable(now)) {
        const plan = this.store.get(fire.scheduleId);
        if (!plan) continue;
        if (!fire.manual && !plan.enabled) { this.store.mark(fire, 'skipped_missed', 'paused-before-launch'); continue; }
        if ((!fire.manual && fire.scheduledFor <= this.missedThrough) || now - fire.scheduledFor >= TOLERANCE_MS) {
          this.store.mark(fire, 'skipped_missed', 'studio-offline'); continue;
        }
        if (this.tasks.size >= 8) break;
        const run = { ...fire, status: 'running', runId: fire.id } as const;
        if (this.store.mark(fire, 'running', undefined, run.runId)) {
          this.observe(run, () => this.executor.start(plan, run, now + START_TIMEOUT_MS, this.lifetime.signal));
        }
      }
      const unsettled = this.store.unsettled();
      const start = unsettled.findIndex(fire => fire.id === this.lastObserved) + 1;
      for (let offset = 0; offset < unsettled.length; offset++) {
        if (this.tasks.size >= 8) break;
        const fire = unsettled[(start + offset) % unsettled.length];
        if (this.tasks.has(fire.id)) continue;
        const plan = this.store.get(fire.scheduleId);
        if (plan) {
          this.lastObserved = fire.id;
          this.observe(fire, () => this.executor.status(plan, fire, this.lifetime.signal));
        }
      }
    } catch (error) { this.log(error); }
  }
  private observe(fire: LocalFire, work: () => Promise<FireOutcome | undefined>): void {
    const task = Promise.resolve().then(work).then(outcome => {
      if (outcome && !this.lifetime.signal.aborted && (fire.status !== outcome.status || fire.reason !== outcome.reason || fire.runId !== outcome.runId)) {
        // A failed admission has no run to open. A durable run keeps the same ID across approval and restart.
        this.store.mark(fire, outcome.status, outcome.reason, outcome.runId ?? (fireActive(outcome.status) ? fire.runId : ''));
      }
    }).catch(error => { if (!this.lifetime.signal.aborted) this.log(error); }).finally(() => this.tasks.delete(fire.id));
    this.tasks.set(fire.id, task);
  }
  async idle(): Promise<void> { await Promise.all(this.tasks.values()); }
  async stop(release?: () => Promise<void>): Promise<void> {
    clearInterval(this.timer); this.lifetime.abort();
    try { await this.idle(); await release?.(); } finally { this.store.close(); }
  }
}
