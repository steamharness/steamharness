import * as vscode from 'vscode';
import type { BotCredentialKind } from './bot-credential-vault';
import { t } from './localization';

export const botCredentialKindLabel = (kind: BotCredentialKind) => kind === 'ssh-private-key' ? t('SSH private key') : kind === 'password' ? t('Password')
  : kind === 'access-key-pair' ? t('Access key pair') : kind === 'structured' ? t('Structured credential') : t('API key or token');

export const canAccessBotCredentialStorage = async (context: vscode.ExtensionContext): Promise<boolean> =>
  vscode.workspace.isTrusted && !vscode.env.remoteName && vscode.env.uiKind === vscode.UIKind.Desktop && typeof context.secrets.keys === 'function'
  && await Promise.resolve(vscode.commands.executeCommand<boolean>('studio.internalCanPersistBotCredentials')).catch(() => false) === true;
