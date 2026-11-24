import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getNextProjectScheduleOccurrence, listNextProjectScheduleOccurrences, parseProjectScheduleInput, type ScheduleInput,
  type ScheduleFireStatus } from '../../../../shared/workflow-schedules/index';
import type { LocalFire, LocalSchedule, ScheduleTarget } from './workflow-schedule-contract';
export type { LocalFire, LocalSchedule, ScheduleTarget } from './workflow-schedule-contract';

export interface ScheduleHost { id: string; pid: number; port: number; capability: string; directory: string; projectId: string }
export const fireActive = (status: ScheduleFireStatus) => status === 'pending' || status === 'running' || status === 'waiting_for_input';
export const scheduleTargetKey = ({ directory, projectId, entryId }: ScheduleTarget) => JSON.stringify([directory, projectId, entryId]);
const nextOccurrence = (input: ScheduleInput, after: number) => getNextProjectScheduleOccurrence({ ...input, after }).getTime();
const busy = (error: unknown) => (Number((error as { errcode?: number }).errcode) & 255) === 5;

export class WorkflowScheduleStore {
  private readonly db: DatabaseSync;
  private owner?: DatabaseSync;
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'schedules.sqlite'), { timeout: 250, enableForeignKeyConstraints: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, target TEXT NOT NULL, spec TEXT NOT NULL, next INTEGER);
      CREATE INDEX IF NOT EXISTS plans_due ON plans(next);
      CREATE TABLE IF NOT EXISTS fires (id TEXT PRIMARY KEY, plan TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, manual INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, run TEXT, UNIQUE(plan, at, manual));
      CREATE INDEX IF NOT EXISTS fires_active ON fires(status, at);
      CREATE INDEX IF NOT EXISTS fires_history ON fires(plan, at DESC);
      CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, directory TEXT NOT NULL, project TEXT NOT NULL, pid INTEGER NOT NULL, port INTEGER NOT NULL, capability TEXT NOT NULL);`);
  }
  /** SQLite drops this independent lock on process exit, without relying on a renewable clock lease. */
  lead(): boolean {
    if (this.owner) return true;
    const connection = new DatabaseSync(path.join(this.directory, 'leader.sqlite'));
    try { connection.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
    catch (error) { connection.close(); if (busy(error)) return false; throw error; }
    this.owner = connection;
    return true;
  }
  close(): void { this.owner?.close(); this.owner = undefined; this.db.close(); }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private plan(row: { id?: unknown; spec?: unknown; next?: unknown }): LocalSchedule {
    return { ...JSON.parse(String(row.spec)), id: String(row.id), nextFireAt: row.next === null ? undefined : Number(row.next) };
  }
  private fire(row: Record<string, unknown>): LocalFire {
    return { id: String(row.id), scheduleId: String(row.plan), scheduledFor: Number(row.at), manual: row.manual === 1, status: row.status as ScheduleFireStatus,
      ...(typeof row.reason === 'string' && row.reason && { reason: row.reason }), ...(typeof row.run === 'string' && row.run && { runId: row.run }) };
  }
  list(target: ScheduleTarget): LocalSchedule[] {
    return this.db.prepare('SELECT * FROM plans WHERE target=? ORDER BY rowid').all(scheduleTargetKey(target)).map(row => this.plan(row));
  }
  get(id: string): LocalSchedule | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE id=?').get(id);
    return row && this.plan(row);
  }
  active(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM fires WHERE plan=? AND status IN ('pending','running','waiting_for_input') LIMIT 1").get(id);
  }
  private assertUnchanged(id: string, expected: LocalSchedule | undefined): void {
    if (!expected) return;
    const current = this.get(id);
    const comparable = (plan: LocalSchedule | undefined) => plan && JSON.stringify({ ...plan, nextFireAt: undefined });
    if (comparable(expected) !== comparable(current)) throw new Error('plan-changed');
  }
  save(target: ScheduleTarget, value: unknown, now: number, id?: string, expected?: LocalSchedule): LocalSchedule {
    const input = parseProjectScheduleInput(value);
    if (input.resolvedTarget !== 'dev') throw new Error('invalid-target');
    const spec = JSON.stringify({ ...input, target });
    const key = scheduleTargetKey(target);
    const occurrence = nextOccurrence(input, now);
    const next = input.enabled ? occurrence : null;
    return this.transaction(() => {
      if (id) {
        this.assertUnchanged(id, expected);
        const previous = this.get(id);
        if (!previous || scheduleTargetKey(previous.target) !== key) throw new Error('invalid-target');
        if (this.active(id)) throw new Error('active');
        this.db.prepare('UPDATE plans SET spec=?, next=? WHERE id=?').run(spec, next, id);
      } else {
        if (this.list(target).length >= 40 || Number(this.db.prepare('SELECT count(*) AS n FROM plans').get()!.n) >= 200) throw new Error('plan-limit');
        id = randomUUID();
        this.db.prepare('INSERT INTO plans (id,target,spec,next) VALUES (?,?,?,?)').run(id, key, spec, next);
      }
      return this.get(id)!;
    });
  }
  setEnabled(id: string, enabled: boolean, now: number, expected?: LocalSchedule): void {
    this.transaction(() => {
      this.assertUnchanged(id, expected);
      const plan = this.get(id);
      if (!plan) throw new Error('invalid-target');
      if (plan.enabled === enabled) return;
      const { id: _, nextFireAt, ...spec } = plan;
      this.db.prepare('UPDATE plans SET spec=?, next=? WHERE id=?').run(JSON.stringify({ ...spec, enabled }), enabled ? nextOccurrence(plan, now) : null, id);
    });
  }
  remove(id: string, expected?: LocalSchedule): void {
    this.transaction(() => {
      this.assertUnchanged(id, expected);
      if (this.active(id)) throw new Error('active');
      this.db.prepare('DELETE FROM plans WHERE id=?').run(id);
    });
  }
  history(id: string, before?: number): (LocalFire & { cursor: number })[] {
    return this.db.prepare('SELECT *, rowid AS cursor FROM fires WHERE plan=? AND rowid<? ORDER BY rowid DESC LIMIT 30')
      .all(id, before ?? Number.MAX_SAFE_INTEGER).map(row => ({ ...this.fire(row), cursor: Number(row.cursor) }));
  }
  private insert(plan: string, at: number, manual: boolean, status: ScheduleFireStatus, reason?: string): void {
    this.db.prepare('INSERT OR IGNORE INTO fires (id,plan,at,manual,status,reason) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), plan, at, Number(manual), status, reason ?? null);
  }
  manual(id: string, now: number, expected?: LocalSchedule): void {
    this.transaction(() => {
      this.assertUnchanged(id, expected);
      const overlap = this.active(id);
      while (this.db.prepare('SELECT 1 FROM fires WHERE plan=? AND at=? AND manual=1').get(id, now)) ++now;
      this.insert(id, now, true, overlap ? 'skipped_overlap' : 'pending', overlap ? 'previous-active' : undefined);
    });
  }
  collect(now: number, missedThrough: number, tolerance: number): void {
    this.transaction(() => {
      const due = this.db.prepare('SELECT * FROM plans WHERE next<=? ORDER BY next LIMIT 32').all(now).map(row => this.plan(row));
      for (const plan of due) {
        const first = plan.nextFireAt!;
        const next = listNextProjectScheduleOccurrences({ ...plan, after: first, count: Math.min(100, Math.floor((now - first) / 60_000) + 1) });
        let at = first;
        for (const occurrence of next) {
          const missed = at <= missedThrough || now - at >= tolerance;
          const overlap = !missed && this.active(plan.id);
          const status = missed ? 'skipped_missed' : overlap ? 'skipped_overlap' : 'pending';
          this.insert(plan.id, at, false, status, missed ? 'studio-offline' : overlap ? 'previous-active' : undefined);
          at = occurrence.getTime();
          if (at > now) break;
        }
        this.db.prepare('UPDATE plans SET next=? WHERE id=?').run(at, plan.id);
      }
    });
  }
  dispatchable(now: number): LocalFire[] {
    return this.db.prepare("SELECT * FROM fires WHERE status='pending' AND at<=? ORDER BY at LIMIT 16").all(now).map(row => this.fire(row));
  }
  unsettled(): LocalFire[] { return this.db.prepare("SELECT * FROM fires WHERE status IN ('running','waiting_for_input') ORDER BY at").all().map(row => this.fire(row)); }
  mark(fire: LocalFire, status: ScheduleFireStatus, reason?: string, runId = fire.runId): boolean {
    return this.db.prepare('UPDATE fires SET status=?,reason=?,run=? WHERE id=? AND status=?')
      .run(status, reason ?? null, runId ?? null, fire.id, fire.status).changes === 1;
  }
  publishHost(host: ScheduleHost): void {
    this.db.prepare('INSERT INTO hosts (id,directory,project,pid,port,capability) VALUES (?,?,?,?,?,?)').run(host.id, host.directory, host.projectId, host.pid, host.port, host.capability);
  }
  removeHost(id: string): void { this.db.prepare('DELETE FROM hosts WHERE id=?').run(id); }
  hosts(target: ScheduleTarget): ScheduleHost[] {
    return this.db.prepare('SELECT id,pid,port,capability,directory,project AS projectId FROM hosts WHERE directory=? AND project=? ORDER BY rowid DESC')
      .all(target.directory, target.projectId) as unknown as ScheduleHost[];
  }
}
