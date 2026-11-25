import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const source = new URL('../extensions/studio-workstation/src/', import.meta.url);
const { outputFiles } = await build({ stdin: { contents: `export { readProjectUsage } from './project-usage-reader';
  export { ProjectUsageService } from './project-usage-service';`, resolveDir: fileURLToPath(source) },
  bundle: true, platform: 'node', format: 'esm', write: false });
const { readProjectUsage, ProjectUsageService } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const instance1 = '11111111-1111-4111-8111-111111111111';
const instance2 = '22222222-2222-4222-8222-222222222222';
const timestamp = Date.UTC(2026, 0, 5);
const entry = (entryId, type, file, extra) => ({ entryId, root: '.', name: entryId, type, entry: file, ...extra });
const bot = entry('agent', 'bot', 'bot.ts');
const workflow = entry('task', 'workflow', 'task.ts');
const doc = entries => ({ id: projectId, name: 'Local project', version: '1.0.0', defaultEntry: entries[0].entryId, entries });

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-project-usage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project #1');
  const storage = path.join(root, 'studio');
  await mkdir(project);
  const uri = pathToFileURL(project).href;
  return { root, project, uri, storage, read: (part, extra) => readProjectUsage({ uri, storage, part, ...extra }) };
}

async function write(filename, content) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

const declare = (directory, entries) => write(path.join(directory, 'steamharness.json'), JSON.stringify(doc(entries)));
const data = (storage, entryId, prefix = []) => path.join(storage, ...prefix, 'projects', projectId, 'entries', entryId);

async function history(root, rows, wal = true) {
  const file = path.join(root, 'runtime', 'history.sqlite');
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE history(kind TEXT, key TEXT, scope TEXT, revision INTEGER, deleted INTEGER, record TEXT, PRIMARY KEY(kind,key))');
  const insert = db.prepare("INSERT INTO history VALUES (?, ?, 'scope', 1, ?, ?)");
  rows.forEach(([kind, record, deleted = 0], index) => insert.run(kind, String(index), deleted, JSON.stringify(record)));
  return { db, file };
}

test('directory totals deduplicate hard links, include hidden files and never descend into symlinks', async t => {
  const f = await fixture(t);
  await write(path.join(f.project, '.quiet', 'file'), Buffer.alloc(12));
  await write(path.join(f.project, 'nested', 'folder', 'file'), Buffer.alloc(9));
  await write(path.join(f.project, 'root-file'), Buffer.alloc(4));
  await write(path.join(f.root, 'outside', 'should-not-count'), Buffer.alloc(128));
  await link(path.join(f.project, '.quiet', 'file'), path.join(f.project, 'nested', 'alias'));
  await symlink(path.join(f.root, 'outside'), path.join(f.project, 'external'), 'junction');
  const { usage } = await f.read('directory');
  assert.deepEqual(usage, { state: 'ok', path: f.project, bytes: 25, files: 4, directories: 3,
    folders: [{ state: 'ok', name: 'nested', bytes: 21 }, { state: 'ok', name: '.quiet', bytes: 12 }] });
  assert.equal((await f.read('runtime')).usage.state, 'not-project');
  assert.equal((await readProjectUsage({ uri: f.uri, storage: f.storage, part: 'directory' }, 0)).usage.state, 'partial');
  await assert.rejects(readdir(f.storage), { code: 'ENOENT' });
});

