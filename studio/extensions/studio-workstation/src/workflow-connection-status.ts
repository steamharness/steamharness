import './localization-host';
import { t } from './localization';
import * as vscode from 'vscode';
import type { WorkflowAccountController } from './workflow-auth';
import type { WorkflowAccountState } from './workflow-auth-client';

export function registerWorkflowConnectionStatus(account: WorkflowAccountController): vscode.Disposable {
  const status = vscode.window.createStatusBarItem('workflowConnection', vscode.StatusBarAlignment.Left, 120);
  status.name = t('Workflow Server');
  status.command = 'studio.openWorkflowAccount';

  const update = (state: WorkflowAccountState): void => {
    let icon = 'debug-disconnect', label = t('Server Disconnected');
    if (state.status === 'authenticated') { icon = 'plug'; label = t('Server Connected'); }
    else if (state.status === 'checking') { icon = 'loading~spin'; label = t('Connecting to Server'); }
    else if (state.status === 'expired') { icon = 'warning'; label = t('Server Sign-in Expired'); }
    else if (state.status === 'error') { icon = 'warning'; label = t('Server Connection Error'); }
    status.text = `$(${icon}) ${label}`;
    status.tooltip = `${t('Workflow Server: {0}', state.serverUrl)}${state.error ? `\n\n${state.error}` : ''}`;
    status.accessibilityInformation = { label: `${label}, ${state.serverUrl}` };
    status.show();
  };

  const listener = account.onDidChange(update);
  update(account.getState());
  return vscode.Disposable.from(status, listener);
}
