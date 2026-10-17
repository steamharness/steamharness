import * as vscode from 'vscode';
import { t } from './localization';
import type { WorkflowLauncher } from './workflow-cli-types';
import type { WorkflowAccountController } from './workflow-auth';
import { projectVersion, type WorkflowProject } from './workflow-types';
import type { CreatedProject, PendingProjectSetup, ProjectCreationDialog, ProjectCreationDialogResult, StudioStartState } from './start-page-types';
import { parseServerProjectShareLink, type ProjectVersionStatus } from './workflow-server-projects';
import { IMPORTED_PROJECTS_KEY, readImportedProjects, rememberImportedProjects, type RecentProject } from './projects';

const PENDING_KEY = 'studio.pendingProjectSetups';

export function startPageLabels(): Record<string, string> {
  return {
    start: t('Start'), create: t('New Project'), current: t('Current Projects'), examples: t('Examples'), recent: t('Recent Projects'), upload: t('Upload Project'), download: t('Download Project'), versions: t('Versions'),
    importLink: t('Import from Link'), shareUrl: t('Project Share Link'), confirmImport: t('Import'), requiredShareUrl: t('Enter a project share link.'),
    system: t('System Status'), quick: t('Quick Access'), refresh: t('Refresh Status'), analysis: t('Open Studio Analysis'),
    openFolder: t('Open Folder'), openWorkspace: t('Open Workspace'), assistant: t('Open Project Assistant'), account: t('Workflow Account'), settings: t('Settings'),
    source: t('Open Project Source'), noCurrent: t('No Workflow projects in this workspace.'), noRecent: t('No recent projects.'),
    localVersion: t('Local Version'), serverVersion: t('Server Version'), upgrade: t('Upgrade...'), updateAvailable: t('Update Available'),
    upToDate: t('Up to Date'), localNewer: t('Local Version Is Newer'), downloadUnavailable: t('Source download is unavailable.'),
    removeRecent: t('Remove from Recent Projects'), unavailable: t('Unavailable'), retry: t('Retry Installation'), openSource: t('Open Project Folder'),
    installFailed: t('Dependencies need attention'), cancelled: t('Installation cancelled'), installing: t('Installing Dependencies'),
    installationLog: t('Show Installation Log'),
    run: t('Run Project'), projectType: t('Project Type'), template: t('Project Template'), starter: t('Minimal Project'),
    projectName: t('Project Name'), parentDirectory: t('Project Parent Folder'), browse: t('Choose Folder'),
    confirmCreate: t('Create'), cancel: t('Cancel'), requiredName: t('Enter a project name.'),
    requiredParent: t('Choose an existing parent folder.'),
    'type.workflow': t('Workflow'), 'type.conversation': t('Conversation'), 'type.kanban': t('Kanban'),
    'type.link': t('Import from Link'),
    'stat.studio': 'Studio', 'stat.vscode': 'VS Code', 'stat.node': 'Node.js', 'stat.core': 'Core', 'stat.cli': 'CLI',
    'stat.account': t('Account'), 'stat.server': t('Server'), 'stat.projects': t('Local Projects'), 'stat.running': t('Running'), 'stat.waiting': t('Waiting for Input'),
  };
}

export function readPendingProjectSetups(value: unknown): PendingProjectSetup[] {
  if (!Array.isArray(value)) { return []; }
  return value.filter((item): item is PendingProjectSetup => !!item && typeof item.id === 'string' && /^[a-f0-9-]{36}$/i.test(item.id)
    && typeof item.name === 'string' && !!item.name && typeof item.directory === 'string' && !!item.directory
    && ['workflow', 'conversation', 'kanban'].includes(item.projectType) && ['failed', 'cancelled'].includes(item.status));
}

interface ProjectSource {
  getProjects(): WorkflowProject[];
  onDidChangeProjects: vscode.Event<void>;
  getVersionStatus(project: WorkflowProject): ProjectVersionStatus;
  onDidChangeVersions: vscode.Event<void>;
}

