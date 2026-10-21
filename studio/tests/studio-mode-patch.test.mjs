import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';

test('workspace modes apply repeatably to the pinned kernel, including temporary view placement', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'studio-mode-patch-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const kernel = path.join(fixture, 'vscode');
  const names = ['0035-studio-workspace-modes.patch', '0036-studio-webview-focus.patch', '0037-studio-steam-workspace-tabs.patch', '0038-studio-steam-group-lifecycle.patch'];
  const upstream = JSON.parse(await readFile(path.join(ROOT, 'config/upstream.json'), 'utf8'));
  const patches = names.map(name => path.join(ROOT, 'patches', name));
  const paths = [...new Set(patches.flatMap(patch => execFileSync('git', ['apply', '--numstat', patch], { cwd: path.join(ROOT, upstream.path), encoding: 'utf8' }).trim().split('\n').map(line => line.split('\t')[2])))];
  const present = execFileSync('git', ['ls-tree', '-r', '--name-only', upstream.commit, '--', ...paths], { cwd: path.join(ROOT, upstream.path), encoding: 'utf8' }).trim().split('\n');
  await mkdir(kernel, { recursive: true }); await mkdir(path.join(fixture, 'patches'));
  for (const filename of present.filter(Boolean)) {
    await mkdir(path.dirname(path.join(kernel, filename)), { recursive: true });
    await writeFile(path.join(kernel, filename), execFileSync('git', ['show', `${upstream.commit}:${filename}`], { cwd: path.join(ROOT, upstream.path) }));
  }
  for (const name of names) { await copyFile(path.join(ROOT, 'patches', name), path.join(fixture, 'patches', name)); }
  const git = args => execFileSync('git', args, { cwd: kernel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  for (const patch of [...patches].reverse()) { git(['apply', '--reverse', '--check', patch]); git(['apply', '--reverse', patch]); }
  git(['add', '--all']);
  git(['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(fixture, 'hooks')}`, 'commit', '--quiet', '-m', 'pinned kernel fixture']);
  await applyPatches(fixture, kernel);
  const first = await Promise.all(paths.map(filename => readFile(path.join(kernel, filename), 'utf8')));
  await applyPatches(fixture, kernel);
  assert.deepEqual(await Promise.all(paths.map(filename => readFile(path.join(kernel, filename), 'utf8'))), first);
});
