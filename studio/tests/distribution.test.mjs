import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ROOT, assertUpstream, git, mergeProduct, prepareDistribution, resolveWorkflowSource } from '../scripts/distribution.mjs';

const baseProduct = {
  nameShort: 'Code - OSS', nameLong: 'Code - OSS', applicationName: 'code-oss',
  dataFolderName: '.vscode-oss', urlProtocol: 'code-oss',
  builtInExtensions: [{ name: 'upstream-debugger', sha256: 'original-checksum' }],
  defaultChatAgent: { extensionId: 'GitHub.copilot', chatExtensionId: 'GitHub.copilot-chat' },
};

test('all distribution patches have valid Git patch syntax', async () => {
  const directory = path.join(ROOT, 'patches');
  for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.patch'))) {
    assert.doesNotThrow(() => git(['apply', '--numstat', path.join(directory, name)], ROOT), name);
  }
});

test('Workflow source resolves the aggregate siblings, standalone layout and explicit override', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-workflow-source-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'studio');
  assert.equal(await resolveWorkflowSource(root, {}), path.join(directory, 'workflow'));
  const aggregate = path.join(directory, 'open-soucres');
  for (const name of ['core', 'cli']) {
    await fs.mkdir(path.join(aggregate, name), { recursive: true });
    await fs.writeFile(path.join(aggregate, name, 'package.json'), '{}');
  }
  assert.equal(await resolveWorkflowSource(root, {}), aggregate);
  await fs.rm(aggregate, { recursive: true, force: true });
  for (const name of ['core', 'cli']) {
    await fs.mkdir(path.join(directory, name));
    await fs.writeFile(path.join(directory, name, 'package.json'), '{}');
  }
  assert.equal(await resolveWorkflowSource(root, {}), directory);
  assert.equal(await resolveWorkflowSource(root, { STUDIO_STEAMHARNESS_SOURCE: path.join(directory, 'custom') }), path.join(directory, 'custom'));
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'upstream/vscode');
  const source = path.join(root, 'extensions/studio-workstation');
  for (const directory of [upstream, path.join(upstream, 'extensions'), path.join(root, 'config'),
    path.join(root, 'patches'), path.join(source, 'dist')]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await fs.writeFile(path.join(upstream, 'product.json'), `${JSON.stringify(baseProduct, null, 2)}\n`);
  await fs.writeFile(path.join(upstream, 'package.json'), '{"version":"1.141.0"}\n');
  await fs.writeFile(path.join(upstream, 'core.txt'), 'upstream\n');
  await fs.writeFile(path.join(source, 'dist/extension.js'), 'exports.activate = () => {};\n');
  await fs.writeFile(path.join(source, 'dist/extension-web.js'), 'exports.activate = () => {};\n');
  git(['init', '--quiet'], upstream);
  git(['add', 'product.json', 'package.json', 'core.txt'], upstream);
  git(['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'test fixture'], upstream);
  const lock = { path: 'upstream/vscode', ref: 'test', commit: git(['rev-parse', 'HEAD'], upstream) };
  await fs.writeFile(path.join(root, 'config/upstream.json'), JSON.stringify(lock));
  await fs.writeFile(path.join(root, 'config/product.json'), JSON.stringify({ nameShort: 'Studio', nameLong: 'Studio Workstation' }));
  return { root, upstream, source, lock };
}

test('branding preserves upstream services and fixed artifacts', () => {
  const branded = mergeProduct(baseProduct, { nameShort: 'Studio', extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' } });
  assert.deepEqual(branded.builtInExtensions, baseProduct.builtInExtensions);
  assert.deepEqual(branded.defaultChatAgent, baseProduct.defaultChatAgent);
  assert.equal(baseProduct.nameShort, 'Code - OSS');
  assert.throws(() => mergeProduct(baseProduct, { nameShort: '' }), /nonempty/);
});

test('prepare is repeatable and links the desktop and web extension', async (t) => {
  const { root, upstream, source } = await fixture(t);
  await prepareDistribution(root);
  const first = await fs.readFile(path.join(upstream, 'product.json'), 'utf8');
  await prepareDistribution(root);
  assert.equal(await fs.readFile(path.join(upstream, 'product.json'), 'utf8'), first);
  assert.equal(await fs.realpath(path.join(upstream, 'extensions/studio-workstation')), await fs.realpath(source));
});

test('branding changes update previously generated data', async (t) => {
  const { root, upstream } = await fixture(t);
  await prepareDistribution(root);
  await fs.writeFile(path.join(root, 'config/product.json'), JSON.stringify({ nameShort: 'My Studio' }));
  const { product } = await prepareDistribution(root);
  assert.equal(product.nameShort, 'My Studio');
  assert.equal(JSON.parse(await fs.readFile(path.join(upstream, 'product.json'), 'utf8')).nameShort, 'My Studio');
});

test('Web development receives Studio branding, gallery and the correct API version', async (t) => {
  const { root, upstream } = await fixture(t);
  const gallery = { serviceUrl: 'https://open-vsx.org/vscode/gallery' };
  await fs.writeFile(path.join(root, 'config/product.json'), JSON.stringify({ nameShort: 'Studio', extensionsGallery: gallery }));
  await prepareDistribution(root);
  const overrides = JSON.parse(await fs.readFile(path.join(upstream, 'product.overrides.json'), 'utf8'));
  assert.equal(overrides.nameShort, 'Studio');
  assert.equal(overrides.version, '1.141.0');
  assert.deepEqual(overrides.extensionsGallery, gallery);
  await fs.writeFile(path.join(upstream, 'product.overrides.json'), '{"nameShort":"Manual Web Change"}\n');
  await assert.rejects(prepareDistribution(root), /product.overrides.json has local edits/);
});

test('prepare preserves manual upstream branding changes', async (t) => {
  const { root, upstream } = await fixture(t);
  await prepareDistribution(root);
  const manual = `${JSON.stringify({ ...baseProduct, nameShort: 'Local Edit' })}\n`;
  await fs.writeFile(path.join(upstream, 'product.json'), manual);
  await assert.rejects(prepareDistribution(root), /has local edits/);
  assert.equal(await fs.readFile(path.join(upstream, 'product.json'), 'utf8'), manual);
});

test('an unrelated extension directory is preserved before branding', async (t) => {
  const { root, upstream } = await fixture(t);
  await fs.mkdir(path.join(upstream, 'extensions/studio-workstation'));
  const before = await fs.readFile(path.join(upstream, 'product.json'), 'utf8');
  await assert.rejects(prepareDistribution(root), /not managed/);
  assert.equal(await fs.readFile(path.join(upstream, 'product.json'), 'utf8'), before);
});

test('an unexpected upstream revision is rejected', async (t) => {
  const { root, lock } = await fixture(t);
  await fs.writeFile(path.join(root, 'config/upstream.json'), JSON.stringify({ ...lock, commit: '0'.repeat(40) }));
  await assert.rejects(assertUpstream(root), /revision mismatch/);
});

test('a broken unrelated extension link is preserved before branding', async (t) => {
  const { root, upstream } = await fixture(t);
  const link = path.join(upstream, 'extensions/studio-workstation');
  const target = path.join(root, 'missing-extension');
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await fs.readFile(path.join(upstream, 'product.json'), 'utf8');
  await assert.rejects(prepareDistribution(root), /not managed/);
  assert.equal(await fs.readlink(link), target);
  assert.equal(await fs.readFile(path.join(upstream, 'product.json'), 'utf8'), before);
});

test('patches are repeatable and preserve conflicting local changes', async (t) => {
  const { root, upstream } = await fixture(t);
  await fs.writeFile(path.join(root, 'patches/0001.patch'),
    'diff --git a/core.txt b/core.txt\n--- a/core.txt\n+++ b/core.txt\n@@ -1 +1 @@\n-upstream\n+studio\n');
  await prepareDistribution(root);
  await prepareDistribution(root);
  assert.equal(await fs.readFile(path.join(upstream, 'core.txt'), 'utf8'), 'studio\n');
  await fs.writeFile(path.join(upstream, 'core.txt'), 'user changes\n');
  await assert.rejects(prepareDistribution(root), /conflicts/);
  assert.equal(await fs.readFile(path.join(upstream, 'core.txt'), 'utf8'), 'user changes\n');
  await fs.rm(path.join(upstream, 'core.txt'));
  git(['add', '--all', '--', 'core.txt'], upstream);
  const deleted = git(['diff', '--cached'], upstream);
  await assert.rejects(prepareDistribution(root), /conflicts/);
  assert.equal(git(['diff', '--cached'], upstream), deleted);
  await assert.rejects(fs.access(path.join(upstream, 'core.txt')));
});

test('overlapping patches are recognized after applying and committing the series without changing the user index', async t => {
  const { root, upstream, lock } = await fixture(t);
  await fs.writeFile(path.join(root, 'patches/0001.patch'),
    'diff --git a/core.txt b/core.txt\n--- a/core.txt\n+++ b/core.txt\n@@ -1 +1 @@\n-upstream\n+studio\n');
  await fs.writeFile(path.join(root, 'patches/0002.patch'),
    'diff --git a/core.txt b/core.txt\n--- a/core.txt\n+++ b/core.txt\n@@ -1 +1 @@\n-studio\n+studio latest\n');
  await prepareDistribution(root);
  await prepareDistribution(root);
  assert.equal(await fs.readFile(path.join(upstream, 'core.txt'), 'utf8'), 'studio latest\n');
  assert.equal(git(['show', ':core.txt'], upstream), 'upstream');
  git(['add', 'core.txt'], upstream);
  git(['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'commit patch series'], upstream);
  await fs.writeFile(path.join(root, 'config/upstream.json'), JSON.stringify({ ...lock, commit: git(['rev-parse', 'HEAD'], upstream) }));
  await fs.writeFile(path.join(upstream, 'package.json'), '{"version":"1.141.0","userChange":true}\n');
  git(['add', 'package.json'], upstream);
  const staged = git(['diff', '--cached'], upstream);
  await prepareDistribution(root);
  assert.equal(git(['diff', '--cached'], upstream), staged);
  assert.equal(await fs.readFile(path.join(upstream, 'core.txt'), 'utf8'), 'studio latest\n');
  await fs.writeFile(path.join(upstream, 'core.txt'), 'user changes\n');
  await assert.rejects(prepareDistribution(root), /conflicts/);
  assert.equal(await fs.readFile(path.join(upstream, 'core.txt'), 'utf8'), 'user changes\n');
});
