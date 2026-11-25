import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { applyEdits, modify } from 'jsonc-parser/lib/esm/main.js';
import { valid } from 'semver';
import { PROJECT_RELEASE_FILE } from '@steamharness/project-manifest';
import { readProjectDeclarationFromDirectory, readProjectDocument } from '@steamharness/project-manifest/node';
import { projectRuntimePackages, readProjectRuntimeArchives } from '../../../vendor/project-templates/project-runtime-packages';
import { t } from './localization';
import { runtimeNpmRange, runtimeNpmUpdate, type RuntimeNpmLatest, type RuntimeNpmUpdate } from './project-runtime-npm-node';

type Manifest = Record<string, unknown>;
export type RuntimeDependencyManager = 'pnpm' | 'npm';
export type RuntimeDependencyCandidate = { directory: string; workspace: string };
export interface RuntimeArchiveInspection {
  kind: 'archive';
  revision: string;
  manager?: RuntimeDependencyManager;
  bundleVersion?: string;
  packages: {
    name: string; group: string; version?: string; installedVersion?: string;
    projectSha256?: string; studioSha256?: string; sameArchive: boolean;
  }[];
  matches: boolean;
}
export type RuntimeDependencyInspection = RuntimeArchiveInspection | { kind: 'npm'; updates: RuntimeNpmUpdate[] };

const execute = promisify(execFile);
const groups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json'];
const metadataLimit = 16 * 1024 * 1024;
const archiveLimit = 128 * 1024 * 1024;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const exists = (file: string) => lstat(file).catch(error => { if (!isMissing(error)) throw error; return undefined; });
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function readMetadata(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > metadataLimit) throw new Error(t('A project runtime file has an unsupported path or file type.'));
  return readFile(file, 'utf8');
}

const object = (value: unknown): Manifest => value && typeof value === 'object' && !Array.isArray(value) ? value as Manifest : {};
function localArchivePath(root: string, spec: string): string | undefined {
  if (!spec.startsWith('file:')) return;
  const relative = spec.slice(5).replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!relative.endsWith('.tgz') || /[:%#?\0\r\n]/u.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..'
    || ['.git', 'node_modules', '.steamharness'].includes(part.toLowerCase()))) return;
  return path.join(root, ...relative.split('/'));
}

async function archiveDigest(file: string, signal?: AbortSignal) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > archiveLimit) throw new Error(t('A project runtime file has an unsupported path or file type.'));
  const sha = createHash('sha256'), integrity = createHash('sha512');
  let length = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    length += chunk.length;
    if (length > archiveLimit) throw new Error(t('A project runtime file has an unsupported path or file type.'));
    sha.update(chunk); integrity.update(chunk);
  }
  return { sha256: sha.digest('hex'), integrity: `sha512-${integrity.digest('base64')}` };
}

async function archiveVersion(file: string, name: string, signal?: AbortSignal): Promise<string> {
  // Read only the npm manifest from the archive. Never extract any project-supplied entries.
  const { stdout } = await execute('tar', ['-xOzf', file, 'package/package.json'], { signal, windowsHide: true, maxBuffer: 256 * 1024, timeout: 10_000,
    env: { ...process.env, TAR_OPTIONS: '' } });
  const pkg = JSON.parse(stdout);
  if (pkg.name !== name || typeof pkg.version !== 'string' || !version.test(pkg.version)) throw new Error('Invalid runtime package manifest.');
  return pkg.version;
}

async function studioArchives(directory: string | undefined, signal?: AbortSignal) {
  if (!directory) return;
  try {
    const archives = await readProjectRuntimeArchives(directory);
    return await Promise.all(archives.map(async archive => {
      const digest = await archiveDigest(archive.source, signal);
      if (digest.sha256 !== archive.sha256 || await archiveVersion(archive.source, archive.name, signal) !== archive.version) throw new Error('Invalid Studio archive.');
      return { ...archive, integrity: digest.integrity };
    }));
  } catch { signal?.throwIfAborted(); return undefined; }
}

