import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const source = new URL('../extensions/studio-workstation/src/', import.meta.url);
const bundle = await build({ stdin: { resolveDir: fileURLToPath(source), contents: `
  export { prepareManagedProjectStorage } from './managed-project-storage';
  export { readProjectUsage } from './project-usage-reader';
  export { assistantDataDirectory, managedProjectDataDirectory, runtimeDataDirectory } from '../../../../cli/src/web/project-data-directory';
` }, platform: 'node', format: 'esm', bundle: true, write: false });
const { prepareManagedProjectStorage, readProjectUsage, assistantDataDirectory, managedProjectDataDirectory, runtimeDataDirectory } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', anotherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const entryId = 'inbox';
const hash = value => createHash('sha256').update(value).digest('hex');
const doc = { id, name: 'Sample', version: '1.0.0', defaultEntry: entryId, entries: [{ entryId, type: 'bot', name: 'Sample Bot', root: '.', entry: 'index.ts' }] };

async function put(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value));
}

async function fixtures(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-managed-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'account', 'runs'), builds = path.join(root, 'builtin-apps'), project = path.join(root, 'project');
  await put(path.join(project, 'steamharness.json'), doc);
  const prepare = signal => prepareManagedProjectStorage({ storage, builds, projectId: id, entryId, projectType: 'bot', signal });
  async function buildAt(stamp, projectId = id, runs = storage) {
    const build = path.join(builds, stamp.repeat(24), 'project');
    const entry = { entryId, root: `entries/${entryId}`, entry: 'index.js', structure: `entries/${entryId}/structure.json` };
    await put(path.join(build, 'steamharness.release.json'), {
      kind: 'steamharness.project.release', version: 1, projectId, projectVersion: '1.0.0', inputHash: hash(stamp), buildId: hash(stamp), entries: [entry],
      files: ['steamharness.json', 'package.json', entry.structure, `${entry.root}/steamharness.json`].map(path => ({ path, size: 0, sha256: hash('') })),
    });
    const legacy = assistantDataDirectory(runs, projectId, build);
    return { build, legacy };
  }
  return { storage, project, buildAt, prepare, root };
}

const agentKey = conversation => `agent:${conversation}:agent`;
const agentFile = conversation => hash(agentKey(conversation)) + '.sqlite';
const storeFile = path.join('runtime', 'memories', hash(JSON.stringify([id, entryId])) + '.sqlite');
const attachment = 'wf_' + 'a'.repeat(32);

async function history(root, key, updatedAt, messages, fileFrom, liveWal = false) {
  const filename = path.join(root, 'runtime', 'history.sqlite');
  await mkdir(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  if (liveWal) db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`CREATE TABLE history(kind TEXT NOT NULL,key TEXT NOT NULL,scope TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(kind,key));
    CREATE TABLE agent_sessions(key TEXT PRIMARY KEY,file TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);`);
  db.prepare("INSERT INTO history VALUES('conversation',?,?,1,0,?)").run(key, key,
    JSON.stringify({ messages, state: { updatedAt }, values: [] }));
  db.prepare("INSERT INTO history VALUES('workflow','conversation-selection','conversation-selection',1,0,?)").run(JSON.stringify({ state: { activeId: key } }));
  if (fileFrom) {
    const agent = path.join(root, 'runtime', 'agents', agentFile(key));
    await mkdir(path.dirname(agent), { recursive: true });
    const node = new DatabaseSync(agent);
    try { node.exec('CREATE TABLE checkpoint(value TEXT);'); node.prepare('INSERT INTO checkpoint VALUES (?)').run(key); }
    finally { node.close(); }
    db.prepare('INSERT INTO agent_sessions(key,file) VALUES (?,?)').run(agentKey(key), agent);
  }
  return { db, filename };
}

function rows(filename, statement) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return db.prepare(statement).all().map(row => ({ ...row })); } finally { db.close(); }
}

