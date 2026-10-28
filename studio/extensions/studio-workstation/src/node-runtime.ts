import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { t } from './localization';

export interface NodeRuntime {
  nodePath: string;
  version: string;
  source: 'bundled' | 'local' | 'host';
  electron: boolean;
  identity: string;
  pathEntries: string[];
  npmCli?: string;
  pnpmCli?: string;
}
interface RuntimeManifest { schemaVersion: number; nodeVersion: string; node: string; npm: string; pnpm: string; bin: string; hashes?: Record<string, string> }
export interface NodeRuntimeOptions {
  source?: 'auto' | 'local'; nodePath?: string; manifestPath?: string; originalPath?: string;
  env?: NodeJS.ProcessEnv; storageDirectory?: string;
}

/** Environment is per invocation, never a mutation of the extension host. */
export function nodeRuntimeEnvironment(runtime: NodeRuntime, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  const inherited = base.PATH ?? Object.entries(base).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [...runtime.pathEntries, inherited].filter(Boolean).join(path.delimiter);
  if (runtime.electron) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
  delete env.npm_config_prefix; delete env.NPM_CONFIG_PREFIX;
  delete env.STEAMHARNESS_STUDIO_NODE_RUNTIME; delete env.STEAMHARNESS_STUDIO_ORIGINAL_PATH;
  return env;
}

async function findLocalNode(searchPath: string): Promise<string> {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
    try { await access(candidate); return candidate; } catch { /* Continue searching. */ }
  }
  throw new Error(t('No local Node.js was found. Choose an executable in Settings or use the bundled runtime.'));
}