async function readRuntimeProject(candidate: RuntimeDependencyCandidate, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    if (!path.isAbsolute(candidate.directory) || !path.isAbsolute(candidate.workspace)) return;
    const [root, workspace] = await Promise.all([realpath(candidate.directory), realpath(candidate.workspace)]);
    if (!inside(workspace, root) || await exists(path.join(root, PROJECT_RELEASE_FILE))) return;
    if ((await readProjectDocument(root)).distribution !== undefined) return;
    await readProjectDeclarationFromDirectory(root);
    const packageFile = path.join(root, 'package.json');
    const source = await readMetadata(packageFile), manifest = object(JSON.parse(source));
    const dependencies = projectRuntimePackages.flatMap(({ name }) => {
      const present = groups.filter(group => Object.hasOwn(object(manifest[group]), name));
      const group = present[0], spec = group && object(manifest[group])[name];
      return present.length === 1 && ['dependencies', 'devDependencies'].includes(group) && typeof spec === 'string' ? [{ name, group, spec }] : [];
    });
    signal?.throwIfAborted();
    return { root, source, manifest, packageFile, dependencies };
  } catch { signal?.throwIfAborted(); return undefined; }
}

async function installedRuntimePackage(modules: string, name: string): Promise<{ version?: string; confined: boolean }> {
  try {
    const installed = await realpath(path.join(modules, name, 'package.json'));
    if (!inside(modules, installed)) return { confined: false };
    const pkg = object(JSON.parse(await readMetadata(installed)));
    if (pkg.name === name && typeof pkg.version === 'string') return { confined: true, version: pkg.version };
  } catch { /* A missing or unreadable installation is not a version result. */ }
  return { confined: true };
}

type RuntimeProject = NonNullable<Awaited<ReturnType<typeof readRuntimeProject>>>;
async function projectState(project: RuntimeProject, bundle: string | undefined, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    const { root, source, manifest, packageFile, dependencies } = project;
    if (dependencies.length !== projectRuntimePackages.length) return;
    const locations = dependencies.map(dependency => {
      const file = localArchivePath(root, dependency.spec);
      return file ? { ...dependency, file } : undefined;
    });
    if (!locations.every(location => !!location) || locations[0].file.toLowerCase() === locations[1].file.toLowerCase()) return;
    const archivePaths = new Set(locations.map(location => location.file.toLowerCase()));
    const shared = groups.some(group => Object.entries(object(manifest[group])).some(([name, spec]) => !locations.some(item => item.name === name)
      && typeof spec === 'string' && archivePaths.has(localArchivePath(root, spec)?.toLowerCase() ?? '')));
    for (const { file } of locations) {
      if (!inside(root, file) || await realpath(path.dirname(file)) !== path.dirname(file)) return;
      const info = await exists(file);
      if (info && (!info.isFile() || await realpath(file) !== file)) return;
    }
    const archives = await studioArchives(bundle, signal);
    const locks = await Promise.all(lockfiles.map(async file => {
      const location = path.join(root, file);
      return await exists(location) ? await readMetadata(location) : undefined;
    }));
    const binding = manifest.packageManager;
    const npm = locks[1] !== undefined || locks[2] !== undefined, pnpm = locks[0] !== undefined;
    const manager = (npm && pnpm || await exists(path.join(root, 'yarn.lock')) || await exists(path.join(root, 'bun.lock')) || await exists(path.join(root, 'bun.lockb')))
      ? undefined : binding === undefined ? npm ? 'npm' : 'pnpm'
        : typeof binding === 'string' && /^pnpm@/u.test(binding) && !npm ? 'pnpm'
          : typeof binding === 'string' && /^npm@/u.test(binding) && !pnpm ? 'npm' : undefined;
    const modules = path.join(root, 'node_modules');
    const modulesStat = await exists(modules);
    const isolated = !modulesStat || modulesStat.isDirectory() && await realpath(modules) === modules;
    const packages = await Promise.all(locations.map(async (location, index) => {
      const target = archives?.[index];
      const digest = await archiveDigest(location.file, signal).catch(() => undefined);
      const sameArchive = !!target && digest?.sha256 === target.sha256;
      const archive = sameArchive ? target.version : digest && await archiveVersion(location.file, location.name, signal).catch(() => undefined);
      const { version: installed, confined } = await installedRuntimePackage(modules, location.name);
      const installedVersion = installed && version.test(installed) ? installed : undefined;
      return { ...location, version: archive, installedVersion, projectSha256: digest?.sha256, studioSha256: target?.sha256, sameArchive, confined };
    }));
    signal?.throwIfAborted();
    const bundleVersion = archives?.[0].version, lock = manager === 'pnpm' ? locks[0] : locks[2] ?? locks[1];
    const matches = !!bundleVersion && packages.every((item, index) =>
      item.sameArchive && item.installedVersion === bundleVersion && lock?.includes(archives![index].integrity));
    const inspection: RuntimeArchiveInspection = {
      kind: 'archive',
      revision: sha256(JSON.stringify([root, source, locks, packages.map(item => [item.projectSha256, item.installedVersion]), archives?.map(item => item.sha256)])),
      manager: !shared && isolated && packages.every(item => item.confined) ? manager : undefined,
      bundleVersion,
      packages: packages.map(({ name, group, version, installedVersion, projectSha256, studioSha256, sameArchive }) =>
        ({ name, group, version, installedVersion, projectSha256, studioSha256, sameArchive })),
      matches,
    };
    return { root, source, manifest, packageFile, packages, archives, locks, modules, inspection };
  } catch { signal?.throwIfAborted(); return undefined; }
}

