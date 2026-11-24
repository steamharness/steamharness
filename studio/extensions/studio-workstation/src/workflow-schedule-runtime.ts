import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readProjectManifestFromDirectory } from '@steamharness/project-manifest/node';
import { readProjectReleaseSync } from '@steamharness/project-manifest/release-node';
import { isProjectUuid } from '@steamharness/workflow-ids';
import type { ScheduleInput } from '../../../../shared/workflow-schedules/index';
import { WorkflowScheduleStore, type LocalFire, type LocalSchedule, type ScheduleHost, type ScheduleTarget } from './workflow-schedule-store';
import { WorkflowScheduler, type FireOutcome } from './workflow-scheduler';
import type { WebSession } from './workflow-cli-types';

type Reply = { status: string; reason?: string; viewUrl?: string };
const terminalOrActive = new Set(['running', 'waiting_for_input', 'success', 'failed']);
const rejected = new Set(['skipped_overlap', 'skipped_missed', 'skipped_authorization', 'skipped_invalid_target']);
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as { code?: string }).code === 'EPERM'; }
};
const replyOutcome = (reply: Reply, id: string): FireOutcome | undefined => terminalOrActive.has(reply.status) || rejected.has(reply.status)
  ? { status: reply.status as FireOutcome['status'], reason: reply.reason, ...(terminalOrActive.has(reply.status) && reply.reason !== 'start-failed' && { runId: id }) } : undefined;

export class WorkflowScheduleRuntime {
  readonly store: WorkflowScheduleStore;
  readonly scheduler: WorkflowScheduler;
  private readonly leases = new Map<string, WebSession>();
  private readonly registrations = new Set<string>();
  private disposed = false;
  private closing?: Promise<void>;
  constructor(directory: string, private readonly webData: string, private readonly trusted: (directory: string) => Promise<boolean>,
    private readonly launch: (target: ScheduleTarget, capability: string, signal: AbortSignal) => Promise<WebSession>, log: (error: unknown) => void) {
    this.store = new WorkflowScheduleStore(directory);
    this.scheduler = new WorkflowScheduler(this.store, { start: this.start.bind(this), status: this.status.bind(this) }, log);
    this.scheduler.start();
  }
  static capability(): string { return randomBytes(32).toString('hex'); }