test('counts committed WAL rows and cold databases without initializing missing data or adding sidecars', async t => {
  const f = await fixture(t);
  await declare(f.project, [bot, workflow, entry('empty-task', 'workflow', 'empty.ts')]);
  const conversations = await history(data(f.storage, 'agent'), [
    ['conversation', { messages: [{}, {}, {}] }], ['conversation', { messages: [{}] }, 1], ['workflow', {}],
  ]);
  t.after(() => conversations.db.close());
  conversations.db.exec("BEGIN IMMEDIATE; INSERT INTO history VALUES ('conversation', 'uncommitted', 'scope', 1, 0, '{\"messages\":[{}]}')");
  const runs = await history(data(f.storage, 'task'), [['run', { state: { createdAt: timestamp } }],
    ['run', { state: { createdAt: timestamp - 10 } }], ['run', { state: { createdAt: timestamp + 10 } }, 1]]);
  runs.db.close();
  const key = createHash('sha256').update(JSON.stringify([projectId, 'agent'])).digest('hex');
  const memoryFile = path.join(data(f.storage, 'agent'), 'runtime', 'memories', `${key}.sqlite`);
  await mkdir(path.dirname(memoryFile));
  const memory = new DatabaseSync(memoryFile);
  memory.exec('PRAGMA journal_mode=WAL; CREATE TABLE bot_memories(project_id TEXT, entry_id TEXT)');
  const insert = memory.prepare('INSERT INTO bot_memories VALUES (?, ?)');
  insert.run(projectId, 'agent'); insert.run(projectId, 'other');
  memory.close();
  await write(path.join(data(f.storage, 'agent'), 'runtime', 'agents', 'agent.sqlite'), Buffer.alloc(20));

  const wal = await readFile(`${conversations.file}-wal`);
  const { usage } = await f.read('runtime');
  assert.equal(usage.state, 'ok');
  const [agent, task, empty] = usage.entries;
  assert.deepEqual([agent.conversation.sessions, agent.conversation.messages], [1, 3]);
  assert.deepEqual([agent.memory.location, agent.memory.records, agent.memory.created], [memoryFile, 1, true]);
  assert.ok(agent.conversation.bytes > wal.length && agent.memory.bytes > 0);
  assert.deepEqual([task.workflow.runs, task.workflow.lastRunAt, empty.workflow.runs], [2, timestamp, 0]);
  assert.equal(usage.size.bytes, agent.conversation.bytes + agent.memory.bytes + task.workflow.bytes);
  assert.deepEqual(await readFile(`${conversations.file}-wal`), wal);
  assert.deepEqual(await readdir(path.dirname(runs.file)), ['history.sqlite']);
  assert.deepEqual(await readdir(path.dirname(memoryFile)), [`${key}.sqlite`]);
  await assert.rejects(readdir(data(f.storage, 'empty-task')), { code: 'ENOENT' });
  conversations.db.exec('ROLLBACK');
});

test('corrupt, linked, or busy history never looks like an empty history', async t => {
  const f = await fixture(t);
  await declare(f.project, [bot, workflow]);
  const botHistory = path.join(data(f.storage, 'agent'), 'runtime', 'history.sqlite');
  await write(botHistory, 'not a database');
  const locked = await history(data(f.storage, 'task'), [['run', { state: { createdAt: timestamp } }]], false);
  t.after(() => locked.db.close());
  locked.db.exec("BEGIN EXCLUSIVE; UPDATE history SET record='{}'");
  const { usage } = await f.read('runtime');
  assert.equal(usage.state, 'partial');
  assert.equal(usage.entries[0].conversation.sessions, undefined);
  assert.equal(usage.entries[0].memory.created, false);
  assert.equal(usage.entries[1].workflow.runs, undefined);
  locked.db.exec('ROLLBACK');
  await rm(botHistory);
  await symlink(locked.file, botHistory);
  assert.equal((await f.read('runtime')).usage.entries[0].conversation.sessions, undefined);
});

test('folder Bot memory usage includes the scoped stores but does not read other instances', async t => {
  const f = await fixture(t);
  await declare(f.project, [{ ...bot, folderContext: true }]);
  const fileName = createHash('sha256').update(JSON.stringify([projectId, 'agent'])).digest('hex') + '.sqlite';
  const locate = (instanceId, folder) => path.join(data(f.storage, 'agent', ['folder-bots', instanceId]), 'runtime',
    ...(folder ? ['memories-by-directory', createHash('sha256').update(folder).digest('hex')] : []), 'memories', fileName);
  const create = async (file, count) => {
    await mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE bot_memories(project_id TEXT, entry_id TEXT)');
      const insert = db.prepare('INSERT INTO bot_memories VALUES (?, ?)');
      for (let i = 0; i < count; i++) insert.run(projectId, 'agent');
    } finally { db.close(); }
    return (await stat(file)).size;
  };
  const managed = { instanceId: instance1, directory: f.project, projectId, entryId: 'agent', name: 'Folder Bot', projectDirectory: f.project };
  const scoped = locate(instance1, 'linked-project');
  const scopedBytes = await create(scoped, 2);
  await create(locate(instance2, 'linked-project'), 4);
  assert.deepEqual((await f.read('runtime', { managed })).usage.entries[0].memory,
    { state: 'ok', location: scoped, created: true, records: 2, bytes: scopedBytes });
  const primary = locate(instance1), primaryBytes = await create(primary, 1);
  assert.deepEqual((await f.read('runtime', { managed })).usage.entries[0].memory,
    { state: 'ok', location: primary, created: true, records: 3, bytes: scopedBytes + primaryBytes });
});

