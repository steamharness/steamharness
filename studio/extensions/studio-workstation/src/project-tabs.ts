import * as vscode from 'vscode';
import { t } from './localization';
import type { Launcher } from './workflow-cli-types';
import { projectDisplayName, type Project } from './workflow-types';

/** Select a project without replacing the window's workspace folders. */
export async function chooseProjectTab(projects: readonly Project[], target?: string): Promise<vscode.Uri | undefined> {
  if (target) { return target.includes('://') ? vscode.Uri.parse(target) : vscode.Uri.file(target); }
  const selected = await vscode.window.showQuickPick([
    ...projects.filter(project => !project.assistant && !project.builtin).map(project => ({
      label: projectDisplayName(project), description: project.folderPath, uri: project.uri,
    })),
    { label: `$(folder-opened) ${t('Choose Project Folder...')}`, description: '', uri: '' },
  ], { title: t('Open Other Project'), placeHolder: t('Choose a project to open in a workspace tab'), matchOnDescription: true });
  if (!selected) { return; }
  if (selected.uri) { return vscode.Uri.parse(selected.uri); }
  return (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    title: t('Open Other Project'), openLabel: t('Open Project in Tab') }))?.[0];
}

/** Use the same CLI inspection as workspace projects, including external folders. */
export async function inspectProjectTab(uri: vscode.Uri, launcher: Pick<Launcher, 'inspect'>): Promise<Project> {
  if (uri.scheme !== 'file') { throw new Error(t('Select a SteamHarness project folder.')); }
  const inspected = await launcher.inspect([uri.fsPath]);
  const project = inspected.projects.find(project => project.folderPath === uri.fsPath);
  if (!project) { throw new Error(t('Select a SteamHarness project folder.')); }
  return { ...project, uri: uri.toString() };
}
