import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';

test('the account menu patches apply repeatably to the pinned kernel and preserve extension authorization commands', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'studio-account-menu-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const kernel = path.join(fixture, 'vscode');
  const filename = 'src/vs/workbench/browser/parts/globalCompositeBar.ts';
  const upstream = JSON.parse(await readFile(path.join(ROOT, 'config/upstream.json'), 'utf8'));
  const paths = [filename, 'src/vs/workbench/browser/parts/studioAccountMenu.ts', 'src/vs/workbench/browser/parts/media/studioAccountMenu.css'];
  const present = execFileSync('git', ['ls-tree', '-r', '--name-only', upstream.commit, '--', ...paths], { cwd: path.join(ROOT, upstream.path), encoding: 'utf8' }).trim().split('\n');
  for (const file of present) {
    await mkdir(path.dirname(path.join(kernel, file)), { recursive: true });
    await writeFile(path.join(kernel, file), execFileSync('git', ['show', `${upstream.commit}:${file}`], { cwd: path.join(ROOT, upstream.path) }));
  }
  const git = args => execFileSync('git', args, { cwd: kernel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  await mkdir(path.join(fixture, 'patches'));
  const patches = ['0028-studio-account-menu.patch', '0029-studio-account-menu-focus.patch'];
  for (const name of patches) { await copyFile(path.join(ROOT, 'patches', name), path.join(fixture, 'patches', name)); }
  for (const name of [...patches].reverse()) {
    const patch = path.join(fixture, 'patches', name);
    try { git(['apply', '--reverse', '--check', patch]); }
    catch { continue; }
    git(['apply', '--reverse', patch]);
  }
  git(['add', '--all']);
  git(['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(fixture, 'hooks')}`, 'commit', '--quiet', '-m', 'pinned kernel fixture']);
  await applyPatches(fixture, kernel);
  const first = await Promise.all(paths.map(file => readFile(path.join(kernel, file), 'utf8')));
  await applyPatches(fixture, kernel);
  assert.deepEqual(await Promise.all(paths.map(file => readFile(path.join(kernel, file), 'utf8'))), first);
  assert.match(first[0], /await this\.studioAccountMenu\.toggle\(this\.label/);
  assert.match(first[0], /executeCommand\('_manageTrustedExtensionsForAccount'/);
  assert.doesNotMatch(first[0], /MenuRegistry\.appendMenuItem\(MenuId\.AccountsContext/);
  const menu = first[1];
  assert.doesNotMatch(menu, /Manage Trusted|Manage Extension|Manage Language|\/api\/ai|System AI/);
});
