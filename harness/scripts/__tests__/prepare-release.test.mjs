import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareRelease } from '../prepare-release.mjs';
import { writeReleaseFixture } from '../../../docs/scripts/__tests__/release-fixture.mjs';

test('Core preparation requires a matching bilingual version page and does not rewrite docs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'steamharness-core-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docsRoot = path.join(root, 'docs');
  const manifest = '{"name":"steamharness","version":"1.1.0"}\n';
  await writeFile(path.join(root, 'package.json'), manifest);
  const options = { root, docsRoot, version: '1.1.0' };
  await assert.rejects(prepareRelease({ ...options, version: '1.1.0-alpha.1' }), /stable X.Y.Z/u);
  await assert.rejects(prepareRelease({ ...options, version: '1.2.0' }), /package.json must be changed/u);
  await writeReleaseFixture(docsRoot, 'core', 'unreleased');
  await assert.rejects(prepareRelease(options), /Missing release notes/u);
  await writeReleaseFixture(docsRoot, 'core', '1.1.0', { enId: 'another-entry' });
  await assert.rejects(prepareRelease(options), /note IDs\/sections differ/u);
  const files = await writeReleaseFixture(docsRoot, 'core', '1.1.0');
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
  assert.deepEqual((await prepareRelease(options)).docsPaths, {
    'zh-CN': '/guides/releases/core/v1.1.0/', en: '/en/guides/releases/core/v1.1.0/',
  });
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), manifest);
});
