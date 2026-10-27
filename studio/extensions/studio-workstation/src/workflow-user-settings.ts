import * as vscode from 'vscode';

/** Only known user settings may be opened by embedded project pages. */
export async function openProjectUserSettings(message: Record<string, unknown> | undefined): Promise<boolean> {
  if (message?.type !== 'workflow-user-settings' || message.version !== 1 || !['agent.permissionPolicy', 'agent.model'].includes(String(message.key))) return false;
  await vscode.commands.executeCommand('studio.openSettings', { section: message.key === 'agent.model' ? 'models' : 'permissions', target: 'user' });
  return true;
}
