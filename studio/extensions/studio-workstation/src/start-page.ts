import * as vscode from 'vscode';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { readProjectInfo, resolveProjectName } from '@steamharness/project-info';
import { t } from './localization';
import type { Launcher } from './workflow-cli-types';
import type { AccountController } from './workflow-auth';
import { projectVersion, type Project } from './workflow-types';
import type { CreatedProject, PendingProjectSetup, ProjectCreationDialog, ProjectCreationDialogResult, StartProject, StudioStartState } from './start-page-types';
import { parseServerProjectShareLink, type ProjectVersionStatus } from './steamharness-server-projects';
import { rememberImportedProjects, type RecentProject } from './projects';
import { updateProjectHistory } from './project-history';
import { chooseProjectWindow, openProjectFolder, type ProjectWindowOptions } from './project-window';
import { getStartRecommendationsProvider, onDidChangeStartRecommendations, normalizeStartRecommendations } from './start-page-recommendations';
export { registerStartRecommendationsProvider } from './start-page-recommendations';

const PENDING_KEY = 'studio.pendingProjectSetups';
const LAST_SETUP_KEY = 'studio.lastProjectSetupId';

export function startPageLabels(): Record<string, string> {
  return {
    overview: t('Project Overview'), create: t('New Project'), examples: t('Examples'), upload: t('Upload Project'),
    importLink: t('Import from Link'), shareUrl: t('Project Share Link'), confirmImport: t('Import'), requiredShareUrl: t('Enter a project share link.'),
    source: t('Open Project Source'), noCurrent: t('No SteamHarness projects in this workspace.'), noWorkspace: t('No project is open.'),
    projectFolder: t('Project Folder'), entries: t('Project Entries'), defaultEntry: t('Default Entry'), openEntry: t('Open Entry'),
    localVersion: t('Local Version'), serverVersion: t('Server Version'), upgrade: t('Upgrade...'), updateAvailable: t('Update Available'),
    upToDate: t('Up to Date'), localNewer: t('Local Version Is Newer'), downloadUnavailable: t('Source download is unavailable.'),
    unavailable: t('Unavailable'), retry: t('Retry Project Setup'),
    installFailed: t('Dependency installation failed'), cancelled: t('Project setup cancelled'), installing: t('Installing Dependencies'),
    validating: t('Validating Project'), registering: t('Registering Project'),
    validationFailed: t('Project validation failed'), registrationFailed: t('Server registration needs attention'), details: t('Details'),
    installationLog: t('Show Installation Log'),
    projectType: t('Project Type'), template: t('Project Template'), starter: t('Minimal Project'),
    projectName: t('Project Name'), parentDirectory: t('Project Parent Folder'), browse: t('Choose Folder'),
    confirmCreate: t('Create'), cancel: t('Cancel'), requiredName: t('Enter a project name.'),
    requiredParent: t('Choose an existing parent folder.'),
    'type.workflow': t('Workflow'), 'type.bot': t('Bot'), 'type.conversation': t('Conversation'), 'type.kanban': t('Kanban'),
    'type.link': t('Import from Link'), 'type.aggregate': t('Aggregate Project'),
  };
}

export function readPendingProjectSetups(value: unknown): PendingProjectSetup[] {
  if (!Array.isArray(value)) { return []; }
  return value.filter((item): item is PendingProjectSetup => !!item && typeof item.id === 'string' && /^[a-f0-9-]{36}$/i.test(item.id)
    && (item.projectId === undefined || item.projectId === '' || typeof item.projectId === 'string' && /^[a-f0-9-]{36}$/i.test(item.projectId))
    && typeof item.name === 'string' && !!item.name && typeof item.directory === 'string' && !!item.directory
    && ['workflow', 'bot', 'kanban'].includes(item.projectType) && ['failed', 'cancelled'].includes(item.status));
}

interface ProjectSource {
  getProjects(): Project[];
  onDidChangeProjects: vscode.Event<void>;
  getVersionStatus(project: Project): ProjectVersionStatus;
  onDidChangeVersions: vscode.Event<void>;
}

