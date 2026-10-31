import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { DatabaseSpaceRepository } from '../database-spaces';
import { LocalStorage } from '../local-storage';
import { DATABASE_ATTACHMENT_CHUNK_SIZE } from '../database-attachments';

const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL;
const options = { skip: !databaseUrl, timeout: 20_000 };
const all = { mode: 'all' as const };
const permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'database-attachments-'));
  const schema = `attachments_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!); url.searchParams.set('options', `-c search_path=${schema}`);
  const sql = new pg.Pool({ connectionString: url.toString() });
  const objects = new LocalStorage({ root, publicBaseUrl: 'http://localhost' });
  const previous = process.env.STEAMHARNESS_SERVER_DATABASE_POOL_MAX;
  process.env.STEAMHARNESS_SERVER_DATABASE_POOL_MAX = '2';
  let repository: DatabaseSpaceRepository;
  try { repository = new DatabaseSpaceRepository(url.toString(), objects); }
  finally { if (previous === undefined) delete process.env.STEAMHARNESS_SERVER_DATABASE_POOL_MAX; else process.env.STEAMHARNESS_SERVER_DATABASE_POOL_MAX = previous; }
  t.after(async () => { await repository.close(); await sql.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(root, { recursive: true, force: true }); });
  await repository.init();
  const actor = { userId: 'owner', isSystemAdmin: true };
  const consumer = { projectId: randomUUID(), entryId: 'map', alias: 'data' };
  const pending = await repository.request({ ...consumer, permissions, target: { kind: 'create', name: 'Images' } }, actor);
  const approved = await repository.review(pending.requestId, { approve: true }, actor);
  const authorization = await repository.authorization(approved.databaseId!, consumer);
  const spaceId = authorization.space.spaceId;
  const identity = { ...consumer, bindingRef: authorization.binding.bindingRef, credentialVersion: authorization.grant.credentialVersion };
  const address = (key: string, storageKind = 'kv') => ({ spaceId, storageKind, scope: 'project', key });
  const call = (operation: string, input: Record<string, unknown> = {}, signal?: AbortSignal) => repository.data(spaceId, { ...identity, operation, ...input }, actor, false, signal) as Promise<any>;
  const attachment = (bytes: Buffer) => {
    const file = { id: randomUUID(), name: 'map.png', mimeType: 'image/png', size: bytes.length, kind: 'image', storage: 'database', spaceId, createdAt: new Date().toISOString() };
    return { file, base64: bytes.toString('base64') };
  };
  return { repository, objects, sql, actor, authorization, address, call, attachment, spaceId };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Small database request was blocked by an attachment.')), ms); })]); }
  finally { clearTimeout(timeout!); }
}

test('two slow attachment downloads leave a two-connection pool available for reads and writes', options, async t => {
  const f = await fixture(t);
  const files = [f.attachment(randomBytes(1024)), f.attachment(randomBytes(1024))];
  for (const value of files) await f.call('set', { entry: f.address(`__knowledge_file:${value.file.id}`, 'persistent_value'), value });
  await f.call('set', { entry: f.address('map'), value: { points: 424 } });
  const stored = await f.sql.query("SELECT value FROM database_space_values WHERE kind='persistent_value'");
  assert.equal(stored.rows.length, 2);
  for (const row of stored.rows) { assert.equal(row.value.base64, undefined); assert.match(row.value.blob.sha256, /^[a-f0-9]{64}$/); }

  const release = deferred(), entered = deferred();
  let downloads = 0;
  const download = f.objects.downloadPrivateBuffer.bind(f.objects);
  t.mock.method(f.objects, 'downloadPrivateBuffer', async (key: string) => {
    if (++downloads === 2) entered.resolve();
    await release.promise;
    return download(key);
  });
  const pending = files.map(value => f.call('get', { entry: f.address(`__knowledge_file:${value.file.id}`, 'persistent_value') }));
  try {
    await bounded(entered.promise);
    const [map, revision, list, written] = await bounded(Promise.all([
      f.call('get', { entry: f.address('map') }), f.call('revision'),
      f.call('list', { entry: f.address('*') }), f.call('set', { entry: f.address('other'), value: true }),
    ]));
    assert.deepEqual(map.value, { points: 424 }); assert.ok(revision.revision);
    assert.ok(list.items.some((item: { key: string }) => item.key === 'map')); assert.equal(written.written, true);
  } finally { release.resolve(); }
  const result = await Promise.all(pending);
  result.forEach((value, index) => assert.deepEqual(value.value, files[index]));
  await assert.rejects(f.call('set', { entry: f.address(`__knowledge_file:${files[0].file.id}`, 'persistent_value'), value: stored.rows[0].value }), /attachment/);
});

test('legacy inline images move to private objects without changing IDs, bytes, revision or attribution', options, async t => {
  const f = await fixture(t);
  const value = f.attachment(randomBytes(2 * 1024 * 1024 + 17));
  const key = `__knowledge_file:${value.file.id}`;
  await f.sql.query("INSERT INTO database_space_values(space_id,kind,namespace,key,value,source) VALUES($1,'persistent_value','space',$2,$3,$4)", [f.spaceId, key, JSON.stringify(value), JSON.stringify({ projectId: 'original' })]);
  const before = (await f.sql.query('SELECT revision::text,source,updated_at FROM database_space_values WHERE key=$1', [key])).rows[0];
  const revision = await f.call('revision');
  const reads = await Promise.all([f.call('get', { entry: f.address(key, 'persistent_value') }), f.call('get', { entry: f.address(key, 'persistent_value') })]);
  for (const read of reads) { assert.deepEqual(read.value, value); assert.equal(read.revision, before.revision); }
  const after = (await f.sql.query('SELECT value,revision::text,source,updated_at FROM database_space_values WHERE key=$1', [key])).rows[0];
  assert.equal(after.value.base64, undefined);
  assert.equal(after.value.blob.sha256, createHash('sha256').update(Buffer.from(value.base64, 'base64')).digest('hex'));
  assert.deepEqual({ revision: after.revision, source: after.source, updated_at: after.updated_at }, before);
  assert.deepEqual(await f.call('revision'), revision);
  const object = path.join(f.objects.root, 'storage', 'database-spaces', f.spaceId, 'attachments', value.file.id, after.value.blob.sha256);
  assert.equal((await stat(object)).size, value.file.size);
  if (process.platform !== 'win32') assert.equal((await stat(object)).mode & 0o777, 0o600);
  assert.deepEqual((await f.call('get', { entry: f.address(key, 'persistent_value') })).value, value);
  await f.call('delete', { entry: f.address(key, 'persistent_value') });
  assert.deepEqual(await f.call('get', { entry: f.address(key, 'persistent_value') }), { exists: false });
});

test('permission revocation during an object download prevents its response', options, async t => {
  const f = await fixture(t);
  const value = f.attachment(Buffer.from('private image'));
  const entry = f.address(`__knowledge_file:${value.file.id}`, 'persistent_value');
  await f.call('set', { entry, value });
  const entered = deferred(), release = deferred();
  const download = f.objects.downloadPrivateBuffer.bind(f.objects);
  t.mock.method(f.objects, 'downloadPrivateBuffer', async (key: string) => { entered.resolve(); await release.promise; return download(key); });
  const pending = assert.rejects(f.call('get', { entry }), /authorization/);
  try {
    await bounded(entered.promise);
    await bounded(f.repository.manage(f.authorization.grant.grantId, 'revoke', f.actor));
  } finally { release.resolve(); }
  await pending;
});

test('cancelled legacy downloads leave the original value intact', options, async t => {
  const f = await fixture(t);
  const value = f.attachment(randomBytes(1024 * 1024));
  const key = `__knowledge_file:${value.file.id}`;
  await f.sql.query("INSERT INTO database_space_values(space_id,kind,namespace,key,value) VALUES($1,'persistent_value','space',$2,$3)", [f.spaceId, key, JSON.stringify(value)]);
  const controller = new AbortController();
  const pool = (f.repository as unknown as { pool: pg.Pool }).pool;
  const query = pool.query.bind(pool) as (text: string, values: unknown[]) => Promise<pg.QueryResult>;
  let chunks = 0;
  t.mock.method(pool, 'query', (async (text: string, values: unknown[]) => {
    const result = await query(text, values);
    if (text.startsWith('SELECT substr(') && ++chunks === 1) controller.abort(new Error('Stopped'));
    return result;
  }) as typeof pool.query);
  await assert.rejects(f.call('get', { entry: f.address(key, 'persistent_value') }, controller.signal), /Stopped/);
  assert.equal(chunks, 1);
  assert.ok(value.base64.length > DATABASE_ATTACHMENT_CHUNK_SIZE);
  assert.deepEqual((await f.sql.query('SELECT value FROM database_space_values WHERE key=$1', [key])).rows[0].value, value);
});

test('slow attachment uploads release database connections and recheck authorization before publishing metadata', options, async t => {
  const f = await fixture(t);
  const files = [f.attachment(randomBytes(1024)), f.attachment(randomBytes(1024))];
  const entered = deferred(), release = deferred();
  const upload = f.objects.uploadPrivateBuffer.bind(f.objects);
  let uploads = 0;
  t.mock.method(f.objects, 'uploadPrivateBuffer', async (key: string, bytes: Buffer) => {
    if (++uploads === 2) entered.resolve();
    await release.promise;
    return upload(key, bytes);
  });
  const pending = files.map(value => assert.rejects(f.call('set', { entry: f.address(`__knowledge_file:${value.file.id}`, 'persistent_value'), value }), /authorization/));
  try {
    await bounded(entered.promise);
    assert.equal((await bounded(f.call('set', { entry: f.address('map'), value: 424 }))).written, true);
    assert.equal((await bounded(f.call('get', { entry: f.address('map') }))).value, 424);
    await bounded(f.repository.manage(f.authorization.grant.grantId, 'revoke', f.actor));
  } finally { release.resolve(); }
  await Promise.all(pending);
  assert.equal((await f.sql.query("SELECT count(*)::int AS count FROM database_space_values WHERE kind='persistent_value'")).rows[0].count, 0);
});

test('failed legacy object storage preserves the original attachment and revision', options, async t => {
  const f = await fixture(t);
  const value = f.attachment(randomBytes(1024)), key = `__knowledge_file:${value.file.id}`;
  await f.sql.query("INSERT INTO database_space_values(space_id,kind,namespace,key,value) VALUES($1,'persistent_value','space',$2,$3)", [f.spaceId, key, JSON.stringify(value)]);
  const before = (await f.sql.query('SELECT value,revision::text,updated_at FROM database_space_values WHERE key=$1', [key])).rows[0];
  const failure = t.mock.method(f.objects, 'uploadPrivateBuffer', async () => { throw new Error('Disk unavailable'); });
  await assert.rejects(f.call('get', { entry: f.address(key, 'persistent_value') }), /Disk unavailable/);
  assert.deepEqual((await f.sql.query('SELECT value,revision::text,updated_at FROM database_space_values WHERE key=$1', [key])).rows[0], before);
  failure.mock.restore();
  assert.deepEqual((await f.call('get', { entry: f.address(key, 'persistent_value') })).value, value);
});

for (const operation of ['set', 'delete'] as const) test(`legacy migration cannot overwrite a concurrent ${operation}`, options, async t => {
  const f = await fixture(t);
  const value = f.attachment(randomBytes(1024)), key = `__knowledge_file:${value.file.id}`, entry = f.address(key, 'persistent_value');
  await f.sql.query("INSERT INTO database_space_values(space_id,kind,namespace,key,value) VALUES($1,'persistent_value','space',$2,$3)", [f.spaceId, key, JSON.stringify(value)]);
  const entered = deferred(), release = deferred();
  const upload = f.objects.uploadPrivateBuffer.bind(f.objects);
  const replacement = { ...value, base64: Buffer.alloc(1024, 1).toString('base64') };
  t.mock.method(f.objects, 'uploadPrivateBuffer', async (key: string, bytes: Buffer) => {
    if (bytes.toString('base64') === value.base64) { entered.resolve(); await release.promise; }
    return upload(key, bytes);
  });
  const pending = assert.rejects(f.call('get', { entry }), /changed during download/);
  try {
    await bounded(entered.promise);
    await bounded(f.call(operation, { entry, value: replacement }));
  } finally { release.resolve(); }
  await pending;
  const current = await f.call('get', { entry });
  if (operation === 'delete') assert.deepEqual(current, { exists: false });
  else assert.deepEqual(current.value, replacement);
});

test('attachment CAS and multi-key transactions recheck revisions after object uploads', options, async t => {
  const f = await fixture(t);
  const value = f.attachment(randomBytes(1024)), entry = f.address(`__knowledge_file:${value.file.id}`, 'persistent_value');
  await f.call('set', { entry, value });
  const before = await f.call('get', { entry });
  const entered = deferred(), release = deferred();
  const upload = f.objects.uploadPrivateBuffer.bind(f.objects);
  const replacement = { ...value, base64: Buffer.alloc(1024, 1).toString('base64') };
  t.mock.method(f.objects, 'uploadPrivateBuffer', async (key: string, bytes: Buffer) => { entered.resolve(); await release.promise; return upload(key, bytes); });
  const pending = f.call('compare-and-set', { entry, expectedRevision: before.revision, value: replacement });
  try {
    await bounded(entered.promise);
    await bounded(f.call('delete', { entry }));
  } finally { release.resolve(); }
  assert.deepEqual(await pending, { applied: false });
  assert.deepEqual(await f.call('get', { entry }), { exists: false });
  const map = f.address('map');
  await f.call('set', { entry: map, value: 'before' });
  const mapBefore = await f.call('get', { entry: map });
  const transactionEntered = deferred(), transactionRelease = deferred();
  t.mock.method(f.objects, 'uploadPrivateBuffer', async (key: string, bytes: Buffer) => { transactionEntered.resolve(); await transactionRelease.promise; return upload(key, bytes); });
  const transaction = f.call('transaction', { entries: [
    { entry, expectedRevision: null, mutation: { operation: 'set', value } },
    { entry: map, expectedRevision: mapBefore.revision, mutation: { operation: 'set', value: 'after' } },
  ] });
  try {
    await bounded(transactionEntered.promise);
    await bounded(f.call('set', { entry: map, value: 'concurrent' }));
  } finally { transactionRelease.resolve(); }
  assert.deepEqual(await transaction, { applied: false });
  assert.deepEqual(await f.call('get', { entry }), { exists: false });
  assert.equal((await f.call('get', { entry: map })).value, 'concurrent');
  const concurrent = await f.call('get', { entry: map });
  assert.deepEqual(await f.call('transaction', { entries: [
    { entry, expectedRevision: null, mutation: { operation: 'set', value } },
    { entry: map, expectedRevision: concurrent.revision, mutation: { operation: 'set', value: 'after' } },
  ] }), { applied: true });
  assert.deepEqual((await f.call('get', { entry })).value, value);
  assert.equal((await f.call('get', { entry: map })).value, 'after');
  assert.deepEqual(await f.call('transaction', { entries: [
    { entry, expectedRevision: null, mutation: { operation: 'delete' } },
    { entry: map, expectedRevision: mapBefore.revision, mutation: { operation: 'set', value: 'invalid' } },
  ] }), { applied: false });
  assert.deepEqual((await f.call('get', { entry })).value, value);
  assert.equal((await f.call('get', { entry: map })).value, 'after');
});

test('single reads observe committed data while a writer owns the space advisory lock', options, async t => {
  const f = await fixture(t);
  await f.call('set', { entry: f.address('map'), value: { points: 424 } });
  const writer = await f.sql.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`database-space:${f.spaceId}`]);
    await writer.query("UPDATE database_space_values SET value='0' WHERE key='map'");
    const [map, revision, list] = await bounded(Promise.all([
      f.call('get', { entry: f.address('map') }), f.call('revision'), f.call('list', { entry: f.address('*') }),
    ]));
    assert.deepEqual(map.value, { points: 424 });
    assert.ok(revision.revision);
    assert.deepEqual(list.items[0].value, { points: 424 });
  } finally { await writer.query('ROLLBACK'); writer.release(); }
});