async function memory(root, key, revision) {
  const file = path.join(root, storeFile);
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE bot_memories(project_id TEXT,entry_id TEXT,key TEXT,PRIMARY KEY(project_id,entry_id,key));
      CREATE TABLE bot_memory_sequence(singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL);`);
    db.prepare('INSERT INTO bot_memories VALUES (?,?,?)').run(id, entryId, key);
    db.prepare('INSERT INTO bot_memory_sequence VALUES (1,?)').run(revision);
  } finally { db.close(); }
}

test('uses a build-independent key for any managed project and isolates ordinary workdirs, accounts and entries', async t => {
  const f = await fixtures(t);
  const first = await f.buildAt('1'), second = await f.buildAt('2');
  const target = build => ({ id, entryId, assistant: { workdir: build, storageScope: 'managed-project' } });
  const stable = runtimeDataDirectory(f.storage, first.build, target(first.build));
  assert.equal(stable, runtimeDataDirectory(f.storage, second.build, target(second.build)));
  assert.notEqual(stable, runtimeDataDirectory(f.storage, second.build, { ...target(second.build), id: anotherId }));
  assert.notEqual(stable, runtimeDataDirectory(path.join(f.root, 'other-account'), second.build, target(second.build)));
  const workdir = build => runtimeDataDirectory(f.storage, build, { ...target(build), assistant: { workdir: build } });
  assert.notEqual(workdir(first.build), workdir(second.build));
  assert.notEqual(stable, workdir(first.build));
  assert.notEqual(runtimeDataDirectory(f.storage, f.project, { id, entryId }), runtimeDataDirectory(f.storage, f.project, { id, entryId: 'other' }));
});

test('restores all confirmed builds once, rehomes agent files and attachments, and removes the old stores', async t => {
  const f = await fixtures(t);
  const first = await f.buildAt('1'), second = await f.buildAt('2'), empty = await f.buildAt('3');
  const unrelated = await f.buildAt('4', anotherId), elsewhere = await f.buildAt('5', id, path.join(f.root, 'other-account', 'runs'));
  const workspace = assistantDataDirectory(f.storage, id, path.join(f.root, 'actual-workspace'));
  const fileLocation = path.join(first.legacy, 'files', attachment, 'preview', 'sample.txt');
  const one = await history(first.legacy, 'one', 1, [{ attachments: [{ id: attachment, path: fileLocation }] }], true, true);
  one.db.close();
  await put(fileLocation, { text: 'attached' });
  await put(path.join(first.legacy, 'files', attachment, 'metadata.json'), { path: fileLocation });
  for (const [root, key, when, messages] of [[second.legacy, 'two', 2, [{}, {}]], [empty.legacy, 'empty', 3, []],
    [unrelated.legacy, 'foreign', 1, [{}]], [elsewhere.legacy, 'foreign-account', 1, [{}]], [workspace, 'workspace-chat', 1, [{}]]]) {
    (await history(root, key, when, messages)).db.close();
  }
  await put(path.join(workspace, 'project.json'), { version: 1, projectId: id, entryId, projectType: 'bot' });
  await memory(first.legacy, 'first', 1);
  await memory(second.legacy, 'second', 4);
  const [destination, sameDestination] = await Promise.all([f.prepare(), f.prepare()]);
  assert.equal(destination, sameDestination);
  assert.equal(destination, managedProjectDataDirectory(f.storage, id));
  const migrated = path.join(destination, 'runtime', 'history.sqlite');
  assert.deepEqual(rows(migrated, "SELECT key FROM history WHERE kind='conversation' AND deleted=0 ORDER BY key"), [{ key: 'empty' }, { key: 'one' }, { key: 'two' }]);
  assert.equal(rows(migrated, "SELECT json_extract(record, '$.state.activeId') AS active FROM history WHERE key='conversation-selection'")[0].active, 'two');
  const agent = path.join(path.toNamespacedPath(destination), 'runtime', 'agents', agentFile('one'));
  assert.deepEqual(rows(migrated, 'SELECT file FROM agent_sessions'), [{ file: agent }]);
  assert.deepEqual(rows(agent, 'SELECT value FROM checkpoint'), [{ value: 'one' }]);
  const newAttachment = path.join(destination, 'files', attachment, 'preview', 'sample.txt');
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'files', attachment, 'metadata.json'), 'utf8')), { path: newAttachment });
  assert.ok(await stat(newAttachment));
  assert.deepEqual(rows(path.join(destination, storeFile), 'SELECT key FROM bot_memories ORDER BY key'), [{ key: 'first' }, { key: 'second' }]);
  assert.deepEqual(rows(path.join(destination, storeFile), 'SELECT revision FROM bot_memory_sequence'), [{ revision: 4 }]);
  for (const { legacy } of [first, second, empty]) await assert.rejects(stat(legacy), { code: 'ENOENT' });
  for (const root of [unrelated.legacy, elsewhere.legacy, workspace]) assert.ok(await stat(root));
  await f.buildAt('6');
  assert.equal(await f.prepare(), destination);
  const { usage } = await readProjectUsage({ storage: f.storage, uri: pathToFileURL(f.project).href, part: 'runtime' });
  assert.equal(usage.state, 'ok');
  // Three restored records plus the separately scoped workdir record.
  assert.equal(usage.entries[0].conversation.sessions, 4);
  assert.equal(usage.entries[0].memory.records, 2);
});

test('does not publish a partial result while an old window is active or on a conflicting saved record', async t => {
  const f = await fixtures(t);
  const first = await f.buildAt('1'), second = await f.buildAt('2');
  (await history(first.legacy, 'same', 1, [{ text: 'a' }])).db.close();
  (await history(second.legacy, 'same', 1, [{ text: 'b' }])).db.close();
  const lease = path.join(first.legacy, 'activity', randomUUID() + '.json');
  await put(lease, { version: 1, projectId: id, pid: process.pid, updatedAt: Date.now() });
  const destination = managedProjectDataDirectory(f.storage, id);
  await assert.rejects(f.prepare(), { code: 'MANAGED_PROJECT_STORAGE_BUSY' });
  await rm(lease);
  await assert.rejects(f.prepare(), /conflicting records/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  assert.ok(await stat(path.join(first.legacy, 'runtime', 'history.sqlite')));
  assert.ok(await stat(path.join(second.legacy, 'runtime', 'history.sqlite')));
});

test('a live journal without an activity lease also prevents removing the source', async t => {
  const f = await fixtures(t), first = await f.buildAt('1');
  const { db, filename } = await history(first.legacy, 'one', 1, [{}], false, true);
  try { await assert.rejects(f.prepare(), { code: 'MANAGED_PROJECT_STORAGE_BUSY' }); assert.ok(await stat(filename)); }
  finally { db.close(); }
  await f.prepare();
  await assert.rejects(stat(first.legacy), { code: 'ENOENT' });
});

test('recovers committed pages left in an orphaned WAL before removing the old data', async t => {
  const f = await fixtures(t), build = await f.buildAt('1');
  const writer = path.join(f.root, 'writer');
  const { db } = await history(writer, 'one', 1, [{ text: 'committed WAL' }], false, true);
  try { await cp(writer, build.legacy, { recursive: true }); }
  finally { db.close(); }
  const destination = await f.prepare();
  assert.deepEqual(rows(path.join(destination, 'runtime', 'history.sqlite'), "SELECT key FROM history WHERE kind='conversation'"), [{ key: 'one' }]);
  await assert.rejects(stat(build.legacy), { code: 'ENOENT' });
});