export class StudioStartController implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly state: StudioStartState;
  private visible = false;
  private disposed = false;
  private revision = 0;
  private requested = false;
  private environmentNeeded = true;
  private refreshing?: Promise<void>;
  private interval?: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private versionTimer?: ReturnType<typeof setTimeout>;
  private readonly creation = new AbortController();
  private installationLog = '';
  private readonly logChanges = new vscode.EventEmitter<vscode.Uri>();
  private readonly logUri = vscode.Uri.parse('studio-project-setup:/installation.log');
  private logTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly launcher: WorkflowLauncher,
    private readonly account: WorkflowAccountController, private readonly projects: ProjectSource,
    private readonly recent: { getChildren(): RecentProject[]; onDidChangeTreeData: vscode.Event<void> },
    private readonly remember: (project: CreatedProject) => Promise<void>, private readonly output: vscode.OutputChannel) {
    this.state = { version: 1, labels: startPageLabels(), templates: [], projects: [], recent: [], pending: [], busy: false,
      canCreate: !!launcher.templates && !!launcher.createProject && !!launcher.installDependencies,
      environment: { studio: context.extension.packageJSON.version, vscode: vscode.version, account: '', server: '' } };
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
    register('studio.internalStartPageVisibility', (visible: boolean) => this.setVisible(visible === true));
    register('studio.internalGetStartState', () => structuredClone(this.state));
    register('studio.refreshStart', async () => { this.environmentNeeded = true; await Promise.all([this.refresh(), vscode.commands.executeCommand('studio.refreshVersions')]); });
    register('studio.createProject', (type?: string) => this.create('starter', type));
    register('studio.createExample', (id?: string) => this.create('example', id));
    register('studio.internalChooseProjectParent', async (directory: string) => {
      const selected = await vscode.window.showOpenDialog({ title: t('Project Parent Folder'), canSelectFiles: false,
        canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(directory) });
      return selected?.[0]?.fsPath;
    });
    register('studio.internalValidateProjectCreation', async (input: ProjectCreationDialogResult) => {
      try {
        if ('shareUrl' in input) { parseServerProjectShareLink(input.shareUrl); }
        else { await this.launcher.validateProjectCreation?.(input); }
        return {};
      }
      catch (error) { return { error: this.errorMessage(error) }; }
    });
    this.subscriptions.push(this.logChanges, vscode.workspace.registerTextDocumentContentProvider('studio-project-setup', {
      provideTextDocumentContent: () => this.installationLog,
      onDidChange: this.logChanges.event,
    }));
    register('studio.showProjectSetupLog', async () => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.logUri), { preview: true, preserveFocus: true }));
    register('studio.retryProjectSetup', (id?: string) => this.runCreation(async () => {
      const project = this.pending().find(entry => entry.id === id);
      if (project) { await this.setupInProjectWindow(project); }
    }));
    register('studio.openCreatedProject', async (id?: string) => {
      const project = this.pending().find(entry => entry.id === id);
      if (project) { await this.validateCreated(project); await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.directory), { forceNewWindow: true }); }
    });
    const schedule = (): void => {
      ++this.revision;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.publish(); if (this.visible) { void this.refresh(); } }, 350);
    };
    this.subscriptions.push(projects.onDidChangeProjects(schedule), recent.onDidChangeTreeData(schedule), account.onDidChange(schedule),
      projects.onDidChangeVersions(() => { clearTimeout(this.versionTimer); this.versionTimer = setTimeout(() => this.publish(), 150); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.resumeProjectSetup()),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) { this.resumeProjectSetup(); } }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('studio.workflow.nodePath') || event.affectsConfiguration('studio.workflow.serverUrl')) {
          this.environmentNeeded = true; schedule();
        }
      }));
    this.publish();
    void vscode.commands.executeCommand<boolean>('studio.internalGetStartVisibility').then(visible => this.setVisible(visible), () => undefined);
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

  private async openProjectWindow(project: CreatedProject, forceNewWindow = true): Promise<void> {
    await this.updatePending({ ...project, status: 'failed', installOnOpen: true, error: t('Project setup is incomplete.') });
    this.creation.signal.throwIfAborted();
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.directory), { forceNewWindow, forceReuseWindow: !forceNewWindow });
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
    this.state.projects = this.projects.getProjects().filter(project => !project.assistant && !project.builtin)
      .map(project => ({ uri: project.uri, name: project.name, projectType: project.projectType, folderPath: project.folderPath,
        update: this.projects.getVersionStatus(project),
        ...(projectVersion(project) ? { version: projectVersion(project) } : {}) }));
    this.state.recent = this.recent.getChildren();
    this.state.pending = this.pending();
    const account = this.account.getState();
    const labels = { 'signed-out': t('Signed Out'), checking: t('Connecting to Server'), authenticated: t('Server Connected'), expired: t('Server Sign-in Expired'), error: t('Server Connection Error') };
    this.state.environment.account = account.user?.displayName || account.user?.email || t('Signed Out');
    this.state.environment.server = `${labels[account.status]} · ${account.serverUrl}`;
    void vscode.commands.executeCommand('studio.internalUpdateStartState', structuredClone(this.state)).then(undefined, error => this.output.appendLine(`Start page: ${String(error)}`));
  }

  private setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) { return; }
    this.visible = visible;
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
        const revision = this.revision;
        const environment = this.environmentNeeded;
        const [templates, runtime, summary] = await Promise.allSettled([
          this.state.templates.length ? Promise.resolve(this.state.templates) : this.launcher.templates?.() ?? Promise.resolve([]),
          environment ? this.launcher.environmentStatus?.() : undefined,
          this.visible && vscode.workspace.isTrusted ? this.launcher.analysisSummary?.() : undefined,
        ]);
        if (this.disposed) { return; }
        if (revision !== this.revision) { this.requested = true; continue; }
        const errors: string[] = [];
        if (templates.status === 'fulfilled') { this.state.templates = templates.value; }
        else { errors.push(this.errorMessage(templates.reason)); }
        if (runtime.status === 'fulfilled' && runtime.value) {
          Object.assign(this.state.environment, runtime.value);
          this.state.environment.error = runtime.value.error;
          this.environmentNeeded = false;
        } else if (runtime.status === 'rejected') { errors.push(this.errorMessage(runtime.reason)); }
        if (summary.status === 'fulfilled' && summary.value) {
          if (!summary.value.unavailable || !this.state.summary) { this.state.summary = summary.value; }
          if (summary.value.unavailable) { errors.push(t('Some local projects could not be read. Open Studio Analysis for details.')); }
        } else if (summary.status === 'rejected') { errors.push(this.errorMessage(summary.reason)); }
        this.state.error = errors.length ? t('Status refresh failed: {0}', errors.join('\n')) : undefined;
        this.publish();
        this.resumeProjectSetup();
      }
    })().catch(error => { this.output.appendLine(`Start page: ${String(error)}`); }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
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
      const request: ProjectCreationDialog = { templates, labels: startPageLabels(),
        parentDirectory: this.launcher.projectCreationDirectory ?? '', projectType: kind === 'starter' ? selector : undefined,
        templateId: kind === 'example' ? selector : undefined };
      if (kind === 'example' && !selector) { request.templateId = request.templates.find(template => template.kind === 'example')?.id; }
      const input = await vscode.commands.executeCommand<ProjectCreationDialogResult | undefined>('studio.internalShowCreateProject', request);
      if (!input) { return; }
      if ('shareUrl' in input) { await vscode.commands.executeCommand('studio.importProjectFromLink', input.shareUrl); return; }
      if (!request.templates.some(template => template.id === input.templateId)) { return; }
      const newWindow = t('Open in New Window'), currentWindow = t('Open in Current Window');
      const target = await vscode.window.showInformationMessage(t('Where would you like to open the new project?'),
        { modal: true }, newWindow, currentWindow);
      if (target !== newWindow && target !== currentWindow) { return; }
      this.creation.signal.throwIfAborted();
      const project = await this.launcher.createProject!(input, this.creation.signal);
      await this.openProjectWindow(project, target === newWindow);
    });
  }

  private async validateCreated(project: CreatedProject): Promise<void> {
    const manifest = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.Uri.file(project.directory), 'package.json'))));
    if (manifest.id !== project.id) { throw new Error(t('Project identity changed. Open the project folder to review it.')); }
  }

  private async install(project: CreatedProject): Promise<void> {
    this.creation.signal.throwIfAborted();
    this.state.installing = project.id;
    this.publish();
    this.appendInstallationLog(`\nProject: ${project.name} (${project.directory})\n`);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Installing Dependencies: {0}', project.name), cancellable: true },
        async (_progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          const signal = AbortSignal.any([controller.signal, this.creation.signal]);
          try {
            if (token.isCancellationRequested) { controller.abort(); }
            await this.launcher.installDependencies!(project.directory, signal, message => this.appendInstallationLog(message));
            signal.throwIfAborted();
            const inspected = await this.launcher.inspect([project.directory]);
            signal.throwIfAborted();
            if (!inspected.projects.some(entry => entry.id === project.id) || inspected.errors.length) { throw new Error(inspected.errors.join('\n') || t('Project dependencies are not ready.')); }
          } finally { cancellation.dispose(); }
        });
    } catch (error) {
      const cancelled = this.creation.signal.aborted || error instanceof Error && error.name === 'AbortError';
      await this.updatePending({ ...project, status: cancelled ? 'cancelled' : 'failed', installOnOpen: false, error: this.errorMessage(error) });
      if (!this.disposed) {
        const retry = t('Retry Installation'), open = t('Open Project Folder');
        void vscode.window.showWarningMessage(t('Project files were created. {0}', cancelled ? t('Installation cancelled') : this.errorMessage(error)), retry, open).then(answer => {
          if (answer) { return vscode.commands.executeCommand(answer === retry ? 'studio.retryProjectSetup' : 'studio.openCreatedProject', project.id); }
          return undefined;
        });
      }
      return;
    } finally {
      this.state.installing = undefined;
      this.publish();
    }
    await this.updatePending(undefined, project.id);
    const uri = vscode.Uri.file(project.directory).toString();
    await this.context.globalState.update(IMPORTED_PROJECTS_KEY, rememberImportedProjects(readImportedProjects(this.context.globalState.get(IMPORTED_PROJECTS_KEY)), [{ id: project.id, name: project.name, uri }]));
    await this.remember(project);
    await vscode.commands.executeCommand('studio.refreshWorkflows');
  }

  private async updatePending(project?: PendingProjectSetup, removeId = project?.id): Promise<void> {
    await this.context.globalState.update(PENDING_KEY, [...this.pending().filter(entry => entry.id !== removeId), ...(project ? [project] : [])]);
    this.publish();
  }

  private appendInstallationLog(message: string): void {
    this.output.append(message);
    this.installationLog = (this.installationLog + message).slice(-200_000);
    clearTimeout(this.logTimer);
    this.logTimer = setTimeout(() => { if (!this.disposed) { this.logChanges.fire(this.logUri); } }, 150);
  }

  private errorMessage(error: unknown): string {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'invalid-name') { return t('Choose a valid folder name without path separators or reserved characters.'); }
    if (code === 'directory-exists') { return t('The project folder already exists. Choose another name.'); }
    if (code === 'invalid-parent') { return t('Choose an existing parent folder.'); }
    if (code === 'invalid-version') { return t('The project template requires exact published dependency versions.'); }
    if (code === 'package-manager-missing') { return t('Install pnpm or npm, then retry dependency installation.'); }
    if (code === 'package-manager-timeout') { return t('Dependency installation timed out. Review the installation log and retry.'); }
    return error instanceof Error ? error.message : String(error);
  }

  dispose(): void {
    this.disposed = true; ++this.revision; this.creation.abort();
    clearTimeout(this.timer); clearTimeout(this.versionTimer); clearTimeout(this.logTimer); clearInterval(this.interval);
    for (const subscription of this.subscriptions) { subscription.dispose(); }
  }
}
