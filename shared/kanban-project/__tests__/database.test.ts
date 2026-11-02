import { expect, it, vi } from 'vitest';
import { connectBrowserDatabase, type BrowserDatabaseDescriptor, type BrowserDatabaseHost } from '../database';
import { createKanbanBridgeScript, type KanbanBrowserApi } from '../index';

const descriptor: BrowserDatabaseDescriptor = { kind: 'steamharness.database', version: 1, target: 'browser', provider: 'postgresql', alias: 'main', schemaHash: 'a'.repeat(64), metadata: { models: [{ name: 'Task', delegate: 'task' }] } };
const binding = { id: 'binding', alias: 'main', databaseId: 'resource', revision: 2, accessRevision: 3 };

it('connects once and pins every table operation to the resolved binding and schema', async () => {
  const host = { resolve: vi.fn(async () => binding), query: vi.fn<BrowserDatabaseHost["query"]>(async () => ({ items: [] })) };
  const client = await connectBrowserDatabase(descriptor, host) as any;
  await client.task.rows({ where: { stage: 'todo' }, orderBy: { id: 'asc' }, page: 2, pageSize: 20 });
  await client.task.insert({ id: 'one', title: 'First' });
  await client.task.update({ key: { id: 'one' }, rowVersion: '12', data: { title: 'Changed' } });
  await client.task.delete({ key: { id: 'one' }, rowVersion: '13' });
  expect(host.resolve).toHaveBeenCalledExactlyOnceWith({ alias: 'main', schemaHash: descriptor.schemaHash });
  expect(host.query.mock.calls.map(call => call[2])).toEqual([
    { model: 'Task', operation: 'rows', where: { stage: 'todo' }, orderBy: { id: 'asc' }, page: 2, pageSize: 20 },
    { model: 'Task', operation: 'insert', data: { id: 'one', title: 'First' } },
    { model: 'Task', operation: 'update', key: { id: 'one' }, rowVersion: '12', data: { title: 'Changed' } },
    { model: 'Task', operation: 'delete', key: { id: 'one' }, rowVersion: '13' },
  ]);
  expect(host.query.mock.calls.every(call => call[0] === binding && call[1] === descriptor.schemaHash)).toBe(true);
  expect(Object.getPrototypeOf(client)).toBeNull();
  expect(Object.isFrozen(client.task)).toBe(true);
  expect(client.transaction).toBeUndefined();
  host.query.mockRejectedValueOnce(Object.assign(new Error('Access changed'), { code: 'DATABASE_ACCESS_DENIED' }));
  await expect(client.task.rows()).rejects.toMatchObject({ code: 'DATABASE_ACCESS_DENIED' });
});

it('rejects Node descriptors, duplicate and reserved delegates, and mismatched bindings', async () => {
  const host = { resolve: vi.fn(async () => binding), query: vi.fn() };
  for (const invalid of [
    { ...descriptor, target: 'node' }, { ...descriptor, schemaHash: 'invalid' },
    { ...descriptor, metadata: { models: [{ name: 'Task', delegate: '__proto__' }] } },
    { ...descriptor, metadata: { models: [...descriptor.metadata.models, ...descriptor.metadata.models] } },
  ]) await expect(connectBrowserDatabase(invalid, host)).rejects.toMatchObject({ code: 'DATABASE_INVALID_REQUEST' });
  expect(host.resolve).not.toHaveBeenCalled();
  await expect(connectBrowserDatabase(descriptor, { ...host, resolve: async () => ({ ...binding, alias: 'other' }) })).rejects.toThrow();
});

it('runs a generated descriptor through the injected page transport without credentials', async () => {
  const listeners: ((event: any) => void)[] = [], posted: any[] = [];
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  const pageWindow = { parent, setTimeout: () => 1, clearTimeout() {}, addEventListener(type: string, listener: (event: any) => void) { if (type === 'message') listeners.push(listener); } } as unknown as Window & { steamHarnessKanban: KanbanBrowserApi };
  new Function('window', 'document', createKanbanBridgeScript({ id: 'default', name: 'Default', params: {} }, 'nonce').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))(pageWindow, { readyState: 'complete' });
  const reply = (value: unknown) => listeners.forEach(listener => listener({ source: parent, data: { type: 'steamharness:kanban-bridge-response', nonce: 'nonce', requestId: posted.at(-1).requestId, ok: true, value } }));
  const connected = pageWindow.steamHarnessKanban.databases.connect(descriptor);
  expect(posted.at(-1)).toMatchObject({ operation: 'database.resolve', input: { database: 'main', schemaHash: descriptor.schemaHash } });
  reply(binding);
  const client = await connected as any;
  const rows = client.task.rows({ orderBy: { id: 'asc' } });
  expect(posted.at(-1)).toMatchObject({ operation: 'database.query', input: { database: 'main', binding, schemaHash: descriptor.schemaHash, request: { operation: 'rows', model: 'Task', orderBy: { id: 'asc' } } } });
  reply({ items: [{ values: { id: 'one' }, rowVersion: '123' }], total: 1, page: 1, pageSize: 50 });
  await expect(rows).resolves.toMatchObject({ total: 1 });
  expect(JSON.stringify(posted)).not.toMatch(/connectionString|password/);
});
