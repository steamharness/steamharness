import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/user-models.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), structuredClone, URL });
const { UserModels, USER_MODELS_SECRET } = module.exports;
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

test('OSS rejects forged system models; private catalogue revalidates authorization and never persists proxy credentials', async () => {
  const f = fixture();
  await assert.rejects(f.update({ action: 'save', model: system }), /unavailable/);
  const registration = f.store.registerCatalogProvider({ load: async () => ({ entries: [{ id: system.credentialId, name: 'Plan', models: [{ id: system.model, name: system.model }] }] }) });
  await f.update({ action: 'save', model: system });
  await assert.rejects(f.update({ action: 'save', model: { ...system, model: 'removed' } }), /unavailable/);
  await assert.rejects(f.update({ action: 'save', model: { ...system, credentialToken: 'must-not-store' } }), /invalid/);
  registration.dispose(); assert.equal(f.store.models().length, 0);
  await f.update({ action: 'save', model: third });
  assert.ok(JSON.parse(f.values.get(USER_MODELS_SECRET)).models.some(model => model.source === 'system'), 'An OSS window preserves hidden private references');
});

test('catalogue races reject obsolete providers, cancellation and a newer cross-window revision', async () => {
  const f = fixture(); let finish;
  const registration = f.store.registerCatalogProvider({ load: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.update({ action: 'save', model: system });
  await new Promise(resolve => setImmediate(resolve));
  f.values.set(USER_MODELS_SECRET, JSON.stringify({ version: 1, revision: 1, models: [third] }));
  finish({ entries: [{ id: system.credentialId, name: 'Plan', models: [{ id: system.model, name: system.model }] }] });
  await assert.rejects(pending, /another window/);
  assert.equal(f.store.models()[0].id, third.id);
  const stale = f.store.catalog(signal()); registration.dispose(); finish({ entries: [] });
  await assert.rejects(stale, /changed/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.store.update({ revision: 1, action: 'delete', id: third.id }, abort.signal), /cancelled/);
  assert.equal(f.writes(), 0);
});
