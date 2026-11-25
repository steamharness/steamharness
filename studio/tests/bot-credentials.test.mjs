import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const source = new URL('../extensions/studio-workstation/src/bot-credential-vault.ts', import.meta.url);
const { outputFiles } = await build({ entryPoints: [fileURLToPath(source)], bundle: true, format: 'esm', platform: 'node', write: false });
const { botCredentialNamespace, createBotCredentialVault, parseBotCredentialAction, readPickedSshKey } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

test('the native store isolates entries, projects, assistants, and folder Bot instances, with explicit rotation and deletion', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-vault-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = new Map(), storage = { async keys() { return [...values.keys()]; }, async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  let protectedStorage = true;
  const vault = (entry = 'main', instance, folder, sourcePath = path.join(root, 'project')) => createBotCredentialVault(storage, root, botCredentialNamespace(root, 'project-id', entry, sourcePath, instance, folder), async () => protectedStorage);
  const slot = { name: 'deploy', kind: 'api-key' };
  assert.equal(await vault().write(slot, 'fixture-first', false), 'saved');
  assert.equal(await vault().write(slot, 'fixture-unapproved-overwrite', false), 'existing');
  assert.deepEqual([...values.values()], ['fixture-first']);
  const bound = path.join(root, 'target');
  for (const other of [vault('other'), vault('main', 'copy-1', bound), vault('main', 'copy-2', bound), vault('main', undefined, bound), vault('main', undefined, undefined, path.join(root, 'other-project'))]) {
    assert.deepEqual(await other.list(), []);
    assert.equal(await other.exists(slot), false);
  }
  assert.deepEqual(await vault().list(), [slot]);
  await vault().write(slot, 'fixture-rotated', true);
  assert.deepEqual([...values.values()], ['fixture-rotated']);
  const cancelled = AbortSignal.abort();
  await assert.rejects(vault().write(slot, 'fixture-cancelled', true, cancelled), { name: 'AbortError' });
  protectedStorage = false;
  await assert.rejects(vault().write(slot, 'fixture-unprotected', true), /unavailable/);
  assert.deepEqual([...values.values()], ['fixture-rotated']);
  protectedStorage = true;
  await vault().remove(slot); assert.equal(values.size, 0);
});

test('SSH entry reads only a bounded selected private-key file and the pipe accepts no value or file path', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-vault-ssh-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture');
  const fixture = '-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZQ==\n-----END OPENSSH PRIVATE KEY-----\n';
  await writeFile(file, fixture);
  assert.equal(await readPickedSshKey(file), fixture);
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'symlink'); await symlink(file, alias);
    await assert.rejects(readPickedSshKey(alias));
  }
  await writeFile(file, 'ssh-ed25519 fixture-public-key');
  await assert.rejects(readPickedSshKey(file), /Invalid Bot credential/);
  await writeFile(file, Buffer.alloc(65537));
  await assert.rejects(readPickedSshKey(file), /Invalid Bot credential/);
  const slot = { name: 'deploy', kind: 'ssh-private-key' };
  const host = { type: 'bot-credential-request', id: 'id', entryId: 'agent', action: 'capture', slot };
  assert.deepEqual(parseBotCredentialAction(host), { action: 'capture', slot });
  for (const input of [{ ...host, file }, { ...host, value: fixture }, { ...host, slot: { ...slot, name: '../other' } }]) assert.equal(parseBotCredentialAction(input), undefined);
});
