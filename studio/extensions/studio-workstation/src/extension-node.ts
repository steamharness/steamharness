import './localization-host';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { localDataHome } from '@steamharness/project-manifest/node';
import * as vscode from 'vscode';
import { activate as activateWorkstation } from './extension';
import { createProjectRuntime } from './workflow-runtime-node';
import { activateProjectAccount } from './workflow-auth';
import { withUserModelWriteLock } from './user-models-node';
import { activateNodeRuntime } from './node-runtime-host';
import { prepareInternalLayer } from './internal-layer';
import { remoteAccessHandler, usingStudioWeb } from './remote-access-node';
import { LocalAccountSessions } from './account-sessions-node';
import { NodeAccountWorkspace } from './account-workspace-data-node';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const platform = await prepareInternalLayer();
  await activateNodeRuntime(context);
  const storage = context.globalStorageUri;
  const desktopSessions = platform && vscode.env.uiKind === vscode.UIKind.Desktop && !vscode.env.remoteName
    && storage && (storage.scheme === 'file' || storage.scheme === 'vscode-userdata') && isAbsolute(storage.fsPath)
    ? new LocalAccountSessions(join(localDataHome(), 'studio', 'desktop-auth')) : undefined;
  if (desktopSessions) context.subscriptions.push(desktopSessions);
  const account = await activateProjectAccount(context, run => withUserModelWriteLock(context.globalStorageUri.fsPath, run), platform,
    platform ? process.env.STEAMHARNESS_STUDIO_INTERNAL_SERVER_URL : undefined, value => createHash('sha256').update(value).digest('hex'), remoteAccessHandler(), desktopSessions,
    !vscode.env.remoteName && vscode.env.uiKind === vscode.UIKind.Desktop || usingStudioWeb() ? owner => new NodeAccountWorkspace(owner) : undefined);
  return activateWorkstation(context, createProjectRuntime(context, account), account);
}
