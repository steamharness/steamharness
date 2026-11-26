import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProjectEntryId, PROJECT_RELEASE_FILE, PROJECT_UUID_PATTERN } from '@steamharness/project-manifest';
import { readProjectDeclarationFromDirectory } from '@steamharness/project-manifest/node';
import { assistantDataDirectory, folderBotDataRoot, projectDataDirectorySync } from '../../../../cli/src/web/project-data-directory';
import type { BotStorageScope } from '../../../../cli/src/web/bot-management-storage';
import type { ManagedUsageTarget } from './project-usage-types';

export interface BotStorageTarget {
  storage: BotStorageScope;
  name: string;
  instance: boolean;
  recheck(): Promise<boolean>;
}

interface TargetInput { uri: string; projectId?: string; entryId?: string }
interface TargetOptions {
  assistantId: string;
  isBuiltinProjectDirectory(directory: string): boolean;
  localAssistantDirectory(): Promise<string>;
  resolveManaged?(uri: string): PromiseLike<ManagedUsageTarget | undefined>;
  trusted(directory: string): PromiseLike<boolean>;
}

async function releaseStamp(directory: string): Promise<string | undefined> {
  try {
    const file = await lstat(path.join(directory, PROJECT_RELEASE_FILE), { bigint: true });
    if (!file.isFile()) throw new Error('Invalid project release manifest.');
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readBinding(input: TargetInput, options: TargetOptions) {
  const { uri, projectId, entryId } = input;
  if (uri.length > 16_384 || entryId !== undefined && !isProjectEntryId(entryId)
    || projectId !== undefined && !PROJECT_UUID_PATTERN.test(projectId)) return;
  const resource = new URL(uri);
  if (resource.protocol !== 'file:' || resource.host || resource.search || resource.hash) return;
  const filename = fileURLToPath(resource);
  const workspaceFile = filename.toLowerCase().endsWith('.code-workspace');
  const managed = workspaceFile ? await options.resolveManaged?.(uri) : undefined;
  if ((workspaceFile && !managed) || (managed && entryId !== undefined && entryId !== managed.entryId)) return;
  const directory = managed && await realpath(managed.directory);
  if (directory && managed && path.relative(directory, managed.directory)) return;
  if (directory && !await options.trusted(directory)) return 'untrusted' as const;
  const source = managed ? managed.projectDirectory ?? await options.localAssistantDirectory() : filename;
  const canonical = await realpath(source);
  const builtin = options.isBuiltinProjectDirectory(source) && options.isBuiltinProjectDirectory(canonical);
  if (!builtin && !await options.trusted(canonical)) return 'untrusted' as const;
  const manifest = await readProjectDeclarationFromDirectory(canonical);
  const entry = manifest.entries.find(item => item.entryId === (managed?.entryId ?? entryId ?? manifest.defaultEntry));
  if (!entry || entry.type !== 'bot' || entry.webApp || (projectId && manifest.projectId !== projectId.toLowerCase())
    || (managed && (managed.projectId !== manifest.projectId || manifest.defaultEntry !== entry.entryId || entry.folderContext !== true))) return;

  return { canonical, directory, instanceId: managed?.instanceId, name: managed?.name ?? entry.name,
    bot: { projectId: manifest.projectId, entryId: entry.entryId }, assistant: !managed && builtin && manifest.projectId === options.assistantId,
    release: await releaseStamp(canonical) };
}

export async function resolveBotStorageTarget(input: TargetInput, options: TargetOptions & { storage: string }): Promise<BotStorageTarget | 'untrusted' | undefined> {
  const binding = await readBinding(input, options);
  if (!binding || binding === 'untrusted') return binding;
  const { canonical, directory, instanceId, bot, assistant, release, name } = binding;
  const root = instanceId === undefined ? options.storage : folderBotDataRoot(options.storage, instanceId);
  const location = assistant ? assistantDataDirectory(root, bot.projectId, canonical) : projectDataDirectorySync(root, canonical, bot.projectId, bot.entryId);
  const directories = directory ? { kind: 'folder-context' as const, primary: directory, roots: [directory] }
    : assistant ? { kind: 'workspace-roots' as const, primary: canonical, roots: [canonical] } : undefined;
  return { storage: { root, runtimeDirectory: path.join(location, 'runtime'), bot, directories }, name, instance: instanceId !== undefined,
    async recheck() {
      const current = await readBinding(input, options).catch(() => undefined);
      // Recheck identity and trust without hashing every release file for each operation.
      return !!current && current !== 'untrusted' && current.canonical === canonical && current.directory === directory
        && current.instanceId === instanceId && current.bot.projectId === bot.projectId && current.bot.entryId === bot.entryId
        && current.assistant === assistant && current.release === release;
    },
  };
}
