import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildProjectRuntime } from '../scripts/build-workflow-runtime.mjs';
import { exists, resolveMonorepoRoot } from '../scripts/distribution.mjs';

test('bundled CLI exposes runtime storage and preserves local Agent IDs across reopen', async t => {
  const source = await resolveMonorepoRoot();
  if (!await exists(path.join(source, 'harness/dist/runtime-storage.js')) || !await exists(path.join(source, 'cli/dist/index.js'))) {
    t.skip('Build Core and CLI before checking the bundled runtime.'); return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-local-runtime-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const studio = fileURLToPath(new URL('../', import.meta.url));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const name of ['src', 'runtime']) await symlink(path.join(studio, 'extensions/studio-workstation', name), path.join(directory, name), linkType);
  await symlink(path.join(studio, 'node_modules'), path.join(directory, 'node_modules'), linkType);
  await buildProjectRuntime(directory);
  const resolve = createRequire(path.join(directory, 'dist/runtime/cli/package.json'));
  const { createLocalRuntimePersistence } = await import(pathToFileURL(resolve.resolve('steamharness/runtime-storage')).href);
  const local = createLocalRuntimePersistence({ directory: path.join(directory, 'history') });
  try {
    const first = await local.agentStorage('bundled', 'agent').open();
    const id = await first.storage.mintId();
    assert.ok(Number.isSafeInteger(id));
    assert.equal(await first.storage.mintId(), id + 1);
    await first.release();
    const reopened = await local.agentStorage('bundled', 'agent').open();
    assert.equal(await reopened.storage.mintId(), id + 2);
    await reopened.release();
  } finally { await local.close(); }
});