test('only distinct built Kanban directories are attributed to an entry', async t => {
  const f = await fixture(t);
  await declare(f.project, [workflow, entry('board', 'kanban', 'boards/dist/index.html'),
    entry('shared-board', 'kanban', 'index.html'), entry('not-built', 'kanban', 'missing/index.html'),
    entry('hosted', 'kanban', 'hosted/index.html', { webApp: { service: 'test' } })]);
  await write(path.join(f.project, 'boards', 'dist', 'index.html'), '<html>');
  await write(path.join(f.project, 'boards', 'dist', 'assets', 'main.js'), '/* fixture */');
  await write(path.join(f.project, 'index.html'), '<html>');
  const { usage } = await f.read('runtime');
  assert.deepEqual(usage.entries.slice(1).map(row => [row.kanban.state, row.kanban.bytes]),
    [['ok', 19], ['shared', undefined], ['unbuilt', undefined], ['hosted', undefined]]);
  assert.equal(usage.size.bytes, 0);
});

test('source, compiled release, and two folder Bot instances use separate Studio namespaces', async t => {
  const f = await fixture(t);
  await declare(f.project, [bot]);
  const release = path.join(f.root, 'release'), releasedEntry = 'entries/agent';
  const releaseFiles = ['steamharness.json', 'package.json', `${releasedEntry}/structure.json`, `${releasedEntry}/steamharness.json`, `${releasedEntry}/main.js`];
  const digest = 'a'.repeat(64);
  await write(path.join(release, 'steamharness.json'), JSON.stringify({ ...doc([{ entryId: 'agent', root: releasedEntry }]), distribution: { kind: 'release', version: 1 } }));
  await write(path.join(release, releasedEntry, 'steamharness.json'), JSON.stringify({ type: 'bot', name: 'Release', entry: 'main.js' }));
  await write(path.join(release, 'steamharness.release.json'), JSON.stringify({ kind: 'steamharness.project.release', version: 1,
    projectId, projectVersion: '1.0.0', buildId: digest, inputHash: digest, entries: [{ entryId: 'agent', root: releasedEntry, entry: 'main.js', structure: `${releasedEntry}/structure.json` }],
    files: releaseFiles.map(path => ({ path, size: 0, sha256: digest })) }));
  for (const [index, prefix] of [[], ['release'], ['folder-bots', instance1], ['folder-bots', instance2]].entries()) {
    const db = await history(data(f.storage, 'agent', prefix), [['conversation', { messages: new Array(index + 1).fill({}) }]]);
    db.db.close();
  }
  const releaseUri = pathToFileURL(release).href;
  const variant = instanceId => ({ instanceId, directory: f.project, projectId, entryId: 'agent', name: 'Folder Bot', projectDirectory: f.project });
  const states = await Promise.all([f.read('runtime'), f.read('runtime', { uri: releaseUri }),
    f.read('runtime', { managed: variant(instance1) }), f.read('runtime', { managed: variant(instance2) })]);
  assert.deepEqual(states.map(snapshot => snapshot.usage.entries[0]?.conversation.messages), [1, 2, 3, 4]);
});

test('worker service shares measurements, isolates cancellation and honors explicit refresh', async t => {
  const f = await fixture(t);
  const worker = path.join(f.root, 'project-usage-worker.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('project-usage-worker.ts', source))], bundle: true, platform: 'node', format: 'cjs', outfile: worker });
  const service = new ProjectUsageService(f.storage, worker);
  t.after(() => service.dispose());
  const request = (id, extra) => service.request({ id, uri: f.uri, part: 'directory', ...extra });
  const first = request('one'), second = request('two');
  service.request({ id: 'one', cancel: true });
  assert.equal(await first, undefined);
  assert.equal((await second).usage.bytes, 0);
  await write(path.join(f.project, 'file'), 'new');
  assert.equal((await request('cached')).usage.bytes, 0);
  assert.equal((await request('refreshed', { refresh: true })).usage.bytes, 3);
  assert.equal(request('remote', { uri: 'file://remote.invalid/folder' }), undefined);
  assert.equal(request('non-file', { uri: 'vscode-remote://remote/project' }), undefined);
});