async function writeCommand(file: string, content: string): Promise<void> {
  if (await readFile(file, 'utf8').catch(() => undefined) === content) return;
  const temporary = `${file}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, content, { mode: 0o755 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function readManifest(file: string): Promise<{ root: string; manifest: RuntimeManifest; identity: string }> {
  try {
    const contents = await readFile(file, 'utf8');
    const manifest = JSON.parse(contents) as RuntimeManifest;
    const root = path.dirname(file);
    const realRoot = await realpath(root);
    const inside = (parent: string, child: string): boolean => {
      const relative = path.relative(parent, child);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const resolvePath = async (value: string): Promise<string> => {
      if (typeof value !== 'string' || path.isAbsolute(value) || !inside(root, path.resolve(root, value))) throw new Error('Invalid runtime path');
      const resolved = await realpath(path.resolve(root, value));
      if (!inside(realRoot, resolved)) throw new Error('Runtime link escapes its installation');
      return resolved;
    };
    if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.nodeVersion)) throw new Error('Invalid manifest');
    for (const key of ['node', 'npm', 'pnpm', 'bin'] as const) {
      await resolvePath(manifest[key]);
    }
    if (manifest.hashes) {
      for (const relative of [manifest.node, manifest.npm, manifest.pnpm]) if (!manifest.hashes[relative]) throw new Error('Missing checksum');
      // The manifest can cover the complete manager payload. Checking just its
      // entrypoints misses missing or damaged modules loaded by npm and pnpm.
      for (const [relative, expected] of Object.entries(manifest.hashes)) {
        if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid checksum');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(await resolvePath(relative))) hash.update(chunk);
        if (hash.digest('hex') !== expected) throw new Error('Corrupt runtime');
      }
    }
    return { root, manifest, identity: createHash('sha256').update(contents).digest('hex') };
  } catch {
    throw new Error(t('The bundled Node.js runtime is missing or damaged. Repair the installation or choose a local Node.js in Settings.'));
  }
}

/** Optional manifest injection is generic; public Studio never downloads Node. */
export async function resolveNodeRuntime(options: NodeRuntimeOptions = {}): Promise<NodeRuntime> {
  const env = options.env ?? process.env;
  const configured = options.nodePath?.trim();
  const local = options.source === 'local' || options.source === undefined && !!configured;
  const file = options.manifestPath ?? env.STEAMHARNESS_STUDIO_NODE_RUNTIME;
  // Local mode must remain usable when repairing a damaged bundled runtime.
  const bundle = file ? await readManifest(file).catch(error => { if (!local) throw error; return undefined; }) : undefined;
  const nodePath = local ? configured || await findLocalNode(options.originalPath ?? env.STEAMHARNESS_STUDIO_ORIGINAL_PATH ?? env.PATH ?? '')
    : bundle ? path.resolve(bundle.root, bundle.manifest.node) : process.execPath;
  if (!path.isAbsolute(nodePath)) throw new Error(t('Choose an absolute path to a Node.js executable.'));
  const source = local ? 'local' : bundle ? 'bundled' : 'host';
  const runtime: NodeRuntime = { nodePath, version: '', source, electron: source === 'host' && !!process.versions.electron,
    identity: '', pathEntries: source === 'host' ? [] : [path.dirname(nodePath)] };
  try {
    runtime.nodePath = await realpath(nodePath);
    if (source !== 'host') runtime.pathEntries = [path.dirname(runtime.nodePath)];
    runtime.version = (await promisify(execFile)(runtime.nodePath, ['--version'], { env: nodeRuntimeEnvironment(runtime, env), timeout: 10_000, windowsHide: true })).stdout.trim();
  } catch { throw new Error(t('Cannot run Node.js at {0}. Choose another executable in Settings.', nodePath)); }
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(runtime.version);
  if (!match || Number(match[1]) < 22 || Number(match[1]) === 22 && Number(match[2]) < 19) throw new Error(t('Node.js 22.19.0 or newer is required; found {0}.', runtime.version));
  if (source === 'bundled' && runtime.version !== `v${bundle!.manifest.nodeVersion}`) throw new Error(t('The bundled Node.js runtime is missing or damaged. Repair the installation or choose a local Node.js in Settings.'));
  if (bundle) {
    runtime.npmCli = path.resolve(bundle.root, bundle.manifest.npm);
    runtime.pnpmCli = path.resolve(bundle.root, bundle.manifest.pnpm);
    if (source === 'bundled') runtime.pathEntries = [path.resolve(bundle.root, bundle.manifest.bin)];
  }
  if (!runtime.npmCli) {
    for (const candidate of [path.resolve(path.dirname(runtime.nodePath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(runtime.nodePath), '../lib/node_modules/npm/bin/npm-cli.js')]) {
      try { await access(candidate); runtime.npmCli = candidate; break; } catch { /* Optional local npm. */ }
    }
  }
  const executable = await stat(runtime.nodePath);
  runtime.identity = createHash('sha256').update(JSON.stringify([runtime.nodePath, runtime.version, runtime.npmCli, runtime.pnpmCli, runtime.electron,
    executable.dev, executable.ino, executable.size, executable.mtimeMs, executable.ctimeMs, bundle?.identity])).digest('hex');
  if (local && bundle && options.storageDirectory) {
    // npm.cmd distributed with Node always picks its neighbouring node.exe.
    // These shims make terminal package managers follow the selected local Node.
    const directory = path.join(options.storageDirectory, 'node-commands', runtime.identity);
    await mkdir(directory, { recursive: true });
    for (const [name, cli] of [['npm', runtime.npmCli], ['npx', path.join(path.dirname(runtime.npmCli!), 'npx-cli.js')], ['pnpm', runtime.pnpmCli]] as const) {
      if (!cli) continue;
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      // Keep batch files ASCII: cmd.exe decodes literals with the active code
      // page, which cannot reliably represent Unicode installation paths.
      const content = process.platform === 'win32' ? `@echo off\r\nnode "%~dp0${name}.cjs" %*\r\n`
        : `#!/bin/sh\nexec ${quote(runtime.nodePath)} ${quote(cli)} "$@"\n`;
      if (process.platform === 'win32') await writeCommand(path.join(directory, `${name}.cjs`), `process.argv[1]=${JSON.stringify(cli)};\nrequire(${JSON.stringify(cli)});\n`);
      await writeCommand(path.join(directory, name + (process.platform === 'win32' ? '.cmd' : '')), content);
    }
    runtime.pathEntries.unshift(directory);
  }
  return runtime;
}
