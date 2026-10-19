import * as vscode from 'vscode';
import { t } from './localization';
import { localizationHtml } from './localization-host';
import { projectVersion, projectDisplayName, type Project } from './workflow-types';
import type { Launcher } from './workflow-cli-types';
import type { AccountController } from './workflow-auth';
import { AuthError, normalizeProjectServerUrl, type Connection } from './workflow-auth-client';
import { ProjectServerClient, compareProjectVersions, parseServerProjectShareLink, type DownloadedServerProject, type ProjectVersionStatus, type ServerProject, type ServerProjectVersion, type UpdatedServerProject, type VersionsState } from './steamharness-server-projects';
import { IMPORTED_PROJECTS_KEY, readImportedProjects } from './projects';

interface ProjectUploadSession {
  id: string;
  project: Project;
  version: string;
  connection: Connection;
  controller?: AbortController;
  task?: Promise<{ success?: boolean; error?: string }>;
  uploaded?: boolean;
}

export class VersionsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeVersions = this.changes.event;
  private view?: vscode.WebviewView;
  private readonly listeners: vscode.Disposable[] = [];
  private localProjects: Project[] = [];
  private preferred?: Project;
  private serverProject?: ServerProject;
  private serverProjects = new Map<string, ServerProject>();
  private checked = false;
  private lastChecked = 0;
  private projectSignature = '';
  private published = '';
  private versions: ServerProjectVersion[] = [];
  private generation = 0;
  private disposed = false;
  private busy = false;
  private choosing = false;
  private loading = false;
  private error?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private reading?: AbortController;
  private readonly lifetime = new AbortController();
  private connectionKey: string;
  private pendingImportLink?: string;
  private uploadSession?: ProjectUploadSession;
  private readonly interval: ReturnType<typeof setInterval>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly launcher: Launcher,
    private readonly account: AccountController, private readonly output: vscode.OutputChannel,
    private readonly prepareUpgrade: (project: Project, signal: AbortSignal) => Promise<vscode.Disposable>,
    private readonly rememberDownload: (projects: DownloadedServerProject[], replacedRoot?: string) => Promise<void>) {
    this.connectionKey = JSON.stringify(account.getConnection());
    const command = <Args extends unknown[]>(name: string, action: (...args: Args) => unknown): void => {
      context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: Args) => {
        try { return await action(...args); }
        catch (error) { this.report(error); }
      }));
    };
    command('studio.uploadProject', (target?: { uri?: string }) => this.upload(target));
    command('studio.upgradeProject', (target?: { uri?: string }) => this.upgrade(target));
    command('studio.refreshVersions', () => this.reload());
    command('studio.downloadProject', () => this.chooseDownload());
    command('studio.importProjectFromLink', (link?: string) => this.importFromLink(link));
    command('studio.internalUploadProject', (input: { id: string; releaseLog: string }) => this.submitUpload(input));
    command('studio.internalCancelProjectUpload', (id: string) => {
      if (this.uploadSession?.id === id) { this.uploadSession.controller?.abort(); }
    });
    context.subscriptions.push(this, vscode.window.registerWebviewViewProvider('studio.versions', this, { webviewOptions: { retainContextWhenHidden: true } }),
      account.onDidChange(state => {
        if (state.status === 'checking') { return; }
        const key = JSON.stringify(account.getConnection());
        if (key === this.connectionKey) { return; }
        this.connectionKey = key;
        this.serverProject = undefined; this.serverProjects.clear(); this.checked = false; this.lastChecked = 0; this.versions = []; this.error = undefined;
        this.reading?.abort(); ++this.generation; this.loading = false;
        this.publish(); this.schedule();
        if (this.pendingImportLink && account.getConnection()) {
          const link = this.pendingImportLink;
          this.pendingImportLink = undefined;
          void this.importFromLink(link).catch(error => this.report(error));
        }
      }), vscode.window.onDidChangeWindowState(state => { if (state.focused && Date.now() - this.lastChecked > 60_000) { this.schedule(); } }));
    this.interval = setInterval(() => { if (vscode.window.state.focused && !this.busy) { this.schedule(); } }, 5 * 60_000);
  }

  update(projects: Project[], preferred?: Project): void {
    this.localProjects = projects.filter(project => !project.assistant && !project.builtin);
    const signature = JSON.stringify(this.localProjects.map(project => [project.uri, project.id, projectVersion(project)]));
    const projectsChanged = signature !== this.projectSignature;
    this.projectSignature = signature;
    const local = this.localProjects.find(project => project.uri === preferred?.uri) ?? this.localProjects[0];
    const changed = local?.uri !== this.preferred?.uri || local?.id !== this.preferred?.id;
    const versionChanged = local && projectVersion(local) !== (this.preferred && projectVersion(this.preferred));
    this.preferred = local;
    if (changed) { this.serverProject = local && this.serverProjects.get(local.id); this.versions = []; }
    void vscode.commands.executeCommand('setContext', 'studio.projectUploadAvailable', !!local && !!this.launcher.uploadProject && vscode.workspace.isTrusted);
    if (projectsChanged || changed || versionChanged) { this.schedule(); }
    this.publish();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.reading?.abort(); ++this.generation;
    this.timer = setTimeout(() => { void this.reload(); }, 350);
  }

  async reload(): Promise<void> {
    clearTimeout(this.timer);
    this.reading?.abort();
    const generation = ++this.generation, connection = this.account.getConnection(), project = this.preferred;
    if (this.disposed || !connection || !this.localProjects.length) { this.loading = false; this.publish(); return; }
    const controller = this.reading = new AbortController();
    this.lastChecked = Date.now();
    this.loading = true; this.error = undefined; this.publish();
    try {
      const client = new ProjectServerClient(connection);
      const projects = await client.projects(controller.signal);
      if (generation !== this.generation || this.disposed) { return; }
      const remote = projects.find(entry => entry.id === project?.id);
      this.serverProjects = new Map(projects.map(entry => [entry.id, entry]));
      this.checked = true; this.lastChecked = Date.now(); this.serverProject = remote;
      let versions = this.versions;
      if (remote && this.view?.visible) {
        const detail = await client.versions(remote.id, controller.signal);
        if (generation !== this.generation || this.disposed) { return; }
        remote.latest = detail.latest;
        versions = detail.versions;
      }
      else if (!remote) { versions = []; }
      if (generation !== this.generation || this.disposed) { return; }
      this.serverProject = remote;
      this.versions = versions;
    } catch (error) {
      if (generation !== this.generation || this.disposed || controller.signal.aborted) { return; }
      this.error = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Project versions: ${this.error}`);
    } finally {
      if (generation === this.generation && !this.disposed) { this.loading = false; this.publish(); }
    }
  }

  getVersionStatus(project: Project): ProjectVersionStatus {
    const localVersion = projectVersion(project), remote = this.serverProjects.get(project.id);
    const comparison = compareProjectVersions(localVersion, remote?.latest ?? undefined);
    const status: ProjectVersionStatus['status'] = !this.account.getConnection() ? 'signed-out' : this.error ? 'unavailable'
      : !this.checked ? 'checking' : !remote?.latest ? 'unpublished' : comparison === -1 ? 'upgrade'
        : comparison === 0 ? 'current' : comparison === 1 ? 'ahead' : 'different';
    return { status, localVersion, serverVersion: remote?.latest ?? undefined, checking: this.loading, busy: this.busy || this.choosing,
      canDownload: !this.error && !!remote?.sourceDownload?.allowed && !!remote.sourceDownload.available && !!this.launcher.downloadProject };
  }

  private publish(): void {
    if (this.disposed) { return; }
    const signature = JSON.stringify(this.localProjects.map(project => [project.uri, this.getVersionStatus(project)]));
    if (signature !== this.published) { this.published = signature; this.changes.fire(); }
    if (!this.view) { return; }
    const local = this.preferred;
    const remote = this.serverProject;
    const state: VersionsState = { type: 'versions-state', generation: this.generation, signedIn: !!this.account.getConnection(),
      loading: this.loading, busy: this.busy || this.choosing, project: local && { id: local.id, name: local.name, uri: local.uri },
      localVersion: local && projectVersion(local), update: local && this.getVersionStatus(local), versions: this.versions,
      canDownload: !this.error && !!remote?.sourceDownload?.allowed && !!this.launcher.downloadProject,
      transfersAvailable: !!this.launcher.downloadProject, error: this.error };
    this.view.description = local ? projectDisplayName(local) : undefined;
    this.view.badge = state.update?.status === 'upgrade' ? { value: 1, tooltip: t('Update Available') } : undefined;
    void this.view.webview.postMessage(state);
  }

  private async upgrade(target?: { uri?: string }): Promise<void> {
    if (this.busy || this.choosing || this.disposed) { return; }
    if (!this.account.getConnection()) { this.account.open(); return; }
    if (!this.launcher.downloadProject) { throw new Error(t('Project transfers are unavailable in this extension host.')); }
    const project = this.localProjects.find(entry => entry.uri === target?.uri) ?? (!target?.uri ? this.preferred : undefined);
    if (!project) { return; }
    this.choosing = true; this.publish();
    try {
      const connection = this.account.getConnection()!, key = JSON.stringify(connection);
      const assertAvailable = (): void => {
        this.lifetime.signal.throwIfAborted();
        if (JSON.stringify(this.account.getConnection()) !== key) { throw new Error(t('Account changed. Try again.')); }
        if (!this.localProjects.some(entry => entry.uri === project.uri && entry.id === project.id)) { throw new Error(t('The project is no longer open.')); }
      };
      const remote = await this.progress(t('Check Project Updates'), async signal => {
        const client = new ProjectServerClient(connection);
        const projects = await client.projects(signal);
        const entry = projects.find(entry => entry.id === project.id);
        if (!entry?.latest) { throw new Error(t('No published version is available for this project.')); }
        if (!entry.sourceDownload?.allowed) { throw new Error(t('Project source download is not granted.')); }
        const versions = await client.versions(project.id, signal);
        const latest = versions.versions.find(version => version.version === versions.latest);
        if (!latest) { throw new Error(t('The server returned an invalid response.')); }
        return { project: entry, latest };
      });
      assertAvailable();
      const localVersion = projectVersion(project), version = remote.latest.version;
      if (compareProjectVersions(localVersion, version) !== -1) {
        await this.reload();
        void vscode.window.showInformationMessage(t('No newer server version is available. Local: {0}. Server: {1}.', localVersion ?? t('Not declared'), version));
        return;
      }
      const isGroupRoot = (): boolean => {
        const imported = readImportedProjects(this.context.globalState.get(IMPORTED_PROJECTS_KEY)).find(entry => entry.uri === project.uri);
        return !imported?.downloadRootUri || imported.downloadRootUri === project.uri;
      };
      const inPlace = !!this.launcher.upgradeProject && project.uri.startsWith('file:') && vscode.workspace.isTrusted
        && isGroupRoot();
      const current = t('Upgrade Current Folder'), separate = t('Download to New Folder');
      const notes = remote.latest.releaseLog?.trim();
      const detail = [t('Local Version: {0}\nServer Version: {1}', localVersion!, version),
        notes ? t('Release Notes\n{0}', notes.length > 1500 ? `${notes.slice(0, 1500)}\u2026` : notes) : '',
        inPlace ? t('Current folder: {0}\nSource files and local edits will be replaced after saving. A source backup is kept beside this folder. Local data, environment files and Git metadata are preserved. Studio sessions that use this project will stop. Stop external processes before continuing.', project.folderPath)
          : t('This folder cannot be upgraded in place. Download a new copy to preserve its workspace or locked project group.'),
        t('A new copy is downloaded to a separate versioned folder. The open project is preserved.')].filter(Boolean).join('\n\n');
      const choice = await vscode.window.showWarningMessage(t('Upgrade {0}: {1} \u2192 {2}', project.name, localVersion!, version),
        { modal: true, detail }, ...(inPlace ? [current, separate] : [separate]));
      if (!choice) { return; }
      assertAvailable();
      if (choice === separate) { await this.downloadAndOpen(remote.project, version); return; }
      this.busy = true; this.publish();
      let guard: vscode.Disposable | undefined;
      let result: UpdatedServerProject | undefined;
      try {
        result = await this.progress(t('Upgrade {0} to {1}', project.name, version), (signal, report) =>
          this.launcher.upgradeProject!(project, version, signal, report, async () => {
            assertAvailable(); signal.throwIfAborted();
            if (!vscode.workspace.isTrusted) { throw new Error(t('Trust the current workspace first.')); }
            if (!isGroupRoot()) { throw new Error(t('This folder is a locked related project. Download to a new folder instead.')); }
            guard = await this.prepareUpgrade(project, signal);
            assertAvailable(); signal.throwIfAborted();
          }, projects => this.rememberDownload(projects, project.uri)));
      } finally {
        guard?.dispose(); this.busy = false; this.publish();
        if (!this.disposed) {
          await vscode.commands.executeCommand('studio.refreshProjects').then(undefined, error => this.output.appendLine(`Project refresh: ${String(error)}`));
          if (result || guard) { await vscode.commands.executeCommand('studio.refreshProjects'); }
          await this.reload();
        }
      }
      if (!result) { return; }
      void this.offerOpenFolder(t('Upgraded {0} to {1}. Source backup: {2}. Reinstall dependencies if package requirements changed.', project.name, version, result.backupDirectory),
        t('Open Source Backup'), result.backupDirectory);
    } finally { this.choosing = false; this.publish(); }
  }

  private async upload(target?: { uri?: string }): Promise<void> {
    if (this.busy || this.choosing || !this.launcher.uploadProject) { return; }
    this.busy = true; this.publish();
    try { await this.prepareUpload(target); }
    finally {
      this.uploadSession?.controller?.abort();
      await this.uploadSession?.task;
      this.uploadSession = undefined;
      this.busy = false; this.publish();
    }
  }

  private async prepareUpload(target?: { uri?: string }): Promise<void> {
    const connection = this.account.getConnection();
    if (!connection) { this.account.open(); return; }
    if (!vscode.workspace.isTrusted) { throw new Error(t('Trust the current workspace first.')); }
    const project = this.localProjects.find(project => project.uri === target?.uri) ?? (!target?.uri ? this.preferred : undefined);
    if (!project) { return; }
    const manifestUri = vscode.Uri.joinPath(vscode.Uri.parse(project.uri), 'package.json');
    const document = vscode.workspace.textDocuments.find(entry => entry.uri.toString() === manifestUri.toString());
    let version = '';
    try {
      const manifest = JSON.parse(document?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(manifestUri)));
      if (typeof manifest?.version === 'string') { version = manifest.version; }
    } catch { /* Report manifest validation in the upload dialog when submitted. */ }
    this.uploadSession = { id: globalThis.crypto.randomUUID(), project, version, connection };
    await vscode.commands.executeCommand('studio.internalShowProjectUpload', {
      id: this.uploadSession.id, name: project.name, version, serverUrl: connection.serverUrl, folderPath: project.folderPath,
      labels: { title: t('Upload Project'), project: t('Project'), version: t('Version'), server: t('Server'),
        directory: t('Project Folder'), releaseLog: t('Release Notes'), upload: t('Upload'), cancel: t('Cancel'), close: t('Close'), unavailable: t('Unavailable'),
        preparing: t('Preparing upload...'), uploading: t('Uploading...'), cancelling: t('Cancelling...'), failed: t('Project transfer failed.'),
        success: t('Uploaded {0} version {1}.', project.name, version) },
    });
  }

  private async submitUpload(input: { id: string; releaseLog: string }): Promise<{ success?: boolean; error?: string }> {
    const session = this.uploadSession;
    if (!session || input?.id !== session.id || typeof input.releaseLog !== 'string' || session.uploaded || session.task) {
      return { error: t('Project transfer failed.') };
    }
    const controller = session.controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const accountListener = this.account.onDidChange(state => {
      if (state.status !== 'checking' && JSON.stringify(this.account.getConnection()) !== JSON.stringify(session.connection)) { controller.abort(); }
    });
    const task = this.performUpload(session, input.releaseLog, signal).then(() => {
      session.uploaded = true;
      return { success: true };
    }, error => {
      const message = signal.aborted ? t('Upload cancelled.') : error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Project upload: ${message}`);
      return { error: message };
    });
    session.task = task;
    try { return await task; }
    finally { session.task = undefined; accountListener.dispose(); }
  }

  private async performUpload(session: ProjectUploadSession, releaseLog: string, signal: AbortSignal): Promise<void> {
    const assertAvailable = (): void => {
      signal.throwIfAborted();
      if (JSON.stringify(this.account.getConnection()) !== JSON.stringify(session.connection)) { throw new Error(t('Account changed. Try again.')); }
      if (!vscode.workspace.isTrusted) { throw new Error(t('Trust the current workspace first.')); }
      if (!this.localProjects.some(project => project.uri === session.project.uri && project.id === session.project.id)) {
        throw new Error(t('The project is no longer open.'));
      }
    };
    assertAvailable();
    const project = session.project;
    if (this.serverProject?.id === project.id && this.serverProject.canManage === false) { throw new Error(t('Project management permission is required.')); }
    const documents = vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.toString().startsWith(`${project.uri}/`));
    for (const document of documents) {
      if (!await document.save()) { throw new Error(t('Save the project files before uploading.')); }
    }
    assertAvailable();
    const readManifest = async (): Promise<void> => {
      let manifest: { id?: string; version?: string } | undefined;
      try { manifest = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.Uri.parse(project.uri), 'package.json')))); }
      catch { throw new Error(t('Declare a valid project UUID and version in package.json first.')); }
      if (manifest?.id !== project.id || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
        throw new Error(t('Declare a valid project UUID and version in package.json first.'));
      }
      if (manifest.version !== session.version) { throw new Error(t('Project version changed. Try uploading again.')); }
    };
    await readManifest();
    try {
      if ((await new ProjectServerClient(session.connection).versions(project.id, signal)).versions.some(entry => entry.version === session.version)) {
        throw new Error(t('Version {0} already exists. Change package.json version before uploading.', session.version));
      }
    } catch (error) { if (!(error instanceof AuthError && error.status === 404)) { throw error; } }
    assertAvailable();
    await readManifest();
    await this.launcher.uploadProject!({ ...project, manifest: { ...project.manifest, version: session.version } }, releaseLog, signal, progress => {
      void vscode.commands.executeCommand('studio.internalUpdateProjectUpload', { id: session.id, message: progress.message }).then(undefined, () => {});
    });
    await this.reload();
  }

  private async chooseDownload(): Promise<void> {
    if (this.busy || this.choosing) { return; }
    this.choosing = true;
    try { await this.prepareDownload(); }
    finally { this.choosing = false; }
  }

  private async prepareDownload(): Promise<void> {
    if (!this.account.getConnection()) { this.account.open(); return; }
    if (!this.launcher.downloadProject) { throw new Error(t('Project transfers are unavailable in this extension host.')); }
    const credentials = this.account.getConnection()!;
    const connection = JSON.stringify(credentials);
    const assertAccount = (): void => {
      if (JSON.stringify(this.account.getConnection()) !== connection) { throw new Error(t('Account changed. Try again.')); }
    };
    const client = new ProjectServerClient(credentials);
    const projects = await this.progress(t('Download Project'), signal => client.projects(signal));
    assertAccount();
    const picked = await vscode.window.showQuickPick(projects.map(project => ({ label: project.name, description: project.latest ?? '', project })), { title: t('Download Project') });
    if (!picked) { return; }
    assertAccount();
    const versions = await this.progress(t('Download Project'), signal => client.versions(picked.project.id, signal));
    assertAccount();
    const selected = await vscode.window.showQuickPick(versions.versions.map(version => ({ label: version.version, description: version.latest ? t('Latest') : '', version })), { title: t('Select Version') });
    assertAccount();
    if (selected) {
      if (!picked.project.sourceDownload?.allowed) { throw new Error(t('Project source download is not granted.')); }
      await this.downloadAndOpen(picked.project, selected.version.version);
    }
  }

  private async download(version: string): Promise<void> {
    const project = this.serverProject;
    if (this.busy || !project || !this.launcher.downloadProject || !this.versions.some(entry => entry.version === version)) { return; }
    if (!project.sourceDownload?.allowed) { throw new Error(t('Project source download is not granted.')); }
    await this.downloadAndOpen(project, version);
  }

  private async importFromLink(value?: string): Promise<void> {
    if (this.busy || this.choosing || this.disposed) { return; }
    this.choosing = true;
    try {
      if (!this.launcher.downloadProject) { throw new Error(t('Project transfers are unavailable in this extension host.')); }
      const link = value ?? await vscode.window.showInputBox({ title: t('Import from Link'), prompt: t('Project Share Link'),
        placeHolder: 'https://server.example.com/share/projects/<project-id>/1.0.0', ignoreFocusOut: true,
        validateInput: input => {
          if (!input.trim()) { return t('Enter a project share link.'); }
          try { parseServerProjectShareLink(input); return undefined; }
          catch (error) { return error instanceof Error ? error.message : t('Enter a valid project share link.'); }
        } });
      if (link === undefined || this.disposed) { return; }
      const share = parseServerProjectShareLink(link);
      const connection = this.account.getConnection();
      if (!connection) {
        this.pendingImportLink = link;
        this.account.open();
        void vscode.window.showInformationMessage(t('Sign in to {0} to import this project.', share.serverUrl));
        return;
      }
      if (normalizeProjectServerUrl(connection.serverUrl) !== share.serverUrl) {
        throw new Error(t('This link belongs to {0}. Sign in to that server before importing.', share.serverUrl));
      }
      const key = JSON.stringify(connection);
      this.busy = true; this.publish();
      const project = await this.progress(t('Import from Link'), signal => new ProjectServerClient(connection).sourceShare(share.id, share.version, signal));
      this.lifetime.signal.throwIfAborted();
      if (JSON.stringify(this.account.getConnection()) !== key) { throw new Error(t('Account changed. Try again.')); }
      if (project.id !== share.id || project.version !== share.version || typeof project.name !== 'string') { throw new Error(t('The server returned an invalid response.')); }
      await this.downloadAndOpen(project, share.version);
    } finally { this.choosing = false; this.busy = false; this.publish(); }
  }

  private async downloadAndOpen(project: { id: string; name: string }, version: string): Promise<void> {
    this.busy = true; this.publish();
    try {
      const downloaded = await this.progress(t('Download {0} version {1}', project.name, version), (signal, report) => this.launcher.downloadProject!(project.id, version, signal, report));
      if (this.disposed) { return; }
      const root = downloaded.find(entry => entry.role === 'root');
      if (!root) { throw new Error(t('The server returned an invalid response.')); }
      await this.rememberDownload(downloaded);
      void this.offerOpenFolder(t('Downloaded {0} version {1} to {2}.', root.name, root.version, root.directory), t('Open Project'), root.directory);
    } finally { this.busy = false; this.publish(); }
  }

  private async offerOpenFolder(message: string, label: string, directory: string): Promise<void> {
    try {
      const answer = await vscode.window.showInformationMessage(message, label);
      if (answer === label && !this.disposed) { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(directory), { forceNewWindow: true }); }
    } catch (error) { this.report(error); }
  }

  private progress<T>(title: string, action: (signal: AbortSignal, report: (value: { message: string }) => void) => Promise<T>): Thenable<T> {
    const connection = JSON.stringify(this.account.getConnection());
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, cancellation) => {
      if (JSON.stringify(this.account.getConnection()) !== connection) { throw new Error(t('Account changed. Try again.')); }
      const controller = new AbortController();
      const listener = cancellation.onCancellationRequested(() => controller.abort());
      const accountListener = this.account.onDidChange(state => {
        if (state.status !== 'checking' && JSON.stringify(this.account.getConnection()) !== connection) { controller.abort(); }
      });
      if (cancellation.isCancellationRequested) { controller.abort(); }
      try { return await action(AbortSignal.any([controller.signal, this.lifetime.signal]), value => progress.report(value)); }
      finally { listener.dispose(); accountListener.dispose(); }
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const listener of this.listeners.splice(0)) { listener.dispose(); }
    this.view = view;
    view.title = t('Versions');
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const asset = (name: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    view.webview.html = `<!DOCTYPE html><html lang="${vscode.env.language}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('versions-ui.css')}"></head>
      <body><main id="versions-app"></main>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('versions-ui.js')}"></script></body></html>`;
    this.listeners.push(view.webview.onDidReceiveMessage(message => { void this.receive(message).catch(error => this.report(error)); }),
      view.onDidChangeVisibility(() => { if (view.visible) { void this.reload(); } }),
      view.onDidDispose(() => { if (this.view === view) { this.view = undefined; for (const listener of this.listeners.splice(0)) { listener.dispose(); } } }));
    this.publish(); void this.reload();
  }

  private async receive(message: { type?: string; generation?: number; projectId?: string; version?: string }): Promise<void> {
    if (message.type === 'ready') { this.publish(); return; }
    if (message.type === 'sign-in') { this.account.open(); return; }
    if (message.generation !== this.generation || this.busy) { return; }
    if (message.type === 'refresh') { await this.reload(); return; }
    if (message.projectId !== this.preferred?.id) { return; }
    if (message.type === 'upgrade') { await this.upgrade(this.preferred); return; }
    if (message.type === 'upload') {
      const local = this.preferred;
      if (local) { await this.upload(local); }
    }
    if (message.type === 'download' && message.version) { await this.download(message.version); }
  }

  private report(error: unknown): void {
    if (this.disposed || error instanceof Error && error.name === 'AbortError') { return; }
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`Project transfer: ${message}`);
    void vscode.window.showErrorMessage(message);
  }

  dispose(): void {
    this.disposed = true; ++this.generation; clearTimeout(this.timer); clearInterval(this.interval); this.reading?.abort(); this.lifetime.abort(); this.changes.dispose();
    for (const listener of this.listeners.splice(0)) { listener.dispose(); }
  }
}
