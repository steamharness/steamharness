import './localization-host';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { activate as activateWorkstation } from './extension';
import { createProjectRuntime } from './workflow-runtime-node';
import { activateProjectAccount } from './workflow-auth';
import { withUserModelWriteLock } from './user-models-node';
import { activateNodeRuntime } from './node-runtime-host';
import { prepareInternalLayer } from './internal-layer';
import { remoteAccessHandler } from './remote-access-node';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const platform = await prepareInternalLayer();
  await activateNodeRuntime(context);
  const account = await activateProjectAccount(context, run => withUserModelWriteLock(context.globalStorageUri.fsPath, run), platform,
    platform ? process.env.STEAMHARNESS_STUDIO_INTERNAL_SERVER_URL : undefined, value => createHash('sha256').update(value).digest('hex'), remoteAccessHandler());
  return activateWorkstation(context, createProjectRuntime(context, account), account);
}
