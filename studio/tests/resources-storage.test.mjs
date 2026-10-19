import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, realpath, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'import-meta-resolve';
import { runResourceRequest } from '../extensions/studio-workstation/runtime/resources-worker.mjs';

const core = await Promise.resolve().then(() => import(resolve('steamharness', new URL('../examples/conversation/package.json', import.meta.url).href))).catch(() => undefined);
const localOptions = { skip: core ? false : 'Install examples/conversation dependencies for Core storage integration checks.' };

async function fixture(t, mode = 'local') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-resources-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folderPath = path.join(root, 'project'); await mkdir(folderPath);
  const project = { id: 'resource-test-project', folderPath };
  const manifest = { id: project.id, steamHarness: { projectInfo: { dataStorage: { mode } } } };
  await writeFile(path.join(folderPath, 'package.json'), JSON.stringify(manifest));
  const storageDir = path.join(root, 'storage');
  const dataDir = path.join(storageDir, createHash('sha256').update(folderPath).digest('hex').slice(0, 24));
  const request = (input, connection, fetcher) => runResourceRequest({ project, storageDir, input, connection }, core, fetcher);
  return { root, project, manifest, storageDir, dataDir, request };
}

test('resource views read the exact project CLI namespace, retain null, and isolate conversation entries', localOptions, async t => {
  const { project, dataDir, request } = await fixture(t);
  const store = core.createLocalWorkflowKVStore({ rootDir: path.join(dataDir, 'kv') });
  await store.setValue({ storageKind: 'kv', projectId: project.id, scope: 'project', key: 'nullable', value: null });
  await store.setValue({ storageKind: 'kv', projectId: project.id, scope: 'conversation', conversationId: 'first', key: 'private', value: 'one' });
  await store.setValue({ storageKind: 'kv', projectId: 'another-project', scope: 'project', key: 'hidden', value: 'no' });
  const page = await request({ kind: 'kv', action: 'list' });
  assert.deepEqual([page.source, page.sources, page.total], ['local', ['local'], 2]);
  assert.deepEqual(page.items.map(item => item.key).sort(), ['nullable', 'private']);
  assert.equal((await request({ kind: 'kv', action: 'get', key: 'nullable' })).value, null);
  assert.equal(await request({ kind: 'kv', action: 'get', key: 'missing' }), null);
  assert.equal((await request({ kind: 'kv', action: 'get', scope: 'conversation', conversationId: 'first', key: 'private' })).value, 'one');
  assert.equal(await request({ kind: 'kv', action: 'get', scope: 'conversation', conversationId: 'second', key: 'private' }), null);
});

test('KV creation, editing, deletion, search and pagination operate through Core', localOptions, async t => {
  const { request } = await fixture(t);
  for (let index = 0; index < 32; index++) { await request({ kind: 'kv', action: 'save', create: true, key: `item-${index}`, value: { index } }); }
  const first = await request({ kind: 'kv', action: 'list' });
  const second = await request({ kind: 'kv', action: 'list', cursor: first.nextCursor });
  assert.deepEqual([first.items.length, second.items.length, first.total, first.hasMore, second.hasMore], [30, 2, 32, true, false]);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 32);
  await assert.rejects(request({ kind: 'kv', action: 'save', create: true, key: 'item-0', value: 'overwrite' }), /already exists/);
  await request({ kind: 'kv', action: 'save', key: 'item-0', value: 'updated unique value' });
  assert.equal((await request({ kind: 'kv', action: 'list', query: 'unique' })).items[0].key, 'item-0');
  assert.deepEqual(await request({ kind: 'kv', action: 'delete', key: 'item-0' }), { removed: true });
  assert.equal((await request({ kind: 'kv', action: 'list' })).total, 31);
  await assert.rejects(request({ kind: 'kv', action: 'save', key: 'bad', value: undefined }), /JSON value/);
});

test('knowledge documents share runtime PersistentValue storage and support full-text search and edits', localOptions, async t => {
  const { project, dataDir, request } = await fixture(t);
  const persistentValue = core.createWorkflowPersistentValueContext({ projectId: project.id,
    store: core.createLocalWorkflowKVStore({ rootDir: path.join(dataDir, 'values'), storageKind: 'persistent_value' }) });
  const seeded = await core.createKnowledgeDocument({ persistentValue }, { title: 'Runtime document', markdown: '# Evidence\n\nshared storage' });
  const page = await request({ kind: 'knowledge', action: 'list' });
  assert.equal(page.items[0].documentId, seeded.id);
  const match = await request({ kind: 'knowledge', action: 'list', query: 'shared' });
  assert.equal(match.search, true); assert.equal(match.items[0].documentId, seeded.id); assert.equal(match.items[0].lineNumber, 3);
  const created = await request({ kind: 'knowledge', action: 'save', create: true, title: 'Created', markdown: 'original' });
  await request({ kind: 'knowledge', action: 'save', documentId: created.id, title: 'Edited', markdown: 'changed' });
  assert.equal((await core.getKnowledgeDocument({ persistentValue }, created.id)).markdown, 'changed');
  assert.equal((await request({ kind: 'knowledge', action: 'get', documentId: created.id })).title, 'Edited');
  await request({ kind: 'knowledge', action: 'delete', documentId: created.id });
  assert.equal(await core.getKnowledgeDocument({ persistentValue }, created.id), undefined);
});