function summarizeProjects(source: ProjectSource, roots: Set<string>): StartProject[] {
  const prefixes = [...roots].map(root => root.endsWith('/') ? root : `${root}/`);
  const aggregates = new Map<string, Map<string, Project>>();
  for (const project of source.getProjects()) {
    if (project.assistant || project.builtin || (!roots.has(project.uri) && !prefixes.some(prefix => project.uri.startsWith(prefix)))) { continue; }
    const key = `${project.id}:${project.uri}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) { aggregates.set(key, aggregate = new Map()); }
    aggregate.set(project.entryId, project);
  }
  return [...aggregates.values()].map(discovered => {
    const first = discovered.values().next().value!;
    const project = discovered.get(first.defaultEntry) ?? first;
    const defaultType = project.entries.find(entry => entry.entryId === project.defaultEntry)?.type ?? project.projectType;
    const entries = project.entries.map(entry => {
      const resolved = discovered.get(entry.entryId);
      const projectType = resolved?.projectType ?? entry.type;
      return { entryId: entry.entryId, name: resolved?.name ?? resolveProjectName(entry.name, readProjectInfo(entry), vscode.env.language), projectType,
        avatarUrl: projectAvatarDataUrl(resolved?.projectCard ?? entry.projectCard, projectType), available: !!resolved };
    });
    return { uri: project.uri, defaultEntry: project.defaultEntry, name: project.aggregateName, description: project.manifest?.description,
      version: projectVersion(project), projectType: entries.length > 1 ? 'aggregate' : defaultType, folderPath: project.folderPath,
      avatarUrl: projectAvatarDataUrl(project.aggregateProjectCard, defaultType), entries, update: source.getVersionStatus(project) };
  });
}

export class StudioStartController implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly state: StudioStartState;
  private launchpadVisible = false;
  private disposed = false;
  private revision = 0;
  private requested = false;
  private forceRecommendations = false;
  private refreshing?: Promise<void>;
  private recommendationsKey?: string;
  private recommendationsAbort?: AbortController;
  private visibilityRevision = 0;
  private interval?: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private versionTimer?: ReturnType<typeof setTimeout>;
  private readonly creation = new AbortController();
  private installationLog = '';
  private logUri?: vscode.Uri;
  private logDirty = false;
  private logWrites: Promise<void> = Promise.resolve();
  private logTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly launcher: Launcher,
    private readonly account: AccountController, private readonly projects: ProjectSource,
    private readonly recent: { getChildren(): RecentProject[]; onDidChangeTreeData: vscode.Event<void>; reconcile?(): Promise<void> },
    private readonly remember: (project: CreatedProject) => Promise<void>, private readonly output: vscode.OutputChannel) {
    this.state = { version: 1, platform: account.platform, labels: startPageLabels(), hasWorkspace: false, projects: [], recent: [], pending: [], busy: false,
      canCreate: !!launcher.templates && !!launcher.createProject && !!launcher.installDependencies };
    const register = <Args extends unknown[]>(command: string, callback: (...args: Args) => unknown): void => {
      this.subscriptions.push(vscode.commands.registerCommand(command, async (...args: Args) => {
        try { return await callback(...args); }
        catch (error) {
          if (this.disposed || (error instanceof Error && error.name === 'AbortError')) { return; }
          output.appendLine(`[${command}] ${String(error)}`);
          await vscode.window.showErrorMessage(t('Studio: {0}', this.errorMessage(error)));
        }
      }));
    };
    register('studio.internalStartPageVisibility', (launchpadVisible: boolean) => { ++this.visibilityRevision; this.setLaunchpadVisible(launchpadVisible === true); });
    register('studio.internalGetStartState', () => structuredClone(this.state));
    register('studio.refreshStart', async () => {
      await vscode.commands.executeCommand('studio.refreshProjectView');
      this.forceRecommendations = true;
      await this.refresh();
    });
    register('studio.openStartRecommendation', (id?: string) => {
      const active = this.recommendationsContext();
      if (!active || active.key !== this.recommendationsKey) return;
      if (id !== undefined && !this.state.recommendations?.items.some(item => item.id === id)) return;
      return active.provider.open(id);
    });
    register('studio.createProject', (type?: string) => this.create('starter', type));
    register('studio.createExample', (id?: string) => this.create('example', id));
    register('studio.internalChooseProjectParent', async (directory: string) => {
      const selected = await vscode.window.showOpenDialog({ title: t('Project Parent Folder'), canSelectFiles: false,
        canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(directory) });
      return selected?.[0]?.fsPath;
    });
    register('studio.internalValidateProjectCreation', async (input: ProjectCreationDialogResult) => {
      try {
        if ('shareUrl' in input) { if (!account.platform) return t('Project transfers are unavailable in this extension host.'); parseServerProjectShareLink(input.shareUrl); }
        else { await this.launcher.validateProjectCreation?.(input); }
        return {};
      }
      catch (error) { return { error: this.errorMessage(error) }; }
    });
    register('studio.showProjectSetupLog', async (setupId?: string) => {
      await this.flushInstallationLog();
      const id = setupId === undefined
        ? this.pending().find(project => this.isProjectWindow(project))?.id ?? this.context.globalState.get<string>(LAST_SETUP_KEY)
        : this.state.pending.find(project => project.id === setupId)?.id;
      if (!id || !/^[a-f0-9-]{36}$/i.test(id)) { throw new Error(t('No project setup log is available yet.')); }
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, 'project-setup', id, 'installation.log');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true, preserveFocus: true });
    });
    register('studio.retryProjectSetup', (id?: string) => this.runCreation(async () => {
      const project = this.pending().find(entry => entry.id === id);
      if (project) { await this.setupInProjectWindow({ ...project, idAllocationError: undefined }); }
    }));
    register('studio.openCreatedProject', async (id?: string) => {
      const project = this.pending().find(entry => entry.id === id);
      if (project) { await this.validateCreated(project); await openProjectFolder(vscode.Uri.file(project.directory), () => !this.disposed); }
    });
    const schedule = (): void => {
      ++this.revision;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.publish(); if (this.launchpadVisible) { void this.refresh(); } }, 350);
    };
    this.subscriptions.push(projects.onDidChangeProjects(schedule), recent.onDidChangeTreeData(schedule), account.onDidChange(schedule),
      onDidChangeStartRecommendations(schedule),
      vscode.workspace.onDidChangeWorkspaceFolders(schedule),
      projects.onDidChangeVersions(() => { clearTimeout(this.versionTimer); this.versionTimer = setTimeout(() => this.publish(), 150); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.resumeProjectSetup()),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) { this.resumeProjectSetup(); } }));
    this.publish();
    const visibilityRevision = this.visibilityRevision;
    void vscode.commands.executeCommand<boolean>('studio.internalGetStartVisibility').then(visible => {
      if (visibilityRevision === this.visibilityRevision) this.setLaunchpadVisible(visible === true);
    }, () => undefined);
    void this.refresh();
    this.resumeProjectSetup();
  }

  private pending(): PendingProjectSetup[] { return readPendingProjectSetups(this.context.globalState.get(PENDING_KEY)); }

  private isProjectWindow(project: CreatedProject): boolean {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 && folders[0].uri.toString() === vscode.Uri.file(project.directory).toString();
  }

  private resumeProjectSetup(): void {
    if (this.disposed || !vscode.workspace.isTrusted) { return; }
    const project = this.pending().find(entry => entry.installOnOpen === true && this.isProjectWindow(entry));
    if (!project) { return; }
    void this.runCreation(() => this.setupInProjectWindow(project)).catch(async error => {
      if (this.disposed || error instanceof Error && error.name === 'AbortError') { return; }
      await this.updatePending({ ...project, installOnOpen: false, error: this.errorMessage(error) });
      this.output.appendLine(`Project setup: ${String(error)}`);
      void vscode.window.showErrorMessage(t('Studio: {0}', this.errorMessage(error)));
    });
  }

  private async openProjectWindow(project: CreatedProject & Partial<PendingProjectSetup>, options?: ProjectWindowOptions): Promise<void> {
    options ??= await chooseProjectWindow();
    if (!options) { return; }
    this.creation.signal.throwIfAborted();
    await this.updatePending({ ...project, status: 'failed', installOnOpen: true, error: t('Project setup is incomplete.') });
    this.creation.signal.throwIfAborted();
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.directory), options);
  }

  private async setupInProjectWindow(project: PendingProjectSetup): Promise<void> {
    await this.validateCreated(project);
    this.creation.signal.throwIfAborted();
    if (!this.isProjectWindow(project)) { await this.openProjectWindow(project); return; }
    if (!vscode.workspace.isTrusted) { throw new Error(t('Trust the current workspace first.')); }
    // Consume the handoff before installation so reloads and cancelled installs require an explicit retry.
    await this.updatePending({ ...project, installOnOpen: false });
    await vscode.commands.executeCommand('studio.openStart');
    await this.install(project);
  }

  private publish(): void {
    if (this.disposed) { return; }
    const recommendations = this.recommendationsContext();
    if (!recommendations) {
      this.recommendationsAbort?.abort(); this.recommendationsKey = undefined; this.state.recommendations = undefined;
    } else if (this.recommendationsKey !== recommendations.key) {
      this.recommendationsAbort?.abort(); this.recommendationsKey = recommendations.key;
      const { provider } = recommendations;
      this.state.recommendations = { title: provider.title, openLabel: provider.openLabel, browseLabel: provider.browseLabel, items: [], message: provider.loadingMessage };
    }
    const roots = new Set(vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()));
    this.state.hasWorkspace = roots.size > 0;
    this.state.projects = summarizeProjects(this.projects, roots);
    const currentUris = new Set(roots);
    if (vscode.workspace.workspaceFile) { currentUris.add(vscode.workspace.workspaceFile.toString()); }
    this.state.recent = this.recent.getChildren().map(project => ({ ...project, current: currentUris.has(project.uri) }));
    const projectUris = new Set([...roots, ...this.state.projects.map(project => project.uri)]);
    this.state.pending = this.pending().filter(project => projectUris.has(vscode.Uri.file(project.directory).toString()))
      .map(({ id, name, directory, status, stage, error }) => ({ id, name, directory, status, stage, error }));
    void vscode.commands.executeCommand('studio.internalUpdateStartState', structuredClone(this.state)).then(undefined, error => this.output.appendLine(`Start page: ${String(error)}`));
  }

  private setLaunchpadVisible(visible: boolean): void {
    if (this.disposed || this.launchpadVisible === visible) { return; }
    this.launchpadVisible = visible;
    clearInterval(this.interval);
    if (visible) {
      void this.refresh();
      this.interval = setInterval(() => void this.refresh(), 5_000);
    }
  }

  private refresh(): Promise<void> {
    if (this.disposed) { return Promise.resolve(); }
    this.requested = true;
    if (this.refreshing) { return this.refreshing; }
    this.refreshing = (async () => {
      while (this.requested && !this.disposed) {
        this.requested = false;
        await this.recent.reconcile?.();
        if (this.disposed) { return; }
        const revision = this.revision;
        this.publish();
        const recommendations = this.launchpadVisible ? this.recommendationsContext() : undefined;
        if (recommendations) {
          const abort = new AbortController(); this.recommendationsAbort = abort;
          const force = this.forceRecommendations;
          this.forceRecommendations = false;
          const provider = recommendations.provider;
          let items: ReturnType<typeof normalizeStartRecommendations> | undefined;
          try { items = normalizeStartRecommendations((await provider.load(abort.signal, { force })).items); }
          catch { /* Keep the last successful list. */ }
          if (this.disposed) { return; }
          if (revision !== this.revision) { this.requested = true; continue; }
          if (this.launchpadVisible && this.recommendationsContext()?.key === recommendations.key && this.state.recommendations) {
            if (items) { this.state.recommendations.items = items; }
            this.state.recommendations.message = !items ? provider.unavailableMessage : items.length ? undefined : provider.emptyMessage;
            this.publish();
          }
        }
        this.resumeProjectSetup();
      }
    })().catch(error => { this.output.appendLine(`Start page: ${String(error)}`); }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private recommendationsContext() {
    if (vscode.workspace.workspaceFolders?.length) return undefined;
    const provider = getStartRecommendationsProvider();
    if (!provider) return undefined;
    try { return { provider, key: `${provider.id}:${provider.contextKey()}` }; }
    catch { return undefined; }
  }

  private async runCreation(action: () => Promise<void>): Promise<void> {
    if (this.state.busy || !this.state.canCreate || this.disposed) { return; }
    this.state.busy = true; this.publish();
    try { await action(); }
    finally { this.state.busy = false; this.publish(); }
  }

  private create(kind: 'starter' | 'example', selector?: string): Promise<void> {
    return this.runCreation(async () => {
      let templates: ProjectCreationDialog['templates'] = [];
      try { templates = await this.launcher.templates!(); }
      catch (error) { this.output.appendLine(`Project templates: ${this.errorMessage(error)}`); }
      const request: ProjectCreationDialog = { templates, labels: startPageLabels(), platform: this.account.platform,
        parentDirectory: this.launcher.projectCreationDirectory ?? '', projectType: kind === 'starter' ? selector : undefined,
        templateId: kind === 'example' ? selector : undefined };
      if (kind === 'example' && !selector) { request.templateId = request.templates.find(template => template.kind === 'example')?.id; }
      const input = await vscode.commands.executeCommand<ProjectCreationDialogResult | undefined>('studio.internalShowCreateProject', request);
      if (!input) { return; }
      if ('shareUrl' in input) { if (this.account.platform) await vscode.commands.executeCommand('studio.importProjectFromLink', input.shareUrl); return; }
      if (!request.templates.some(template => template.id === input.templateId)) { return; }
      const options = await chooseProjectWindow(t('Where would you like to open the new project?'));
      if (!options) { return; }
      this.creation.signal.throwIfAborted();
      const project = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Creating Project'), cancellable: false },
        () => this.launcher.createProject!(input, this.creation.signal));
      const pending = { ...project, ...(project.id ? {} : { id: globalThis.crypto.randomUUID(), projectId: '' }) };
      await this.remember(project);
      await this.openProjectWindow(pending, options);
    });
  }

  private async validateCreated(project: CreatedProject & { projectId?: string }): Promise<void> {
    const manifest = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.Uri.file(project.directory), 'steamharness.json'))));
    if (manifest.id !== (project.projectId ?? project.id)) { throw new Error(t('Project identity changed. Open the project folder to review it.')); }
  }

  private async install(input: PendingProjectSetup): Promise<void> {
    this.creation.signal.throwIfAborted();
    let project: PendingProjectSetup = { ...input, installOnOpen: false };
    if (project.dependenciesInstalled && this.launcher.hasProjectDependencies && !await this.launcher.hasProjectDependencies(project.directory)) {
      project.dependenciesInstalled = false;
    }
    let stage: NonNullable<PendingProjectSetup['stage']> = project.dependenciesInstalled ? 'validation' : 'dependencies';
    this.state.installing = project.id;
    this.publish();
    try {
      await this.updatePending({ ...project, stage });
      await this.beginInstallationLog(project.id);
      this.appendInstallationLog(`\nProject: ${project.name} (${project.directory})\n`);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Preparing Project: {0}', project.name), cancellable: true },
        async (progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          const signal = AbortSignal.any([controller.signal, this.creation.signal]);
          try {
            if (token.isCancellationRequested) { controller.abort(); }
            if (!project.dependenciesInstalled) {
              progress.report({ message: t('Installing Dependencies') });
              await this.launcher.installDependencies!(project.directory, signal, message => this.appendInstallationLog(message));
              signal.throwIfAborted();
              project = { ...project, dependenciesInstalled: true };
              this.appendInstallationLog(`\n${t('Dependencies installed successfully.')}\n`);
            }
            if (project.projectId === '') {
              stage = 'registration';
              await this.updatePending({ ...project, stage });
              progress.report({ message: t('Generating a local project ID') });
              if (!this.launcher.registerProject) {
                throw new Error(t('Project created without an ID. Retry Project Setup after selecting a local Node runtime.'));
              }
              await this.validateCreated(project);
              const projectId = await this.launcher.registerProject(project.directory, signal);
              project = { ...project, projectId };
              await this.updatePending({ ...project, stage });
            }
            stage = 'validation';
            await this.updatePending({ ...project, stage });
            progress.report({ message: t('Validating Project') });
            this.appendInstallationLog(`${t('Validating Project')}\n`);
            if (await this.launcher.prepareProjectTemplate?.(project.directory, signal)) {
              this.appendInstallationLog(`${t('Template source matched to the installed SDK.')}\n`);
            }
            signal.throwIfAborted();
            await this.validateCreated(project);
            const inspected = await this.launcher.inspect([project.directory], { validationDetails: true });
            signal.throwIfAborted();
            const projectId = project.projectId ?? project.id;
            if (!inspected.projects.some(entry => entry.id === projectId) || inspected.errors.length) { throw new Error(inspected.errors.join('\n') || t('Project validation failed')); }
            this.appendInstallationLog(`${t('Project validation succeeded.')}\n`);
            const uri = vscode.Uri.file(project.directory).toString();
            await updateProjectHistory(this.context, history => ({ ...history,
              imported: rememberImportedProjects(history.imported, [{ id: projectId, name: project.name, uri }]) }));
            await this.remember({ ...project, id: projectId });
            await vscode.commands.executeCommand('studio.refreshProjects');
          } finally { cancellation.dispose(); }
        });
    } catch (error) {
      const cancelled = this.creation.signal.aborted || error instanceof Error && error.name === 'AbortError';
      const label = stage === 'dependencies' ? t('Installing Dependencies') : stage === 'validation' ? t('Validating Project') : t('Registering Project');
      this.appendInstallationLog(`\n${t('Project setup failed at {0}: {1}', label, this.errorMessage(error))}\n`);
      await this.updatePending({ ...project, stage, status: cancelled ? 'cancelled' : 'failed', installOnOpen: false, error: this.errorMessage(error) });
      if (!this.disposed) {
        const retry = t('Retry Project Setup'), open = t('Open Project Folder');
        void vscode.window.showWarningMessage(t('Project files were created. {0}', cancelled ? t('Project setup cancelled') : this.errorMessage(error)), retry, open).then(answer => {
          if (answer) { return vscode.commands.executeCommand(answer === retry ? 'studio.retryProjectSetup' : 'studio.openCreatedProject', project.id); }
          return undefined;
        });
      }
      return;
    } finally {
      await this.flushInstallationLog();
      this.state.installing = undefined;
      this.publish();
    }
    await this.updatePending(undefined, project.id);
  }

  private async updatePending(project?: PendingProjectSetup, removeId = project?.id): Promise<void> {
    await this.context.globalState.update(PENDING_KEY, [...this.pending().filter(entry => entry.id !== removeId), ...(project ? [project] : [])]);
    this.publish();
  }

  private appendInstallationLog(message: string): void {
    this.output.append(message);
    this.installationLog = (this.installationLog + message).slice(-200_000);
    this.logDirty = true;
    clearTimeout(this.logTimer);
    this.logTimer = setTimeout(() => { void this.flushInstallationLog(); }, 150);
  }

  private async beginInstallationLog(id: string): Promise<void> {
    await this.flushInstallationLog();
    const directory = vscode.Uri.joinPath(this.context.globalStorageUri, 'project-setup', id);
    await vscode.workspace.fs.createDirectory(directory);
    this.logUri = vscode.Uri.joinPath(directory, 'installation.log');
    try { this.installationLog = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.logUri)).slice(-200_000); }
    catch (error) { if ((error as { code?: string }).code !== 'FileNotFound') { throw error; } this.installationLog = ''; }
    await this.context.globalState.update(LAST_SETUP_KEY, id);
  }

  private flushInstallationLog(): Promise<void> {
    clearTimeout(this.logTimer);
    if (this.logDirty && this.logUri) {
      const uri = this.logUri, content = new TextEncoder().encode(this.installationLog);
      this.logDirty = false;
      this.logWrites = this.logWrites.then(() => vscode.workspace.fs.writeFile(uri, content))
        .catch(error => { this.output.appendLine(`Project setup log: ${String(error)}`); });
    }
    return this.logWrites;
  }

  private errorMessage(error: unknown): string {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'invalid-name') { return t('Choose a valid folder name without path separators or reserved characters.'); }
    if (code === 'directory-exists') { return t('The project folder already exists. Choose another name.'); }
    if (code === 'invalid-parent') { return t('Choose an existing parent folder.'); }
    if (code === 'invalid-id') { return t('The Server returned an invalid project ID.'); }
    if (code === 'identity-changed') { return t('Project identity changed. Open the project folder to review it.'); }
    if (code === 'invalid-version') { return t('The project template requires exact published dependency versions.'); }
    if (code === 'runtime-packages-unavailable') { return t('The bundled Core and CLI packages are missing or damaged. Rebuild the local packages or repair this Studio installation.'); }
    if (code === 'package-manager-missing') { return t('Install pnpm or npm, then retry dependency installation.'); }
    if (code === 'package-manager-timeout') { return t('Dependency installation timed out. Review the installation log and retry.'); }
    return error instanceof Error ? error.message : String(error);
  }

  dispose(): void {
    this.disposed = true; ++this.revision; this.creation.abort();
    this.recommendationsAbort?.abort();
    clearTimeout(this.timer); clearTimeout(this.versionTimer); clearTimeout(this.logTimer); clearInterval(this.interval);
    void this.flushInstallationLog();
    for (const subscription of this.subscriptions) { subscription.dispose(); }
  }
}
