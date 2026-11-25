import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isProjectEntryId, PROJECT_UUID_PATTERN } from '@steamharness/project-manifest';
import { readProjectDeclarationFromDirectory } from '@steamharness/project-manifest/node';
import { DEVELOPER_ASSISTANT_PROJECT_ID } from './assistant-workspace';
import { botCredentialKindLabel, canAccessBotCredentialStorage } from './bot-credentials';
import { listBotCredentialSummaries, resolveBotCredentialNamespace } from './bot-credential-vault';
import type { ManagedUsageTarget } from './project-usage-types';

export type BotCredentialListResult = { status: 'ok'; rows: { name: string; type: string }[] } | { status: 'untrusted' | 'unavailable' };

/** Resolve the selected local entry without loading or running project code. */
export function createBotCredentialListReader(context: vscode.ExtensionContext, options: {
  isBuiltinProjectDirectory(directory: string): boolean;
  localAssistantDirectory(): Promise<string>;
  resolveManaged?(uri: string): Thenable<ManagedUsageTarget | undefined>;
  signal: AbortSignal;
}) {
  const canAccess = () => canAccessBotCredentialStorage(context);
  const trusted = (directory: string) => vscode.commands.executeCommand<boolean>('studio.internalSidebarProjectTrust', vscode.Uri.file(directory).toString(), false);
  return async (input: unknown): Promise<BotCredentialListResult> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { status: 'unavailable' };
    const { uri, entryId, projectId } = input as Record<string, unknown>;
    if (typeof uri !== 'string' || uri.length > 16384 || entryId !== undefined && !isProjectEntryId(entryId)
      || projectId !== undefined && (typeof projectId !== 'string' || !PROJECT_UUID_PATTERN.test(projectId))) return { status: 'unavailable' };
    try {
      const resource = vscode.Uri.parse(uri, true);
      if (resource.scheme !== 'file' || resource.authority || resource.query || resource.fragment || !path.isAbsolute(resource.fsPath)) return { status: 'unavailable' };
      if (!vscode.workspace.isTrusted) return { status: 'untrusted' };
      if (options.signal.aborted || !await canAccess()) return { status: 'unavailable' };

      const workspaceFile = resource.fsPath.toLowerCase().endsWith('.code-workspace');
      const managed = workspaceFile ? await options.resolveManaged?.(resource.toString()) : undefined;
      if (workspaceFile && !managed || managed && entryId !== undefined && managed.entryId !== entryId) return { status: 'unavailable' };
      const folder = managed && await realpath(managed.directory);
      if (folder && !await trusted(folder)) return { status: 'untrusted' };
      const source = managed ? managed.projectDirectory ?? await options.localAssistantDirectory() : resource.fsPath;
      const projectDirectory = await realpath(source);
      if (!options.isBuiltinProjectDirectory(source) && !await trusted(projectDirectory)) return { status: 'untrusted' };

      const manifest = await readProjectDeclarationFromDirectory(projectDirectory);
      const entry = manifest.entries.find(item => item.entryId === (managed?.entryId ?? entryId ?? manifest.defaultEntry));
      if (!entry || entry.type !== 'bot' || projectId && manifest.projectId !== projectId
        || managed && (managed.projectId !== manifest.projectId || manifest.defaultEntry !== entry.entryId || entry.folderContext !== true)) return { status: 'unavailable' };
      // The built-in release runs with its own directory as the Assistant workdir.
      const workdir = folder || (manifest.projectId === DEVELOPER_ASSISTANT_PROJECT_ID && options.isBuiltinProjectDirectory(source) ? projectDirectory : undefined);
      const profile = context.globalStorageUri.fsPath;
      const namespace = await resolveBotCredentialNamespace(profile, { projectId: manifest.projectId, entryId: entry.entryId,
        projectDirectory, instanceId: managed?.instanceId, workdir });
      if (options.signal.aborted || !vscode.workspace.isTrusted) return { status: 'unavailable' };
      const rows = await listBotCredentialSummaries(context.secrets, namespace, options.signal);
      if (!vscode.workspace.isTrusted) return { status: 'untrusted' };
      return { status: 'ok', rows: rows.map(({ name, kind }) => ({ name, type: botCredentialKindLabel(kind) })) };
    } catch { return { status: 'unavailable' }; }
  };
}
