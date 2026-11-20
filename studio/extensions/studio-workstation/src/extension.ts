import './localization-host';
import { t } from './localization';
import * as vscode from 'vscode';
import { applyRecentMetadata, IMPORTED_PROJECTS_KEY, projectTypeIcons, RECENT_PROJECTS_KEY, readImportedProjects, readRecentProjects, rememberProjects, type RecentMetadata, type RecentProject } from './projects';
import { ProjectIcons } from './project-icons';
import { activateProject } from './workflow';
import type { Launcher } from './workflow-cli-types';
import { activateProjectAccount, type AccountController } from './workflow-auth';
import { activateDocumentPreviews } from './document-preview';
import { StudioStartController } from './start-page';
import { activateInternalLayer } from './internal-layer';
import { openProjectFolder } from './project-window';
import { isMissingProject, pruneMissingProjectHistory, updateProjectHistory } from './project-history';
import { ProjectSidebar } from './project-sidebar';

class RecentProjectsProvider {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly icons: ProjectIcons) {}
  async reconcile(): Promise<void> { if (await pruneMissingProjectHistory(this.context)) { this.refresh(); } }
  refresh(): void { this.change.fire(); }
  dispose(): void { this.change.dispose(); }
  withOrigin(uri: string, metadata?: RecentMetadata): RecentMetadata | undefined {
    return metadata?.projectId && metadata.distribution !== 'release' && readImportedProjects(this.context.globalState.get(IMPORTED_PROJECTS_KEY)).some(row => row.uri === uri && row.id === metadata.projectId)
      ? { ...metadata, distribution: 'download' } : metadata;
  }
  getChildren(): RecentProject[] {
    return readRecentProjects(this.context.globalState.get(RECENT_PROJECTS_KEY)).map(project => ({ ...project,
      ...(project.kind === 'folder' ? this.withOrigin(project.uri, this.icons.metadata(project.uri)) : undefined) }));
  }

  getTreeItem(project: RecentProject): vscode.TreeItem {
    const item = new vscode.TreeItem(project.label);
    item.contextValue = 'studio.recentProject';
    item.resourceUri = vscode.Uri.parse(project.uri);
    item.description = [project.version, item.resourceUri.fsPath].filter(Boolean).join(' \u00b7 ');
    item.tooltip = [project.label, project.version, item.resourceUri.fsPath].filter(Boolean).join('\n');
    item.iconPath = project.avatarUrl ? vscode.Uri.parse(project.avatarUrl) : new vscode.ThemeIcon(project.projectType ? projectTypeIcons[project.projectType] : project.kind === 'workspace' ? 'file-submodule' : 'folder');
    item.command = { command: 'studio.openRecentProject', title: t('Open Project'), arguments: [project] };
    return item;
  }
}