  async register(directory: string, projectId: string, session: WebSession, capability: string): Promise<ScheduleHost | undefined> {
    if (this.disposed || session.ready.workflowScheduleProtocolVersion !== 1 || session.ready.project.id !== projectId) return;
    const resolved = await realpath(directory);
    if (this.disposed) return;
    const url = new URL(session.ready.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) return;
    const host = { id: randomUUID(), pid: process.pid, port: Number(url.port), capability, directory: resolved, projectId };
    this.store.publishHost(host);
    this.registrations.add(host.id);
    const retired = () => {
      if (this.disposed) return;
      try { this.store.removeHost(host.id); this.registrations.delete(host.id); }
      catch { /* A stale port is ignored and the registration is removed on shutdown. */ }
    };
    const exit = session.onExit(retired);
    void session.closed.then(() => { exit.dispose(); retired(); }).catch(() => undefined);
    return host;
  }
  async verifyTarget(target: ScheduleTarget): Promise<void> {
    if (!path.isAbsolute(target.directory) || !isProjectUuid(target.projectId) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(target.entryId)
      || await realpath(target.directory).catch(() => '') !== target.directory) throw new Error('target-changed');
    if (!await this.trusted(target.directory)) throw new Error('authorization-changed');
    const manifest = await readProjectManifestFromDirectory(target.directory).catch(() => undefined);
    if (!manifest || readProjectReleaseSync(target.directory) || manifest.projectId !== target.projectId || manifest.version !== target.version
      || !manifest.entries.some(entry => entry.entryId === target.entryId && entry.type === 'workflow')) throw new Error('target-changed');
  }
  async validate(target: ScheduleTarget, input: ScheduleInput, signal: AbortSignal): Promise<void> {
    await this.verifyTarget(target);
    const result = await this.call(target, { action: 'validate', entrypointId: input.entrypointId, paramValues: input.paramValues }, signal);
    if (result.status !== 'valid') throw new Error(result.reason ?? 'upgrade-runtime');
    await this.verifyTarget(target);
  }
  async existingRunView(plan: LocalSchedule, fire: LocalFire, signal: AbortSignal): Promise<string | undefined> {
    await this.verifyTarget(plan.target);
    for (const host of this.store.hosts(plan.target)) {
      try {
        const reply = await this.rpc(host, plan.target, { action: 'view', scheduleId: plan.id, runId: fire.runId }, signal);
        if (reply?.status !== 'view' || typeof reply.viewUrl !== 'string') continue;
        const url = new URL(reply.viewUrl);
        if (url.origin === `http://127.0.0.1:${host.port}` && url.pathname === `/entries/${plan.target.entryId}/`
          && !url.username && !url.password && !url.search && /^#session=[a-f0-9]{64}$/u.test(url.hash)) return url.href;
      } catch { signal.throwIfAborted(); }
    }
  }
  private async rpc(host: ScheduleHost, target: ScheduleTarget, input: object, signal: AbortSignal): Promise<Reply | undefined> {
    if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535 || !/^[a-f\d]{64}$/u.test(host.capability)) return;
    if (!alive(host.pid)) { if (!this.disposed) this.store.removeHost(host.id); return; }
    const response = await fetch(`http://127.0.0.1:${host.port}/entries/${target.entryId}/api/host-workflow-schedule`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      headers: { Authorization: `Bearer ${host.capability}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, projectId: target.projectId, directory: target.directory, version: target.version }),
    });
    return response.ok ? await response.json() as Reply : undefined;
  }
  private async call(target: ScheduleTarget, input: { action: 'start' | 'validate' } & Record<string, unknown>, signal: AbortSignal, fireId?: string): Promise<Reply> {
    let conflict = false;
    for (const host of this.store.hosts(target)) {
      if (input.action === 'start') await this.verifyTarget(target);
      let reply: Reply | undefined;
      try { reply = await this.rpc(host, target, input, signal); }
      catch (error) {
        signal.throwIfAborted();
        // An ambiguous start is never sent to a second host. The ledger will look for the already assigned run ID.
        const code = (error as { cause?: { code?: string } }).cause?.code;
        if (input.action === 'start' && code !== 'ECONNREFUSED') throw error;
      }
      if (reply?.status === 'owner_conflict') { conflict = true; continue; }
      if (reply) return reply;
    }
    if (conflict) return { status: 'skipped_overlap', reason: 'entry-active' };
    await this.verifyTarget(target);
    signal.throwIfAborted();
    const key = WorkflowScheduleRuntime.capability();
    let session: WebSession;
    try { session = await this.launch(target, key, signal); }
    catch {
      signal.throwIfAborted();
      return { status: 'failed', reason: 'start-failed' };
    }
    let keep = false;
    try {
      const host = await this.register(target.directory, target.projectId, session, key);
      if (!host) return { status: 'skipped_invalid_target', reason: 'upgrade-runtime' };
      await this.verifyTarget(target);
      // Keep an admitted worker alive, including after a transport error, until the status path settles it.
      if (fireId) { this.leases.set(fireId, session); keep = true; }
      const reply = await this.rpc(host, target, input, signal);
      return reply?.status === 'owner_conflict' ? { status: 'skipped_overlap', reason: 'entry-active' } : reply ?? { status: 'skipped_invalid_target', reason: 'upgrade-runtime' };
    } finally { if (!keep) await session.close(); }
  }
  private async start(plan: LocalSchedule, fire: LocalFire, deadline: number, lifetime: AbortSignal): Promise<FireOutcome | undefined> {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    try {
      await this.verifyTarget(plan.target);
      const outcome = await this.call(plan.target, { action: 'start', deadline, entrypointId: plan.entrypointId, paramValues: plan.paramValues,
        schedule: { source: 'schedule', scheduleId: plan.id, scheduleName: plan.name, fireId: fire.id, scheduledFor: new Date(fire.scheduledFor).toISOString(), triggerKind: plan.trigger.kind } }, signal, fire.id);
      if (outcome.status !== 'running') await this.retire(fire.id);
      return replyOutcome(outcome, fire.id);
    } catch (error) {
      if ((error as Error).message === 'authorization-changed') return { status: 'skipped_authorization', reason: 'authorization-changed' };
      if ((error as Error).message === 'target-changed') return { status: 'skipped_invalid_target', reason: 'target-changed' };
      throw error;
    }
  }
  private async retire(id: string): Promise<void> {
    const session = this.leases.get(id);
    if (session) { this.leases.delete(id); await session.close(); }
  }
  private async status(plan: LocalSchedule, fire: LocalFire, signal: AbortSignal): Promise<FireOutcome | undefined> {
    const target = plan.target;
    let ownerUnreachable = false;
    for (const host of this.store.hosts(target)) {
      let reply: Reply | undefined;
      try { reply = await this.rpc(host, target, { action: 'status', runId: fire.id, scheduleId: plan.id }, signal); }
      catch (error) {
        signal.throwIfAborted();
        ownerUnreachable ||= (error as { cause?: { code?: string } }).cause?.code !== 'ECONNREFUSED';
        continue;
      }
      if (!reply || reply.status === 'not_found') continue;
      if (reply.status !== 'running') await this.retire(fire.id);
      return replyOutcome(reply, fire.id);
    }
    const filename = path.join(this.webData, 'projects', target.projectId.toLowerCase(), 'entries', target.entryId, 'runtime', 'history.sqlite');
    const info = await lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    let stored: { state?: { status?: string; pendingInput?: unknown; schedule?: { scheduleId?: string; fireId?: string } } } | undefined;
    if (info?.isFile()) {
      const db = new DatabaseSync(filename, { readOnly: true, timeout: 100 });
      try {
        const row = db.prepare("SELECT record FROM history WHERE kind='run' AND key=? AND deleted=0").get(fire.id);
        if (typeof row?.record === 'string') stored = JSON.parse(row.record);
      } finally { db.close(); }
    }
    const state = stored?.state;
    if (ownerUnreachable && (!state || state.status === 'running')) return;
    await this.retire(fire.id);
    if (state?.schedule?.scheduleId !== plan.id || state?.schedule?.fireId !== fire.id) return { status: 'failed', reason: 'run-not-started' };
    if (state.pendingInput) return { status: 'waiting_for_input', runId: fire.id };
    return state.status === 'success' ? { status: 'success', runId: fire.id } : { status: 'failed', runId: fire.id, reason: state.status === 'running' ? 'interrupted' : 'run-failed' };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    return this.closing = this.scheduler.stop(async () => {
      await Promise.allSettled([...this.leases.keys()].map(id => this.retire(id)));
      for (const id of this.registrations) this.store.removeHost(id);
      this.registrations.clear();
    });
  }
  dispose(): void { void this.close().catch(() => undefined); }
}
