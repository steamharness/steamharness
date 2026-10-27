import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ensurePinnedWindowsUpdater, ensureWindowsInnoUpdater, LEGACY_WINDOWS_UPDATER, windowsUpdaterAsset } from '../scripts/windows-updater.mjs';

const bytes = Buffer.from('MZ pinned native updater fixture');
const asset = { version: '0.0.1', sourceCommit: 'a'.repeat(40), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, url: 'https://example.com/updater.exe' };

test('non-versioned Windows installations select the legacy folder-compatible updater', async () => {
  assert.equal(windowsUpdaterAsset({ win32VersionedUpdate: false }), LEGACY_WINDOWS_UPDATER);
  assert.equal(LEGACY_WINDOWS_UPDATER.version, '0.23.0');
  for (const product of [{}, { win32VersionedUpdate: true }]) {
    assert.equal(windowsUpdaterAsset(product), undefined);
    assert.equal(await ensureWindowsInnoUpdater(product, { download: () => assert.fail('Versioned installation must keep its upstream updater') }), undefined);
  }
});

test('updater cache verifies bytes, reuses a valid artifact and repairs corruption', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-updater-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const fetchFile = async (url, file) => { assert.equal(url, asset.url); calls++; await fs.writeFile(file, bytes); };
  const file = await ensurePinnedWindowsUpdater(asset, root, fetchFile);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(await ensurePinnedWindowsUpdater(asset, root, fetchFile), file);
  assert.equal(calls, 1);
  await fs.writeFile(file, Buffer.alloc(bytes.length));
  assert.equal(await ensurePinnedWindowsUpdater(asset, root, fetchFile), file);
  assert.equal(calls, 2);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['inno_updater.exe']);
});

test('interrupted, truncated and wrong-hash updater downloads never enter the cache', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-updater-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const fetchFile of [
    async (_url, file) => { await fs.writeFile(file, bytes); throw new Error('interrupted'); },
    async (_url, file) => fs.writeFile(file, bytes.subarray(0, 3)),
    async (_url, file) => fs.writeFile(file, Buffer.alloc(bytes.length)),
  ]) {
    await assert.rejects(ensurePinnedWindowsUpdater(asset, root, fetchFile));
    const directories = await fs.readdir(root);
    assert.equal(directories.length, 1);
    assert.deepEqual(await fs.readdir(path.join(root, directories[0])), []);
  }
});
