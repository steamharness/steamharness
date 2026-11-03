import { emptyRuntimeRecord, type RuntimeHistoryLease, type RuntimeHistoryRecord, type RuntimePersistence } from 'steamharness/runtime-storage';
import type { RunRecord, WorkspaceContract } from './workflow-workspace';

/** One workspace execution lease protects drafts, runs and pending input together. */
export class WorkflowHistory {
  private lease?: Promise<RuntimeHistoryLease>;
  private records = new Map<string, RuntimeHistoryRecord>();
  private pending: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  constructor(private readonly persistence: () => RuntimePersistence | undefined, private readonly lost?: (error: Error) => void) {}
  private backend() { const backend = this.persistence(); if (!backend) throw new Error('Sign in to persist workflow history.'); return backend; }
  read(): Promise<WorkspaceContract> {
    const next = this.pending.then(() => this.load());
    this.pending = next.catch(() => undefined); return next;
  }
  private async load(): Promise<WorkspaceContract> {
    const [runs, workspaces] = await Promise.all([this.backend().list('run'), this.backend().list('workflow')]);
    const meta = workspaces.find(record => record.key === 'workspace');
    this.records = new Map([...runs, ...workspaces].map(record => [`${record.kind}:${record.key}`, record]));
    return { version: 1, runs: runs.map(record => ({ ...record.state, items: record.messages.map(item => item.value), events: record.events.map(item => item.value) } as unknown as RunRecord)).sort((a, b) => b.createdAt - a.createdAt),
      drafts: Object.fromEntries((meta?.values ?? []).map(item => [item.id, item.value])), ...meta?.state } as unknown as WorkspaceContract;
  }
  save(workspace: WorkspaceContract): Promise<void> {
    const epoch = this.epoch;
    const captured = structuredClone(workspace);
    const next = this.pending.then(async () => {
      if (epoch !== this.epoch) return;
      const acquiring = this.lease ??= this.backend().acquire('workflow', error => {
        if (epoch !== this.epoch || this.lease !== acquiring) return;
        const failed = this.lease; this.lease = undefined;
        void failed?.then(lease => lease.close()).catch(() => undefined); this.lost?.(error);
      }).catch(error => { if (this.lease === acquiring) this.lease = undefined; throw error; });
      const lease = await acquiring;
      lease.assertOwned();
      const { runs, drafts, ...state } = captured;
      const records = runs.map(run => {
        const { items, events, ...state } = run;
        return { ...emptyRuntimeRecord('run', run.id, 'workflow'), state,
          messages: items.map((value, index) => ({ id: String(index), value: value as unknown as Record<string, unknown> })),
          events: events.map((value, index) => ({ id: String(index), value })) };
      });
      records.push({ ...emptyRuntimeRecord('workflow', 'workspace', 'workflow'), state: state as never, values: Object.entries(drafts).map(([id, value]) => ({ id, value: value as unknown as Record<string, unknown> })) } as never);
      for (const record of records) {
        if (epoch !== this.epoch) return;
        const key = `${record.kind}:${record.key}`, previous = this.records.get(key);
        const next = { ...record, revision: previous?.revision ?? 0 };
        if (previous && JSON.stringify({ ...previous, revision: 0 }) === JSON.stringify(record)) continue;
        this.records.set(key, await lease.write(next));
      }
      for (const [key, record] of this.records) if (record.kind === 'run' && !runs.some(run => run.id === record.key)) { await lease.delete(record); this.records.delete(key); }
    });
    this.pending = next.catch(() => undefined); return next;
  }
  async reset(): Promise<void> {
    this.epoch++; await this.pending;
    try { if (this.lease) await (await this.lease).close(); }
    finally { this.lease = undefined; this.records.clear(); }
  }
}
