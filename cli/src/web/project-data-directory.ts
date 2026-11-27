import { localEntryDirectory } from '@steamharness/project-manifest/node';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BotMemoryDirectories, createLocalRuntimePersistence, RuntimePersistence } from 'steamharness/runtime-storage';

export const webProjectDataDirectory = localEntryDirectory;
export function projectDataDirectorySync(storageDir: string, _projectDir: string, projectId: string, entryId: string): string {
  return localEntryDirectory(storageDir, projectId, entryId);
}
export async function projectDataDirectory(storageDir: string, projectDir: string, projectId: string, entryId: string): Promise<string> {
  return projectDataDirectorySync(storageDir, projectDir, projectId, entryId);
}

const digest = (input: string) => createHash('sha256').update(input).digest('hex');
export function runtimeDataDirectory(storageDir: string, project: {
  id: string; entryId: string; assistant?: { workdir: string; storageScope?: 'managed-project' };
}, instanceId?: string): string {
  return localEntryDirectory(storageDir, project.id, project.entryId, instanceId !== undefined ? { instanceId }
    : project.assistant && project.assistant.storageScope !== 'managed-project' ? { workdir: project.assistant.workdir } : undefined);
}

export type WebBotMemoryDirectoryScope = Pick<BotMemoryDirectories, 'kind' | 'primary' | 'roots'>;

export function botMemoryDirectoryScope(project: {
  projectType: string; id: string; entryId: string; conversation?: { engine?: string };
  assistant?: { workdir: string; roots: readonly { folderPath: string }[] };
  entries: readonly { entryId: string; folderContext?: boolean }[];
}, folderBot: { projectId: string; directory: string } | undefined): WebBotMemoryDirectoryScope | undefined {
  if (project.projectType !== 'bot' || project.conversation?.engine !== 'agent') return;
  if (project.assistant) {
    const primary = project.assistant.workdir;
    return { kind: 'workspace-roots', primary, roots: [...new Set([primary, ...project.assistant.roots.map(root => root.folderPath)])] };
  }
  if (folderBot?.projectId === project.id && project.entries.some(entry => entry.entryId === project.entryId && entry.folderContext === true)) {
    return { kind: 'folder-context', primary: folderBot.directory, roots: [folderBot.directory] };
  }
}

export const botMemoryDirectoryError = () => Object.assign(new Error('Choose an existing project directory authorized for this Bot.'),
  { code: 'BOT_MEMORY_DIRECTORY_UNAVAILABLE' });

async function existingDirectory(directory: string): Promise<string> {
  const canonical = await realpath(directory);
  if (!(await stat(canonical)).isDirectory()) throw botMemoryDirectoryError();
  return canonical;
}

const sameDirectory = (left: string, right: string) => path.relative(left, right) === '';
const withinFolder = (relative: string) => relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);

async function selectMemoryDirectory(scope: WebBotMemoryDirectoryScope, candidate: string): Promise<string> {
  if (typeof candidate !== 'string' || candidate.length > 4096 || candidate.includes('\0') || !path.isAbsolute(candidate)) throw botMemoryDirectoryError();
  try {
    if (scope.kind === 'folder-context') {
      if (!withinFolder(path.relative(scope.primary, candidate))) throw botMemoryDirectoryError();
      const canonical = await existingDirectory(candidate);
      // A folder Bot already has a canonical binding. Never let a symlink select a different project.
      const resolvedRelative = path.relative(scope.primary, canonical);
      if (!withinFolder(resolvedRelative) || scope.primary !== await existingDirectory(scope.primary) || !sameDirectory(candidate, canonical) ||
        path.resolve(scope.primary, resolvedRelative) !== canonical) throw botMemoryDirectoryError();
      return resolvedRelative;
    }
    // Keep the spelling recorded by Studio: it is part of the existing assistant data key.
    const registered = scope.roots.find(root => root === candidate) ?? scope.roots.find(root => sameDirectory(root, candidate));
    const canonical = await existingDirectory(candidate);
    if (registered && canonical === await existingDirectory(registered)) return registered;
    if (!registered && sameDirectory(candidate, canonical)) {
      const matches = await Promise.all(scope.roots.map(async root => {
        try { return await existingDirectory(root) === canonical ? root : undefined; }
        catch { return undefined; }
      }));
      const available = matches.filter(root => root !== undefined);
      if (available.length === 1) return available[0];
    }
  } catch { /* Do not reveal filesystem errors or try a default database. */ }
  throw botMemoryDirectoryError();
}

export function createWebBotMemoryDirectories(scope: WebBotMemoryDirectoryScope, options: {
  storageDir: string; runtimeDirectory: string; projectId: string; persistence: RuntimePersistence;
  createPersistence: typeof createLocalRuntimePersistence;
}): BotMemoryDirectories {
  return { ...scope, async withStore(bot, projectPath, use) {
    const selected = await selectMemoryDirectory(scope, projectPath);
    if (scope.kind === 'workspace-roots' ? selected === scope.primary : !selected) return use(options.persistence.botMemory!(bot));
    const directory = scope.kind === 'workspace-roots' ? path.join(localEntryDirectory(options.storageDir, options.projectId, bot.entryId, { workdir: selected }), 'runtime')
      : path.join(options.runtimeDirectory, 'memories-by-directory', digest(selected));
    // Only the scoped memory file is opened; conversations and artifacts stay in the primary runtime.
    const persistence = options.createPersistence({ directory });
    try { return await use(persistence.botMemory!(bot)); }
    finally { await persistence.close(); }
  } };
}
