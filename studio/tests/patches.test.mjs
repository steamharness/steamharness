import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';
import { pinnedKernel } from './helpers/pinned-kernel.mjs';

const original = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\n';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = cwd => git(cwd, ['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'studio-patches-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'vscode');
  for (const name of ['vscode', 'patches', 'config']) { await fs.mkdir(path.join(root, name)); }
  git(upstream, ['init', '-q']);
  await fs.writeFile(path.join(upstream, 'core.txt'), original);
  git(upstream, ['add', '.']); commit(upstream);
  const index = path.join(upstream, git(upstream, ['rev-parse', '--git-path', 'index']).trim());
  return { root, upstream, index, core: path.join(upstream, 'core.txt') };
}

async function patch(root, upstream, name, contents) {
  const file = path.join(upstream, 'core.txt');
  const before = await fs.readFile(file);
  await fs.writeFile(file, contents);
  const diff = git(upstream, ['diff', '--binary', '--full-index', '--', 'core.txt']);
  await fs.writeFile(path.join(root, 'patches', name), diff);
  await fs.writeFile(file, before);
}

async function receipt(root, upstream) {
  const patches = {};
  for (const name of await fs.readdir(path.join(root, 'patches'))) {
    patches[name] = createHash('sha256').update(await fs.readFile(path.join(root, 'patches', name))).digest('hex');
  }
  await fs.writeFile(path.join(root, 'config/patches.json'), JSON.stringify({
    version: 1, commit: git(upstream, ['rev-parse', 'HEAD']).trim(), patches,
  }));
}

test('the pinned kernel skips superseded historical patches even in a shallow checkout with local edits', async t => {
  const files = ['src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css',
    'src/vs/workbench/browser/parts/titlebar/titlebarActions.ts', 'src/vs/workbench/browser/parts/titlebar/titlebarPart.ts',
    'src/vs/workbench/browser/parts/editor/studioStart.ts', 'src/vs/workbench/browser/parts/editor/media/studioStart.css',
    'src/vs/workbench/browser/parts/globalCompositeBar.ts'];
  const { upstream } = await pinnedKernel(t, [...files, 'src/vs/workbench/contrib/webview/browser/webviewElement.ts']);
  const index = path.join(upstream, '.git/index');
  const before = await Promise.all(files.map(file => fs.readFile(path.join(upstream, file))));
  await applyPatches(ROOT, upstream);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(path.join(upstream, file)))), before);
  await fs.appendFile(path.join(upstream, files[2]), '\n// staged local edit\n');
  git(upstream, ['add', '--', files[2]]);
  await fs.appendFile(path.join(upstream, files[2]), '// unstaged local edit\n');
  await fs.writeFile(path.join(upstream, 'notes.txt'), 'untracked work\n');
  const staged = await fs.readFile(index), local = await fs.readFile(path.join(upstream, files[2]));
  await applyPatches(ROOT, upstream);
  assert.deepEqual(await fs.readFile(index), staged);
  assert.deepEqual(await fs.readFile(path.join(upstream, files[2])), local);
  assert.equal(await fs.readFile(path.join(upstream, 'notes.txt'), 'utf8'), 'untracked work\n');
  assert.equal(git(upstream, ['rev-parse', '--is-shallow-repository']).trim(), 'true');
});

test('integrated receipts follow descendant commits but invalidate changed patch contents and unrelated revisions', async t => {
  const { root, upstream, core, index } = await fixture(t);
  await patch(root, upstream, '0001.patch', original.replace('delta', 'studio'));
  await fs.writeFile(core, 'successor implementation\n');
  git(upstream, ['add', '.']); commit(upstream);
  await receipt(root, upstream);
  await fs.appendFile(core, 'later refinement\n');
  git(upstream, ['add', '.']); commit(upstream);
  const before = await fs.readFile(core), staged = await fs.readFile(index);
  await applyPatches(root, upstream);
  assert.deepEqual(await fs.readFile(core), before);
  const file = path.join(root, 'patches/0001.patch');
  const previous = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, previous.replace('+studio', '+updated studio'));
  await assert.rejects(applyPatches(root, upstream), /0001.patch conflicts.*automatic merge/u);
  await fs.writeFile(file, previous);
  const recorded = JSON.parse(await fs.readFile(path.join(root, 'config/patches.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'config/patches.json'), JSON.stringify({ ...recorded, commit: '0'.repeat(40) }));
  await assert.rejects(applyPatches(root, upstream), /0001.patch conflicts/u);
  assert.deepEqual(await fs.readFile(core), before);
  assert.deepEqual(await fs.readFile(index), staged);
});

test('three-way application preserves staged and unstaged edits when patch context has changed', async t => {
  const { root, upstream, core, index } = await fixture(t);
  const name = '0001.patch';
  await patch(root, upstream, name, original.replace('delta', 'studio'));
  await fs.writeFile(core, original.replace('zeta', 'staged user edit'));
  git(upstream, ['add', 'core.txt']);
  await fs.writeFile(core, (await fs.readFile(core, 'utf8')).replace('iota', 'unstaged user edit'));
  const staged = await fs.readFile(index);
  assert.throws(() => git(upstream, ['apply', '--check', path.join(root, 'patches', name)]));
  git(upstream, ['config', 'color.ui', 'always']);
  git(upstream, ['config', 'diff.noprefix', 'true']);
  await applyPatches(root, upstream);
  const expected = original.replace('delta', 'studio').replace('zeta', 'staged user edit').replace('iota', 'unstaged user edit');
  assert.equal(await fs.readFile(core, 'utf8'), expected);
  await applyPatches(root, upstream);
  assert.equal(await fs.readFile(core, 'utf8'), expected);
  assert.deepEqual(await fs.readFile(index), staged);
});

test('a conflict in a later patch leaves the whole series, staged index and untracked files untouched', async t => {
  const { root, upstream, core, index } = await fixture(t);
  await patch(root, upstream, '0001.patch', original.replace('alpha', 'studio alpha'));
  await fs.writeFile(path.join(root, 'patches/0002.patch'),
    'diff --git a/notes.txt b/notes.txt\nnew file mode 100644\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+studio notes\n');
  await fs.writeFile(path.join(upstream, 'notes.txt'), 'user notes\n');
  await fs.appendFile(core, 'staged user edit\n'); git(upstream, ['add', 'core.txt']);
  await fs.appendFile(core, 'unstaged user edit\n');
  const staged = await fs.readFile(index), before = await fs.readFile(core);
  await assert.rejects(applyPatches(root, upstream), /Patch 0002.patch conflicts/u);
  assert.deepEqual(await fs.readFile(core), before);
  assert.deepEqual(await fs.readFile(index), staged);
  assert.equal(await fs.readFile(path.join(upstream, 'notes.txt'), 'utf8'), 'user notes\n');
});

test('a genuine content conflict keeps the original file and real index free of conflict markers', async t => {
  const { root, upstream, core, index } = await fixture(t);
  await patch(root, upstream, '0001.patch', original.replace('delta', 'studio'));
  await fs.writeFile(core, original.replace('delta', 'user delta'));
  git(upstream, ['add', 'core.txt']);
  const before = await fs.readFile(core), staged = await fs.readFile(index);
  await assert.rejects(applyPatches(root, upstream), /Patch 0001.patch conflicts/u);
  assert.deepEqual(await fs.readFile(core), before);
  assert.deepEqual(await fs.readFile(index), staged);
  assert.equal(git(upstream, ['ls-files', '--unmerged']), '');
});