async function readArchiveState(candidate: RuntimeDependencyCandidate, bundle: string | undefined, signal?: AbortSignal) {
  const project = await readRuntimeProject(candidate, signal);
  return project && projectState(project, bundle, signal);
}

export async function inspectRuntimeDependencies(candidate: RuntimeDependencyCandidate, bundle: string | undefined, signal?: AbortSignal,
  npmLatest?: RuntimeNpmLatest): Promise<RuntimeDependencyInspection | undefined> {
  const project = await readRuntimeProject(candidate, signal);
  if (!project) return;
  const archive = await projectState(project, bundle, signal);
  if (archive) return archive.inspection;
  if (!npmLatest) return;
  const modules = path.join(project.root, 'node_modules');
  const updates = (await Promise.all(project.dependencies.map(async (dependency): Promise<RuntimeNpmUpdate | undefined> => {
    const range = runtimeNpmRange(dependency.spec);
    if (!range) return;
    signal?.throwIfAborted();
    const [latestVersion, installed] = await Promise.all([npmLatest(dependency.name), installedRuntimePackage(modules, dependency.name)]);
    signal?.throwIfAborted();
    if (!latestVersion) return;
    const installedVersion = valid(installed.version ?? '') ?? undefined;
    const kind = runtimeNpmUpdate(range, latestVersion, installedVersion);
    if (kind) return { ...dependency, installedVersion, latestVersion, kind };
  }))).filter(update => update !== undefined);
  if (updates.length) return { kind: 'npm', updates };
}

const changed = () => new Error(t('The project dependencies or Studio bundle changed. Refresh the comparison and try again.'));

