import * as vscode from 'vscode';
import { t } from './localization';
import { projectTypeIcons, readRecentProjects, RECENT_PROJECTS_KEY } from './projects';
import { findProjectCandidates } from './project-candidates';
import { editSidebarPreferences, orderedSidebarIds, readSidebarPreferences, sidebarEntryKey, sidebarEntryTitle, type SavedSidebarEntry, type SidebarPreferences } from './project-sidebar-state';
import { bindHostedSidebar, sidebarStatusHtml } from './project-sidebar-view';
import { hostedSidebarHtml } from './project-sidebar-html';
import type { HostedLaunchpadTarget, HostedSidebarPreview, HostedSidebarProject, SidebarEdit, SidebarItem, SidebarProjectEntry } from './project-sidebar-types';
import type { AssistantConversation, BotManagementPanel } from './assistant-view';
import type { Launcher } from './workflow-cli-types';
import type { Project } from './workflow-types';

const setting = 'sidebar.entries';
const trustCommand = 'studio.internalSidebarProjectTrust';
const tabId = (id: string) => id === 'assistant' ? 'studio-assistant' : `studio-sidebar.${id}`;
const viewId = (id: string) => `studio.sidebar.${id}`;
const localFolder = (uri: vscode.Uri) => uri.scheme === 'file' && !uri.query && !uri.fragment;
const typeLabel = (type: SidebarProjectEntry['type']) => type === 'bot' ? t('Bot') : type === 'kanban' ? t('Kanban') : t('Workflow');

interface SidebarProjectSource {
  title: string;
  load(signal: AbortSignal): Promise<Project>;
  check(): Promise<void>;
  onDidChange?(listener: () => void): { dispose(): void };
}

interface WorkspaceSidebarProject extends SidebarProjectSource {
  id: string;
  type: SidebarProjectEntry['type'];
}

