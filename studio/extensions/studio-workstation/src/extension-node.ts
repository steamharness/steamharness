import './localization-host';
import * as vscode from 'vscode';
import { activate as activateWorkstation } from './extension';
import { createProjectRuntime } from './workflow-runtime-node';
import { activateProjectAccount } from './workflow-auth';
import { withUserModelWriteLock } from './user-models-node';
import { activateNodeRuntime } from './node-runtime-host';
import { prepareInternalLayer } from './internal-layer';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const platform = await prepareInternalLayer();
  await activateNodeRuntime(context);
  const account = await activateProjectAccount(context, run => withUserModelWriteLock(context.globalStorageUri.fsPath, run), platform);
  return activateWorkstation(context, createProjectRuntime(context, account), account);
}
