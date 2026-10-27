import { t } from './localization';
import * as vscode from 'vscode';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { projectTypeLabels, projectVersion, projectDisplayName, type Project } from './workflow-types';
import type { AccountController } from './workflow-auth';
import type { Launcher, WebSession } from './workflow-cli-types';
import { projectFrameHtml, type ProjectWindowChrome } from './workflow-webview';
import { AssistantViewProvider, type AssistantConversation } from './assistant-view';
import { ResourceViews } from './workflow-resources-view';
import { ToolInstances } from './tool-instances';
import { TraceView } from './workflow-trace-view';
import { InfoView } from './workflow-info-view';
import { RelatedProjectsView } from './workflow-related-projects-view';
import { VersionsView } from './workflow-versions-view';
import type { ProjectVersionStatus } from './steamharness-server-projects';
import { assistantWorkspaceAvailable } from './assistant-workspace';
import { bindProjectClipboard } from './workflow-clipboard';
import { bindProjectPathPicker } from './workflow-path-picker';
import { bindProjectPathOpen } from './workflow-path-open';
import { openProjectUserSettings } from './workflow-user-settings';
import { ProjectFileIcons } from './workflow-file-icons';
import { bindProjectResourceCards, type ResourceCardResult } from './workflow-resource-cards';
import type { ProjectIcons } from './project-icons';
import { openProjectFolder } from './project-window';
import { StudioModeController } from './studio-mode';
import { chooseProjectTab, inspectProjectTab } from './project-tabs';
import { RecoverableWebSession } from './workflow-session';

const ignored = new Set(['node_modules', 'vendor', 'dist', 'out', 'build', 'upstream']);
const containers = new Set(['workspace', 'workflow', 'projects', 'examples']);
const utf8 = new TextDecoder();

export async function findProjectCandidates(root: vscode.Uri, depth = 0): Promise<vscode.Uri[]> {
  if (depth > 4) { return []; }
  try {
    const pkg = JSON.parse(utf8.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'package.json'))));
    if (typeof pkg.id === 'string' && /^[0-9a-f-]{36}$/i.test(pkg.id)) { return [root]; }
  } catch { /* A workspace folder need not be a Workflow package. */ }
  let children: [string, vscode.FileType][];
  try { children = await vscode.workspace.fs.readDirectory(root); } catch { return []; }
  const nested = await Promise.all(children
    .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.') && !ignored.has(name) && (depth === 0 || containers.has(name) || containers.has(root.path.split('/').at(-1) ?? '')))
    .map(([name]) => findProjectCandidates(vscode.Uri.joinPath(root, name), depth + 1)));
  return nested.flat();
}

class ProjectsProvider implements vscode.TreeDataProvider<Project> {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  private published = '';
  projects: Project[] = [];
  refresh(): void {
    const signature = JSON.stringify(this.projects.map(({ uri, id, name, projectType, projectCard, folderPath, manifest }) => ({ uri, id, name, projectType, projectCard, folderPath, version: manifest?.version })));
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
    item.contextValue = 'studio.project';
    item.iconPath = vscode.Uri.parse(projectAvatarDataUrl(project.projectCard, project.projectType));
    item.command = { command: 'studio.openProject', title: t("Run Project"), arguments: [project] };
    return item;
  }
}

