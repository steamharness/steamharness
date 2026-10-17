import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { waitForDesktopReady } from './desktop-localization.mjs';

const source = await readFile(new URL('./desktop-readiness-extension.cjs', import.meta.url), 'utf8');
const extensionPath = path.join(os.tmpdir(), 'studio-readiness-fixture');
const readyFile = path.join(extensionPath, 'ready.json');

function readinessExtension(studio) {
  const files = new Map();
  const exports = {};
  const modules = {
    vscode: { extensions: { getExtension: id => id === 'studio.studio-workstation' ? studio : undefined } },
    'node:fs/promises': {
      writeFile: async (file, content) => files.set(file, content),
      rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    },
    'node:path': path,
  };
  vm.runInNewContext(source, { exports, require: id => modules[id] });
  return { files, activate: () => exports.activate({ extensionPath }) };
}

test('desktop readiness waits for the real Studio activation before permitting UI actions', async () => {
  let finish;
  const studio = { isActive: false, activate: () => new Promise(resolve => { finish = resolve; }) };
  const helper = readinessExtension(studio);
  const active = helper.activate();
  assert.equal(helper.files.size, 0);
  studio.isActive = true;
  finish();
  await active;
  assert.deepEqual(JSON.parse(helper.files.get(readyFile)), { ready: true });
  assert.equal(helper.files.has(`${readyFile}.tmp`), false);
});

test('desktop readiness reports failed or missing Studio activation instead of starting UI actions', async () => {
  for (const studio of [undefined, { activate: async () => { throw new Error('Activation failed'); } }]) {
    const helper = readinessExtension(studio);
    await helper.activate();
    const state = JSON.parse(helper.files.get(readyFile));
    assert.ok(state.error);
    assert.equal(state.ready, undefined);
  }
});

test('desktop startup fails promptly on activation errors and process exit', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-readiness-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ready.json');
  const running = { exitCode: null, signalCode: null };
  await writeFile(file, JSON.stringify({ ready: true }));
  await waitForDesktopReady(file, running);
  await writeFile(file, JSON.stringify({ error: 'Activation failed' }));
  await assert.rejects(waitForDesktopReady(file, running), /activation failed: Activation failed/);
  await assert.rejects(waitForDesktopReady(file, { exitCode: 1, signalCode: null }), /exited before/);
  await assert.rejects(waitForDesktopReady(file, running, 0), /activation timed out/);
});
