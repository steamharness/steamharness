import * as vscode from 'vscode';
import { readProjectDeclaration } from '@steamharness/project-manifest';
import { IMPORTED_PROJECTS_KEY, readImportedProjects, rememberImportedProjects } from './projects';
import type { DownloadedServerProject } from './steamharness-server-projects';

export async function readPackageManifest(uri: vscode.Uri): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(uri, 'package.json'))));
}
/** Resource discovery conveys locations, never database permissions. */
export async function resourceProjectDirectories(context: Pick<vscode.ExtensionContext, 'globalState'>): Promise<string[]> {
  const directories = await Promise.all(readImportedProjects(context.globalState.get(IMPORTED_PROJECTS_KEY)).map(async project => {
    try {
      const uri = vscode.Uri.parse(project.uri);
      if (uri.scheme !== 'file' || readProjectDeclaration(await readPackageManifest(uri)).projectId !== project.id) return undefined;
      return uri.fsPath;
    } catch { return undefined; }
  }));
  return [...new Set(directories.filter((value): value is string => !!value))];
}
export async function rememberDownloadedProjects(context: Pick<vscode.ExtensionContext, 'globalState'>, projects: DownloadedServerProject[], replacedRoot?: string): Promise<void> {
  const previous = readImportedProjects(context.globalState.get(IMPORTED_PROJECTS_KEY));
  const incoming = projects.map(project => ({ id: project.id, name: project.name, version: project.version, uri: vscode.Uri.file(project.directory).toString() }));
  await context.globalState.update(IMPORTED_PROJECTS_KEY, rememberImportedProjects(previous.filter(project => project.uri !== replacedRoot), incoming));
}
