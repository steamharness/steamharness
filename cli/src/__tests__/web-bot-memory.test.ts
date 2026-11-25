import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalRuntimePersistence } from 'steamharness/runtime-storage';
import { expect, it, onTestFinished, vi } from 'vitest';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { startEntryWebServer } from '../web/server';
import type { WebHostConfiguration } from '../web/host-config';
import type { Project, Runtime } from '../web/workflow-types';

async function fixture(versions: { botMemoryManagementVersion?: number; botMemoryDirectoryVersion?: number } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'steamharness-memory-upgrade-')));
  const directory = path.join(root, 'project'), dataDir = path.join(root, 'data');
  const id = randomUUID(), entryId = 'agent';
  const entry = { entryId, type: 'bot' as const, root: '.', entry: 'index.ts', name: 'Agent fixture', folderContext: true };
  const project: Project & { runtime: typeof versions } = { id, entryId, defaultEntry: entryId, projectType: 'bot', uri: '', folderPath: directory, entryRoot: directory,
    name: entry.name, aggregateName: entry.name, entries: [entry], fields: [], entrypoints: [], conversation: { engine: 'agent' }, runtime: versions };
  const runtime: Runtime = { available: true, inspect: async () => ({ projects: [project], errors: [] }), resolveParams: async () => ({}),
    run: async () => ({ status: 'success' }), uploadFiles: async () => [], readFile: async () => { throw new Error('File unavailable'); },
    deleteFiles: async () => {}, deleteConversation: async () => {}, cancelConversation: async () => {}, cancel() {}, dispose() {} };
  vi.stubEnv('STEAMHARNESS_WEB_HOST', 'studio');
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(root, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', ''); vi.stubEnv('STEAMHARNESS_SERVER_URL', '');
  const apps: Awaited<ReturnType<typeof startEntryWebServer>>[] = [];
  onTestFinished(async () => { try { await Promise.all(apps.map(app => app.close())); } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); } });
  await mkdir(directory);
  await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id, name: 'memory-agent', defaultEntry: entryId, entries: [entry] }));
  await writeFile(path.join(directory, 'index.ts'), 'export {};');

  const open = async (host: WebHostConfiguration = { surface: 'editor', localBotArtifacts: true }) => {
    const app = await startEntryWebServer({ projectDir: directory, dataDir, entryId, runtime, host }); apps.push(app);
    const token = new URLSearchParams(new URL(app.url).hash.slice(1)).get('session');
    const post = (route: string, value: object) => fetch(`${app.origin}/api/${route}`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    return { call: (body: object) => post('bot-memory', body), async state() { return (await (await post('message', { type: 'ready' })).json()).messages.find((message: { type: string }) => message.type === 'state'); } };
  };
  return { id, root, directory, dataDir, entryId, open };
}

const address = { category: 'fixture', key: 'engine' };
const read = { action: 'get', ...address };
const save = (content: string, projectPath?: string) => ({ action: 'save', ...address, content, projectPath });

it('a native Studio host advertises upgrade and refuses management if the project SDK cannot journal Bot writes', async () => {
  const app = await (await fixture()).open();
  expect(await app.state()).toMatchObject({ botMemory: 'upgrade' });
  const blocked = await app.call(save('not written'));
  expect(blocked.status).toBe(404);
  expect(await blocked.json()).toEqual({ code: 'BOT_MEMORY_UNAVAILABLE' });
});

