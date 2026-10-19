import './localization-host';
import * as vscode from 'vscode';
import { activate as activateWorkstation } from './extension';
import { createProjectRuntime } from './workflow-runtime-node';
import { activateProjectAccount } from './workflow-auth';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const account = await activateProjectAccount(context);
  return activateWorkstation(context, createProjectRuntime(context, account), account);
}
