import { describe, expect, it } from 'vitest';
import { KanbanDiagnostics } from '../web/kanban-diagnostics';

describe('Kanban runtime diagnostic evidence', () => {
  it('reports stalled reads immediately and discards their late completion after a preview change', () => {
    const diagnostics = new KanbanDiagnostics(), attempts = [{ source: 'database' as const }];
    const read = diagnostics.start({ requestId: 'request', operation: 'files.readFile', input: { database: 'data', fileId: 'wf_ab12' } }, 'profile', Date.now(), attempts);
    expect(diagnostics.snapshot()[0]).toMatchObject({ status: 'pending', ok: null, attempts: [{ source: 'database' }] });
    diagnostics.clear(); diagnostics.finish(read, new Error('late failure'));
    expect(diagnostics.snapshot()).toEqual([]);
  });
  it('retains attachment 404 and database fallback without copying data or raw failures', () => {
    const diagnostics = new KanbanDiagnostics();
    diagnostics.record({ requestId: 'request', operation: 'files.readFile', input: { database: 'data', fileId: 'wf_file', secret: 'private-value' } },
      'configuration', Date.now(), [{ source: 'configuration-attachment', status: 404 }, { source: 'database' }],
      new Error('Bearer private-token https://private.test', { cause: new DOMException('private details', 'TimeoutError') }));
    const result = diagnostics.snapshot();
    expect(result[0]).toMatchObject({ configurationId: 'configuration', fileId: 'wf_file', database: 'data', ok: false,
      attempts: [{ source: 'configuration-attachment', status: 404 }, { source: 'database' }],
      error: { code: 'KANBAN_BRIDGE_ERROR', category: 'timeout' } });
    expect(JSON.stringify(result)).not.toMatch(/private|Bearer|https:/);
    result[0].attempts.length = 0;
    expect(diagnostics.snapshot()[0]!.attempts).toHaveLength(2);
  });
  it('bounds history and never retains KV keys, values or file payloads', () => {
    const diagnostics = new KanbanDiagnostics();
    for (let i = 0; i < 60; i++) diagnostics.record({ requestId: String(i), operation: 'kv.setValue', input: { database: 'data', key: 'sensitive', value: 'secret' } }, String(i), Date.now(), []);
    expect(diagnostics.snapshot()).toHaveLength(50);
    expect(diagnostics.snapshot()[0]!.configurationId).toBe('10');
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/sensitive|secret/);
    diagnostics.clear(); expect(diagnostics.snapshot()).toEqual([]);
  });
  it('recognizes database timeouts after HarnessError serializes their causes', () => {
    const diagnostics = new KanbanDiagnostics();
    for (const error of [new Error('The operation was aborted due to timeout'),
      { name: 'HarnessError', safeCause: { name: 'HarnessError', message: 'private file request timed out' } }]) {
      diagnostics.record({ requestId: 'request', operation: 'files.readFile', input: { database: 'data', fileId: 'file' } },
        'configuration', Date.now(), [{ source: 'database' }], error);
      expect(diagnostics.snapshot().at(-1)?.error?.category).toBe('timeout');
    }
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/private file|operation was aborted/);
  });
});
