import * as vscode from 'vscode';

/** Only known user settings may be opened by embedded project pages. */
export async function openProjectUserSettings(message: Record<string, unknown> | undefined): Promise<boolean> {
  if (message?.type !== 'workflow-user-settings' || message.version !== 1 || message.key !== 'agent.permissionPolicy') return false;
  await vscode.commands.executeCommand('studio.openSettings', { section: 'permissions', target: 'user' });
  return true;
}
