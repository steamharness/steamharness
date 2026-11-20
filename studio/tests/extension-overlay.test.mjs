import assert from 'node:assert/strict';
import { test } from 'node:test';
import { context } from 'esbuild';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { overlayExtensionBuildPlugin, stageOverlayExtension } from '../scripts/extension-overlay.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'studio-overlay-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), stage = path.join(root, 'stage');
  await fs.mkdir(path.join(source, 'dist/document-preview'), { recursive: true });
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'package.json'), '{"edition":"overlay"}');
  await fs.writeFile(path.join(source, 'dist/extension.js'), 'module.exports = "first";');
  await fs.writeFile(path.join(source, 'dist/extension-web.js'), 'module.exports = "web";');
  await fs.writeFile(path.join(source, 'dist/document-preview/main.js'), 'first renderer');
  return { root, source, stage };
}

test('overlay migration keeps executable paths owned and preview assets linked to subsequent builds', async t => {
  const { source, stage } = await fixture(t);
  await fs.symlink(path.join(source, 'dist'), path.join(stage, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await stageOverlayExtension(source, stage);
  for (const name of ['extension.js', 'extension-web.js']) {
    assert.equal(path.relative(await fs.realpath(stage), await fs.realpath(path.join(stage, 'dist', name))), path.join('dist', name));
    assert.equal(await fs.readFile(path.join(stage, 'dist', name), 'utf8'), await fs.readFile(path.join(source, 'dist', name), 'utf8'));
  }
  await fs.writeFile(path.join(source, 'dist/document-preview/main.js'), 'updated renderer');
  assert.equal(await fs.readFile(path.join(stage, 'dist/document-preview/main.js'), 'utf8'), 'updated renderer');
  assert.equal(await fs.readFile(path.join(stage, 'package.json'), 'utf8'), '{"edition":"overlay"}');
});

test('successful extension rebuilds update the staged entry while a failed rebuild preserves its last working bundle', async t => {
  const { source, stage } = await fixture(t);
  await stageOverlayExtension(source, stage);
  const entry = path.join(source, 'entry.cjs'), output = path.join(source, 'dist/extension.js');
  await fs.writeFile(entry, 'module.exports = "first";');
  const builder = await context({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'cjs',
    logLevel: 'silent', plugins: [overlayExtensionBuildPlugin(source, stage, 'extension.js')] });
  t.after(() => builder.dispose());
  for (const value of ['second', 'third']) {
    await fs.writeFile(entry, `module.exports = ${JSON.stringify(value)};`);
    await builder.rebuild();
    assert.equal(await fs.readFile(path.join(stage, 'dist/extension.js'), 'utf8'), await fs.readFile(output, 'utf8'));
    assert.match(await fs.readFile(output, 'utf8'), new RegExp(value));
  }
  const working = await fs.readFile(path.join(stage, 'dist/extension.js'), 'utf8');
  await fs.writeFile(entry, 'module.exports = (');
  await assert.rejects(builder.rebuild());
  assert.equal(await fs.readFile(path.join(stage, 'dist/extension.js'), 'utf8'), working);
});

test('public extension builds do not create an overlay stage', async t => {
  const { source, root } = await fixture(t), stage = path.join(root, 'absent');
  const builder = await context({ entryPoints: [path.join(source, 'dist/extension.js')], outfile: path.join(source, 'rebuilt.js'),
    platform: 'node', logLevel: 'silent', plugins: [overlayExtensionBuildPlugin(source, stage, 'extension.js')] });
  t.after(() => builder.dispose());
  await builder.rebuild();
  await assert.rejects(fs.access(stage), { code: 'ENOENT' });
});
