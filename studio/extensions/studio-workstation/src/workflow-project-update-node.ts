import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { t } from './localization';
import { downloadServerProject } from './steamharness-server-projects-node';
import { compareProjectVersions, type DownloadedServerProject, type UpdatedServerProject } from './steamharness-server-projects';

// Source archives exclude host data. Preserve it, dependency installations and editor/SCM state at every depth.
const preservedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', '.vscode', '.idea', '.workflow-kv',
  '.workflow-persistent-values', '.workflow-runs', '.workflow-schedules', '.steamharness', '.workflow-files', '.data',
  'local-project-registries', 'workflow-files']);
function preserve(name: string): boolean {
  const lower = name.toLowerCase();
  return preservedDirectories.has(lower) || lower === '.env' || lower === '.envrc' || lower.startsWith('.env.') && lower !== '.env.example'
    || lower === 'workflow-auth.json' || lower === 'local-projects.json' || lower === 'steamharness.sqlite' || lower.startsWith('steamharness.sqlite-');
}
async function preservedPaths(directory: string, signal: AbortSignal, relative = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    signal.throwIfAborted();
    const child = path.join(relative, entry.name);
    if (preserve(entry.name)) { found.push(child); }
    else if (entry.isDirectory()) { found.push(...await preservedPaths(directory, signal, child)); }
  }
  return found;
}
async function validateSource(directory: string, signal: AbortSignal): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    signal.throwIfAborted();
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) {
      throw new Error(t('The downloaded source contains an unsupported file type.'));
    }
    if (preserve(entry.name) && !['.vscode', '.idea'].includes(entry.name.toLowerCase())) {
      throw new Error(t('The downloaded source contains a protected local path.'));
    }
    if (entry.isDirectory()) { await validateSource(path.join(directory, entry.name), signal); }
  }
}
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
async function absent(file: string): Promise<boolean> {
  try { await lstat(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return true; } throw error; }
}

export async function upgradeServerProject(options: Parameters<typeof downloadServerProject>[0] & {
  directory: string; expectedVersion: string; beforeReplace: () => Promise<void>;
  afterReplace: (projects: DownloadedServerProject[]) => Promise<void>;
}): Promise<UpdatedServerProject> {
  if (!/^\d+\.\d+\.\d+$/.test(options.expectedVersion) || !/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error(t('Declare a valid project UUID and version in steamharness.json first.'));
  }
  if (compareProjectVersions(options.expectedVersion, options.version) !== -1) { throw new Error(t('The target version must be newer than the local version.')); }
  const directory = path.resolve(options.directory);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || directory === path.dirname(directory)) {
    throw new Error(t('Choose a regular project folder for an in-place upgrade.'));
  }
  const root = await realpath(directory), parent = path.dirname(root);
  const assertManifest = async (): Promise<void> => {
    const manifest = JSON.parse(await readFile(path.join(root, 'steamharness.json'), 'utf8'));
    if (manifest.id !== options.projectId || manifest.version !== options.expectedVersion) {
      throw new Error(t('The local project changed. Check versions and try again.'));
    }
  };
  await assertManifest();
  const lockPath = path.join(parent, `.${path.basename(root)}.studio-upgrade.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') { throw new Error(t('An upgrade is already in progress for this folder. Lock: {0}', lockPath)); }
    throw error;
  }
  let staging: string | undefined, backup: string | undefined;
  let downloaded: Awaited<ReturnType<typeof downloadServerProject>> = [];
  let originalMoved = false, replacementInstalled = false, recoveryFailed = false;
  const moved: string[] = [];
  try {
    // Download and validate the aggregate project before touching the open project.
    downloaded = await downloadServerProject({ ...options, parentDirectory: contains(root, path.resolve(options.parentDirectory)) ? parent : options.parentDirectory });
    const source = downloaded[0]!;
    options.signal.throwIfAborted();
    staging = await mkdtemp(path.join(parent, '.studio-upgrade-'));
    const replacement = path.join(staging, 'source');
    await cp(source.directory, replacement, { recursive: true, errorOnExist: true, force: false,
      filter: () => { options.signal.throwIfAborted(); return true; } });
    await validateSource(replacement, options.signal);
    const targetManifest = JSON.parse(await readFile(path.join(replacement, 'steamharness.json'), 'utf8'));
    if (targetManifest.id !== options.projectId || targetManifest.version !== options.version) { throw new Error(t('The server returned an invalid response.')); }
    await chmod(replacement, stat.mode & 0o7777);
    options.signal.throwIfAborted();
    await options.beforeReplace();
    await assertManifest();
    options.signal.throwIfAborted();
    const retained = await preservedPaths(root, options.signal);
    for (const relative of retained) {
      options.signal.throwIfAborted();
      const destination = path.join(replacement, relative);
      if (!await absent(destination)) { await rm(destination, { recursive: true, force: true }); }
      await mkdir(path.dirname(destination), { recursive: true });
    }
    backup = await mkdtemp(path.join(parent, `.${path.basename(root)}-backup-${options.expectedVersion}-`));
    await rmdir(backup);
    await lock.writeFile(JSON.stringify({ directory: root, staging, backup, version: options.version, pid: process.pid }));
    await lock.sync();
    options.progress({ message: t('Backing up source and preserving local data') });
    for (const relative of retained) {
      options.signal.throwIfAborted();
      await rename(path.join(root, relative), path.join(replacement, relative));
      moved.push(relative);
    }
    options.signal.throwIfAborted();
    await rename(root, backup); originalMoved = true;
    options.signal.throwIfAborted();
    await rename(replacement, root); replacementInstalled = true;
    options.signal.throwIfAborted();
    const projects = downloaded.map(project => ({ ...project, directory }));
    await options.afterReplace(projects);
    return { projects, backupDirectory: backup };
  } catch (error) {
    // Rollback ignores cancellation so an interrupted transfer cannot leave the workspace half replaced.
    try {
      const replacement = staging && path.join(staging, 'source');
      if (replacementInstalled) { await rename(root, replacement!); replacementInstalled = false; }
      if (originalMoved) { await rename(backup!, root); originalMoved = false; }
      for (const relative of moved.reverse()) { await rename(path.join(replacement!, relative), path.join(root, relative)); }
    } catch {
      recoveryFailed = true;
      throw new Error(t('The upgrade could not be restored automatically. Original source: {0}. Retained local data: {1}.', originalMoved ? backup! : root, staging!));
    }
    throw error;
  } finally {
    if (!recoveryFailed) {
      if (staging) { await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
      for (const project of downloaded) {
        await rm(project.directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    await lock.close().catch(() => undefined);
    if (!recoveryFailed) { await rm(lockPath, { force: true }).catch(() => undefined); }
  }
}
