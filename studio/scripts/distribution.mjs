import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function resolveWorkflowSource(root = ROOT, env = process.env) {
  if (env.STUDIO_STEAMHARNESS_SOURCE) return path.resolve(env.STUDIO_STEAMHARNESS_SOURCE);
  const workspace = path.resolve(root, '..');
  const aggregate = path.join(workspace, 'open-soucres');
  if (await exists(path.join(aggregate, 'core/package.json')) &&
      await exists(path.join(aggregate, 'cli/package.json'))) {
    return aggregate;
  }
  if (await exists(path.join(workspace, 'core/package.json')) &&
      await exists(path.join(workspace, 'cli/package.json'))) {
    return workspace;
  }
  return path.join(workspace, 'workflow');
}

export async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function git(args, cwd, env = {}) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    const stop = (signal) => child.kill(signal);
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${signal ?? code}.`));
      }
    });
  });
}

export async function assertRuntime(root = ROOT) {
  const required = (await fs.readFile(path.join(root, '.nvmrc'), 'utf8')).trim();
  const expected = required.split('.').map(Number);
  const actual = process.versions.node.split('.').map(Number);
  if (actual[0] !== expected[0] || actual[1] < expected[1] ||
      (actual[1] === expected[1] && actual[2] < expected[2])) {
    throw new Error(`Node ${required}+ (${expected[0]}.x) required; found ${process.versions.node}. Run: nvm install && nvm use`);
  }
}

export async function assertUpstream(root = ROOT) {
  const lock = await readJSON(path.join(root, 'config/upstream.json'));
  const directory = path.resolve(root, lock.path);
  if (!await exists(path.join(directory, '.git'))) {
    throw new Error('VS Code source is missing. Run npm run setup.');
  }
  const commit = git(['rev-parse', 'HEAD'], directory);
  if (commit !== lock.commit) {
    throw new Error(`VS Code revision mismatch: expected ${lock.commit}, found ${commit}. Update config/upstream.json and the submodule together.`);
  }
  return { ...lock, directory };
}

const digest = (content) => createHash('sha256').update(content).digest('hex');

export function mergeProduct(base, overrides) {
  const product = { ...base, ...overrides };
  for (const name of ['nameShort', 'nameLong', 'applicationName', 'dataFolderName', 'urlProtocol']) {
    if (typeof product[name] !== 'string' || !product[name].trim()) {
      throw new Error(`Product field ${name} must be a nonempty string.`);
    }
  }
  return product;
}

export async function applyPatches(root, upstream) {
  const patches = path.join(root, 'patches');
  const files = (await fs.readdir(patches)).filter((name) => name.endsWith('.patch')).sort();
  if (!files.length) { return; }
  const applied = new Set();
  const paths = new Set();
  for (const name of files) {
    const records = git(['apply', '--numstat', '-z', path.join(patches, name)], upstream).split('\0');
    for (let index = 0; index < records.length; index++) {
      if (!records[index]) { continue; }
      const filename = records[index].split('\t').slice(2).join('\t');
      if (filename) { paths.add(filename); }
      else { paths.add(records[++index]); paths.add(records[++index]); }
    }
  }
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-patch-index-'));
  const env = { GIT_INDEX_FILE: path.join(directory, 'index') };
  try {
    git(['read-tree', 'HEAD'], upstream, env);
    const tracked = new Set(git(['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...paths], upstream).split('\0'));
    const snapshot = [];
    for (const filename of paths) {
      if (tracked.has(filename) || await exists(path.join(upstream, filename))) { snapshot.push(filename); }
    }
    if (snapshot.length) { git(['--literal-pathspecs', 'add', '--all', '--', ...snapshot], upstream, env); }
    // Peel later patches from a disposable index so overlapping earlier patches remain recognizable.
    for (const name of [...files].reverse()) {
      const file = path.join(patches, name);
      try {
        git(['apply', '--cached', '--reverse', '--check', file], upstream, env);
        git(['apply', '--cached', '--reverse', file], upstream, env);
        applied.add(name);
      } catch {
        // Missing or conflicting patches are checked against the real files below.
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  for (const name of files) {
    if (applied.has(name)) { continue; }
    const file = path.join(patches, name);
    try {
      git(['apply', '--check', file], upstream);
    } catch (error) {
      throw new Error(`Patch ${name} conflicts with the current source. Resolve the conflict without discarding local changes.\n${error.stderr ?? error.message}`);
    }
    git(['apply', file], upstream);
  }
}

export async function prepareDistribution(root = ROOT) {
  const upstream = await assertUpstream(root);
  const productFile = path.join(upstream.directory, 'product.json');
  const stateFile = path.join(root, '.studio/product-state.json');
  const base = git(['show', `${upstream.commit}:product.json`], upstream.directory);
  const current = (await fs.readFile(productFile, 'utf8')).trim();
  const overrides = await readJSON(path.join(root, 'config/product.json'));
  const product = mergeProduct(JSON.parse(base), overrides);
  const generated = JSON.stringify(product, null, 2);
  const state = await exists(stateFile) ? await readJSON(stateFile) : undefined;
  const packageJSON = JSON.parse(git(['show', `${upstream.commit}:package.json`], upstream.directory));
  const webOverridesFile = path.join(upstream.directory, 'product.overrides.json');
  const webGenerated = JSON.stringify({ ...product, version: packageJSON.version }, null, 2);
  const webCurrent = await exists(webOverridesFile) ? (await fs.readFile(webOverridesFile, 'utf8')).trim() : undefined;

  if (current !== base && current !== generated && digest(current) !== state?.sha256) {
    throw new Error('upstream/vscode/product.json has local edits. Move your branding changes to config/product.json before preparing Studio.');
  }
  if (webCurrent !== undefined && webCurrent !== webGenerated && digest(webCurrent) !== state?.webSha256) {
    throw new Error('upstream/vscode/product.overrides.json has local edits. Move your branding changes to config/product.json before preparing Studio.');
  }

  const source = path.join(root, 'extensions/studio-workstation');
  const link = path.join(upstream.directory, 'extensions/studio-workstation');
  let linked = false;
  let linkExists = false;
  try {
    await fs.lstat(link);
    linkExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (linkExists) {
    let target;
    try {
      target = await fs.realpath(link);
    } catch {
      throw new Error('The upstream Studio extension link is broken and is not managed by this project.');
    }
    if (target !== await fs.realpath(source)) {
      throw new Error('The upstream Studio extension directory already exists and is not managed by this project.');
    }
    linked = true;
  }

  if (!await exists(path.join(source, 'dist/extension.js')) ||
      !await exists(path.join(source, 'dist/extension-web.js'))) {
    throw new Error('Studio extension is not built. Run npm run build:extension.');
  }

  await applyPatches(root, upstream.directory);
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  if (current !== generated) {
    await fs.writeFile(productFile, `${generated}\n`);
  }
  if (webCurrent !== webGenerated) {
    await fs.writeFile(webOverridesFile, `${webGenerated}\n`);
  }
  if (!linked) {
    await fs.symlink(process.platform === 'win32' ? source : path.relative(path.dirname(link), source), link,
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  await fs.writeFile(stateFile, `${JSON.stringify({ commit: upstream.commit, sha256: digest(generated), webSha256: digest(webGenerated) }, null, 2)}\n`);
  return { upstream, product };
}