test('a bundled resource worker executes when launched through the managed extension symlink', localOptions, async t => {
  const { root, project, storageDir } = await fixture(t);
  const extension = path.join(root, 'extension'); await mkdir(extension);
  const worker = path.join(extension, 'resources-worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../extensions/studio-workstation/runtime/resources-worker.mjs', import.meta.url))],
    outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const managed = path.join(root, 'managed-extension'); await symlink(extension, managed, 'dir');
  await mkdir(path.join(project.folderPath, 'node_modules'));
  await symlink(await realpath(new URL('../examples/conversation/node_modules/steamharness', import.meta.url)), path.join(project.folderPath, 'node_modules/steamharness'), 'dir');
  const child = spawn(process.execPath, [path.join(managed, 'resources-worker.mjs')], { cwd: project.folderPath, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin.end(JSON.stringify({ project, storageDir, input: { kind: 'kv', action: 'list' } }));
  assert.equal(await exited, 0, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual([result.value.source, result.value.sources, result.value.items], ['local', ['local'], []]);
});

test('a changed manifest or forbidden storage source cannot mutate a different project', async t => {
  const { project, request } = await fixture(t);
  await assert.rejects(request({ kind: 'kv', action: 'list', source: 'server' }), /does not allow/);
  await writeFile(path.join(project.folderPath, 'package.json'), JSON.stringify({ id: 'replaced' }));
  await assert.rejects(request({ kind: 'kv', action: 'delete', key: 'secret' }), /identity has changed/);
});

test('server storage uses the declared project identity and authenticated management endpoints', async t => {
  const { request, project } = await fixture(t, 'server');
  const connection = { serverUrl: 'https://workflow.test', accessToken: 'private-host-token' };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(JSON.stringify({ errCode: 0, data: { items: [{ key: 'remote', scope: 'project', valuePreview: 'stored', valueType: 'string' }], total: 1, hasMore: false } }));
  };
  const page = await request({ kind: 'kv', action: 'list', query: 'remote' }, connection, fetcher);
  assert.equal(page.source, 'server'); assert.equal(page.items[0].title, 'remote');
  assert.equal(calls[0].url.pathname, `/api/projects/${project.id}/kv`);
  assert.equal(calls[0].url.searchParams.get('q'), 'remote');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${connection.accessToken}`);
  await request({ kind: 'knowledge', action: 'save', documentId: 'doc / ?', title: 'Edited', markdown: 'content' }, connection, async (url, options) => {
    assert.equal(new URL(url).pathname, `/api/projects/${project.id}/knowledge-documents/doc%20%2F%20%3F`);
    assert.equal(options.method, 'PUT'); assert.deepEqual(JSON.parse(options.body), { title: 'Edited', markdown: 'content' });
    return new Response(JSON.stringify({ errCode: 0, data: { id: 'doc / ?', title: 'Edited', markdown: 'content' } }));
  });
  await assert.rejects(request({ kind: 'kv', action: 'save', key: 'remote', value: 'no' }, connection, fetcher), /managed by the project runtime/);
  await assert.rejects(request({ kind: 'kv', action: 'list' }), error => error.status === 401);
  await assert.rejects(request({ kind: 'kv', action: 'list' }, connection, async () => new Response(JSON.stringify({ errCode: 1, errMessage: 'Permission denied' }), { status: 403 })), error => error.status === 403);
});

test('knowledge search pagination preserves document and line identities on the server', async t => {
  const { request } = await fixture(t, 'server');
  const page = await request({ kind: 'knowledge', action: 'list', query: 'needle', cursor: '30' }, { serverUrl: 'https://workflow.test', accessToken: 'token' }, async url => {
    assert.equal(new URL(url).searchParams.get('q'), 'needle'); assert.equal(new URL(url).searchParams.get('cursor'), '30');
    return new Response(JSON.stringify({ errCode: 0, data: { totalMatches: 33, hasMore: false, matches: [{ documentId: 'doc', title: 'Title', lineNumber: 4, line: 'needle' }] } }));
  });
  assert.equal(page.items[0].id, 'doc:4'); assert.equal(page.total, 33);
});

test('foreign server search retains pagination without a local project or Core runtime', async () => {
  const page = await runResourceRequest({ project: { id: 'owner' }, input: { kind: 'knowledge', action: 'list', source: 'server',
    projectId: 'foreign', query: 'needle', cursor: '30' }, connection: { serverUrl: 'https://workflow.test', accessToken: 'token' } }, undefined, async url => {
    assert.equal(new URL(url).pathname, '/api/projects/foreign/knowledge-documents/search');
    assert.equal(new URL(url).searchParams.get('cursor'), '30');
    return new Response(JSON.stringify({ errCode: 0, data: { totalMatches: 33, hasMore: true, nextCursor: '60',
      matches: [{ documentId: 'doc', title: 'Title', lineNumber: 4, line: 'needle' }] } }));
  });
  assert.deepEqual([page.source, page.sources, page.total, page.nextCursor, page.items[0].id], ['server', ['server'], 33, '60', 'doc:4']);
  await assert.rejects(runResourceRequest({ input: { kind: 'knowledge', action: 'delete', source: 'server', projectId: 'foreign' } }), /read-only/);
});
