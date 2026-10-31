import * as vscode from 'vscode';
import { IMPORTED_PROJECTS_KEY, readImportedProjects } from './projects';
import type { Project } from './workflow-types';
import type { StartSummary } from './start-page-types';

export function studioAnalysisSummary(result: { generatedAt: number; projects: Array<{ availability: string; runs: Array<{ status: string }> }> }): StartSummary {
  const available = result.projects.filter(project => project.availability === 'available');
  const runs = available.flatMap(project => project.runs);
  return { projects: available.length, running: runs.filter(run => run.status === 'running').length,
    waiting: runs.filter(run => run.status === 'waiting_for_input').length,
    unavailable: result.projects.length - available.length, generatedAt: result.generatedAt };
}

export function studioAnalysisProjects(context: Pick<vscode.ExtensionContext, 'globalState'>, current: Project[]) {
  const projects = new Map(readImportedProjects(context.globalState.get(IMPORTED_PROJECTS_KEY)).map(project => [project.uri, project]));
  const workspaceUris = new Set((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString()));
  for (const project of current.filter(project => !project.assistant && !project.builtin)) { projects.set(project.uri, project); }
  return [...projects.values()].filter(project => vscode.Uri.parse(project.uri).scheme === 'file').map(project => {
    const opened = current.find(entry => entry.uri === project.uri);
    return { id: project.id, name: project.name, uri: project.uri, folderPath: vscode.Uri.parse(project.uri).fsPath,
      inWorkspace: !!opened || workspaceUris.has(project.uri), projectType: opened?.projectType };
  });
}

export function createStudioAnalysisHandler(read: () => Promise<unknown>, signal: AbortSignal) {
  return async (operation: string, input: Record<string, unknown>): Promise<unknown> => {
    signal.throwIfAborted();
    if (!vscode.workspace.isTrusted || operation !== 'studio.analysis.get' || Object.keys(input).length) {
      throw new Error('Only local Studio analysis is available through this connection.');
    }
    const result = await read();
    signal.throwIfAborted();
    if (!vscode.workspace.isTrusted) { throw new Error('Studio workspace trust changed.'); }
    return result;
  };
}
