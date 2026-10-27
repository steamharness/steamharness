import './localization-host';
import * as vscode from 'vscode';
import { activate as activateWorkstation } from './extension';
import { createProjectRuntime } from './workflow-runtime-node';
import { activateProjectAccount } from './workflow-auth';
import { withUserModelWriteLock } from './user-models-node';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const account = await activateProjectAccount(context, run => withUserModelWriteLock(context.globalStorageUri.fsPath, run));
  return activateWorkstation(context, createProjectRuntime(context, account), account);
}
