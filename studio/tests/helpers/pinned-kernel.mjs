import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ROOT } from '../../scripts/distribution.mjs';

// Share read-only objects, but keep refs, files and the index inside the fixture.
// Keep the real pinned commit identity so its integrated-patch receipt applies.
export async function pinnedKernel(t, files) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'studio-pinned-kernel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'vscode');
  for (const directory of [upstream, path.join(root, 'patches'), path.join(root, 'config')]) {
    await fs.mkdir(directory);
  }
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lock = JSON.parse(await fs.readFile(path.join(ROOT, 'config/upstream.json'), 'utf8'));
  const objects = git(path.join(ROOT, lock.path), ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim();
  git(upstream, ['init', '-q']);
  await fs.writeFile(path.join(upstream, '.git/objects/info/alternates'), `${objects}\n`);
  git(upstream, ['update-ref', 'HEAD', lock.commit]);
  git(upstream, ['read-tree', 'HEAD']);
  await fs.writeFile(path.join(upstream, '.git/shallow'), `${lock.commit}\n`);
  await fs.copyFile(path.join(ROOT, 'config/patches.json'), path.join(root, 'config/patches.json'));
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(upstream, file)), { recursive: true });
    await fs.writeFile(path.join(upstream, file), git(upstream, ['show', `HEAD:${file}`]));
  }
  return { root, upstream };
}
