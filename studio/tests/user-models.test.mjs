import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/user-models.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), structuredClone, URL, AbortController, crypto: globalThis.crypto, TextEncoder, Error });
const { UserModels, USER_MODELS_SECRET } = module.exports;
const compiledLock = await build({ entryPoints: ['extensions/studio-workstation/src/user-models-node.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const lockModule = { exports: {} };
runInNewContext(compiledLock.outputFiles[0].text, { module: lockModule, exports: lockModule.exports, require: createRequire(import.meta.url) });
const { withUserModelWriteLock } = lockModule.exports;
const third = { id: 'custom', name: 'Custom', model: 'model-one', source: 'third-party', apiKind: 'openai-responses', baseUrl: 'https://example.test/v1', apiKey: 'test-only-user-model-key' };
const system = { id: 'system', name: 'Subscribed', model: 'model-two', source: 'system', credentialId: 'subscription-one' };
const signal = () => new AbortController().signal;
function fixture() {
  const values = new Map(); let notifications = 0, writes = 0;
  const secrets = { get: async key => values.get(key), store: async (key, value) => { writes++; values.set(key, value); } };
  const store = new UserModels(secrets, () => { notifications++; });
  const update = data => store.update({ revision: store.state().revision, ...data }, signal());
  return { store, values, update, notifications: () => notifications, writes: () => writes };
}

test('user model secrets persist across workspaces without entering webview state; no-op edits are deduplicated', async () => {
  const f = fixture(); await f.store.reload();
  assert.equal(f.store.state().systemAvailable, false);
  await f.update({ action: 'save', model: third });
  assert.equal(f.store.models()[0].apiKey, third.apiKey);
  assert.ok(!JSON.stringify(f.store.state()).includes(third.apiKey));
  assert.equal(f.store.state().entries[0].hasApiKey, true);
  const state = f.store.state(); state.entries[0].name = 'mutable';
  assert.equal(f.store.models()[0].name, third.name);
  await f.update({ action: 'save', model: { ...third, apiKey: '' } });
  assert.equal(f.writes(), 1);
  const other = new UserModels({ get: async key => f.values.get(key) }, () => {}); await other.reload();
  assert.equal(other.models()[0].apiKey, third.apiKey);
  await f.update({ action: 'save', model: { ...third, id: 'second' } });
  await f.update({ action: 'default', id: 'second' });
  assert.equal(f.store.models()[0].id, 'second');
  await f.update({ action: 'delete', id: 'second' });
  assert.equal(f.store.models()[0].id, third.id);
  await assert.rejects(f.store.update({ revision: 0, action: 'delete', id: third.id }, signal()), /another window/);
  await assert.rejects(f.update({ action: 'save', model: { ...third, id: 'new', apiKey: '' } }), /invalid/);
  f.store.dispose(); other.dispose();
});

const catalog = (models = [{ id: system.model, name: 'Subscribed model' }]) => ({ entries: [{ id: system.credentialId, name: 'My account', models }] });

test('all built-in models load without saving and only the default reference is persisted', async () => {
  const f = fixture();
  await assert.rejects(f.update({ action: 'save', model: system }), /managed/);
  const list = catalog(Array.from({ length: 130 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })));
  const registration = f.store.registerCatalogProvider({ load: async () => list });
  await f.store.refreshCatalog();
  assert.equal(f.store.models().length, 130);
  assert.equal(f.writes(), 0, 'The account catalogue does not enter SecretStorage');
  const selected = f.store.models()[120];
  assert.equal(f.store.state().providerNames[selected.id], 'My account');
  await assert.rejects(f.update({ action: 'delete', id: selected.id }), /managed/);
  await assert.rejects(f.update({ action: 'save', model: { ...third, id: selected.id } }), /valid model/);
  await f.update({ action: 'default', id: selected.id });
  assert.equal(f.store.models()[0].id, selected.id);
  assert.deepEqual(JSON.parse(f.values.get(USER_MODELS_SECRET)).models, []);
  await f.store.refreshCatalog();
  assert.equal(f.store.models()[0].id, selected.id, 'Refresh preserves a stable default reference');
  const other = new UserModels({ get: async key => f.values.get(key) }, () => {});
  await other.reload(); other.registerCatalogProvider({ load: async () => list }); await other.refreshCatalog();
  assert.equal(other.models()[0].id, selected.id);
  await f.update({ action: 'save', model: third });
  await f.update({ action: 'default', id: third.id });
  assert.equal(f.store.models()[0].id, third.id);
  await f.update({ action: 'delete', id: third.id });
  assert.equal(f.store.models()[0].source, 'system');
  registration.dispose(); assert.equal(f.store.models().length, 0);
  f.store.dispose(); other.dispose();
});

test('refresh is deduplicated, preserves available models on failure and updates names from the catalogue', async () => {
  const f = fixture(); let calls = 0, fail = false, response = catalog();
  f.store.registerCatalogProvider({ load: async () => { calls++; if (fail) throw new Error('Offline'); return response; } });
  await Promise.all([f.store.refreshCatalog(), f.store.refreshCatalog()]);
  assert.equal(calls, 1);
  const id = f.store.models()[0].id;
  response = catalog([{ id: system.model, name: 'New catalogue name' }, { id: system.model, name: 'Duplicate' }, { id: 'another-model', name: 'Second model' }]);
  await f.store.refreshCatalog();
  assert.equal(f.store.models().length, 2);
  assert.equal(f.store.models()[0].id, id);
  assert.equal(f.store.models()[0].name, 'New catalogue name');
  fail = true; await assert.rejects(f.store.refreshCatalog(), /Offline/);
  assert.equal(f.store.state().catalogError, 'Offline'); assert.equal(f.store.models().length, 2);
  assert.equal(f.store.state().catalogLoading, false);
  fail = false; response = catalog([]); await f.store.refreshCatalog();
  assert.equal(f.store.models().length, 0); assert.equal(f.store.state().catalogError, undefined);
  f.store.dispose();
});

test('account switches, sign-out and provider replacement ignore late results and keep custom models', async () => {
  const f = fixture(); await f.update({ action: 'save', model: third });
  const requests = [];
  const registration = f.store.registerCatalogProvider({ load: signal => new Promise(resolve => requests.push({ signal, resolve })) });
  const first = f.store.refreshCatalog();
  f.store.setConnection({ serverUrl: 'https://server.test', accessToken: 'test-account-one' });
  const second = f.store.refreshCatalog();
  requests[1].resolve(catalog()); await second;
  assert.equal(f.store.models().length, 2);
  requests[0].resolve(catalog([{ id: 'obsolete', name: 'Obsolete' }])); await assert.rejects(first, /changed/);
  assert.ok(!JSON.stringify(f.store.models()).includes('Obsolete'));
  f.store.setConnection({ serverUrl: 'https://server.test', accessToken: 'test-account-two' });
  assert.equal(f.store.models().length, 1, 'Old account models disappear immediately');
  assert.equal(f.store.models()[0].id, third.id); assert.equal(requests[0].signal.aborted, true);
  const thirdRequest = f.store.refreshCatalog();
  f.store.setConnection(undefined);
  const signout = f.store.refreshCatalog(); requests[3].resolve({ entries: [], unavailable: true }); await signout;
  requests[2].resolve(catalog()); await assert.rejects(thirdRequest, /changed/);
  assert.equal(f.store.models().length, 1);
  const stale = f.store.refreshCatalog(); registration.dispose();
  f.store.registerCatalogProvider({ load: async () => catalog([{ id: 'replacement', name: 'Replacement' }]) });
  await f.store.refreshCatalog(); requests[4].resolve(catalog()); await assert.rejects(stale, /changed/);
  assert.equal(f.store.models().find(model => model.source === 'system').model, 'replacement');
  assert.ok(!JSON.stringify(f.store.state()).includes('test-account'));
  assert.ok(!f.values.get(USER_MODELS_SECRET).includes('test-account'));
  f.store.dispose();
});

test('legacy system IDs remain usable while names and availability come from the live catalogue', async () => {
  const f = fixture();
  f.values.set(USER_MODELS_SECRET, JSON.stringify({ version: 1, revision: 2, models: [system, third] }));
  await f.store.reload(); assert.deepEqual(f.store.models().map(model => model.id), ['custom']);
  const registration = f.store.registerCatalogProvider({ load: async () => catalog() }); await f.store.refreshCatalog();
  assert.equal(f.store.models()[0].id, system.id); assert.equal(f.store.models()[0].name, 'Subscribed model');
  await assert.rejects(f.update({ action: 'save', model: system }), /managed/);
  await assert.rejects(f.update({ action: 'save', model: { ...third, id: system.id } }), /managed/);
  registration.dispose(); await f.update({ action: 'save', model: { ...third, name: 'Edited custom' } });
  assert.ok(JSON.parse(f.values.get(USER_MODELS_SECRET)).models.some(model => model.source === 'system'), 'OSS preserves hidden legacy references');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.store.update({ revision: f.store.state().revision, action: 'delete', id: third.id }, abort.signal), /cancelled/);
  f.store.dispose();
});

test('legacy account references do not reduce the 100 custom-model allowance', async () => {
  const f = fixture();
  const customs = Array.from({ length: 99 }, (_, index) => ({ ...third, id: `custom-${index}` }));
  f.values.set(USER_MODELS_SECRET, JSON.stringify({ version: 1, revision: 1, models: [system, ...customs] }));
  await f.store.reload();
  await f.update({ action: 'save', model: { ...third, id: 'hundredth' } });
  assert.equal(f.store.models().length, 100);
  await assert.rejects(f.update({ action: 'save', model: { ...third, id: 'too-many' } }), /100 custom/);
  const restored = new UserModels({ get: async key => f.values.get(key) }, () => {}); await restored.reload();
  assert.equal(restored.models().length, 100);
  assert.equal(restored.state().error, undefined);
  f.store.dispose(); restored.dispose();
});

test('simultaneous windows cannot overwrite one revision and locks release after failed writes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-user-model-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = new Map(); let release, entered;
  const storing = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const secrets = { get: async key => values.get(key), store: async (key, value) => {
    entered(); await paused; values.set(key, value);
  } };
  const lock = run => withUserModelWriteLock(directory, run);
  const first = new UserModels(secrets, () => {}, lock), second = new UserModels(secrets, () => {}, lock);
  t.after(() => { first.dispose(); second.dispose(); });
  const save = first.update({ revision: 0, action: 'save', model: third }, signal());
  await storing;
  try {
    await assert.rejects(second.update({ revision: 0, action: 'save', model: { ...third, id: 'other' } }, signal()), /another window/);
  } finally { release(); }
  await save;
  await assert.rejects(second.update({ revision: 0, action: 'save', model: { ...third, id: 'other' } }, signal()), /another window/);
  assert.deepEqual(JSON.parse(values.get(USER_MODELS_SECRET)).models.map(model => model.id), ['custom']);
  await assert.rejects(second.update({ revision: 1, action: 'save', model: { ...third, id: 'other', apiKey: '' } }, signal()), /invalid/);
  await second.update({ revision: 1, action: 'save', model: { ...third, id: 'other' } }, signal());
  assert.deepEqual(JSON.parse(values.get(USER_MODELS_SECRET)).models.map(model => model.id), ['custom', 'other']);
});

test('model write locks exclude another process and release after that host crashes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-user-model-crash-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[1]);
    database.exec('BEGIN IMMEDIATE');
    process.send('locked');
    setInterval(() => {}, 1000);
  `, path.join(directory, 'user-models-lock.sqlite')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await once(child, 'message'), ['locked', undefined]);
  await assert.rejects(withUserModelWriteLock(directory, async () => assert.fail('Another host owns the lock')), /another window/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(await withUserModelWriteLock(directory, async () => 'saved'), 'saved');
});
