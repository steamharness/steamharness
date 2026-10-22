import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

function git(upstream, args, env = {}) {
  return execFileSync('git', args, {
    cwd: upstream, env: { ...process.env, ...env }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

async function integratedPatches(root, upstream, head, patches) {
  let receipt;
  try {
    receipt = JSON.parse(await fs.readFile(path.join(root, 'config/patches.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') { return new Set(); }
    throw error;
  }
  if (receipt.version !== 1 || !/^[a-f0-9]{40,64}$/u.test(receipt.commit) ||
      !receipt.patches || typeof receipt.patches !== 'object') {
    throw new Error('Invalid integrated patch receipt: config/patches.json.');
  }
  if (receipt.commit !== head) {
    try { git(upstream, ['merge-base', '--is-ancestor', receipt.commit, head]); }
    catch { return new Set(); }
  }
  return new Set(patches.filter(patch => receipt.patches[patch.name] === patch.sha256).map(patch => patch.name));
}

function patchPaths(upstream, patches) {
  const paths = new Set();
  for (const patch of patches) {
    const records = git(upstream, ['apply', '--numstat', '-z', patch.file]).split('\0');
    for (let index = 0; index < records.length; index++) {
      if (!records[index]) { continue; }
      const filename = records[index].split('\t').slice(2).join('\t');
      if (filename) { paths.add(filename); }
      else { paths.add(records[++index]); paths.add(records[++index]); }
    }
  }
  return [...paths];
}

// A later patch can change the same lines as an earlier one. Recognize the
// series backwards in a disposable index, independently of the user's index.
function recognizePatches(upstream, patches, env, applied) {
  for (const patch of [...patches].reverse()) {
    try {
      git(upstream, ['apply', '--cached', '--reverse', patch.file], env);
      applied.add(patch.name);
    } catch {
      // Missing patches are validated against the complete worktree below.
    }
  }
}

export async function applyPatches(root, upstream) {
  const directory = path.join(root, 'patches');
  const patches = await Promise.all((await fs.readdir(directory)).filter(name => name.endsWith('.patch')).sort().map(async name => {
    const file = path.join(directory, name);
    return { name, file, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') };
  }));
  if (!patches.length) { return; }
  const head = git(upstream, ['rev-parse', 'HEAD']).trim();
  // The receipt records historical patches already integrated into the fork.
  // Their implementation may since have evolved beyond reverse-applicability.
  const applied = await integratedPatches(root, upstream, head, patches);
  if (applied.size === patches.length) { return; }
  const paths = patchPaths(upstream, patches);
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'studio-patch-index-'));
  const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    git(upstream, ['read-tree', head], env);
    recognizePatches(upstream, patches, env, applied);
    git(upstream, ['read-tree', head], env);
    const tracked = new Set(git(upstream, ['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', head, '--', ...paths]).split('\0'));
    const snapshot = [];
    for (const filename of paths) {
      let present = tracked.has(filename);
      if (!present) {
        try { await fs.lstat(path.join(upstream, filename)); present = true; }
        catch (error) { if (error.code !== 'ENOENT') { throw error; } }
      }
      if (present) { snapshot.push(filename); }
    }
    if (snapshot.length) { git(upstream, ['--literal-pathspecs', 'add', '--all', '--', ...snapshot], env); }
    const before = git(upstream, ['write-tree'], env).trim();
    recognizePatches(upstream, patches, env, applied);
    git(upstream, ['read-tree', before], env);
    const merged = [];
    for (const patch of patches) {
      if (applied.has(patch.name)) { continue; }
      try {
        try {
          git(upstream, ['apply', '--cached', '--check', patch.file], env);
        } catch {
          // Git uses the patch's blob IDs as the merge base. Conflicts remain
          // confined to this temporary index, including add/add conflicts.
          git(upstream, ['apply', '--cached', '--3way', patch.file], env);
          merged.push(patch.name);
          continue;
        }
        git(upstream, ['apply', '--cached', patch.file], env);
      } catch (error) {
        throw new Error(`Patch ${patch.name} conflicts with the current source after automatic merge. Local files and the index were not changed.\n${error.stderr ?? error.message}`);
      }
    }
    const after = git(upstream, ['write-tree'], env).trim();
    if (after !== before) {
      const changes = path.join(scratch, 'changes.patch');
      await fs.writeFile(changes, git(upstream, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
        '--no-color', '--src-prefix=a/', '--dst-prefix=b/', before, after]));
      if (git(upstream, ['rev-parse', 'HEAD']).trim() !== head) {
        throw new Error('VS Code revision changed while preparing patches. Retry preparation.');
      }
      // Apply the entire verified series once. Git checks every target before
      // writing, so a failure or concurrent edit cannot leave half a series.
      git(upstream, ['apply', '--check', changes]);
      git(upstream, ['apply', changes]);
    }
    for (const name of merged) { console.log(`Studio: Automatically merged patch ${name}.`); }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
