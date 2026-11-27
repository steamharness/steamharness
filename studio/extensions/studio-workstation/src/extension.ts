import './localization-host';
import { t } from './localization';
import * as vscode from 'vscode';
import { applyRecentMetadata, projectTypeIcons, readRecentProjects, rememberProjects, type RecentProject } from './projects';
import { ProjectIcons } from './project-icons';
import { activateProject } from './workflow';
import type { Launcher } from './workflow-cli-types';
import { activateProjectAccount, type AccountController } from './workflow-auth';
import { activateDocumentPreviews } from './document-preview';
import { StudioStartController } from './start-page';
import { activateInternalLayer } from './internal-layer';
import { openProjectFolder } from './project-window';
import { bindProjectHistory, isMissingProject, pruneMissingProjectHistory, readProjectHistory, updateProjectHistory } from './project-history';
import { ProjectSidebar } from './project-sidebar';
import { ProjectDependencyProgress } from './project-dependency-progress';

class RecentProjectsProvider {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  private snapshot = '';

  constructor(private readonly context: vscode.ExtensionContext, private readonly icons: ProjectIcons, private readonly shared: () => boolean) {}
  async reconcile(): Promise<void> {
    await pruneMissingProjectHistory(this.context);
    const snapshot = JSON.stringify(readProjectHistory(this.context));
    if (snapshot !== this.snapshot) { this.snapshot = snapshot; this.refresh(); }
  }
  refresh(): void { this.change.fire(); }
  dispose(): void { this.change.dispose(); }
  getChildren(): RecentProject[] {
    const history = readProjectHistory(this.context);
    const projects = new Map(history.recent.map(project => [project.uri, project]));
    if (this.shared()) for (const project of history.imported) {
      if (!projects.has(project.uri)) projects.set(project.uri, { uri: project.uri, label: project.name, kind: 'folder', lastOpened: 0 });
    }
    return [...projects.values()].map(project => ({ ...project,
      ...(project.kind === 'folder' ? this.icons.metadata(project.uri) : undefined) }));
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
  bindProjectHistory(context, () => account.workspace());
  const icons = new ProjectIcons(launcher, message => output.appendLine(message), [], () => readProjectHistory(context).imported);
  const recent = new RecentProjectsProvider(context, icons, () => !!account.workspace());
  const recentLimit = () => account.workspace() ? 50 : vscode.workspace.getConfiguration('studio').get<number>('recentProjects.limit', 12);
  context.subscriptions.push(output, recent, icons, icons.onDidChange(updates => {
    recent.refresh();
    void updateProjectHistory(context, history => ({ ...history, recent: applyRecentMetadata(history.recent, updates) }))
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
    await account.waitForWorkspaceAccount();
    const now = Date.now();
    const opened: RecentProject[] = (vscode.workspace.workspaceFolders ?? [])
      .filter(folder => ['file', 'vscode-remote'].includes(folder.uri.scheme) &&
        (folder.uri.scheme !== 'file' || !launcher.isBuiltinProjectDirectory?.(folder.uri.fsPath)))
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
    if (opened.length) await saveRecent(previous => rememberProjects(previous, opened, recentLimit()));
  };

  context.subscriptions.push(vscode.commands.registerCommand('studio.internalWorkspaceInbox', (owner: unknown, input: unknown) => {
    const holder = account.workspace();
    if (holder && holder.owner === owner) return holder.inbox(input);
    return undefined;
  }));
  register('studio.internalEditWorkspaceHistory', async (owner: string, action: 'import' | 'remove', uris: string[]) => {
    const holder = account.workspace();
    if (!holder || holder.owner !== owner || !Array.isArray(uris) || !['import', 'remove'].includes(action)) return false;
    const rows: RecentProject[] = [];
    for (const raw of uris.slice(0, 50)) {
      if (typeof raw !== 'string' || raw.length > 16384) continue;
      const uri = vscode.Uri.parse(raw);
      if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment) continue;
      if (action === 'import') {
        if (launcher.isBuiltinProjectDirectory?.(uri.fsPath)) continue;
        try { if (!((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory)) continue; }
        catch (error) { if (isMissingProject(error)) continue; throw error; }
      }
      rows.push({ uri: uri.toString(), label: uri.fsPath.split(/[\\/]/).filter(Boolean).at(-1) ?? uri.fsPath, kind: 'folder', lastOpened: Date.now() });
    }
    if (!rows.length || account.workspace() !== holder) return false;
    const selected = new Set(rows.map(row => row.uri));
    await updateProjectHistory(context, history => action === 'import'
      ? { ...history, recent: rememberProjects(history.recent, rows, 50) }
      : { recent: history.recent.filter(row => !selected.has(row.uri)), imported: history.imported.filter(row => !selected.has(row.uri)) });
    recent.refresh();
    return account.workspace() === holder;
  });

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
  register('studio.removeRecentProject', async (project?: RecentProject, expectedOwner?: string | null) => {
    if (!project || !readRecentProjects([project]).length) {
      return;
    }
    const remove: vscode.MessageItem = { title: t('Remove from Recent Projects') };
    const holder = account.workspace();
    if (expectedOwner !== undefined && (holder?.owner ?? null) !== expectedOwner) return false;
    const answer = await vscode.window.showWarningMessage(t('Remove "{0}" from recent projects?', project.label), {
      modal: true,
      detail: t('This only removes the recent entry. The project files and current workspace will not be affected.'),
    }, remove, { title: t('Cancel'), isCloseAffordance: true });
    if (answer === remove && holder === account.workspace()) {
      await updateProjectHistory(context, history => ({ recent: history.recent.filter(entry => entry.uri !== project.uri),
        imported: history.imported.filter(entry => entry.uri !== project.uri) }));
      recent.refresh();
      return true;
    }
    return false;
  });
  register('studio.clearRecentProjects', async () => {
    const holder = account.workspace();
    const clear = t('Clear');
    const answer = await vscode.window.showWarningMessage(t('Clear recent projects?'), { modal: true }, clear);
    if (answer === clear && holder === account.workspace()) {
      if (holder) { await updateProjectHistory(context, () => ({ recent: [], imported: [] })); recent.refresh(); }
      else await saveRecent(() => [], true);
    }
  });
  register('studio.internalDetectProjectTypes', (uris: string[]) => icons.resolveMany(Array.isArray(uris) ? uris.filter(uri => typeof uri === 'string').slice(0, 500) : []));
  const listBuiltinProjectDirectories = launcher.listBuiltinProjectDirectories;
  if (listBuiltinProjectDirectories) context.subscriptions.push(vscode.commands.registerCommand('studio.internalListBuiltinProjects', async () => {
    const { directories, pending } = await listBuiltinProjectDirectories();
    const uris = directories.map(directory => vscode.Uri.file(directory));
    const metadata = new Map((await icons.resolveMany(uris.map(uri => uri.toString()))).map(project => [project.uri, project]));
    const projects = uris.flatMap(uri => {
      const project = metadata.get(uri.toString());
      return project?.distribution === 'release' && project.projectName ? [{ ...project, kind: 'folder', path: uri.fsPath, name: project.projectName }] : [];
    });
    return { projects, pending };
  }));
  const readLibraryActivity = launcher.readLibraryActivity;
  if (readLibraryActivity) {
    context.subscriptions.push(vscode.commands.registerCommand('studio.internalReadLibraryActivity', readLibraryActivity));
  }
  if (launcher.readProjectUsage) {
    context.subscriptions.push(vscode.commands.registerCommand('studio.internalProjectUsage', launcher.readProjectUsage));
  }
  if (launcher.openBotCredentials) {
    context.subscriptions.push(vscode.commands.registerCommand('studio.internalOpenBotCredentials', launcher.openBotCredentials));
  }
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
    account.onDidChange(() => recent.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('studio.recentProjects.limit')) {
        refreshWorkspace();
      }
    }),
  );
  const sidebar = new ProjectSidebar(context, launcher, output);
  account.setProjectSidebar(sidebar);
  await activateInternalLayer(context, output, account, sidebar, {
    inspect: (paths, options) => launcher.inspect(paths, options),
    start: (...args) => launcher.start(...args),
    localAssistantDirectory: launcher.localAssistantDirectory,
    readSidebarEntries: launcher.readSidebarEntries,
    async avatar(uri) { return (await icons.resolveMany([uri]))[0]?.avatarUrl; },
  });
  const accountReady = account.waitForWorkspaceAccount();
  const restoreRecent = () => recent.reconcile().then(rememberCurrentWorkspace).catch(error => output.appendLine(`Recent projects: ${String(error)}`));
  if (accountReady) void accountReady.then(restoreRecent);
  else await restoreRecent();
  const dependencyProgress = new ProjectDependencyProgress();
  context.subscriptions.push(dependencyProgress);
  const workflows = await activateProject(context, launcher, output, account, icons, sidebar, dependencyProgress);
  context.subscriptions.push(new StudioStartController(context, launcher, account, workflows, recent,
    project => saveRecent(previous => rememberProjects(previous, [{ uri: vscode.Uri.file(project.directory).toString(), label: project.name, kind: 'folder', lastOpened: Date.now() }],
      recentLimit())), output, dependencyProgress));
  output.appendLine(`Studio ${context.extension.packageJSON.version} activated.`);
}