export async function replaceRuntimeDependencies(options: {
  candidate: RuntimeDependencyCandidate; bundle: string; revision: string; signal: AbortSignal;
  beforeReplace(directory: string): Promise<void>;
  install(directory: string, manager: RuntimeDependencyManager): Promise<void>;
}): Promise<string> {
  const { candidate, bundle, revision, signal } = options;
  const initial = await readArchiveState(candidate, bundle, signal);
  if (!initial || initial.inspection.revision !== revision || !initial.inspection.manager || !initial.archives) throw changed();
  const root = initial.root, lockfile = path.join(root, '.steamharness-runtime-update.lock');
  const lock = await open(lockfile, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(t('A runtime dependency replacement is already in progress for this project.'));
    throw error;
  });
  const rollback: (() => Promise<unknown>)[] = [];
  let backup: string | undefined, restored = true;
  try {
    await options.beforeReplace(root);
    const state = await readArchiveState(candidate, bundle, signal);
    if (!state || state.root !== root || state.inspection.revision !== revision || !state.inspection.manager || !state.archives) throw changed();
    if (state.inspection.matches) return state.inspection.bundleVersion!;
    const targetVersion = state.archives[0].version;
    const stage = backup = await mkdtemp(path.join(root, '.studio-runtime-update-'));
    const stagedArchives: string[] = [];
    if (state.packages.some(item => !item.sameArchive)) {
      for (const [index, archive] of state.archives.entries()) {
        signal.throwIfAborted();
        const file = path.join(stage, `new-${index}.tgz`);
        await copyFile(archive.source, file, constants.COPYFILE_EXCL);
        if ((await archiveDigest(file, signal)).sha256 !== archive.sha256) throw changed();
        stagedArchives.push(file);
      }
    }
    const moveAside = async (file: string, name: string) => {
      signal.throwIfAborted();
      const previous = path.join(stage, name);
      const present = await exists(file);
      if (present) await rename(file, previous);
      rollback.push(async () => {
        await rm(file, { recursive: name === 'node_modules', force: true });
        if (present) await rename(previous, file);
      });
    };
    const backupInstallFile = async (file: string, name: string, present: boolean) => {
      signal.throwIfAborted();
      const previous = path.join(stage, name);
      if (present) await copyFile(file, previous, constants.COPYFILE_EXCL);
      rollback.push(async () => { await rm(file, { force: true }); if (present) await rename(previous, file); });
    };
    for (const [index, staged] of stagedArchives.entries()) {
      await moveAside(state.packages[index].file, `old-${index}.tgz`);
      await rename(staged, state.packages[index].file);
    }
    let updated = state.source;
    await backupInstallFile(state.packageFile, 'package.json', true);
    if (Object.hasOwn(state.manifest, 'steamharnessRuntime')) {
      const edit = modify(state.source, ['steamharnessRuntime'], undefined, { formattingOptions: { insertSpaces: !/^\t/mu.test(state.source),
        tabSize: /^ +(?=")/mu.exec(state.source)?.[0].length ?? 2, eol: state.source.includes('\r\n') ? '\r\n' : '\n' } });
      updated = applyEdits(state.source, edit);
      const manifestMode = (await lstat(state.packageFile)).mode & 0o777;
      const stagedManifest = path.join(stage, 'updated-package.json');
      await writeFile(stagedManifest, updated, { flag: 'wx', mode: manifestMode });
      await rename(stagedManifest, state.packageFile);
    }
    for (const [index, name] of lockfiles.entries()) {
      await backupInstallFile(path.join(root, name), name, state.locks[index] !== undefined);
    }
    await moveAside(state.modules, 'node_modules');
    await options.install(root, state.inspection.manager);
    const result = await readArchiveState(candidate, bundle, signal);
    if (!result?.inspection.matches || !isDeepStrictEqual(result.manifest, JSON.parse(updated))) throw new Error(t('The installed runtime did not match the Studio bundle. The original dependencies were restored.'));
    return targetVersion;
  } catch (error) {
    for (const restore of rollback.reverse()) {
      try { await restore(); } catch { restored = false; }
    }
    if (!restored) throw new Error(t('The previous runtime could not be fully restored. Backup: {0}', backup));
    throw error;
  } finally {
    await lock.close().catch(() => undefined);
    if (restored) {
      if (backup) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      await rm(lockfile, { force: true }).catch(() => undefined);
    }
  }
}
