import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProjectEntryId, PROJECT_UUID_PATTERN } from '@steamharness/project-manifest';
import { readProjectDeclarationFromDirectory } from '@steamharness/project-manifest/node';
import { assistantDataDirectory, folderBotDataRoot, projectDataDirectorySync } from '../../../../cli/src/web/project-data-directory';
import type { BotStorageScope } from '../../../../cli/src/web/bot-management-storage';
import type { ManagedUsageTarget } from './project-usage-types';

export interface BotStorageTarget extends BotStorageScope {
  name: string;
  instance: boolean;
}

export async function resolveBotStorageTarget(input: { uri: string; projectId?: string; entryId?: string }, options: {
  storage: string;
  assistantId: string;
  isBuiltinProjectDirectory(directory: string): boolean;
  localAssistantDirectory(): Promise<string>;
  resolveManaged?(uri: string): PromiseLike<ManagedUsageTarget | undefined>;
  trusted(directory: string): PromiseLike<boolean>;
}): Promise<BotStorageTarget | 'untrusted' | undefined> {
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
  if (directory && (path.relative(directory, managed!.directory) || !await options.trusted(directory))) return 'untrusted';
  const source = managed ? managed.projectDirectory ?? await options.localAssistantDirectory() : filename;
  const canonical = await realpath(source);
  const builtin = options.isBuiltinProjectDirectory(source) && options.isBuiltinProjectDirectory(canonical);
  if (!builtin && !await options.trusted(canonical)) return 'untrusted';
  const manifest = await readProjectDeclarationFromDirectory(canonical);
  const entry = manifest.entries.find(item => item.entryId === (managed?.entryId ?? entryId ?? manifest.defaultEntry));
  if (!entry || entry.type !== 'bot' || entry.webApp || (projectId && manifest.projectId !== projectId.toLowerCase())
    || (managed && (managed.projectId !== manifest.projectId || manifest.defaultEntry !== entry.entryId || entry.folderContext !== true))) return;

  const bot = { projectId: manifest.projectId, entryId: entry.entryId };
  const root = managed ? folderBotDataRoot(options.storage, managed.instanceId) : options.storage;
  const assistant = !managed && builtin && bot.projectId === options.assistantId;
  const location = assistant ? assistantDataDirectory(root, bot.projectId, canonical) : projectDataDirectorySync(root, canonical, bot.projectId, bot.entryId);
  const directories = directory ? { kind: 'folder-context' as const, primary: directory, roots: [directory] }
    : assistant ? { kind: 'workspace-roots' as const, primary: canonical, roots: [canonical] } : undefined;
  return { root, runtimeDirectory: path.join(location, 'runtime'), bot, directories, name: managed?.name ?? entry.name, instance: !!managed };
}
