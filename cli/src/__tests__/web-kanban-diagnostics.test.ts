import { describe, expect, it } from 'vitest';
import { KanbanDiagnostics, failureCategory, failureLogReason } from '../web/kanban-diagnostics';

describe('Kanban runtime diagnostic evidence', () => {
  it('reports stalled reads immediately and discards their late completion after a preview change', () => {
    const diagnostics = new KanbanDiagnostics(), attempts = [{ source: 'local' as const }];
    const read = diagnostics.start({ requestId: 'request', operation: 'files.readFile', input: { fileId: 'wf_ab12' } }, 'profile', Date.now(), attempts);
    expect(diagnostics.snapshot()[0]).toMatchObject({ status: 'pending', ok: null, attempts: [{ source: 'local' }] });
    diagnostics.clear(); diagnostics.finish(read, new Error('late failure'));
    expect(diagnostics.snapshot()).toEqual([]);
  });
  it('retains attachment 404 and local fallback without copying data or raw failures', () => {
    const diagnostics = new KanbanDiagnostics();
    diagnostics.record({ requestId: 'request', operation: 'files.readFile', input: { fileId: 'wf_file', secret: 'private-value' } },
      'configuration', Date.now(), [{ source: 'configuration-attachment', status: 404 }, { source: 'local' }],
      new Error('Bearer private-token https://private.test', { cause: new DOMException('private details', 'TimeoutError') }));
    const result = diagnostics.snapshot();
    expect(result[0]).toMatchObject({ configurationId: 'configuration', fileId: 'wf_file', ok: false,
      attempts: [{ source: 'configuration-attachment', status: 404 }, { source: 'local' }],
      error: { code: 'KANBAN_BRIDGE_ERROR', category: 'timeout' } });
    expect(JSON.stringify(result)).not.toMatch(/private|Bearer|https:/);
    result[0].attempts.length = 0;
    expect(diagnostics.snapshot()[0]!.attempts).toHaveLength(2);
  });
  it('bounds history and never retains KV keys, values or file payloads', () => {
    const diagnostics = new KanbanDiagnostics();
    for (let i = 0; i < 60; i++) diagnostics.record({ requestId: String(i), operation: 'files.readFile', input: { fileId: `wf_${i}`, sensitive: 'secret' } }, String(i), Date.now(), []);
    expect(diagnostics.snapshot()).toHaveLength(50);
    expect(diagnostics.snapshot()[0]!.configurationId).toBe('10');
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/sensitive|secret/);
    diagnostics.clear(); expect(diagnostics.snapshot()).toEqual([]);
  });
  it('recognizes file read timeouts after HarnessError serializes their causes', () => {
    const diagnostics = new KanbanDiagnostics();
    for (const error of [new Error('The operation was aborted due to timeout'),
      { name: 'HarnessError', safeCause: { name: 'HarnessError', message: 'private file request timed out' } }]) {
      diagnostics.record({ requestId: 'request', operation: 'files.readFile', input: { fileId: 'file' } },
        'configuration', Date.now(), [{ source: 'local' }], error);
      expect(diagnostics.snapshot().at(-1)?.error?.category).toBe('timeout');
    }
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/private file|operation was aborted/);
  });
  it('classifies common host failures without copying their messages', () => {
    expect(failureCategory(Object.assign(new Error('/private/connection'), { code: 'ECONNREFUSED' }))).toBe('connection');
    expect(failureCategory(Object.assign(new Error('/private/permission'), { code: 'EACCES' }))).toBe('permission');
    expect(failureCategory(Object.assign(new Error('/private/missing'), { code: 'ENOENT' }))).toBe('missing');
  });
  it('keeps diagnostic cause types and codes while redacting credential-like messages', () => {
    const failure = new Error('Bearer private-token', { cause: { name: 'DatabaseResourceError', code: 'PRIVATE_INTERNAL_ERROR', message: 'postgres://private/secret' } });
    expect(failureLogReason(failure)).toBe('Error: [redacted] <- DatabaseResourceError (PRIVATE_INTERNAL_ERROR)');
    expect(failureLogReason(new Error('Database alias is missing', { cause: new DOMException('private detail', 'TimeoutError') })))
      .toBe('Error: Database alias is missing <- TimeoutError');
  });
});
