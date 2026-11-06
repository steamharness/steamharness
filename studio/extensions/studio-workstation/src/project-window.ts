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

/** A release application owns a separate window rooted at its immutable distribution. */
export async function openReleaseProjectWindow(directory: string, sourceUri: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const source = vscode.Uri.parse(sourceUri), local = vscode.Uri.file(directory);
  const folder = source.scheme === 'vscode-remote' ? source.with({ path: local.path, query: '', fragment: '' }) : local;
  await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: true, forceReuseWindow: false });
}
