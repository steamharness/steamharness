import { t } from './localization';
import * as vscode from 'vscode';
import { projectTypeLabels, projectVersion, projectDisplayName, type Project } from './workflow-types';
import type { AccountController } from './workflow-auth';
import type { Launcher, WebSession } from './workflow-cli-types';
import { workflowFrameHtml } from './workflow-webview';
import { AssistantViewProvider, type AssistantConversation } from './assistant-view';
import { ResourceViews } from './workflow-resources-view';
import { TraceView } from './workflow-trace-view';
import { InfoView } from './workflow-info-view';
import { RelatedProjectsView } from './workflow-related-projects-view';
import { VersionsView } from './workflow-versions-view';
import type { ProjectVersionStatus } from './workflow-server-projects';
import { assistantWorkspaceAvailable } from './assistant-workspace';
import { bindWorkflowClipboard } from './workflow-clipboard';
import { bindWorkflowResourceCards, type ResourceCardResult } from './workflow-resource-cards';
import { projectTypeIcons as icons } from './projects';
import type { ProjectIcons } from './project-icons';

const ignored = new Set(['node_modules', 'vendor', 'dist', 'out', 'build', 'upstream']);
const containers = new Set(['workspace', 'workflow', 'projects', 'examples']);
const utf8 = new TextDecoder();

export async function findWorkflowCandidates(root: vscode.Uri, depth = 0): Promise<vscode.Uri[]> {
  if (depth > 4) { return []; }
  try {
    const pkg = JSON.parse(utf8.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'package.json'))));
    if (typeof pkg.id === 'string' && /^[0-9a-f-]{36}$/i.test(pkg.id)) { return [root]; }
  } catch { /* A workspace folder need not be a Workflow package. */ }
  let children: [string, vscode.FileType][];
  try { children = await vscode.workspace.fs.readDirectory(root); } catch { return []; }
  const nested = await Promise.all(children
    .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.') && !ignored.has(name) && (depth === 0 || containers.has(name) || containers.has(root.path.split('/').at(-1) ?? '')))
    .map(([name]) => findWorkflowCandidates(vscode.Uri.joinPath(root, name), depth + 1)));
  return nested.flat();
}

class ProjectsProvider implements vscode.TreeDataProvider<Project> {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  private published = '';
  projects: Project[] = [];
  refresh(): void {
    const signature = JSON.stringify(this.projects.map(({ uri, id, name, projectType, folderPath, manifest }) => ({ uri, id, name, projectType, folderPath, version: manifest?.version })));
    if (signature === this.published) { return; }
    this.published = signature;
    this.change.fire();
  }
  dispose(): void { this.change.dispose(); }
  getChildren(): Project[] { return this.projects; }
  getTreeItem(project: Project): vscode.TreeItem {
    const item = new vscode.TreeItem(project.name);
    item.id = project.uri;
    item.resourceUri = vscode.Uri.parse(project.uri);
    item.description = [projectTypeLabels[project.projectType], projectVersion(project)].filter(Boolean).join(' \u00b7 ');
    item.tooltip = `${projectDisplayName(project)}\n${project.folderPath}`;
    item.contextValue = 'studio.workflowProject';
    item.iconPath = new vscode.ThemeIcon(icons[project.projectType]);
    item.command = { command: 'studio.openWorkflow', title: t("Run Project"), arguments: [project] };
    return item;
  }
}

