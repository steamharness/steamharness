import './localization-host';
import * as vscode from 'vscode';
import { activate as activateWorkstation } from './extension';
import { createProjectRuntime } from './workflow-runtime-node';
import { activateProjectAccount } from './workflow-auth';
import { withUserModelWriteLock } from './user-models-node';
import { activateNodeRuntime } from './node-runtime-host';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await activateNodeRuntime(context);
  const account = await activateProjectAccount(context, run => withUserModelWriteLock(context.globalStorageUri.fsPath, run));
  return activateWorkstation(context, createProjectRuntime(context, account), account);
}
