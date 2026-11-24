import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyBuiltinProjectRelease } from '../scripts/builtin-project-release.mjs';

test('the Studio bundle copies only the compiled release inventory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-builtin-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'bundle');
  await mkdir(path.join(source, 'entries/main'), { recursive: true });
  for (const file of ['index.ts', 'config.json', 'entries/main/index.mjs', 'entries/main/index.mjs.map']) {
    await writeFile(path.join(source, file), file);
  }
  const manifest = path.join(source, 'steamharness.release.json');
  const writeInventory = paths => writeFile(manifest, JSON.stringify({ kind: 'steamharness.project.release', version: 1,
    files: paths.map(path => ({ path })) }));
  await writeInventory(['entries/main/index.mjs']);
  await copyBuiltinProjectRelease(source, destination);
  assert.deepEqual((await readdir(destination)).sort(), ['entries', 'steamharness.release.json']);
  assert.deepEqual(await readdir(path.join(destination, 'entries/main')), ['index.mjs']);
  assert.equal(await readFile(path.join(destination, 'entries/main/index.mjs'), 'utf8'), 'entries/main/index.mjs');
  await writeInventory(['../config.json']);
  await assert.rejects(copyBuiltinProjectRelease(source, destination), /Unsafe built-in project release path/);
});
