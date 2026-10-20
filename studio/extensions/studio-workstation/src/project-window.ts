import * as vscode from 'vscode';
import { t } from './localization';

export interface ProjectWindowOptions {
  forceNewWindow: boolean;
  forceReuseWindow: boolean;
}

export async function chooseProjectWindow(message = t('Where would you like to open the project?')): Promise<ProjectWindowOptions | undefined> {
  const newWindow = t('Open in New Window'), currentWindow = t('Open in Current Window');
  const target = await vscode.window.showInformationMessage(message, { modal: true }, newWindow, currentWindow);
  if (target !== newWindow && target !== currentWindow) { return; }
  return { forceNewWindow: target === newWindow, forceReuseWindow: target === currentWindow };
}

export async function openProjectFolder(uri: vscode.Uri, isActive: () => boolean = () => true): Promise<void> {
  const options = await chooseProjectWindow();
  if (options && isActive()) { await vscode.commands.executeCommand('vscode.openFolder', uri, options); }
}
