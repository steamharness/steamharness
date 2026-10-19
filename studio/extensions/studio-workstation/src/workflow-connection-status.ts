import './localization-host';
import { t } from './localization';
import * as vscode from 'vscode';
import type { AccountController } from './workflow-auth';
import type { AccountState } from './workflow-auth-client';

export function registerProjectConnectionStatus(account: AccountController): vscode.Disposable {
  const status = vscode.window.createStatusBarItem('projectConnection', vscode.StatusBarAlignment.Left, 120);
  status.name = t('SteamHarness Server');
  status.command = 'studio.openAccount';

  const update = (state: AccountState): void => {
    let icon = 'debug-disconnect', label = t('Server Disconnected');
    if (state.status === 'authenticated') { icon = 'plug'; label = t('Server Connected'); }
    else if (state.status === 'checking') { icon = 'loading~spin'; label = t('Connecting to Server'); }
    else if (state.status === 'expired') { icon = 'warning'; label = t('Server Sign-in Expired'); }
    else if (state.status === 'error') { icon = 'warning'; label = t('Server Connection Error'); }
    status.text = `$(${icon}) ${label}`;
    status.tooltip = `${t('SteamHarness Server: {0}', state.serverUrl)}${state.error ? `\n\n${state.error}` : ''}`;
    status.accessibilityInformation = { label: `${label}, ${state.serverUrl}` };
    status.show();
  };

  const listener = account.onDidChange(update);
  update(account.getState());
  return vscode.Disposable.from(status, listener);
}
