import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import semver from 'semver';

test('the durable feature CLI requires the Core release providing its session API', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const range = manifest.peerDependencies['steamharness'];
  assert.equal(range, manifest.devDependencies['steamharness']);
  assert.ok(semver.satisfies(manifest.devDependencies['steamharness'], range));
  for (const version of ['0.2.3', '0.2.4-20260909003', '0.2.4-20260930002', '0.2.4-20261009004', '0.2.4', '0.2.5-20261012001', '0.2.5', '0.3.0']) {
    assert.ok(!semver.satisfies(version, range), `Core ${version} does not provide the tested feature contract`);
  }
});
