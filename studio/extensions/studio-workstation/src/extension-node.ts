import './localization-host';
import * as vscode from 'vscode';
import { activate as activateWorkstation } from './extension';
import { createWorkflowRuntime } from './workflow-runtime-node';
import { activateWorkflowAccount } from './workflow-auth';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const account = await activateWorkflowAccount(context);
  return activateWorkstation(context, createWorkflowRuntime(context, account), account);
}
