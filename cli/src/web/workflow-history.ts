import { emptyRuntimeRecord, type RuntimeHistoryLease, type RuntimeHistoryRecord, type RuntimePersistence } from 'steamharness/runtime-storage';
import type { RuntimeOutputAppend, RuntimeOutputPage, RuntimeOutputDetails, RuntimeOutputSummary } from 'steamharness/runtime-storage';
import type { RunRecord, WorkspaceContract } from './workflow-workspace';

export interface WorkflowOutputJournal {
  append(runId: string, input: RuntimeOutputAppend): Promise<RuntimeOutputSummary>;
  page(runId: string, page?: number, pageSize?: number): Promise<RuntimeOutputPage>;
  details(runId: string): Promise<RuntimeOutputDetails>;
  references(runId: string): Promise<string[]>;
}

/** One workspace execution lease protects drafts, runs and pending input together. */
export class WorkflowHistory {
  private lease?: Promise<RuntimeHistoryLease>;
  private records = new Map<string, RuntimeHistoryRecord>();
  private pending: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  constructor(private readonly persistence: () => RuntimePersistence | undefined, private readonly lost?: (error: Error) => void) {}
  private backend() { const backend = this.persistence(); if (!backend) throw new Error('Workflow history is not ready.'); return backend; }
  get journal(): WorkflowOutputJournal | undefined {
    const backend = this.backend();
    if (!backend.readRunOutputPage || !backend.readRunOutputDetails || !backend.readRunOutputReferences) return;
    return {
      append: (runId, input) => {
        const captured = structuredClone(input);
        const next = this.pending.then(async () => {
          const lease = await this.acquire();
          if (!lease.appendRunOutput) throw new Error('Incremental run output is not supported by this storage.');
          return lease.appendRunOutput(runId, captured);
        });
        this.pending = next.catch(() => undefined); return next;
      },
      page: async (runId, page, pageSize) => { await this.pending; return backend.readRunOutputPage!(runId, page, pageSize); },
      details: async runId => { await this.pending; return backend.readRunOutputDetails!(runId); },
      references: async runId => { await this.pending; return backend.readRunOutputReferences!(runId); },
    };
  }
  private acquire(): Promise<RuntimeHistoryLease> {
    const epoch = this.epoch;
    const acquiring = this.lease ??= this.backend().acquire('workflow', error => {
      if (epoch !== this.epoch || this.lease !== acquiring) return;
      this.lease = undefined;
      void acquiring.then(lease => lease.close()).catch(() => undefined); this.lost?.(error);
    }).catch(error => { if (this.lease === acquiring) this.lease = undefined; throw error; });
    return acquiring;
  }
  read(): Promise<WorkspaceContract> {
    const next = this.pending.then(() => this.load());
    this.pending = next.catch(() => undefined); return next;
  }
  private async load(): Promise<WorkspaceContract> {
    const [runs, workspaces] = await Promise.all([this.backend().list('run'), this.backend().list('workflow')]);
    const meta = workspaces.find(record => record.key === 'workspace');
    this.records = new Map([...runs, ...workspaces].map(record => [`${record.kind}:${record.key}`, record]));
    const restored: RunRecord[] = [];
    for (const record of runs) {
      const page = await this.backend().readRunOutputPage?.(record.key, 1, 1);
      restored.push({ ...record.state,
        ...(page?.revision ? { outputSummary: { total: page.total, revision: page.revision }, items: [], events: [] }
          : { items: record.messages.map(item => item.value), events: record.events.map(item => item.value) }),
      } as unknown as RunRecord);
    }
    return { version: 1, runs: restored.sort((a, b) => b.createdAt - a.createdAt),
      drafts: Object.fromEntries((meta?.values ?? []).map(item => [item.id, item.value])), ...meta?.state } as unknown as WorkspaceContract;
  }
  save(workspace: WorkspaceContract): Promise<void> {
    const epoch = this.epoch;
    const captured = structuredClone(workspace);
    const next = this.pending.then(async () => {
      if (epoch !== this.epoch) return;
      const lease = await this.acquire();
      lease.assertOwned();
      const { runs, drafts, ...state } = captured;
      const records = runs.map(run => {
        const { items, events, ...state } = run;
        return { ...emptyRuntimeRecord('run', run.id, 'workflow'), state,
          messages: (run.outputSummary ? [] : items).map((value, index) => ({ id: String(index), value: value as unknown as Record<string, unknown> })),
          events: (run.outputSummary ? [] : events).map((value, index) => ({ id: String(index), value })) };
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