export async function activateWorkflow(context: vscode.ExtensionContext, launcher: Launcher, output: vscode.OutputChannel, account: AccountController, projectIcons?: ProjectIcons): Promise<{
  getProjects(): Project[]; onDidChangeProjects: vscode.Event<void>;
  getVersionStatus(project: Project): ProjectVersionStatus; onDidChangeVersions: vscode.Event<void>;
}> {
  const provider = new ProjectsProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 110);
  status.command = 'studio.openWorkflow';
  const versionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 109);
  versionStatus.name = t('Project Updates');
  versionStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  const workspaces = new Map<string, { panel: vscode.WebviewPanel; project: Project; running: boolean; close(): Promise<void> }>();
  const opening = new Map<string, Promise<AssistantConversation>>();
  const starting = new Map<AbortController, Project>();
  const startingSources = new Map<AbortController, string[]>();
  const startingDone = new Map<AbortController, Promise<void>>();
  const settling = new Map<string, Promise<void>>();
  const terminals = new Map<vscode.Terminal, string>();
  const sessions = new Set<WebSession>();
  const sessionSources = new Map<WebSession, string[]>();
  const sessionStops = new Map<WebSession, () => Promise<void>>();
  const upgrading = new Set<string>();
  let disposed = false, scanEpoch = 0;
  let initialScan = Promise.resolve();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let entryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | undefined;
  let refreshRequested = false;
  let resumeRefresh: (() => void) | undefined;
  let cliConnection = JSON.stringify(account.getConnection());
  const currentProject = (): Project | undefined => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri ? [...provider.projects].sort((a, b) => b.uri.length - a.uri.length).find(entry => uri.toString().startsWith(`${entry.uri}/`)) : undefined)
      ?? [...workspaces.values()].find(workspace => workspace.panel.active)?.project ?? provider.projects[0];
  };
  const theme = (): 'light' | 'dark' => [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind) ? 'light' : 'dark';
  const usesProject = (sources: string[], uri: string): boolean => sources.some(directory => {
    const source = vscode.Uri.file(directory).toString();
    return source === uri || source.startsWith(`${uri}/`) || uri.startsWith(`${source}/`);
  });
  const assertNotUpgrading = (sources: string[]): void => {
    if ([...upgrading].some(uri => usesProject(sources, uri))) { throw new Error(t('This project is being upgraded. Wait for the upgrade to finish.')); }
  };
  const projectAvailable = (project: Project): boolean => {
    const roots = vscode.workspace.workspaceFolders ?? [];
    return !disposed && vscode.workspace.isTrusted && (project.assistant
      ? assistantWorkspaceAvailable(project.assistant, roots.filter(folder => folder.uri.scheme === 'file').map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name })))
      : project.builtin === 'analysis' || roots.some(root => project.uri === root.uri.toString() || project.uri.startsWith(`${root.uri.toString()}/`)));
  };
  const updateEntry = (): void => {
    clearTimeout(entryTimer); entryTimer = undefined;
    if (disposed) { return; }
    const target = currentProject();
    resources.update(provider.projects, target);
    trace.update(provider.projects, target);
    void related.update(provider.projects, target);
    versions.update(provider.projects, target);
    void info.update(provider.projects, target);
    updateVersionEntry();
    void vscode.commands.executeCommand('setContext', 'studio.workflowAvailable', !!target);
    if (!target) { status.hide(); return; }
    status.text = t("$(play) Run Project \u00B7 {0}", projectDisplayName(target));
    status.tooltip = target.folderPath; status.show();
  };
  const updateVersionEntry = (): void => {
    const project = currentProject();
    if (!project || project.assistant || project.builtin) { versionStatus.hide(); return; }
    const update = versions.getVersionStatus(project);
    if (update.status !== 'upgrade') { versionStatus.hide(); return; }
    versionStatus.text = t('$(arrow-circle-up) {0} \u2192 {1}', update.localVersion!, update.serverVersion!);
    versionStatus.tooltip = t('Update available for {0}. Local: {1}. Server: {2}. Choose where to upgrade.', project.name, update.localVersion!, update.serverVersion!);
    versionStatus.command = { command: 'studio.upgradeProject', title: t('Upgrade Project'), arguments: [{ uri: project.uri }] };
    versionStatus.show();
  };
  const scheduleEntry = (): void => {
    if (disposed) { return; }
    clearTimeout(entryTimer);
    entryTimer = setTimeout(updateEntry, 150);
  };
  const createWorkspace = async (project: Project, restored?: vscode.WebviewPanel, sidebar?: vscode.WebviewView): Promise<AssistantConversation> => {
    await settling.get(project.uri);
    if (!projectAvailable(project)) { restored?.dispose(); throw new Error('Workflow workspace is unavailable.'); }
    const controller = new AbortController();
    let finishStarting!: () => void;
    startingDone.set(controller, new Promise<void>(resolve => { finishStarting = resolve; }));
    starting.set(controller, project);
    const disposedPanel = (sidebar ?? restored)?.onDidDispose(() => controller.abort());
    let session: WebSession;
    let sources: string[] = [];
    try {
      const bindings = await related.bindings(project), resourceProjects = await related.resourceProjects();
      sources = [project.folderPath, ...bindings.map(binding => binding.projectDir), ...resourceProjects];
      assertNotUpgrading(sources);
      startingSources.set(controller, sources);
      session = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t("Starting SteamHarness Web") }, async () =>
        launcher.start(project, sidebar ? 'assistant' : 'editor', controller.signal, bindings, resourceProjects));
      if (controller.signal.aborted || !projectAvailable(project)) { await session.close(); throw new Error('Workflow workspace has closed.'); }
    } catch (error) {
      restored?.dispose(); throw error;
    } finally { starting.delete(controller); startingSources.delete(controller); startingDone.delete(controller); finishStarting(); disposedPanel?.dispose(); }
    sessions.add(session);
    sessionSources.set(session, sources);
    const panel = sidebar ?? restored ?? vscode.window.createWebviewPanel('studio.workflow', projectDisplayName(project), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    const listeners: vscode.Disposable[] = [];
    let closed = false;
    const close = (): Promise<void> => {
      if (closed) { return session.closed; }
      closed = true; sessions.delete(session); sessionSources.delete(session); sessionStops.delete(session);
      if (!sidebar && workspaces.get(project.uri)?.close === close) { workspaces.delete(project.uri); }
      for (const listener of listeners.splice(0)) { listener.dispose(); }
      const settled = session.close().finally(() => { if (settling.get(project.uri) === settled) { settling.delete(project.uri); } });
      settling.set(project.uri, settled); updateEntry(); return settled;
    };
    sessionStops.set(session, async () => { await close(); if ('reveal' in panel) { panel.dispose(); } });
    listeners.push(panel.onDidDispose(() => void close()));
    let relatedGeneration = 0;
    const syncRelatedProjects = (): void => {
      const generation = ++relatedGeneration;
      void Promise.all([related.bindings(project), related.resourceProjects()]).then(([bindings, resourceProjects]) => {
        if (!closed && generation === relatedGeneration) {
          const sources = [project.folderPath, ...bindings.map(binding => binding.projectDir), ...resourceProjects];
          assertNotUpgrading(sources);
          sessionSources.set(session, sources);
          session.updateRelatedProjects(bindings, resourceProjects);
        }
      }).catch(error => output.appendLine(`Related projects: ${String(error)}`));
    };
    listeners.push(related.onDidChangeBindings(syncRelatedProjects));
    syncRelatedProjects();
    try {
      const local = vscode.Uri.parse(session.ready.url);
      const external = await vscode.env.asExternalUri(local);
      const address = new URL(external.toString());
      address.hash = new URL(session.ready.url).hash;
      if (closed || !projectAvailable(project)) { await close(); throw new Error('Workflow workspace has closed.'); }
      panel.webview.options = { enableScripts: true, localResourceRoots: [], portMapping: [{ webviewPort: Number(new URL(session.ready.url).port), extensionHostPort: Number(new URL(session.ready.url).port) }] };
      const traceBinding = trace.bind(project, session.ready.traceProtocolVersion, panel.webview);
      const clipboardBinding = bindWorkflowClipboard(panel.webview);
      const resourceBinding = bindWorkflowResourceCards(panel.webview, session.ready.url, async result => {
        if (closed) { throw new Error(t('Unable to open the resource.')); }
        await openCard(result, project, session, address);
      });
      listeners.push(traceBinding, clipboardBinding, resourceBinding, panel.webview.onDidReceiveMessage(message => {
        if (message?.type === 'workflow-account' && message.version === 1) { account.open(); }
        else if (!clipboardBinding.receive(message) && !resourceBinding.receive(message)) { traceBinding.receive(message); }
      }));
      panel.webview.html = workflowFrameHtml(address.href, project.name, project.uri, theme(), globalThis.crypto.randomUUID().replace(/-/g, ''), vscode.env.language);
      if ('reveal' in panel) {
        panel.title = projectDisplayName(project); panel.iconPath = new vscode.ThemeIcon(icons[project.projectType]);
        workspaces.set(project.uri, { panel, project, running: true, close });
        listeners.push(panel.onDidChangeViewState(scheduleEntry));
      }
      listeners.push(vscode.window.onDidChangeActiveColorTheme(() => void panel.webview.postMessage({ type: 'workflow-host', theme: theme() })),
        session.onExit(() => {
          traceBinding.dispose();
          sessions.delete(session); sessionSources.delete(session); sessionStops.delete(session);
          if (!closed) {
            const entry = workspaces.get(project.uri);
            if (entry?.close === close) { entry.running = false; }
            output.appendLine(`SteamHarness Web stopped: ${project.name}`);
          }
        }));
      output.appendLine(`SteamHarness Web: ${project.name}; project Core ${session.ready.runtime.harnessVersion}; ${session.ready.runtime.harnessPath}`);
      updateEntry(); return { dispose: close, closed: session.closed };
    } catch (error) { await close(); if ('reveal' in panel) { panel.dispose(); } throw error; }
  };
  const openProject = async (target?: Project): Promise<void> => {
    const selected = target?.builtin === 'analysis' ? target : target?.uri ? provider.projects.find(entry => entry.uri === target.uri) : currentProject();
    if (!selected) { return; }
    assertNotUpgrading([selected.folderPath]);
    await settling.get(selected.uri);
    const pending = opening.get(selected.uri);
    if (pending) { await pending; workspaces.get(selected.uri)?.panel.reveal(); return; }
    const existing = workspaces.get(selected.uri);
    if (existing?.running) { existing.panel.reveal(); return; }
    const created = (async () => { await existing?.close(); return createWorkspace(selected, existing?.panel); })(); opening.set(selected.uri, created);
    try { await created; } finally { opening.delete(selected.uri); }
  };
  const openCard = async (result: ResourceCardResult, owner: Project, session: WebSession, origin: URL): Promise<void> => {
    const { card, project } = result;
    if (result.action === 'open' || result.action === 'project') {
      if ((card.kind === 'kv' || card.kind === 'knowledge') && project) { await resources.open(card.kind, project, card.target, owner); return; }
      if (card.kind === 'file' && project?.folderPath) {
        const root = vscode.Uri.file(project.assistant?.workdir ?? project.folderPath);
        await vscode.window.showTextDocument(vscode.Uri.joinPath(root, card.target.filePath)); return;
      }
      if (card.kind === 'browser') { await vscode.env.openExternal(vscode.Uri.parse(card.target.url)); return; }
      if ((card.kind === 'project' && card.preview !== true || result.action === 'project') && project?.folderPath) {
        const workspaceProject = provider.projects.find(entry => entry.uri === project.uri);
        if (workspaceProject) { await openProject(workspaceProject); }
        else { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(project.uri), { forceNewWindow: true }); }
        return;
      }
    }
    const preview = vscode.window.createWebviewPanel('studio.resourcePreview', card.title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    const url = new URL(result.url, origin); url.hash = new URL(session.ready.url).hash;
    preview.webview.options = { enableScripts: true, localResourceRoots: [], portMapping: [{ webviewPort: Number(origin.port), extensionHostPort: Number(new URL(session.ready.url).port) }] };
    const ready = result.action === 'window' ? new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { listener.dispose(); disposal.dispose(); reject(new Error(t('Unable to open the resource.'))); }, 20_000);
      const listener = preview.webview.onDidReceiveMessage(message => {
        if (message?.type === 'workflow-frame-ready') { clearTimeout(timer); listener.dispose(); disposal.dispose(); resolve(); }
      });
      const disposal = preview.onDidDispose(() => { clearTimeout(timer); listener.dispose(); disposal.dispose(); reject(new Error(t('Unable to open the resource.'))); });
    }) : Promise.resolve();
    preview.iconPath = new vscode.ThemeIcon(card.kind === 'knowledge' ? 'book' : card.kind === 'kv' ? 'database' : 'preview');
    const clipboard = bindWorkflowClipboard(preview.webview);
    const subscriptions = [clipboard, preview.webview.onDidReceiveMessage(message => clipboard.receive(message)),
      vscode.window.onDidChangeActiveColorTheme(() => void preview.webview.postMessage({ type: 'workflow-host', theme: theme() })), session.onExit(() => preview.dispose())];
    preview.onDidDispose(() => { for (const listener of subscriptions) { listener.dispose(); } });
    preview.webview.html = workflowFrameHtml(url.href, card.title, owner.uri, theme(), globalThis.crypto.randomUUID().replace(/-/g, ''), vscode.env.language);
    if (result.action === 'window') {
      try { await ready; preview.reveal(); await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); }
      catch (error) { preview.dispose(); throw error; }
    }
  };
  const assistant = new AssistantViewProvider(context, launcher, output, (project, view) => createWorkspace(project, undefined, view));
  const resources = new ResourceViews(context, launcher, account, output);
  const trace = new TraceView(context, openProject, output);
  const related = new RelatedProjectsView(context, output, findWorkflowCandidates, projectIcons);
  const prepareUpgrade = async (project: Project, signal: AbortSignal): Promise<vscode.Disposable> => {
    signal.throwIfAborted();
    if (!projectAvailable(project) || upgrading.has(project.uri)) { throw new Error(t('The project is no longer available for upgrading.')); }
    upgrading.add(project.uri);
    ++scanEpoch;
    const release = new vscode.Disposable(() => { upgrading.delete(project.uri); scheduleRefresh(); });
    try {
      const inside = (uri: vscode.Uri): boolean => uri.toString().startsWith(`${project.uri}/`);
      for (const document of vscode.workspace.notebookDocuments.filter(document => document.isDirty && inside(document.uri))) {
        signal.throwIfAborted();
        if (!await document.save()) { throw new Error(t('Save the project files before upgrading.')); }
      }
      for (const document of vscode.workspace.textDocuments.filter(document => document.isDirty && inside(document.uri))) {
        signal.throwIfAborted();
        if (!await document.save()) { throw new Error(t('Save the project files before upgrading.')); }
      }
      const pending: Promise<unknown>[] = [];
      signal.throwIfAborted();
      for (const [controller, entry] of starting) {
        if (usesProject(startingSources.get(controller) ?? [entry.folderPath], project.uri)) {
          const done = startingDone.get(controller);
          if (done) { pending.push(done); }
          controller.abort();
        }
      }
      for (const [session, sources] of sessionSources) {
        if (usesProject(sources, project.uri)) { const stop = sessionStops.get(session); if (stop) { pending.push(stop()); } }
      }
      for (const [terminal, uri] of terminals) {
        if (uri === project.uri || uri.startsWith(`${project.uri}/`)) { terminal.dispose(); terminals.delete(terminal); }
      }
      await Promise.all(pending);
      signal.throwIfAborted();
      await settling.get(project.uri);
      if (vscode.workspace.textDocuments.some(document => document.isDirty && inside(document.uri))
        || vscode.workspace.notebookDocuments.some(document => document.isDirty && inside(document.uri))) {
        throw new Error(t('Save the project files before upgrading.'));
      }
      return release;
    } catch (error) { release.dispose(); throw error; }
  };
  const versions = new VersionsView(context, launcher, account, output, prepareUpgrade,
    (projects, replacedRoot) => related.rememberProjectGroup(projects, replacedRoot));
  const info = new InfoView(context, versions);
  const inspectProjects = async (epoch: number): Promise<void> => {
    if (upgrading.size) { return; }
    if (!launcher.available || !vscode.workspace.isTrusted) { provider.projects = []; launcher.updateAnalysisProjects?.([]); provider.refresh(); updateEntry(); return; }
    const candidates = (await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => findWorkflowCandidates(folder.uri)))).flat();
    if (disposed || epoch !== scanEpoch || upgrading.size) { return; }
    const byPath = new Map(candidates.map(uri => [uri.fsPath, uri]));
    const result = await launcher.inspect([...byPath.keys()]);
    if (disposed || epoch !== scanEpoch || upgrading.size) { return; }
    provider.projects = result.projects.filter(project => byPath.has(project.folderPath)).map(project => ({ ...project, uri: byPath.get(project.folderPath)!.toString() }));
    launcher.updateAnalysisProjects?.(provider.projects);
    for (const error of result.errors) { output.appendLine(`Workflow inspection: ${error}`); }
    provider.refresh(); updateEntry();
  };
  const refresh = (): Promise<void> => {
    clearTimeout(refreshTimer); refreshTimer = undefined;
    resumeRefresh?.(); resumeRefresh = undefined;
    if (disposed) { return Promise.resolve(); }
    ++scanEpoch; refreshRequested = true;
    if (refreshing) { return refreshing; }
    refreshing = (async () => {
      try {
        while (refreshRequested && !disposed) {
          // Keep callers waiting through changes scheduled during the current scan.
          if (refreshTimer) { await new Promise<void>(resolve => { resumeRefresh = resolve; }); }
          if (disposed) { return; }
          refreshRequested = false;
          const epoch = scanEpoch;
          try { await inspectProjects(epoch); }
          catch (error) { if (!disposed && epoch === scanEpoch) { throw error; } }
        }
      } finally { refreshing = undefined; }
    })();
    return refreshing;
  };
  const scheduleRefresh = (): void => {
    if (disposed) { return; }
    ++scanEpoch; refreshRequested = true;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh().catch(error => output.appendLine(String(error))), 350);
  };
  const changedFile = (uri: vscode.Uri): void => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || uri.path.slice(folder.uri.path.length).split('/').some(part => ignored.has(part))) { return; }
    scheduleRefresh();
  };
  const closeTerminals = (): void => { for (const terminal of terminals.keys()) { terminal.dispose(); } terminals.clear(); };
  const register = <Args extends unknown[]>(command: string, callback: (...args: Args) => unknown): vscode.Disposable => vscode.commands.registerCommand(command, async (...args: Args) => {
    try { return await callback(...args); }
    catch (error) { output.appendLine(String(error)); await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
  });
  const watcher = vscode.workspace.createFileSystemWatcher('**/{package.json,index.ts,kanban.json}');
  context.subscriptions.push(launcher, provider, status, versionStatus, versions.onDidChangeVersions(updateVersionEntry),
    vscode.window.registerWebviewPanelSerializer('studio.workflow', { deserializeWebviewPanel: async (panel, state: { projectUri?: string } | undefined) => {
      await initialScan;
      let project = provider.projects.find(entry => entry.uri === state?.projectUri);
      if (!project && state?.projectUri && launcher.inspectAnalysis) {
        try { const analysis = await launcher.inspectAnalysis(); if (analysis.uri === state.projectUri) project = analysis; }
        catch { panel.dispose(); return; }
      }
      if (!project) { panel.dispose(); return; }
      await opening.get(project.uri);
      if (workspaces.has(project.uri)) { panel.dispose(); return; }
      const created = createWorkspace(project, panel); opening.set(project.uri, created);
      try { await created; } finally { opening.delete(project.uri); }
    } }),
    register('studio.openWorkflow', openProject), register('studio.refreshWorkflows', refresh),
    register('studio.openAnalysis', async () => {
      if (!launcher.inspectAnalysis) { throw new Error(t('Studio Analysis is unavailable in this environment.')); }
      await openProject(await launcher.inspectAnalysis());
    }),
    register('studio.openWorkflowSource', async (target?: Project) => {
      const selected = target?.uri ? provider.projects.find(entry => entry.uri === target.uri) : currentProject();
      if (selected) { await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.parse(selected.uri), 'package.json')); }
    }),
    register('studio.openWorkflowDemo', () => openProject(provider.projects.find(entry => entry.id === 'b20a7d1d-b6f5-4b0c-8589-265d56fc879a') ?? currentProject())),
    register('studio.openWorkflowCli', async () => {
      const project = currentProject();
      if (!project || !vscode.workspace.isTrusted || !launcher.available) { return; }
      const entry = await launcher.cliEntry(project.folderPath);
      assertNotUpgrading([project.folderPath]);
      const terminal = vscode.window.createTerminal({ name: 'SteamHarness CLI', cwd: project.folderPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
      terminals.set(terminal, project.uri);
      const quote = (value: string): string => process.platform === 'win32' ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, "'\\''")}'`;
      terminal.sendText(`${quote(vscode.workspace.getConfiguration('studio').get<string>('workflow.nodePath') || process.execPath)} ${quote(entry)} --help`); terminal.show();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const [controller, project] of starting) { if (!projectAvailable(project)) { controller.abort(); } }
      for (const entry of workspaces.values()) { if (!projectAvailable(entry.project)) { entry.panel.dispose(); } }
      scheduleRefresh();
    }), vscode.workspace.onDidGrantWorkspaceTrust(scheduleRefresh), vscode.window.onDidChangeActiveTextEditor(scheduleEntry),
    vscode.window.onDidCloseTerminal(terminal => terminals.delete(terminal)),
    account.onDidChange(state => { if (state.status !== 'checking') { const next = JSON.stringify(account.getConnection()); if (state.status === 'signed-out' || next !== cliConnection) { closeTerminals(); } cliConnection = next; } }),
    watcher, watcher.onDidChange(changedFile), watcher.onDidCreate(changedFile), watcher.onDidDelete(changedFile),
    { dispose: () => { disposed = true; ++scanEpoch; clearTimeout(refreshTimer); resumeRefresh?.(); resumeRefresh = undefined; clearTimeout(entryTimer); closeTerminals(); for (const controller of starting.keys()) { controller.abort(); } for (const entry of workspaces.values()) { entry.panel.dispose(); } for (const session of sessions) { void session.close(); } } });
  initialScan = refresh().catch(error => output.appendLine(`Workflow: ${String(error)}`));
  await initialScan;
  void assistant.showInitially().catch(error => output.appendLine(`Project Assistant: ${String(error)}`));
  return { getProjects: () => [...provider.projects], onDidChangeProjects: provider.onDidChangeTreeData,
    getVersionStatus: project => versions.getVersionStatus(project), onDidChangeVersions: versions.onDidChangeVersions };
}