it('an assistant resolves each opened root to that root’s original store, without following unrelated aliases or linking across libraries', async () => {
  const { id, root, directory, dataDir, entryId, open } = await fixture({ botMemoryManagementVersion: 1, botMemoryDirectoryVersion: 1 });
  const a = path.join(root, 'a'), b = path.join(root, 'b'), alias = path.join(root, 'open-b'), link = path.join(a, 'other');
  await Promise.all([mkdir(a), mkdir(b)]);
  await Promise.all([alias, link].map(target => symlink(b, target, process.platform === 'win32' ? 'junction' : 'dir')));
  const roots = [a, alias].map(folderPath => ({ folderPath, uri: pathToFileURL(folderPath).href, name: path.basename(folderPath) }));
  const host = (workdir: string): WebHostConfiguration => ({ surface: 'assistant', localBotArtifacts: true, assistantProjectDir: directory,
    assistant: { workdir, roots: workdir === a ? roots : roots.slice(1) } });
  const legacyKey = createHash('sha256').update(`assistant:${id}:${a}`).digest('hex').slice(0, 24);
  const legacy = createLocalRuntimePersistence({ directory: path.join(dataDir, legacyKey, 'runtime') });
  const { memory: previous } = await legacy.botMemory!({ projectId: id, entryId }).execute({ action: 'save', ...address, content: 'original A' });
  await legacy.close();
  const assistant = await open(host(a));
  expect(await assistant.state()).toMatchObject({ botMemory: 'ready', botMemoryDirectories: { selectable: true, primary: a, roots: [a, alias] } });
  expect(await (await assistant.call(read)).json()).toMatchObject({ memory: previous });
  const saved = await assistant.call(save('B after selecting the canonical path', b));
  expect(saved.status).toBe(200);
  const { memory: secondary } = await saved.json();
  expect(await (await assistant.call({ ...read, projectPath: alias })).json()).toMatchObject({ memory: secondary });
  const direct = await open(host(alias));
  expect(await (await direct.call(read)).json()).toMatchObject({ memory: secondary });
  const crossLink = await assistant.call({ action: 'link', projectPath: a, sourceId: (previous as { id: string }).id, targetId: secondary.id,
    expectedRevision: (previous as { revision: number }).revision, relation: 'depends_on' });
  expect(crossLink.status).toBe(404);
  expect(await crossLink.json()).toEqual({ code: 'BOT_MEMORY_NOT_FOUND' });
  for (const projectPath of [link, root, path.join(a, 'missing'), 'relative', '', null, path.join(directory, 'index.ts')]) {
    const invalid = await assistant.call({ ...save('never written'), key: 'invalid', projectPath });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: 'BOT_MEMORY_DIRECTORY_UNAVAILABLE' });
  }
  expect(await (await assistant.call({ action: 'list' })).json()).toMatchObject({ memories: [previous] });
});

it('folder contexts separate memory by subdirectory and instance', async () => {
  const { id, root, directory, open } = await fixture({ botMemoryManagementVersion: 1, botMemoryDirectoryVersion: 1 });
  const nested = path.join(directory, 'nested'), outside = path.join(root, 'outside'), link = path.join(directory, 'symlink');
  await Promise.all([mkdir(nested), mkdir(outside)]);
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const host = (projectId: string, directory: string): WebHostConfiguration => ({ surface: 'editor', localBotArtifacts: true,
    folderBot: { id: randomUUID(), projectId, directory, background: false } });
  const [first, second] = await Promise.all([open(host(id, directory)), open(host(id, directory))]);
  expect(await first.state()).toMatchObject({ botMemoryDirectories: { selectable: true, primary: directory, kind: 'folder-context' } });
  expect((await first.call(save('instance default'))).status).toBe(200);
  expect((await first.call(save('subproject', nested))).status).toBe(200);
  expect(await (await first.call({ ...read, projectPath: nested })).json()).toMatchObject({ memory: { content: 'subproject' } });
  expect(await (await first.call(read)).json()).toMatchObject({ memory: { content: 'instance default' } });
  expect(await (await second.call({ ...read, projectPath: nested })).json()).toEqual({ memory: null });
  expect(await (await second.call(read)).json()).toEqual({ memory: null });
  for (const projectPath of [outside, link]) expect((await first.call(save('never written', projectPath))).status).toBe(400);
});

it('a pre-directory SDK remains usable in the primary store and refuses explicit selectors', async () => {
  const { id, directory, open } = await fixture({ botMemoryManagementVersion: 1 });
  const legacy = await open({ surface: 'editor', localBotArtifacts: true, folderBot: { id: randomUUID(), projectId: id, directory, background: false } });
  expect(await legacy.state()).toMatchObject({ botMemory: 'ready', botMemoryDirectories: { selectable: false, primary: directory } });
  expect((await legacy.call(save('legacy writes still work'))).status).toBe(200);
  expect((await legacy.call({ ...read, projectPath: directory })).status).toBe(400);
  expect(await (await legacy.call(read)).json()).toMatchObject({ memory: { content: 'legacy writes still work' } });
});
