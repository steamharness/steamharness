import { execFile } from 'node:child_process';
import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const json = async file => JSON.parse(await readFile(file, 'utf8'));

export async function builtinProjectCompiler(runtimeSource) {
  const modules = await realpath(path.join(runtimeSource, 'node_modules')).catch(error => {
    throw new Error('Install the SteamHarness workspace dependencies before building Studio (pnpm install --frozen-lockfile).', { cause: error });
  });
  const cliRoot = path.join(modules, '@steamharness', 'cli');
  const cli = await json(path.join(cliRoot, 'package.json')).catch(error => {
    throw new Error('The built-in project CLI is not installed. Run pnpm install --frozen-lockfile in the SteamHarness workspace.', { cause: error });
  });
  const entry = path.join(cliRoot, cli.bin.steamharness);
  await access(entry).catch(error => {
    throw new Error('Build Core and CLI in the SteamHarness workspace (pnpm run build) before building Studio.', { cause: error });
  });
  return { modules, entry };
}

export async function copyBuiltinProjectRelease(source, destination) {
  const release = await json(path.join(source, 'steamharness.release.json'));
  if (release.kind !== 'steamharness.project.release' || release.version !== 1) throw new Error(`Invalid built-in project release: ${source}`);
  const files = new Set(['steamharness.release.json', ...release.files.map(file => file.path)]);
  const directories = new Set();
  for (const file of files) {
    const segments = file.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[:\\]/.test(segment))) {
      throw new Error(`Unsafe built-in project release path: ${file}`);
    }
    for (let length = 1; length < segments.length; length++) directories.add(segments.slice(0, length).join('/'));
  }
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, filter: async file => {
    const relative = path.relative(source, file).split(path.sep).join('/');
    if (!relative) return true;
    if (files.has(relative) && (await lstat(file)).isFile() || directories.has(relative) && (await lstat(file)).isDirectory()) return true;
    if (files.has(relative) || directories.has(relative)) throw new Error(`Invalid built-in project release path: ${relative}`);
    return false;
  } });
  await Promise.all([...files].map(file => access(path.join(destination, file))));
}

/** Compile in a scratch project so only the sealed release, not build inputs, is copied into Studio. */
export async function buildBuiltinProjectRelease(destination, runtimeSource, stage, signal) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-project-'));
  try {
    const { modules, entry } = await builtinProjectCompiler(runtimeSource);
    await stage(root);
    await symlink(modules, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const { stdout } = await exec(process.execPath, [entry, 'release', root, '--json'], { cwd: root, signal, windowsHide: true });
    const { directory } = JSON.parse(stdout);
    signal?.throwIfAborted();
    await copyBuiltinProjectRelease(directory, destination);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Merge an already-built static Kanban into the regular project release format. */
export async function stageBuiltinKanban(root, source, artifact, entryId) {
  const project = await json(path.join(source, 'steamharness.json'));
  const entry = project.entries?.find(entry => entry.entryId === entryId);
  if (entry?.type !== 'kanban' || entry.root !== '.' || entry.configuration !== 'configuration.json') {
    throw new Error(`Invalid built-in Kanban declaration: ${source}`);
  }
  const output = 'dist/steamharness/build/' + entryId;
  await mkdir(path.join(root, output), { recursive: true });
  await cp(artifact, path.join(root, output), { recursive: true });
  await cp(path.join(source, 'configuration.json'), path.join(root, 'configuration.json'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: project.name, version: project.version, type: 'module' }));
  // Assets have already been built by the owning build script. Check the staged entry during release.
  await writeFile(path.join(root, 'steamharness.json'), JSON.stringify({ ...project, entries: [{ ...entry, entry: `${output}/index.html` }], defaultEntry: entryId,
    release: { build: [process.execPath, '-e', 'require("node:fs").accessSync(process.argv[1])', `${output}/index.html`] } }));
}
