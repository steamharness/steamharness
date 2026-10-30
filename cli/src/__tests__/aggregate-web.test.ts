import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWebServer } from '../web/server';
import { LocalDatabaseRegistry } from 'steamharness';
import type { Project, Report, Runtime } from '../web/workflow-types';

const all = { mode: 'all' as const }, permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };
const apps: Awaited<ReturnType<typeof startWebServer>>[] = [], folders: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function fixture(database = false) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aggregate-web-'))); folders.push(directory);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(directory, 'host'));
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(directory, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  const entries = ([['agent', 'conversation'], ['assistant', 'conversation'], ['workflow', 'workflow'], ['board', 'kanban']] as const).map(([entryId, type]) => ({
    entryId, type, name: entryId, root: entryId, entry: type === 'kanban' ? 'index.html' : 'index.ts', configuration: 'configuration.json',
    databases: database && entryId === 'agent' ? [{ alias: 'data', databaseId: randomUUID() }] : [],
  }));
  const id = randomUUID(), pkg = { id, name: 'Aggregate test', version: "0.1.0",  entries: entries.map(({databases, ...entry})=>({...entry,databases:databases.map(database=>database.alias)})), defaultEntry: 'agent'  };
  await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify(pkg));
  if(database) await writeFile(path.join(directory,'config.json'),JSON.stringify({version:1,databases:{data:entries[0]!.databases[0]!.databaseId}}));
  for (const entry of entries) {
    await mkdir(path.join(directory, entry.root), {recursive:true});
    await writeFile(path.join(directory, entry.root, entry.entry), entry.type === 'kanban' ? '<!doctype html><title>Board</title>' : 'export {};');
    await writeFile(path.join(directory, entry.root, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'label', type: 'string' }] }));
  }
  const projects: Project[] = entries.map(entry => ({ id, entryId: entry.entryId, name: entry.name, aggregateName: pkg.name, entries, defaultEntry: 'agent', entryRoot: path.join(directory, entry.root), databases: entry.databases, folderPath: directory, uri: '', projectType: entry.type, fields: [], entrypoints: entry.type === 'workflow' ? [{ id: 'operation', title: 'Operation', fields: [] }] : [], ...(entry.type === 'workflow' ? { defaultEntrypoint: 'operation' } : entry.type === 'kanban' ? { kanban: { artifactDir: '.', entry: entry.entry } } : {}) }));
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

it('keeps host catalogs, approvals and data out of CLI Web while retaining explicit alias binding', async () => {
  const f = await fixture(true);
  for (const action of ['request', 'review', 'revoke', 'rotate', 'narrow', 'data']) {
    expect((await f.post('agent', { type: 'databases', action, alias: 'data', host: 'local' })).ok).toBe(false);
  }
  const registry = new LocalDatabaseRegistry();
  const request = registry.request({ projectId: (await f.state('agent')).project.id, entryId: 'agent', alias: 'data', permissions, target: { kind: 'create', name: 'Approved by host' } });
  const approval = registry.review(request.requestId, { approve: true });
  const result = await f.call('agent', { type: 'databases', action: 'bind', alias: 'data', databaseId: approval.databaseId });
  expect(result.value.requirements[0]).toMatchObject({ status: 'bound', space: { name: 'Approved by host' } });
  expect(result.value).not.toHaveProperty('local'); expect(result.value).not.toHaveProperty('server');
  expect(JSON.parse(await readFile(path.join(f.directory, 'config.json'), 'utf8')).databases.data).toBe(approval.databaseId);
});

it('keeps saved cross-entry Kanban and image card URLs inside their owning aggregate mount', async () => {
  const f = await fixture(), state = await f.state('agent'), board = await f.state('board');
  await writeFile(path.join(f.directory, 'card.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const cards = [
    { cardId: 'map', kind: 'kanban', title: 'Saved map', target: { source: 'local', projectId: state.project.id, entryId: 'board', configurationId: board.configurations.activeConfigurationId } },
    { cardId: 'image', kind: 'file', target: { source: 'local', filePath: 'card.svg' } },
  ];
  f.app.controller!.current.messages.push({ id: 'answer', role: 'assistant', content: '', items: cards.map(output => ({
    metadata: { kind: 'agent-part', partType: 'tool' }, content: { status: 'success', tool: 'workflow-ui_present_card', output: { action: 'upsert', ...output } },
  })) });
  const headers = { Authorization: `Bearer ${new URLSearchParams(new URL(f.app.url).hash.slice(1)).get('session')}` };
  for (const card of cards) {
    const preview = await f.call('agent', { type: 'resource', messageId: 'answer', cardId: card.cardId, action: 'inline' });
    expect(preview.url).toMatch(/^\/entries\/agent\/resource\//);
    expect((await fetch(new URL(preview.url, f.app.origin), { headers })).status).toBe(200);
    const data = (await f.call('agent', { type: 'resource-data', id: preview.id })).data;
    const assetUrl = data.kanban?.url ?? data.content;
    expect(assetUrl).toMatch(/^\/entries\/agent\/(?:kanban|resource-assets)\//);
    const asset = await fetch(new URL(assetUrl, f.app.origin), { headers });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain(card.cardId === 'map' ? '<title>Board</title>' : '<svg');
    // This was the URL emitted before mount-aware resource previews.
    const unmounted = await fetch(new URL(assetUrl.replace('/entries/agent', ''), f.app.origin), { headers });
    expect(unmounted.status).toBe(404); expect(await unmounted.text()).toBe('Unknown project entry.');
  }
});
