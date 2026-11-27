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
const unrelatedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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
const data = (storage, entryId, prefix = []) => path.join(storage, 'projects', projectId, ...prefix, 'entries', entryId);
const memoryName = (id = projectId, entryId = 'agent') => createHash('sha256').update(JSON.stringify([id, entryId])).digest('hex') + '.sqlite';
const memoryPath = (directory, id, entryId) => path.join(directory, 'runtime', 'memories', memoryName(id, entryId));
const register = (directory, entryId, projectType, id = projectId) => write(path.join(directory, 'project.json'),
  JSON.stringify({ version: 1, projectId: id, entryId, projectType }));

async function putMemory(file, count, entryId = 'agent') {
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE bot_memories(project_id TEXT, entry_id TEXT)');
    const insert = db.prepare('INSERT INTO bot_memories VALUES (?, ?)');
    for (let i = 0; i < count; i++) insert.run(projectId, entryId);
    insert.run(projectId, 'other');
    insert.run(unrelatedId, 'agent');
  } finally { db.close(); }
  return (await stat(file)).size;
}

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
  const memoryFile = memoryPath(data(f.storage, 'agent'));
  await putMemory(memoryFile, 1);
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
  assert.deepEqual(await readdir(path.dirname(memoryFile)), [memoryName()]);
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

test('bad history records do not hide readable session and run counts or a valid last-run timestamp', async t => {
  const f = await fixture(t);
  await declare(f.project, [bot, workflow]);
  const conversations = await history(data(f.storage, 'agent'), [
    ['conversation', { messages: [{}, {}] }], ['conversation', {}],
  ]);
  conversations.db.exec("UPDATE history SET record='not valid JSON' WHERE key='1'");
  conversations.db.close();
  const workflowHistory = await history(data(f.storage, 'task'), [
    ['run', { state: { createdAt: timestamp } }], ['run', { state: { createdAt: 'not a timestamp' } }],
    ['run', {}], ['run', { state: { createdAt: 9e15 } }],
  ]);
  workflowHistory.db.exec("UPDATE history SET record='not valid JSON' WHERE key='2'");
  workflowHistory.db.close();

  const { usage } = await f.read('runtime');
  assert.equal(usage.state, 'partial');
  const [agent, task] = usage.entries;
  assert.equal(agent.conversation.sessions, 2);
  assert.equal(agent.conversation.messages, undefined);
  assert.equal(task.workflow.runs, 4);
  assert.equal(task.workflow.lastRunAt, timestamp);
});

