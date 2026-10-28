import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWebServer } from '../web/server';
import type { Project, Report, Runtime } from '../web/workflow-types';

const apps: Awaited<ReturnType<typeof startWebServer>>[] = [], folders: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function fixture(database = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aggregate-web-')); folders.push(directory);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(directory, 'host'));
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(directory, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  const all = { mode: 'all' as const }, permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };
  const entries = ([['agent', 'conversation'], ['assistant', 'conversation'], ['workflow', 'workflow'], ['board', 'kanban']] as const).map(([entryId, type]) => ({
    entryId, type, name: entryId, root: entryId, entry: type === 'kanban' ? 'index.html' : 'index.ts', configuration: 'configuration.json',
    databases: database && entryId === 'agent' ? [{ alias: 'data', host: 'local' as const, permissions }] : [],
  }));
  const id = randomUUID(), pkg = { id, name: 'Aggregate test', steamHarness: { entries, defaultEntry: 'agent' } };
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(pkg));
  for (const entry of entries) {
    await mkdir(path.join(directory, entry.root));
    await writeFile(path.join(directory, entry.root, entry.entry), entry.type === 'kanban' ? '<!doctype html><title>Board</title>' : 'export {};');
    await writeFile(path.join(directory, entry.root, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'label', type: 'string' }] }));
  }
  const projects: Project[] = entries.map(entry => ({ id, entryId: entry.entryId, name: entry.name, aggregateName: pkg.name, entries, defaultEntry: 'agent', entryRoot: path.join(directory, entry.root), databases: entry.databases, folderPath: directory, uri: '', projectType: entry.type, fields: [], entrypoints: entry.type === 'workflow' ? [{ id: 'operation', title: 'Operation', fields: [] }] : [], ...(entry.type === 'workflow' ? { defaultEntrypoint: 'operation' } : {}) }));
  const active = new Map<string, { runId?: string; finish(report: Report): void }>();
  const runtime: Runtime = { available: true, inspect: vi.fn(async () => ({ projects, errors: [] })), resolveParams: vi.fn(async () => ({})),
    run: vi.fn(async request => new Promise<Report>(finish => active.set(request.project.entryId, { runId: request.runId, finish }))),
    cancel: vi.fn(runId => { for (const operation of active.values()) if (operation.runId === runId) operation.finish({ status: 'aborted' }); }),
    dispose: vi.fn(() => { for (const operation of active.values()) operation.finish({ status: 'aborted' }); }),
    uploadFiles: vi.fn(async () => []), readFile: vi.fn(), deleteFiles: vi.fn(), readResource: vi.fn(), cancelConversation: vi.fn(), deleteConversation: vi.fn(),
  };
  const open = async () => { const app = await startWebServer({ projectDir: directory, dataDir: path.join(directory, 'history'), runtime }); apps.push(app); return app; };
  let app = await open();
  const post = (entryId: string, message: object) => fetch(`${app.origin}/entries/${entryId}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${new URLSearchParams(new URL(app.url).hash.slice(1)).get('session')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
  const call = async (entryId: string, message: object) => { const response = await post(entryId, message), body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body.messages[0]; };
  return { directory, entries, runtime, active, post, call, state: (entryId: string) => call(entryId, { type: 'ready' }), get app() { return app; }, async reopen() { await app.close(); apps.splice(apps.indexOf(app), 1); app = await open(); } };
}

it('serves mixed and repeated entry types through one host and isolates drafts, configuration and restored sessions', async () => {
  const f = await fixture();
  expect((await fetch(f.app.origin, { redirect: 'manual' })).headers.get('location')).toBe('/entries/agent/');
  expect((await fetch(`${f.app.origin}/entries/missing/`)).status).toBe(404);
  const a = await f.state('agent'), b = await f.state('assistant');
  expect(a.aggregate.entries.map((entry: any) => entry.entryId)).toEqual(f.entries.map(entry => entry.entryId));
  expect(a.project.id).toBe(b.project.id); expect(a.project.entryId).toBe('agent'); expect(b.project.entryId).toBe('assistant');
  await f.call('agent', { type: 'draft', text: 'Agent draft', attachments: [] });
  await f.call('assistant', { type: 'draft', text: 'Assistant draft', attachments: [] });
  await f.call('agent', { type: 'project-configuration', call: { action: 'save', revision: a.configurations.revision, id: a.configurations.activeConfigurationId, values: { label: 'Only agent' } } });
  expect((await f.state('assistant')).configurations.configurations[0].values).toEqual({});
  expect((await f.post('assistant', { type: 'draft', applicationId: `${a.project.id}:agent`, text: 'Wrong entry', attachments: [] })).ok).toBe(false);
  await f.reopen();
  const restoredA = await f.state('agent'), restoredB = await f.state('assistant');
  expect(JSON.stringify(restoredA)).toContain('Agent draft'); expect(JSON.stringify(restoredA)).not.toContain('Assistant draft');
  expect(JSON.stringify(restoredB)).toContain('Assistant draft'); expect(JSON.stringify(restoredB)).not.toContain('Agent draft');
  expect(restoredA.configurations.configurations[0].values).toEqual({ label: 'Only agent' });
  expect((await f.state('board')).project.projectType).toBe('kanban');
});

it('keeps parallel entries running while navigating and cancels only the requested entry', async () => {
  const f = await fixture();
  for (const entry of ['agent', 'assistant']) await f.call(entry, { type: 'send', text: entry, params: {}, attachments: [] });
  await vi.waitFor(() => expect(f.active.size).toBe(2));
  await fetch(f.app.entryUrl('board')); await f.state('workflow');
  expect(f.runtime.cancel).not.toHaveBeenCalled();
  await f.call('agent', { type: 'stop' });
  await vi.waitFor(() => expect(f.runtime.cancel).toHaveBeenCalledWith(f.active.get('agent')!.runId));
  expect(f.runtime.cancel).not.toHaveBeenCalledWith(f.active.get('assistant')!.runId);
  f.active.get('assistant')!.finish({ status: 'success', output: { items: [] } });
});

it('requires database approval and binding, then applies narrowed and revoked grants to data tools', async () => {
  const f = await fixture(true);
  const database = (message: object) => f.call('agent', { type: 'databases', ...message });
  const data = (operation: string, input: object = {}) => database({ action: 'data', alias: 'data', operation, input });
  const denied = (operation: string, input: object = {}) => f.post('agent', { type: 'databases', action: 'data', alias: 'data', operation, input });
  expect((await denied('kv.getValue', { key: 'shared' })).ok).toBe(false);
  expect((await f.state('assistant')).project.entryId).toBe('assistant');
  let result = await database({ action: 'request', host: 'local', alias: 'data', target: { kind: 'create', name: 'Approved space' } });
  expect(result.value.local.spaces).toEqual([]);
  const request = result.value.local.requests[0]; expect(request.status).toBe('pending');
  const reviewMessageId = randomUUID();
  result = await database({ action: 'review', host: 'local', requestId: reviewMessageId, databaseRequestId: request.requestId, approve: true });
  expect(result.requestId).toBe(reviewMessageId);
  expect(result.value.local.requests[0]).toMatchObject({ requestId: request.requestId, status: 'approved' });
  const grant = result.value.local.grants[0], binding = result.value.local.bindings[0];
  expect((await f.post('agent', { type: 'databases', action: 'review', host: 'local', requestId: randomUUID(), databaseRequestId: request.requestId, approve: true })).ok).toBe(false);
  await database({ action: 'bind', host: 'local', alias: 'data', bindingRef: binding.bindingRef });
  expect(JSON.parse(await readFile(path.join(f.directory, 'package.json'), 'utf8')).steamHarness.entries[0].databases[0].bindingRef).toBe(binding.bindingRef);
  await data('kv.setValue', { key: 'shared', value: { count: 1 } });
  expect((await data('kv.getValue', { key: 'shared' })).value.data).toEqual({ count: 1 });
  await data('knowledge.createDocument', { id: 'guide', title: 'Guide', markdown: 'Shared knowledge' });
  expect((await data('knowledge.getDocument', { documentId: 'guide' })).value.data.markdown).toBe('Shared knowledge');
  const file = (await data('files.createFile', { name: 'guide.txt', base64: Buffer.from('attachment').toString('base64') })).value.data;
  expect((await data('files.readFile', { fileId: file.id })).value.data.base64).toBe(Buffer.from('attachment').toString('base64'));
  await database({ action: 'narrow', host: 'local', grantId: grant.grantId, permissions: { kv: { read: { mode: 'all' }, write: { mode: 'none' } }, knowledge: { read: { mode: 'none' }, write: { mode: 'none' } } } });
  for (const [operation, input] of [['kv.setValue', { key: 'shared', value: 2 }], ['knowledge.getDocument', { documentId: 'guide' }], ['files.readFile', { fileId: file.id }], ['kv.getValue', { key: 'knowledge.document.guide' }]] as const) expect((await denied(operation, input)).ok).toBe(false);
  expect((await data('kv.listValues')).value.data.items.map((item: any) => item.key)).toEqual(['shared']);
  await database({ action: 'revoke', host: 'local', grantId: grant.grantId });
  expect((await denied('kv.getValue', { key: 'shared' })).ok).toBe(false);
  expect((await f.state('assistant')).project.entryId).toBe('assistant');
});
