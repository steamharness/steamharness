import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryRuntimePersistence, type RuntimePersistence } from 'steamharness/runtime-storage';
import { WorkflowHistory } from '../web/workflow-history';
import type { RunRecord, WorkspaceContract } from '../web/workflow-workspace';

const histories: WorkflowHistory[] = [];
afterEach(async () => { await Promise.all(histories.splice(0).map(history => history.reset())); });
function history(backend: () => RuntimePersistence, lost?: (error: Error) => void) {
  const value = new WorkflowHistory(backend, lost); histories.push(value); return value;
}
function workspace(): WorkspaceContract {
  const run: RunRecord = { id: 'run', scopeId: 'scope', title: 'Run', createdAt: 1, updatedAt: 2,
    status: 'waiting_for_input', args: [], params: {}, policies: {}, files: [], nodes: [], logs: '', resolvedInputs: [],
    items: [{ id: 'first', content: 'A' }, { id: 'second', content: 'B' }], events: [{ order: 1 }, { order: 2 }],
    pendingInput: { requestId: 'request', nodeName: 'approval', title: 'Continue?', params: [] } };
  return { version: 1, runs: [run], selectedId: run.id, occupiedId: run.id,
    drafts: { main: { scopeId: 'draft-scope', values: { message: 'draft' }, rawArgs: '[]', inputMode: 'form', policies: {} } } };
}
it('restores ordered run output, events, pending input and drafts from relational records', async () => {
  const backend = createMemoryRuntimePersistence(), writer = history(() => backend), state = workspace();
  await writer.read(); await writer.save(state);
  const reader = history(() => backend);
  expect(await reader.read()).toEqual(state);
  const revisions = (await backend.list('run')).map(record => record.revision);
  await writer.save(state);
  expect((await backend.list('run')).map(record => record.revision)).toEqual(revisions);
  await writer.save({ version: 1, runs: [], drafts: {} });
  expect((await reader.read()).runs).toEqual([]);
});
it('fences another window until the previous workspace owner releases its lease', async () => {
  const backend = createMemoryRuntimePersistence(), first = history(() => backend), second = history(() => backend);
  await first.read(); await second.read(); await first.save(workspace());
  await expect(second.save(workspace())).rejects.toMatchObject({ code: 'RUNTIME_STORAGE_OWNER_CONFLICT' });
  await first.reset(); await second.read(); await expect(second.save(workspace())).resolves.toBeUndefined();
});
it('retries an unchanged captured state after a transport failure without advancing its revision', async () => {
  const memory = createMemoryRuntimePersistence(); let fail = true;
  const backend: RuntimePersistence = { ...memory, acquire: async (...args) => {
    const lease = await memory.acquire(...args);
    return { ...lease, write: async record => { if (fail) { fail = false; throw new Error('offline'); } return lease.write(record); } };
  } };
  const writer = history(() => backend); await writer.read();
  await expect(writer.save(workspace())).rejects.toThrow('offline');
  expect(await memory.list('run')).toEqual([]);
  await writer.save(workspace()); expect(await writer.read()).toEqual(workspace());
});
it('ignores a delayed lease failure from the previous account after resetting history', async () => {
  const oldAccount = createMemoryRuntimePersistence(), newAccount = createMemoryRuntimePersistence(), lost = vi.fn();
  let oldFailure!: (error: Error) => void;
  let backend: RuntimePersistence = { ...oldAccount, acquire: (scope, onLost) => { oldFailure = onLost!; return oldAccount.acquire(scope); } };
  const writer = history(() => backend, lost); await writer.read(); await writer.save(workspace());
  await writer.reset(); backend = newAccount; await writer.read(); await writer.save(workspace());
  oldFailure(new Error('Old account disconnected'));
  expect(lost).not.toHaveBeenCalled();
  await expect(writer.save(workspace())).resolves.toBeUndefined();
});
