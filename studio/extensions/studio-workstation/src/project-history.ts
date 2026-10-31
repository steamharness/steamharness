import * as vscode from 'vscode';
import { IMPORTED_PROJECTS_KEY, RECENT_PROJECTS_KEY, readImportedProjects, readRecentProjects, type ImportedProject, type RecentProject } from './projects';

interface ProjectHistory { recent: RecentProject[]; imported: ImportedProject[] }
type Context = Pick<vscode.ExtensionContext, 'globalState'>;
const pending = new WeakMap<vscode.Memento, Promise<boolean>>();

function readHistory(context: Context): ProjectHistory {
  return { recent: readRecentProjects(context.globalState.get(RECENT_PROJECTS_KEY)),
    imported: readImportedProjects(context.globalState.get(IMPORTED_PROJECTS_KEY)) };
}

export function updateProjectHistory(context: Context, update: (history: ProjectHistory) => ProjectHistory): Promise<boolean> {
  const operation = (pending.get(context.globalState) ?? Promise.resolve(false)).catch(() => false).then(async () => {
    const previous = readHistory(context), next = update(previous);
    let changed = false;
    for (const [name, key] of [['recent', RECENT_PROJECTS_KEY], ['imported', IMPORTED_PROJECTS_KEY]] as const) {
      if (JSON.stringify(previous[name]) !== JSON.stringify(next[name])) {
        await context.globalState.update(key, next[name]); changed = true;
      }
    }
    return changed;
  });
  pending.set(context.globalState, operation);
  return operation;
}

export function isMissingProject(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === 'FileNotFound' || code === 'ENOENT';
}

export async function pruneMissingProjectHistory(context: Context): Promise<boolean> {
  const previous = readHistory(context);
  const openedUris = (): Set<string> => new Set([vscode.workspace.workspaceFile, ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri)]
    .flatMap(uri => uri ? [uri.toString()] : []));
  const current = openedUris();
  const candidates = new Map([...previous.recent, ...previous.imported].map(project => [project.uri, vscode.Uri.parse(project.uri)]));
  const missing = new Set((await Promise.all([...candidates].map(async ([uri, resource]) => {
    if (resource.scheme !== 'file' || current.has(uri)) { return; }
    try { await vscode.workspace.fs.stat(resource); }
    catch (error) { if (isMissingProject(error)) { return uri; } }
  }))).filter((uri): uri is string => !!uri));
  if (!missing.size) { return false; }
  // Re-read after filesystem checks so new imports and recently reopened records survive.
  return updateProjectHistory(context, history => {
    const protectedUris = openedUris();
    for (const name of ['recent', 'imported'] as const) {
      for (const project of history[name]) {
        if (!previous[name].some(record => JSON.stringify(record) === JSON.stringify(project))) { protectedUris.add(project.uri); }
      }
    }
    const retain = (project: RecentProject | ImportedProject): boolean => !missing.has(project.uri) || protectedUris.has(project.uri);
    return { recent: history.recent.filter(retain), imported: history.imported.filter(retain) };
  });
}
