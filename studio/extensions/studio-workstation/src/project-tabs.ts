import * as vscode from 'vscode';
import { t } from './localization';
import type { Launcher } from './workflow-cli-types';
import { projectDisplayName, type Project } from './workflow-types';

/** Select a project without replacing the window's workspace folders. */
export async function chooseProjectTab(projects: readonly Project[], target?: string): Promise<{ uri: vscode.Uri; entryId?: string } | undefined> {
  if (target) { return { uri: target.includes('://') ? vscode.Uri.parse(target) : vscode.Uri.file(target) }; }
  const selected = await vscode.window.showQuickPick([
    ...projects.filter(project => !project.assistant && !project.builtin).map(project => ({
      label: projectDisplayName(project), description: project.folderPath, uri: project.uri, entryId: project.entryId,
    })),
    { label: `$(folder-opened) ${t('Choose Project Folder...')}`, description: '', uri: '', entryId: undefined },
  ], { title: t('Open Other Project'), placeHolder: t('Choose a project to open in a workspace tab'), matchOnDescription: true });
  if (!selected) { return; }
  if (selected.uri) { return { uri: vscode.Uri.parse(selected.uri), entryId: selected.entryId }; }
  const uri = (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    title: t('Open Other Project'), openLabel: t('Open Project in Tab') }))?.[0];
  return uri ? {uri} : undefined;
}

/** Use the same CLI inspection as workspace projects, including external folders. */
export async function inspectProjectTab(uri: vscode.Uri, launcher: Pick<Launcher, 'inspect'>): Promise<Project> {
  if (uri.scheme !== 'file') { throw new Error(t('Select a SteamHarness project folder.')); }
  const inspected = await launcher.inspect([uri.fsPath]);
  const project = inspected.projects.find(project => project.folderPath === uri.fsPath && project.entryId === project.defaultEntry);
  if (!project) { throw new Error(t('Select a SteamHarness project folder.')); }
  return { ...project, uri: uri.toString() };
}