export class ProjectSidebar implements vscode.Disposable {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChange = this.change.event;
  private readonly builtin = new Map<string, { item: SidebarItem; viewId: string; provider: vscode.WebviewViewProvider; hosted?: HostedSidebarProject }>();
  private readonly providers = new Map<string, { dispose(): void }>();
  private readonly mounts = new Map<string, { close(): void; recheck(): Promise<void>; openConversation(id: string): void; openBotPanel(panel: BotManagementPanel): void }>();
  private resident?: { id: string; key: string; signal: AbortSignal; ready: Promise<{ key: string; preview: HostedSidebarPreview; title: string }>; close(): void };
  private syncQueue = Promise.resolve();
  private editQueue = Promise.resolve();
  private started = false;
  private assistantOverride?: { project: SidebarProjectSource; exclusive: boolean };
  private assistantConversation?: string;
  private assistantBotPanel?: BotManagementPanel;
  private workspaceProjects = new Map<string, WorkspaceSidebarProject>();
  private disposed = false;
  private visibleTabs = '';
  private getProjects: () => Project[] = () => [];
  private mountProject?: (project: Project, view: vscode.WebviewView, signal: AbortSignal, conversationId?: string) => Promise<AssistantConversation>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly launcher: Launcher, private readonly output: vscode.OutputChannel) {
    context.subscriptions.push(this, vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(`studio.${setting}`)) void this.sync();
    }), vscode.commands.registerCommand('studio.internalSidebarTrustChanged', () => {
      for (const mount of this.mounts.values()) void mount.recheck();
    }), vscode.commands.registerCommand('studio.internalReleaseHostedLaunchpadApp', key => {
      if (typeof key === 'string' && this.resident?.key === key) this.resident.close();
    }), vscode.commands.registerCommand('studio.internalResolveHostedProjectLink', async (key, link) => {
      const resident = this.resident;
      if (!resident || resident.key !== key || resident.signal.aborted || typeof link !== 'string' || link.length > 256) return;
      const target = await this.builtin.get(resident.id)?.hosted?.resolveProjectLink?.(link);
      if (this.resident === resident && !resident.signal.aborted) return target;
    }));
  }

  registerHosted(project: HostedSidebarProject): vscode.Disposable {
    if (this.builtin.has(project.id) || !this.launcher.openHostedSidebar) return { dispose() {} };
    this.builtin.set(project.id, {
      item: { id: project.id, title: project.title, type: 'kanban', builtin: true, visible: true }, viewId: project.viewId, hosted: project,
      provider: { resolveWebviewView: view => bindHostedSidebar(view, project, this.launcher.openHostedSidebar!, this.output) },
    });
    if (this.started) void this.sync();
    return { dispose: () => { if (this.resident?.id === project.id) this.resident.close(); this.builtin.delete(project.id); void this.sync(); } };
  }

  overrideAssistant(project: SidebarProjectSource, { exclusive = false } = {}): void {
    if (!this.started) this.assistantOverride = { project, exclusive };
  }

  /** Insert window-supplied projects after the assistant without editing global settings. */
  setWorkspaceProjects(projects: readonly WorkspaceSidebarProject[]): Promise<void> {
    this.workspaceProjects = new Map(projects.map(project => [`workspace-${project.id}`, project]));
    return this.sync();
  }

  /** One in-flight or ready preview per account scope, not per navigation. */
  async prepareHostedInLaunchpad(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.resident?.id === id && this.resident.signal === signal) return this.resident.ready;
    const project = this.builtin.get(id)?.hosted;
    const open = this.launcher.openHostedSidebar;
    if (this.disposed || !project || !open) throw new Error(t('The built-in project files are unavailable.'));
    const state = project.getState();
    if (!('binding' in state)) throw new Error(state.message);
    this.resident?.close();
    const key = globalThis.crypto.randomUUID();
    let preview: HostedSidebarPreview | undefined, closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', close);
      if (this.resident?.key === key) this.resident = undefined;
      if (preview) void preview.close().catch(() => undefined);
      void Promise.resolve(vscode.commands.executeCommand('studio.internalCloseLaunchpadApp', key)).catch(() => undefined);
    };
    signal.addEventListener('abort', close, { once: true });
    const ready = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      if (closed) throw new Error('Preview revoked');
      preview = await open(project, state.binding, signal);
      if (closed) { await preview.close(); throw new Error('Preview revoked'); }
      const mounted = await vscode.commands.executeCommand<boolean>('studio.internalPrepareLaunchpadApp', key, {
        port: Number(new URL(preview.url).port), accountUrl: state.binding.accountUrl,
      });
      if (!mounted || closed) throw new Error('Preview unavailable');
      return { key, preview, title: project.title };
    }).catch(error => {
      if (!closed) this.output.appendLine(`[launchpad] ${project.title}: ${String(error)}`);
      close(); throw new Error(t('The built-in project files are unavailable.'));
    });
    this.resident = { id, key, signal, ready, close };
    return ready;
  }

  async showHostedInLaunchpad(id: string, requestId: string, signal: AbortSignal, target: HostedLaunchpadTarget): Promise<void> {
    const { key, preview, title: defaultTitle } = await this.prepareHostedInLaunchpad(id, signal);
    signal.throwIfAborted();
    const title = target.title?.trim() || defaultTitle;
    if (!await vscode.commands.executeCommand('studio.internalShowLaunchpadApp', key, requestId, { id: target.id, title,
      ...(target.titlebarOverlay === true && { titlebarOverlay: true }),
      html: hostedSidebarHtml(vscode.env.language, title, preview, target.route, target.titlebarOverlay === true,
        !!this.builtin.get(id)?.hosted?.resolveProjectLink) })) {
      throw new Error(t('The built-in project files are unavailable.'));
    }
  }

  async openAssistantConversation(id: string): Promise<boolean> {
    if (!this.assistantOverride?.exclusive || this.disposed) return false;
    const mounted = this.mounts.get('assistant');
    if (mounted) mounted.openConversation(id);
    else this.assistantConversation = id;
    await this.sync();
    await vscode.commands.executeCommand('studio.developerAssistant.focus');
    return true;
  }

  async openAssistantBotPanel(panel: BotManagementPanel): Promise<boolean> {
    if (!this.assistantOverride?.exclusive || this.disposed) return false;
    const mounted = this.mounts.get('assistant');
    if (mounted) mounted.openBotPanel(panel); else this.assistantBotPanel = panel;
    await this.sync();
    await vscode.commands.executeCommand('studio.developerAssistant.focus');
    return true;
  }

  start(assistant: vscode.WebviewViewProvider, getProjects: () => Project[], mount: NonNullable<ProjectSidebar['mountProject']>): Promise<void> {
    this.getProjects = getProjects;
    this.mountProject = mount;
    const override = this.assistantOverride?.project;
    this.builtin.set('assistant', { item: { id: 'assistant', title: override?.title ?? t('Project Assistant'), type: 'bot', builtin: true, visible: true }, viewId: 'studio.developerAssistant', provider: override ? {
      resolveWebviewView: view => { view.title = override.title; this.bindSidebarProject(view, 'assistant', override); },
    } : assistant });
    this.started = true;
    if (this.launcher.readSidebarEntries) void vscode.commands.executeCommand('studio.internalWatchSidebarTrust').then(undefined, () => undefined);
    return this.sync().then(async () => {
      if (override && !this.disposed) await vscode.commands.executeCommand('studio.developerAssistant.focus');
    }).catch(error => this.output.appendLine(`[sidebar] ${String(error)}`));
  }

  private preferences(): SidebarPreferences {
    // Project-supplied workspace settings cannot select executable sidebars.
    return readSidebarPreferences(vscode.workspace.getConfiguration('studio').inspect(setting)?.globalValue);
  }

  get canAdd(): boolean { return this.started && !this.assistantOverride?.exclusive && !!this.launcher.readSidebarEntries && vscode.workspace.isTrusted; }

  items(preferences = this.preferences()): SidebarItem[] {
    if (this.assistantOverride?.exclusive) {
      const assistant = this.builtin.get('assistant');
      return assistant ? [assistant.item] : [];
    }
    const builtins = ['assistant', ...[...this.builtin.keys()].filter(id => id !== 'assistant')].filter(id => this.builtin.has(id) && !this.builtin.get(id)?.hosted?.standalone);
    const projects = this.launcher.readSidebarEntries ? preferences.projects : [];
    const items = new Map<string, SidebarItem>(projects.map(entry => [entry.id, { id: entry.id, directory: entry.directory, title: sidebarEntryTitle(entry, vscode.env.language),
      visible: entry.visible, type: entry.type, builtin: false }]));
    for (const [id, { item }] of this.builtin) items.set(id, item);
    return orderedSidebarIds({ ...preferences, projects }, builtins).map(id => items.get(id)!);
  }

  private sync(): Promise<void> {
    const run = this.syncQueue.then(async () => {
      if (!this.started || this.disposed) return;
      const preferences = this.preferences();
      let items = this.items(preferences).filter(item => item.visible);
      if (!this.assistantOverride?.exclusive && this.workspaceProjects.size) {
        const projects: SidebarItem[] = [...this.workspaceProjects].map(([id, { title, type }]) => ({ id, title, type, builtin: false, visible: true }));
        items = [...items.filter(item => item.id === 'assistant'), ...projects, ...items.filter(item => item.id !== 'assistant')];
      }
      const retained = new Set(items.map(item => item.id));
      for (const [id, provider] of this.providers) {
        if (!retained.has(id)) { this.mounts.get(id)?.close(); this.providers.delete(id); provider.dispose(); }
      }
      for (const item of items) {
        if (this.providers.has(item.id)) continue;
        const builtin = this.builtin.get(item.id);
        const saved = preferences.projects.find(entry => entry.id === item.id);
        this.providers.set(item.id, vscode.window.registerWebviewViewProvider(builtin?.viewId ?? viewId(item.id), builtin?.provider ?? {
          resolveWebviewView: view => {
            const project = this.workspaceProjects.get(item.id);
            if (project) this.bindSidebarProject(view, item.id, project);
            else if (saved) this.bindProject(view, saved);
          },
        }, { webviewOptions: { retainContextWhenHidden: true } }));
      }
      const tabs = items.map(item => ({ id: tabId(item.id), viewId: this.builtin.get(item.id)?.viewId ?? viewId(item.id), title: item.title,
        icon: item.id === 'assistant' ? projectTypeIcons.bot : item.builtin ? 'comment-discussion' : projectTypeIcons[item.type] }));
      const signature = JSON.stringify(tabs);
      if (signature !== this.visibleTabs) {
        await vscode.commands.executeCommand('studio.internalSyncSidebarTabs', tabs);
        this.visibleTabs = signature;
      }
      this.change.fire();
    });
    this.syncQueue = run.catch(error => this.output.appendLine(`[sidebar] ${String(error)}`));
    return this.syncQueue;
  }

  edit(edit: SidebarEdit): Promise<void> {
    const run = this.editQueue.then(async () => {
      if (!this.started || this.disposed || this.assistantOverride?.exclusive) return;
      let preferences = this.preferences();
      const previous = preferences;
      if (edit.action === 'add') {
        const added = await this.selectProjects(preferences);
        if (!added.length || this.disposed) return;
        preferences = this.preferences();
        const existing = new Set(preferences.projects.map(sidebarEntryKey));
        preferences = { ...preferences, projects: [...preferences.projects, ...added.filter(item => !existing.has(sidebarEntryKey(item)))] };
      } else {
        preferences = editSidebarPreferences(preferences, this.items(preferences).filter(item => item.builtin).map(item => item.id), edit);
        if (preferences === previous) return;
      }
      await vscode.workspace.getConfiguration('studio').update(setting, preferences, vscode.ConfigurationTarget.Global);
      await this.sync();
    });
    this.editQueue = run.catch(() => undefined);
    return run;
  }

  private async selectProjects(preferences: SidebarPreferences): Promise<SavedSidebarEntry[]> {
    const read = this.launcher.readSidebarEntries;
    if (!read || !vscode.workspace.isTrusted) throw new Error(t('Trust the current workspace first.'));
    const added = new Set(preferences.projects.map(sidebarEntryKey));
    const options = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Reading project history...'), cancellable: true }, async (_, token) => {
      const history = await vscode.commands.executeCommand<string[]>('studio.internalSidebarHistory');
      const uris = [...new Set([
        ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString()), ...this.getProjects().map(project => project.uri),
        ...(history ?? []), ...readRecentProjects(this.context.globalState.get(RECENT_PROJECTS_KEY)).filter(item => item.kind === 'folder').map(item => item.uri),
      ])].map(value => vscode.Uri.parse(value)).filter(localFolder);
      const cancelled = () => token.isCancellationRequested || this.disposed;
      const projects = await findProjectCandidates(uris, cancelled);
      const candidates = new Map<string, SidebarProjectEntry>();
      for (let index = 0; index < projects.length && !cancelled(); index += 12) {
        const batch = await Promise.all(projects.slice(index, index + 12).map(uri => read(uri.fsPath).catch(() => [])));
        for (const entry of batch.flat()) {
          const key = sidebarEntryKey(entry);
          if (!added.has(key)) candidates.set(key, entry);
        }
      }
      if (cancelled()) return;
      return [...candidates.values()].map(entry => ({ label: sidebarEntryTitle(entry, vscode.env.language), description: `${typeLabel(entry.type)} · ${entry.entryId}`, detail: entry.directory, entry }));
    });
    if (!options) return [];
    if (!options.length) { void vscode.window.showInformationMessage(t('No more runnable entries in your project history.')); return []; }
    const picks = await vscode.window.showQuickPick(options, { title: t('Add projects from history'), canPickMany: true, matchOnDescription: true, matchOnDetail: true });
    if (!picks?.length || this.disposed) return [];
    const confirm = t('Add and Allow Running');
    if (await vscode.window.showWarningMessage(t('Allow Studio to run the selected project entries when opened in the right sidebar?'),
      { modal: true, detail: picks.map(pick => `${pick.label} — ${pick.detail} (${pick.entry.entryId})`).join('\n') }, confirm) !== confirm) return [];
    const approved: SavedSidebarEntry[] = [];
    for (const { entry } of picks) {
      if (this.disposed || !vscode.workspace.isTrusted) break;
      try {
        const checked = await this.validate(entry, true);
        approved.push({ ...checked, id: globalThis.crypto.randomUUID(), visible: true });
      } catch (error) { void vscode.window.showWarningMessage(t('{0}: {1}', sidebarEntryTitle(entry, vscode.env.language), error instanceof Error ? error.message : String(error))); }
    }
    return approved;
  }

  private async validate(entry: SidebarProjectEntry, interactive = false): Promise<SidebarProjectEntry> {
    if (!vscode.workspace.isTrusted) throw new Error(t('Trust the current workspace first.'));
    const checked = (await this.launcher.readSidebarEntries!(entry.directory).catch(() => [])).find(item => sidebarEntryKey(item) === sidebarEntryKey(entry) && item.type === entry.type);
    if (!checked) throw new Error(t('The project entry has changed or is no longer available.'));
    if (!await vscode.commands.executeCommand<boolean>(trustCommand, vscode.Uri.file(checked.directory).toString(), interactive)) {
      throw new Error(t('Trust this project folder before running it.'));
    }
    return checked;
  }

  private bindProject(view: vscode.WebviewView, saved: SavedSidebarEntry): void {
    this.bindSidebarProject(view, saved.id, {
      title: saved.title,
      async check() {
        if (!vscode.workspace.isTrusted || !await vscode.commands.executeCommand<boolean>(trustCommand, vscode.Uri.file(saved.directory).toString())) {
          throw new Error(t('Trust this project folder before running it.'));
        }
      },
      load: async signal => {
        const entry = await this.validate(saved);
        signal.throwIfAborted();
        const result = await this.launcher.inspect([entry.directory], { signal });
        const project = result.projects.find(candidate => candidate.id === entry.projectId && candidate.entryId === entry.entryId && candidate.projectType === entry.type && candidate.folderPath === entry.directory);
        if (!project) throw new Error(result.errors[0] || t('The project entry could not be opened.'));
        await this.validate(entry);
        return { ...project, uri: vscode.Uri.file(entry.directory).toString() };
      },
    });
  }

  private bindSidebarProject(view: vscode.WebviewView, id: string, source: SidebarProjectSource): void {
    this.mounts.get(id)?.close();
    let closed = false, opening: AbortController | undefined, conversation: AssistantConversation | undefined;
    let selection = id === 'assistant' ? this.assistantConversation : undefined;
    let botPanelPending = id === 'assistant' ? this.assistantBotPanel : undefined;
    if (id === 'assistant') { this.assistantConversation = undefined; this.assistantBotPanel = undefined; }
    const lifecycle: vscode.Disposable[] = [];
    const status = (message: string, retry = false) => {
      if (!closed) view.webview.html = sidebarStatusHtml(message, retry ? t('Retry') : undefined);
    };
    const stop = () => { opening?.abort(); opening = undefined; const previous = conversation; conversation = undefined; void previous?.dispose(); };
    const mount = async () => {
      if (closed || opening || conversation || !view.visible) return;
      const attempt = opening = new AbortController();
      status(t('Opening project entry...'));
      try {
        const project = await source.load(attempt.signal);
        attempt.signal.throwIfAborted();
        const target = selection;
        const running = await this.mountProject!(project, view, attempt.signal, target);
        if (closed || attempt.signal.aborted || opening !== attempt) { await running.dispose(); return; }
        conversation = running;
        if (selection && selection !== target) running.openConversation?.(selection);
        selection = undefined;
        if (botPanelPending) { running.openBotPanel?.(botPanelPending); botPanelPending = undefined; }
        void running.closed.then(() => {
          if (!closed && conversation === running) { conversation = undefined; void running.dispose(); status(t('The project stopped.'), true); }
        });
      } catch (error) {
        if (!attempt.signal.aborted && !closed) {
          this.output.appendLine(`[sidebar] ${source.title}: ${String(error)}`);
          status(error instanceof Error ? error.message : t('The project entry could not be opened.'), true);
        }
      } finally { if (opening === attempt) opening = undefined; }
    };
    const current = {
      close: () => {
        if (closed) return;
        closed = true; stop();
        for (const listener of lifecycle) listener.dispose();
        if (this.mounts.get(id) === current) this.mounts.delete(id);
      },
      recheck: async () => {
        if (!opening && !conversation) return;
        try { await source.check(); }
        catch (error) { if (!closed) { stop(); status(error instanceof Error ? error.message : t('The project entry could not be opened.'), true); } }
      },
      openConversation: (target: string) => {
        if (conversation?.openConversation) conversation.openConversation(target);
        else selection = target;
      },
      openBotPanel: (panel: BotManagementPanel) => { if (conversation?.openBotPanel) conversation.openBotPanel(panel); else botPanelPending = panel; },
    };
    this.mounts.set(id, current);
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    lifecycle.push(view.onDidDispose(current.close), view.onDidChangeVisibility(() => { if (view.visible) void mount(); }),
      view.webview.onDidReceiveMessage(value => { if (value?.type === 'studio-sidebar-action') void mount(); }));
    if (source.onDidChange) lifecycle.push(source.onDidChange(() => { void current.recheck(); }));
    void mount();
  }

  dispose(): void {
    this.disposed = true;
    this.resident?.close();
    for (const mount of this.mounts.values()) mount.close();
    for (const provider of this.providers.values()) provider.dispose();
    this.providers.clear(); this.change.dispose();
  }
}
