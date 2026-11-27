import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isProjectEntryId, PROJECT_UUID_PATTERN } from '@steamharness/project-manifest';
import { readProjectDeclarationFromDirectory } from '@steamharness/project-manifest/node';
import { DEVELOPER_ASSISTANT_PROJECT_ID } from './assistant-workspace';
import type { BotCredentialScope } from './bot-credential-vault';
import type { ManagedUsageTarget } from './project-usage-types';

export interface BotCredentialTarget { scope: BotCredentialScope; name: string; recheck(): Promise<boolean> }

/** Resolve the selected local entry without loading or running project code. */
export function createBotCredentialTargetResolver(options: {
  isBuiltinProjectDirectory(directory: string): boolean;
  localAssistantDirectory(): Promise<string>;
  resolveManaged?(uri: string): Thenable<ManagedUsageTarget | undefined>;
  trusted(directory: string): Thenable<boolean>;
}) {
  const read = async (input: unknown): Promise<{ scope: BotCredentialScope; name: string } | 'untrusted' | undefined> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const { uri, entryId, projectId } = input as Record<string, unknown>;
    if (typeof uri !== 'string' || uri.length > 16384 || entryId !== undefined && !isProjectEntryId(entryId)
      || projectId !== undefined && (typeof projectId !== 'string' || !PROJECT_UUID_PATTERN.test(projectId))) return;
    try {
      const resource = vscode.Uri.parse(uri, true);
      if (resource.scheme !== 'file' || resource.authority || resource.query || resource.fragment || !path.isAbsolute(resource.fsPath)) return;
      if (!vscode.workspace.isTrusted) return 'untrusted';

      const workspaceFile = resource.fsPath.toLowerCase().endsWith('.code-workspace');
      const managed = workspaceFile ? await options.resolveManaged?.(resource.toString()) : undefined;
      if (workspaceFile && !managed || managed && entryId !== undefined && managed.entryId !== entryId) return;
      const folder = managed && await realpath(managed.directory);
      if (folder && (path.relative(folder, managed!.directory) || !await options.trusted(folder))) return 'untrusted';
      const source = managed ? managed.projectDirectory ?? await options.localAssistantDirectory() : resource.fsPath;
      const projectDirectory = await realpath(source);
      const builtin = options.isBuiltinProjectDirectory(source) && options.isBuiltinProjectDirectory(projectDirectory);
      if (!builtin && !await options.trusted(projectDirectory)) return 'untrusted';

      const manifest = await readProjectDeclarationFromDirectory(projectDirectory);
      const entry = manifest.entries.find(item => item.entryId === (managed?.entryId ?? entryId ?? manifest.defaultEntry));
      if (!entry || entry.type !== 'bot' || projectId && manifest.projectId !== projectId.toLowerCase()
        || managed && (managed.projectId !== manifest.projectId || manifest.defaultEntry !== entry.entryId || entry.folderContext !== true)) return;
      // The built-in release runs with its own directory as the Assistant workdir.
      const workdir = folder || (manifest.projectId === DEVELOPER_ASSISTANT_PROJECT_ID && builtin ? projectDirectory : undefined);
      return { scope: { projectId: manifest.projectId, entryId: entry.entryId, projectDirectory, instanceId: managed?.instanceId, workdir },
        name: managed?.name ?? (manifest.entries.filter(item => item.type === 'bot').length > 1 ? entry.name : manifest.name) };
    } catch { return undefined; }
  };
  return async (input: unknown): Promise<BotCredentialTarget | 'untrusted' | undefined> => {
    const target = await read(input);
    if (!target || target === 'untrusted') return target;
    const identity = JSON.stringify(target.scope);
    return { ...target, async recheck() {
      const current = await read(input);
      return !!current && current !== 'untrusted' && JSON.stringify(current.scope) === identity;
    } };
  };
}