export async function activate(context: vscode.ExtensionContext, runtime?: Launcher, suppliedAccount?: AccountController): Promise<void> {
  activateDocumentPreviews(context);
  const account = suppliedAccount ?? await activateProjectAccount(context);
  const output = vscode.window.createOutputChannel('Studio');
  const launcher = runtime ?? {
    available: false,
    inspect: async () => ({ projects: [], errors: [] }),
    inspectAssistant: async () => ({ projects: [], errors: [] }),
    start: async () => { throw new Error('Workflow requires a local or remote Node extension host.'); },
    cliEntry: async () => { throw new Error('Workflow requires a Node extension host.'); },
    dispose: () => undefined,
  };
  const icons = new ProjectIcons(launcher, message => output.appendLine(message), readRecentProjects(context.globalState.get(RECENT_PROJECTS_KEY)));
  const recent = new RecentProjectsProvider(context, icons);
  context.subscriptions.push(output, recent, icons, icons.onDidChange(updates => {
    recent.refresh();
    void updateProjectHistory(context, history => ({ ...history, recent: applyRecentMetadata(history.recent, new Map([...updates].map(([uri, data]) => [uri, recent.withOrigin(uri, data) ?? data]))) }))
      .catch(error => output.appendLine(`Recent project icons: ${String(error)}`));
  }));

  const register = <Args extends unknown[]>(id: string, callback: (...args: Args) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: Args) => {
      try {
        return await callback(...args);
      } catch (error) {
        output.appendLine(`[${id}] ${String(error)}`);
        await vscode.window.showErrorMessage(t('Studio: {0}', error instanceof Error ? error.message : String(error)));
      }
    }));
  };

  const saveRecent = async (update: (previous: RecentProject[]) => RecentProject[], forgetRemoved = false): Promise<void> => {
    await updateProjectHistory(context, history => {
      const next = update(history.recent), retained = new Set(next.map(project => project.uri));
      const removed = new Set(forgetRemoved ? history.recent.filter(project => !retained.has(project.uri)).map(project => project.uri) : []);
      return { recent: next, imported: history.imported.filter(project => !removed.has(project.uri)) };
    });
    recent.refresh();
  };

  const rememberCurrentWorkspace = async (): Promise<void> => {
    const now = Date.now();
    const opened: RecentProject[] = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => ['file', 'vscode-remote'].includes(folder.uri.scheme))
      .map((folder) => ({ uri: folder.uri.toString(), label: folder.name, kind: 'folder', lastOpened: now }));
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile && ['file', 'vscode-remote'].includes(workspaceFile.scheme)) {
      opened.unshift({
        uri: workspaceFile.toString(),
        label: (workspaceFile.path.split('/').at(-1) ?? t('Workspace')).replace(/\.code-workspace$/, ''),
        kind: 'workspace',
        lastOpened: now,
      });
    }
    const limit = vscode.workspace.getConfiguration('studio').get<number>('recentProjects.limit', 12);
    await saveRecent((previous) => rememberProjects(previous, opened, limit));
  };

  register('studio.openFolder', async () => {
    const folders = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: t('Open Project'),
    });
    if (folders?.[0]) {
      await openProjectFolder(folders[0]);
    }
  });
  register('studio.openWorkspace', async () => {
    const files = await vscode.window.showOpenDialog({
      canSelectFolders: false, canSelectFiles: true, canSelectMany: false,
      filters: { [t('Workspace')]: ['code-workspace'] }, openLabel: t('Open Workspace'),
    });
    if (files?.[0]) {
      await openProjectFolder(files[0]);
    }
  });
  register('studio.openRecentProject', async (project?: RecentProject) => {
    if (!project || !readRecentProjects([project]).length) {
      return;
    }
    const uri = vscode.Uri.parse(project.uri);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch (error) {
      if (!isMissingProject(error)) { throw error; }
      await saveRecent(previous => previous.filter(entry => entry.uri !== project.uri), true);
      return;
    }
    await openProjectFolder(uri);
  });
  register('studio.removeRecentProject', async (project?: RecentProject) => {
    if (!project || !readRecentProjects([project]).length) {
      return;
    }
    const remove: vscode.MessageItem = { title: t('Remove from Recent Projects') };
    const answer = await vscode.window.showWarningMessage(t('Remove "{0}" from recent projects?', project.label), {
      modal: true,
      detail: t('This only removes the recent entry. The project files and current workspace will not be affected.'),
    }, remove, { title: t('Cancel'), isCloseAffordance: true });
    if (answer === remove) {
      await saveRecent((previous) => previous.filter((entry) => entry.uri !== project.uri), true);
    }
  });
  register('studio.clearRecentProjects', async () => {
    const clear = t('Clear');
    const answer = await vscode.window.showWarningMessage(t('Clear recent projects?'), { modal: true }, clear);
    if (answer === clear) {
      await saveRecent(() => [], true);
    }
  });
  register('studio.internalDetectProjectTypes', async (uris: string[]) => (await icons.resolveMany(Array.isArray(uris) ? uris.filter(uri => typeof uri === 'string').slice(0, 500) : [])).map(row => ({ ...row, ...recent.withOrigin(row.uri, row) })));
  register('studio.refreshProjects', async () => { await recent.reconcile(); icons.refresh(); recent.refresh(); });
  register('studio.newFile', async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument());
  });
  register('studio.openTerminal', () => {
    const name = vscode.workspace.getConfiguration('studio').get<string>('terminal.name', 'Studio');
    vscode.window.createTerminal({ name }).show();
  });
  register('studio.runTask', () => vscode.commands.executeCommand('workbench.action.tasks.runTask'));

  const refreshWorkspace = (): void => {
    void rememberCurrentWorkspace().catch((error) => output.appendLine(`Recent projects: ${String(error)}`));
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(refreshWorkspace),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('studio.recentProjects.limit')) {
        refreshWorkspace();
      }
    }),
  );
  const sidebar = new ProjectSidebar(context, launcher, output);
  account.setProjectSidebar(sidebar);
  await Promise.all([activateInternalLayer(context, output, account, sidebar), recent.reconcile().then(rememberCurrentWorkspace)]);
  const workflows = await activateProject(context, launcher, output, account, icons, sidebar);
  context.subscriptions.push(new StudioStartController(context, launcher, account, workflows, recent,
    project => saveRecent(previous => rememberProjects(previous, [{ uri: vscode.Uri.file(project.directory).toString(), label: project.name, kind: 'folder', lastOpened: Date.now() }],
      vscode.workspace.getConfiguration('studio').get<number>('recentProjects.limit', 12))), output));
  output.appendLine(`Studio ${context.extension.packageJSON.version} activated.`);
}