test('folder Bot memory usage includes the scoped stores but does not read other instances', async t => {
  const f = await fixture(t);
  await declare(f.project, [{ ...bot, folderContext: true }]);
  const locate = (instanceId, folder) => path.join(data(f.storage, 'agent', ['instances', instanceId]), 'runtime',
    ...(folder ? ['memories-by-directory', createHash('sha256').update(folder).digest('hex')] : []), 'memories', memoryName());
  const managed = { instanceId: instance1, directory: f.project, projectId, entryId: 'agent', name: 'Folder Bot', projectDirectory: f.project };
  const scoped = locate(instance1, 'linked-project');
  const scopedBytes = await putMemory(scoped, 2);
  const secondBytes = await putMemory(locate(instance2, 'linked-project'), 4);
  assert.deepEqual((await f.read('runtime', { managed })).usage.entries[0].memory,
    { state: 'ok', location: scoped, created: true, records: 2, bytes: scopedBytes });
  const primary = locate(instance1), primaryBytes = await putMemory(primary, 1);
  assert.deepEqual((await f.read('runtime', { managed })).usage.entries[0].memory,
    { state: 'ok', location: primary, created: true, records: 3, bytes: scopedBytes + primaryBytes });
  assert.deepEqual((await f.read('runtime')).usage.entries[0].memory,
    { state: 'ok', location: primary, created: true, records: 7, bytes: scopedBytes + primaryBytes + secondBytes });
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

test('project usage combines source, release and folder Bot records while an instance only sees its own data', async t => {
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
  for (const [index, prefix] of [[], ['workspaces', 'a'.repeat(64)], ['instances', instance1], ['instances', instance2]].entries()) {
    const db = await history(data(f.storage, 'agent', prefix), [['conversation', { messages: new Array(index + 1).fill({}) }]]);
    db.db.close();
  }
  const otherProject = path.join(f.storage, 'projects', unrelatedId, 'instances', instance1, 'entries', 'agent');
  (await history(otherProject, [['conversation', { messages: new Array(20).fill({}) }]])).db.close();
  // A second checkout with the same manifest identity does not create another copy of the storage.
  const secondCheckout = path.join(f.root, 'another checkout');
  await declare(secondCheckout, [bot]);
  const releaseUri = pathToFileURL(release).href;
  const variant = instanceId => ({ instanceId, directory: f.project, projectId, entryId: 'agent', name: 'Folder Bot', projectDirectory: f.project });
  const states = await Promise.all([f.read('runtime'), f.read('runtime', { uri: releaseUri }),
    f.read('runtime', { uri: pathToFileURL(secondCheckout).href }), f.read('runtime', { managed: variant(instance1) }), f.read('runtime', { managed: variant(instance2) })]);
  assert.deepEqual(states.map(snapshot => snapshot.usage.entries[0]?.conversation.messages), [10, 10, 10, 3, 4]);
  assert.equal(states[0].usage.location, undefined);
  assert.equal(states[0].usage.entries[0].conversation.sessions, 4);
  assert.equal(states[4].usage.location, path.dirname(path.dirname(data(f.storage, 'agent', ['instances', instance2]))));
});

test('saved entry identities preserve retired histories and distinguish old versions of an entry with a new type', async t => {
  const f = await fixture(t);
  await declare(f.project, [bot]);
  const current = data(f.storage, 'agent'), oldEntry = data(f.storage, 'agent', ['workspaces', 'a'.repeat(64)]);
  const oldBot = data(f.storage, 'retired', ['instances', instance1]);
  const wrongOwner = data(f.storage, 'foreign', ['workspaces', 'a'.repeat(64)]);
  await register(oldEntry, 'agent', 'workflow');
  await register(oldBot, 'retired', 'bot');
  await register(wrongOwner, 'foreign', 'bot', unrelatedId);
  (await history(current, [['conversation', { messages: [{}, {}] }]])).db.close();
  (await history(oldEntry, [['run', { state: { createdAt: timestamp } }]])).db.close();
  (await history(oldBot, [['conversation', { messages: [{}, {}, {}] }]])).db.close();
  (await history(wrongOwner, [['conversation', { messages: new Array(20).fill({}) }]])).db.close();
  await putMemory(memoryPath(oldBot, projectId, 'retired'), 1, 'retired');

  const { usage } = await f.read('runtime');
  assert.equal(usage.state, 'ok');
  assert.equal(usage.entries.length, 3);
  assert.equal(usage.entries[0].conversation.messages, 2);
  const workflow = usage.entries.find(entry => entry.type === 'workflow');
  assert.equal(workflow.entryId, 'agent');
  assert.equal(workflow.workflow.runs, 1);
  const retired = usage.entries.find(entry => entry.entryId === 'retired');
  assert.equal(retired.conversation.messages, 3);
  assert.equal(retired.memory.records, 1);
  assert.ok(usage.size.bytes >= retired.conversation.bytes + retired.memory.bytes + workflow.workflow.bytes);

  const managed = { instanceId: instance1, directory: f.project, projectId, entryId: 'agent', name: 'Folder Bot', projectDirectory: f.project };
  assert.deepEqual((await f.read('runtime', { managed })).usage.entries.map(row => [row.entryId, row.conversation.sessions]), [['agent', 0]]);

  const legacy = await history(data(f.storage, 'unmarked'), [['run', { state: { createdAt: timestamp } }]]);
  legacy.db.close();
  const partial = (await f.read('runtime')).usage;
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.size, { state: 'ok', bytes: usage.size.bytes + (await stat(legacy.file)).size });
  assert.equal(partial.entries.length, 3);
});

test('measures assistant histories across workdirs and exact memory-only scopes without mixing projects or accounts', async t => {
  const f = await fixture(t);
  await declare(f.project, [bot, workflow]);
  function hashed(storage, workdir, id = projectId, entry = 'agent') {
    return path.join(storage, 'projects', id, 'workspaces', createHash('sha256').update(workdir).digest('hex'), 'entries', entry);
  }
  const first = hashed(f.storage, f.project), second = hashed(f.storage, path.join(f.root, 'a closed workdir'), projectId, workflow.entryId);
  await register(first, bot.entryId, bot.type, projectId.toUpperCase());
  const firstHistory = await history(first, [['conversation', { messages: [{}, {}] }], ['conversation', { messages: [{}] }, 1]]);
  firstHistory.db.close();
  const firstMemory = await putMemory(memoryPath(first), 2);
  // Studio Control and the Bot can write different record kinds under the same assistant workdir.
  await register(second, workflow.entryId, workflow.type);
  const secondHistory = await history(second, [['conversation', { messages: [{}, {}, {}] }],
    ['run', { state: { createdAt: timestamp } }], ['run', { state: { createdAt: timestamp + 500 } }, 1]]);
  secondHistory.db.close();
  const secondBot = hashed(f.storage, path.join(f.root, 'a closed workdir'));
  const secondMemory = await putMemory(memoryPath(secondBot), 5);
  const memoryOnly = hashed(f.storage, path.join(f.root, 'a selected memory directory'));
  const elsewhere = await putMemory(memoryPath(memoryOnly), 3);
  // A memory-only entry does not need to be opened in the editor.
  const otherProject = hashed(f.storage, f.project, unrelatedId);
  await register(otherProject, bot.entryId, bot.type, unrelatedId);
  (await history(otherProject, [['conversation', { messages: new Array(20).fill({}) }]])).db.close();
  await putMemory(memoryPath(otherProject), 20);
  const otherAccount = hashed(path.join(f.root, 'other-account', 'runs'), f.project);
  await register(otherAccount, bot.entryId, bot.type);
  (await history(otherAccount, [['conversation', { messages: new Array(20).fill({}) }]])).db.close();
  await symlink(otherAccount, path.join(f.storage, 'f'.repeat(24)), 'junction');

  const { usage } = await f.read('runtime');
  assert.equal(usage.state, 'ok');
  assert.equal(usage.location, undefined);
  const [agent, task] = usage.entries;
  assert.deepEqual([agent.conversation.sessions, agent.conversation.messages], [1, 2]);
  assert.deepEqual(agent.memory, { state: 'ok', created: true, records: 10, bytes: firstMemory + secondMemory + elsewhere });
  assert.deepEqual([task.workflow.runs, task.workflow.lastRunAt], [1, timestamp]);
  assert.equal(agent.conversation.bytes + task.workflow.bytes, (await stat(firstHistory.file)).size + (await stat(secondHistory.file)).size);
  assert.equal(usage.size.bytes, agent.conversation.bytes + task.workflow.bytes + agent.memory.bytes +
    (await stat(path.join(first, 'project.json'))).size + (await stat(path.join(second, 'project.json'))).size);
});

test('resolves a retired workdir Bot before attributing its separate memory-only directory', async t => {
  const f = await fixture(t);
  await declare(f.project, [workflow]);
  const memoryOnly = data(f.storage, 'retired', ['workspaces', '1'.repeat(64)]);
  const priorWorkdir = data(f.storage, 'retired', ['workspaces', 'f'.repeat(64)]);
  const entryId = 'retired';
  const bytes = await putMemory(memoryPath(memoryOnly, projectId, entryId), 1, entryId);
  await register(priorWorkdir, entryId, 'bot');
  (await history(priorWorkdir, [['conversation', { messages: [{}] }]])).db.close();

  const { usage } = await f.read('runtime');
  assert.equal(usage.state, 'ok');
  const retired = usage.entries.find(entry => entry.entryId === entryId);
  assert.equal(retired.conversation.messages, 1);
  assert.equal(retired.memory.records, 1);
  assert.equal(retired.memory.bytes, bytes);
});

test('does not count the same cold history or memory database twice across runtime roots', async t => {
  const f = await fixture(t);
  await declare(f.project, [bot]);
  const source = data(f.storage, 'agent'), release = data(f.storage, 'agent', ['workspaces', 'a'.repeat(64)]);
  const { db, file } = await history(source, [['conversation', { messages: [{}, {}] }]]);
  db.close();
  const memory = memoryPath(source), memoryBytes = await putMemory(memory, 1);
  await mkdir(path.dirname(memoryPath(release)), { recursive: true });
  await link(file, path.join(release, 'runtime', 'history.sqlite'));
  await link(memory, memoryPath(release));
  const { usage } = await f.read('runtime');
  assert.equal(usage.state, 'ok');
  const [agent] = usage.entries;
  const historyBytes = (await stat(file)).size;
  assert.deepEqual(agent.conversation, { state: 'ok', sessions: 1, messages: 2, bytes: historyBytes });
  assert.equal(agent.memory.records, 1);
  assert.equal(agent.memory.bytes, memoryBytes);
  assert.equal(usage.size.bytes, memoryBytes + historyBytes);
});

test('an unreadable scope or linked memory database is not reported as empty', async t => {
  const f = await fixture(t);
  await declare(f.project, [bot]);
  const local = data(f.storage, 'agent'), outside = path.join(f.root, 'outside');
  await putMemory(memoryPath(outside), 1);
  await mkdir(path.dirname(memoryPath(local)), { recursive: true });
  await symlink(memoryPath(outside), memoryPath(local), 'file');
  const linked = await f.read('runtime');
  assert.equal(linked.usage.state, 'partial');
  assert.equal(linked.usage.entries[0].memory.created, undefined);
  assert.equal(linked.usage.entries[0].memory.records, undefined);
  await rm(path.join(local, 'runtime'), { recursive: true });
  await symlink(path.join(outside, 'runtime'), path.join(local, 'runtime'), 'junction');
  const linkedRuntime = await f.read('runtime');
  assert.equal(linkedRuntime.usage.state, 'partial');
  assert.equal(linkedRuntime.usage.entries[0].memory.created, undefined);
  assert.equal(linkedRuntime.usage.entries[0].memory.records, undefined);
  const timedOut = await readProjectUsage({ uri: f.uri, storage: f.storage, part: 'runtime' }, 0);
  assert.equal(timedOut.usage.state, 'partial');
  assert.equal(timedOut.usage.entries[0].conversation.sessions, undefined);
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

  await declare(f.project, [bot]);
  const usage = (id, identity) => service.request({ id, uri: f.uri, part: 'runtime', identity, refresh: true });
  assert.equal((await usage('matching', `${projectId}:source`)).usage.state, 'ok');
  assert.equal((await usage('stale', `${unrelatedId}:release`)).usage.state, 'unavailable');
});