export async function activateProject(context: vscode.ExtensionContext, launcher: Launcher, output: vscode.OutputChannel, account: AccountController, projectIcons?: ProjectIcons): Promise<{
  getProjects(): Project[]; onDidChangeProjects: vscode.Event<void>;
  getVersionStatus(project: Project): ProjectVersionStatus; onDidChangeVersions: vscode.Event<void>;
}> {
  const provider = new ProjectsProvider();
  const fileIcons = new ProjectFileIcons();
  context.subscriptions.push(fileIcons);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 110);
  status.command = 'studio.openProject';
  const versionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 109);
  versionStatus.name = t('Project Updates');
  versionStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  const workspaces = new Map<string, { panel: vscode.WebviewPanel; project: Project; running: boolean; loaded: boolean; ready: Promise<void>; close(): Promise<void> }>();
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
  let projectScanReady = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let entryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | undefined;
  let refreshRequested = false;
  let resumeRefresh: (() => void) | undefined;
  let cliConnection = JSON.stringify(account.getConnection());
  let steamPreparation: AbortController | undefined;
  let windowChrome: ProjectWindowChrome = { active: false, height: 52, left: 0, right: 0, revision: 0 };
  const chromeFor = (uri: string, primary: boolean): ProjectWindowChrome => ({ ...windowChrome, active: windowChrome.active && primary && windowChrome.projectUri === uri });
  const syncWindowChrome = (): void => {
    for (const entry of workspaces.values()) {
      void entry.panel.webview.postMessage({ type: 'workflow-host', windowChrome: chromeFor(entry.project.uri, entry.panel.viewType === 'studio.project') });
    }
  };
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
  const externalProjects = new Map<string, Project>();
  const resolveProjectTab = async (uri: vscode.Uri): Promise<Project> => {
    const known = provider.projects.find(project => project.uri === uri.toString()) ?? externalProjects.get(uri.toString());
    if (known) { return known; }
    const inspected = await inspectProjectTab(uri, launcher);
    const project = externalProjects.get(inspected.uri) ?? inspected;
    if (!disposed) { externalProjects.set(project.uri, project); }
    return project;
  };
  const projectAvailable = (project: Project): boolean => {
    const roots = vscode.workspace.workspaceFolders ?? [];
    return !disposed && vscode.workspace.isTrusted && (project.assistant
      ? assistantWorkspaceAvailable(project.assistant, roots.filter(folder => folder.uri.scheme === 'file').map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name })))
      : project.builtin === 'analysis' || externalProjects.get(project.uri) === project || roots.some(root => project.uri === root.uri.toString() || project.uri.startsWith(`${root.uri.toString()}/`)));
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
    toolInstances.update(provider.projects, target);
    updateVersionEntry();
    void vscode.commands.executeCommand('setContext', 'studio.projectAvailable', !!target);
    const workspace = target ? workspaces.get(target.uri) : undefined;
    if (projectScanReady) { mode.update(!!target && vscode.workspace.isTrusted, target?.uri, !!workspace?.running && workspace.loaded); }
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
  const createWorkspace = async (project: Project, restored?: vscode.WebviewPanel, sidebar?: vscode.WebviewView, viewColumn = vscode.ViewColumn.Active, signal?: AbortSignal, toolTab = false, conversationView?: 'new' | 'restore'): Promise<AssistantConversation> => {
    await settling.get(project.uri);
    signal?.throwIfAborted();
    if (!projectAvailable(project)) { restored?.dispose(); throw new Error('Workflow workspace is unavailable.'); }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
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
      if (controller.signal.aborted || !projectAvailable(project)) {
        await session.close(); controller.signal.throwIfAborted(); throw new Error('Workflow workspace has closed.');
      }
    } catch (error) {
      restored?.dispose(); controller.signal.throwIfAborted(); throw error;
    } finally { signal?.removeEventListener('abort', abort); starting.delete(controller); startingSources.delete(controller); startingDone.delete(controller); finishStarting(); disposedPanel?.dispose(); }
    const recoverable = new RecoverableWebSession(session, async (port, recoverySignal) => {
      if (!projectAvailable(project)) throw new Error('Workflow workspace is unavailable.');
      const bindings = await related.bindings(project), resourceProjects = await related.resourceProjects();
      assertNotUpgrading([project.folderPath, ...bindings.map(binding => binding.projectDir), ...resourceProjects]);
      return launcher.start(project, sidebar ? 'assistant' : 'editor', recoverySignal, bindings, resourceProjects, port);
    });
    session = recoverable;
    sessions.add(session);
    sessionSources.set(session, sources);
    const panel = sidebar ?? restored ?? vscode.window.createWebviewPanel(toolTab ? 'studio.projectTool' : 'studio.project', projectDisplayName(project), viewColumn, { enableScripts: true, retainContextWhenHidden: true });
    const listeners: vscode.Disposable[] = [];
    let frameReady!: () => void;
    const ready = new Promise<void>(resolve => { frameReady = resolve; });
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
      signal?.throwIfAborted();
      if (closed || !projectAvailable(project)) { await close(); throw new Error('Workflow workspace has closed.'); }
      panel.webview.options = { enableScripts: true, localResourceRoots: [], portMapping: [{ webviewPort: Number(new URL(session.ready.url).port), extensionHostPort: Number(new URL(session.ready.url).port) }] };
      let traceBinding = trace.bind(project, session.ready.traceProtocolVersion, panel.webview);
      const clipboardBinding = bindProjectClipboard(panel.webview);
      const pickerBinding = bindProjectPathPicker(panel.webview, vscode.Uri.file(project.folderPath));
      const pathOpenBinding = bindProjectPathOpen(panel.webview);
      const fileIconsBinding = fileIcons.bind(panel.webview);
      const resourceBinding = bindProjectResourceCards(panel.webview, () => session.ready.url, async result => {
        if (closed) { throw new Error(t('Unable to open the resource.')); }
        await openCard(result, project, session, address);
      });
      listeners.push({ dispose: () => traceBinding.dispose() }, clipboardBinding, pickerBinding, pathOpenBinding, fileIconsBinding, resourceBinding, panel.webview.onDidReceiveMessage(message => {
        if (message?.type === 'workflow-reconnect' && message.version === 1 && typeof message.requestId === 'string' && message.requestId.length <= 64) {
          void recoverable.reconnect().then(async restarted => {
            if (closed) return;
            if (restarted) {
              traceBinding.dispose(); traceBinding = trace.bind(project, session.ready.traceProtocolVersion, panel.webview);
              const entry = workspaces.get(project.uri);
              if (entry?.close === close) entry.running = true;
              updateEntry();
            }
            const token = new URLSearchParams(new URL(session.ready.url).hash.slice(1)).get('session');
            await panel.webview.postMessage({ type: 'workflow-host', recovery: { requestId: message.requestId, ...(token ? { token } : {}) } });
          }).catch(error => {
            output.appendLine(`SteamHarness Web recovery: ${String(error)}`);
            if (!closed) void panel.webview.postMessage({ type: 'workflow-host', recovery: { requestId: message.requestId, error: String((error as Error).message) } });
          });
          return;
        }
        if (message?.type === 'workflow-frame-ready') {
          const entry = workspaces.get(project.uri);
          if (entry?.close === close) { entry.loaded = true; }
          frameReady(); updateEntry();
          void vscode.commands.executeCommand<ProjectWindowChrome>('studio.internalGetWindowChrome').then(chrome => {
            if (!closed && chrome && chrome.revision >= windowChrome.revision) { windowChrome = chrome; syncWindowChrome(); }
          }, () => undefined);
        }
        if (message?.type === 'workflow-project-upload' && message.version === 1 && launcher.uploadProject && !project.assistant && !closed && projectAvailable(project)) {
          void vscode.commands.executeCommand('studio.uploadProject', { uri: project.uri }).then(undefined, error => output.appendLine(`Project upload: ${String(error)}`));
          return;
        }
        if (!sidebar && message?.type === 'workflow-user-settings' && message.version === 1 && message.key === 'agent.permissionPolicy') {
          void openProjectUserSettings(message).catch(error => output.appendLine(`User settings: ${String(error)}`));
          return;
        }
        if (message?.type === 'workflow-account' && message.version === 1) { account.open(); }
        else if (!clipboardBinding.receive(message) && !resourceBinding.receive(message) && !pickerBinding.receive(message) && !pathOpenBinding.receive(message) && !fileIconsBinding.receive(message)) { traceBinding.receive(message); }
      }));
      panel.webview.html = projectFrameHtml(address.href, project.name, project.uri, theme(), globalThis.crypto.randomUUID().replace(/-/g, ''), vscode.env.language, chromeFor(project.uri, 'viewType' in panel && panel.viewType === 'studio.project'), conversationView, !project.assistant && !!launcher.uploadProject);
      if ('reveal' in panel) {
        panel.title = projectDisplayName(project); panel.iconPath = vscode.Uri.parse(projectAvatarDataUrl(project.projectCard, project.projectType));
        workspaces.set(project.uri, { panel, project, running: true, loaded: false, ready, close });
        listeners.push(panel.onDidChangeViewState(scheduleEntry));
      }
      listeners.push(vscode.window.onDidChangeActiveColorTheme(() => void panel.webview.postMessage({ type: 'workflow-host', theme: theme() })),
        session.onExit(exit => {
          traceBinding.dispose();
          if (!closed) {
            const entry = workspaces.get(project.uri);
            if (entry?.close === close) { entry.running = false; }
            updateEntry();
            output.appendLine(`SteamHarness Web stopped: ${project.name}${exit ? `; code=${exit.code}; signal=${exit.signal}` : ''}`);
            if (exit?.stderr) output.appendLine(exit.stderr);
          }
        }));
      output.appendLine(`SteamHarness Web: ${project.name}; project Core ${session.ready.runtime.harnessVersion}; ${session.ready.runtime.harnessPath}`);
      updateEntry(); return { dispose: close, closed: session.closed };
    } catch (error) { await close(); if ('reveal' in panel) { panel.dispose(); } throw error; }
  };
  const revealProject = (panel: vscode.WebviewPanel, viewColumn?: vscode.ViewColumn, signal?: AbortSignal, reveal = true): Promise<void> => {
    if (!signal) { if (reveal) { panel.reveal(viewColumn); } return Promise.resolve(); }
    signal.throwIfAborted();
    if (panel.active && (viewColumn === undefined || panel.viewColumn === viewColumn)) { return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        clearTimeout(timeout); changed.dispose(); closed.dispose(); signal.removeEventListener('abort', aborted);
        if (error) { reject(error); } else { resolve(); }
      };
      const check = (): void => { if (panel.active && (viewColumn === undefined || panel.viewColumn === viewColumn)) { finish(); } };
      const aborted = (): void => finish(signal.reason);
      const changed = panel.onDidChangeViewState(check);
      const closed = panel.onDidDispose(() => finish(new Error(t('The project is no longer open.'))));
      const timeout = setTimeout(() => finish(new Error(t('The project view did not finish loading. Try again.'))), 20_000);
      signal.addEventListener('abort', aborted, { once: true });
      if (reveal) { panel.reveal(viewColumn); }
      check();
    });
  };
  const openProject = async (target?: Project, viewColumn?: vscode.ViewColumn, signal?: AbortSignal, toolTab = false): Promise<void> => {
    signal?.throwIfAborted();
    const selected = target?.builtin === 'analysis' ? target : target?.uri ? provider.projects.find(entry => entry.uri === target.uri) ?? externalProjects.get(target.uri) : currentProject();
    if (!selected) { return; }
    assertNotUpgrading([selected.folderPath]);
    await settling.get(selected.uri);
    signal?.throwIfAborted();
    const pending = opening.get(selected.uri);
    if (pending) {
      try { await pending; }
      catch (error) {
        signal?.throwIfAborted();
        // A new mode request may arrive while its canceled startup is still settling.
        if (!signal || !(error instanceof Error) || error.name !== 'AbortError') { throw error; }
      }
      signal?.throwIfAborted();
    }
    const existing = workspaces.get(selected.uri);
    if (existing?.running) { await revealProject(existing.panel, viewColumn, signal); return; }
    const created = (async () => { await existing?.close(); return createWorkspace(selected, existing?.panel, undefined, viewColumn, signal, toolTab); })(); opening.set(selected.uri, created);
    try {
      await created; signal?.throwIfAborted();
      const panel = workspaces.get(selected.uri)?.panel;
      if (panel && (signal || existing && viewColumn !== undefined)) { await revealProject(panel, viewColumn, signal, !!existing); }
    } finally { opening.delete(selected.uri); }
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
        else { await openProjectFolder(vscode.Uri.parse(project.uri), () => !disposed); }
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
    const clipboard = bindProjectClipboard(preview.webview);
    const subscriptions = [clipboard, preview.webview.onDidReceiveMessage(message => clipboard.receive(message)),
      vscode.window.onDidChangeActiveColorTheme(() => void preview.webview.postMessage({ type: 'workflow-host', theme: theme() })), session.onExit(() => preview.dispose())];
    preview.onDidDispose(() => { for (const listener of subscriptions) { listener.dispose(); } });
    preview.webview.html = projectFrameHtml(url.href, card.title, owner.uri, theme(), globalThis.crypto.randomUUID().replace(/-/g, ''), vscode.env.language);
    if (result.action === 'window') {
      try { await ready; preview.reveal(); await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); }
      catch (error) { preview.dispose(); throw error; }
    }
  };
  const assistant = new AssistantViewProvider(context, launcher, output,
    (project, view) => createWorkspace(project, undefined, view, undefined, undefined, false, 'restore'));
  const mode = new StudioModeController(context, output);
  const resources = new ResourceViews(context, launcher, account, output);
  const trace = new TraceView(context, openProject, output);
  const related = new RelatedProjectsView(context, output, findProjectCandidates, projectIcons);
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
  const toolInstances = new ToolInstances(context, (kind, subscriptions, restored) => {
    if (kind === 'kv' || kind === 'knowledge') {
      const resources = new ResourceViews(context, launcher, account, output, false, subscriptions);
      return { update: (projects, preferred) => resources.update(projects, preferred), resolve: view => resources.resolve(kind, view) };
    }
    if (kind === 'trace') {
      const instance = new TraceView(context, openProject, output, trace, subscriptions);
      return { update: (projects, preferred) => instance.update(projects, preferred), resolve: view => instance.resolve(view) };
    }
    if (kind === 'assistant') {
      const instance = new AssistantViewProvider(context, launcher, output,
        (project, view) => createWorkspace(project, undefined, view, undefined, undefined, false, restored ? 'restore' : 'new'), false, subscriptions);
      return { update() {}, resolve: view => instance.resolveWebviewView(view) };
    }
    const instance = kind === 'info' ? new InfoView(context, versions, false, subscriptions)
      : new VersionsView(context, launcher, account, output, prepareUpgrade,
        (projects, replacedRoot) => related.rememberProjectGroup(projects, replacedRoot), false, subscriptions, versions);
    return { update: (projects, preferred) => instance.update(projects, preferred), resolve: view => instance.resolveWebviewView(view),
      selectProject: () => instance.selectProject() };
  });
  const inspectProjects = async (epoch: number): Promise<void> => {
    if (upgrading.size) { return; }
    if (!launcher.available || !vscode.workspace.isTrusted) { provider.projects = []; launcher.updateAnalysisProjects?.([]); provider.refresh(); updateEntry(); return; }
    const candidates = (await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => findProjectCandidates(folder.uri)))).flat();
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
  const watcher = vscode.workspace.createFileSystemWatcher('**/{package.json,index.ts,configuration.json}');
  const projectSerializer: vscode.WebviewPanelSerializer = { deserializeWebviewPanel: async (panel, state: { projectUri?: string } | undefined) => {
    await initialScan;
    let project = provider.projects.find(entry => entry.uri === state?.projectUri) ?? (state?.projectUri ? externalProjects.get(state.projectUri) : undefined);
    if (!project && state?.projectUri && vscode.workspace.isTrusted && launcher.available) {
      try { project = await resolveProjectTab(vscode.Uri.parse(state.projectUri)); }
      catch { /* Non-file built-in projects have their own resolver below. */ }
    }
    if (!project && state?.projectUri && launcher.inspectAnalysis) {
      try { const analysis = await launcher.inspectAnalysis(); if (analysis.uri === state.projectUri) project = analysis; }
      catch { panel.dispose(); return; }
    }
    if (!project) { panel.dispose(); return; }
    await opening.get(project.uri);
    if (workspaces.has(project.uri)) { panel.dispose(); return; }
    const created = createWorkspace(project, panel); opening.set(project.uri, created);
    try { await created; } finally { opening.delete(project.uri); }
  } };
  context.subscriptions.push(launcher, provider, status, versionStatus, versions.onDidChangeVersions(updateVersionEntry),
    vscode.window.registerWebviewPanelSerializer('studio.project', projectSerializer),
    vscode.window.registerWebviewPanelSerializer('studio.projectTool', projectSerializer),
    register('studio.openProjectConfigurations', async (projectDir: string) => {
      if (!vscode.workspace.isTrusted) throw new Error(t('Trust the current workspace first.'));
      const uri = vscode.Uri.file(projectDir).toString();
      let project = provider.projects.find(project => project.uri === uri);
      if (!project) { await refresh(); project = provider.projects.find(project => project.uri === uri); }
      if (!project) {
        const inspected=await launcher.inspect([projectDir]);
        const candidate=inspected.projects.find(project=>project.folderPath===projectDir);
        if(!candidate)throw new Error(t('Studio Control requires a Workflow project directory.'));
        project={...candidate,uri};externalProjects.set(uri,project);
      }
      await openProject(project);
      const entry = workspaces.get(project.uri);
      if (!entry) throw new Error(t('Project configurations are unavailable.'));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([entry.ready, new Promise<never>((_resolve,reject) => { timeout=setTimeout(()=>reject(new Error(t('Unable to open the resource.'))),20_000); })]);
        await entry.panel.webview.postMessage({type:'workflow-host',openConfigurations:true});
      } finally { clearTimeout(timeout); }
      return {opened:true};
    }),
    register('studio.openProject', (target?: Project, viewColumn?: vscode.ViewColumn) => openProject(target, viewColumn)), register('studio.refreshProjectView', refresh),
    register('studio.openProjectInTab', async (target?: string) => {
      if (!vscode.workspace.isTrusted) { throw new Error(t('Trust the current workspace first.')); }
      const uri = await chooseProjectTab([...provider.projects, ...externalProjects.values()], target);
      if (!uri || disposed) { return; }
      const project = await resolveProjectTab(uri);
      if (!disposed) { await openProject(project, undefined, undefined, true); }
    }),
    vscode.commands.registerCommand('studio.internalUpdateWindowChrome', (chrome: ProjectWindowChrome) => { if (chrome.revision >= windowChrome.revision) { windowChrome = chrome; syncWindowChrome(); } }),
    vscode.commands.registerCommand('studio.internalCancelSteamPreparation', () => steamPreparation?.abort()),
    vscode.commands.registerCommand('studio.internalPrepareSteamProject', async (projectUri?: string) => {
      const project = projectUri ? provider.projects.find(project => project.uri === projectUri) ?? externalProjects.get(projectUri) : currentProject();
      if (!project || !projectAvailable(project)) { return false; }
      steamPreparation?.abort();
      const controller = new AbortController();
      steamPreparation = controller;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let panelClosed: vscode.Disposable | undefined;
      let abort!: () => void;
      const canceled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      try {
        await Promise.race([openProject(project, vscode.ViewColumn.One, controller.signal), canceled]);
        const entry = workspaces.get(project.uri);
        if (!entry?.running) { return false; }
        panelClosed = entry.panel.onDidDispose(() => controller.abort());
        await Promise.race([entry.ready, canceled, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(t('The project view did not finish loading. Try again.'))), 20_000);
        })]);
        return !controller.signal.aborted && entry.running && projectAvailable(project);
      } catch (error) {
        if (controller.signal.aborted) { return false; }
        throw error;
      } finally {
        clearTimeout(timeout); panelClosed?.dispose(); controller.signal.removeEventListener('abort', abort);
        if (steamPreparation === controller) { steamPreparation = undefined; }
      }
    }),
    register('studio.openAnalysis', async () => {
      if (!launcher.inspectAnalysis) { throw new Error(t('Studio Analysis is unavailable in this environment.')); }
      await openProject(await launcher.inspectAnalysis());
    }),
    register('studio.openProjectSource', async (target?: Project) => {
      const selected = target?.uri ? provider.projects.find(entry => entry.uri === target.uri) ?? externalProjects.get(target.uri) : currentProject();
      if (selected) { await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.parse(selected.uri), 'package.json')); }
    }),
    register('studio.openProjectDemo', () => openProject(provider.projects.find(entry => entry.id === 'b20a7d1d-b6f5-4b0c-8589-265d56fc879a') ?? currentProject())),
    register('studio.openProjectCli', async () => {
      const project = currentProject();
      if (!project || !vscode.workspace.isTrusted || !launcher.available) { return; }
      const entry = await launcher.cliEntry(project.folderPath);
      assertNotUpgrading([project.folderPath]);
      const terminal = vscode.window.createTerminal({ name: 'SteamHarness CLI', cwd: project.folderPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
      terminals.set(terminal, project.uri);
      const quote = (value: string): string => process.platform === 'win32' ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, "'\\''")}'`;
      terminal.sendText(`${quote(vscode.workspace.getConfiguration('studio').get<string>('project.nodePath') || process.execPath)} ${quote(entry)} --help`); terminal.show();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const [controller, project] of starting) { if (!projectAvailable(project)) { controller.abort(); } }
      for (const entry of workspaces.values()) { if (!projectAvailable(entry.project)) { entry.panel.dispose(); } }
      scheduleRefresh();
    }), vscode.workspace.onDidGrantWorkspaceTrust(scheduleRefresh), vscode.window.onDidChangeActiveTextEditor(scheduleEntry),
    vscode.window.onDidCloseTerminal(terminal => terminals.delete(terminal)),
    account.onDidChange(state => { if (state.status !== 'checking') { const next = JSON.stringify(account.getConnection()); if (state.status === 'signed-out' || next !== cliConnection) { closeTerminals(); } cliConnection = next; } }),
    watcher, watcher.onDidChange(changedFile), watcher.onDidCreate(changedFile), watcher.onDidDelete(changedFile),
    { dispose: () => { disposed = true; steamPreparation?.abort(); ++scanEpoch; clearTimeout(refreshTimer); resumeRefresh?.(); resumeRefresh = undefined; clearTimeout(entryTimer); closeTerminals(); for (const controller of starting.keys()) { controller.abort(); } for (const entry of workspaces.values()) { entry.panel.dispose(); } for (const session of sessions) { void session.close(); } } });
  initialScan = refresh().catch(error => output.appendLine(`Workflow: ${String(error)}`));
  await initialScan;
  projectScanReady = true;
  updateEntry();
  void assistant.showInitially().catch(error => output.appendLine(`Project Assistant: ${String(error)}`));
  return { getProjects: () => [...provider.projects], onDidChangeProjects: provider.onDidChangeTreeData,
    getVersionStatus: project => versions.getVersionStatus(project), onDidChangeVersions: versions.onDidChangeVersions };
}
