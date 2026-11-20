import { ServerAuthClient, studioProtocols, type DeviceStart } from '../../../../shared/server-auth/index';
import type { ServiceChannel } from '../../../../shared/service-urls/index';
declare const __STEAMHARNESS_SERVICE_CHANNEL__: ServiceChannel;
export const studioAuthChannel: ServiceChannel = typeof __STEAMHARNESS_SERVICE_CHANNEL__ === 'undefined' ? 'dev' : __STEAMHARNESS_SERVICE_CHANNEL__;
import { t, locale } from './localization';
import { localizationHtml } from './localization-host';
import { webviewContextMenu } from './webview-context-menu';
import * as vscode from 'vscode';
import { registerProjectConnectionStatus } from './workflow-connection-status';
import { AccountSections } from './account-sections';
import type { AccountSectionProvider } from './account-section-types';
import { accountMenuState } from './account-menu-state';
import { settingsState, settingsViewState, updateSetting } from './settings';
import type { SettingsOpenOptions, SettingsState, SettingsTarget, SettingsViewState } from './settings-types';
import type { ProjectSidebar } from './project-sidebar';
import { UserModels, USER_MODELS_SECRET } from './user-models';
import type { UserModelCatalogProvider, UserModelWriteLock } from './user-model-types';
import { publicServiceUrls, serviceChannelFromServerUrl } from '../../../../shared/service-urls/index';
import {
  DEFAULT_STEAMHARNESS_SERVER_URL, Account, AuthError, ServerClient, normalizeProjectServerUrl,
  type AccountState, type Connection, type LoginSession,
} from './workflow-auth-client';

const SECRET_KEY = `studio.project.account.${studioAuthChannel}`;
const LEGACY_SECRET_KEY = 'studio.project.account';
const PROVIDER_ID = 'studio-steamharness';

export class AccountController implements vscode.Disposable {
  private readonly modelChanges = new vscode.EventEmitter<void>();
  readonly onDidChangeUserModels = this.modelChanges.event;
  private readonly userModels: UserModels;
  private readonly change = new vscode.EventEmitter<AccountState>();
  readonly onDidChange = this.change.event;
  private readonly sessionChange = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private previousSession?: vscode.AuthenticationSession;
  private panel?: vscode.WebviewPanel;
  private loginPanel?: vscode.WebviewPanel;
  private loginBusy = false;
  private loginAbort?: AbortController;
  private pendingLogin?: { state: string; client: ServerAuthClient; started: DeviceStart };
  private viewState: SettingsViewState = { section: 'general', target: 'user' };
  private settingsTimer?: ReturnType<typeof setTimeout>;
  private sidebar?: ProjectSidebar;
  private settingWrites: Promise<void> = Promise.resolve();
  private languagePreference = 'system';
  private languageWrites: Promise<void> = Promise.resolve();
  private readonly account: Account;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sections = new AccountSections(states => {
    void this.panel?.webview.postMessage({ type: 'account-sections', states });
  });

  private onlineOpened = false;
  private pendingRestore?: Promise<void>;
  private aiSession?: LoginSession;
  private aiLogin?: Promise<Connection | undefined>;
  private aiLoginAbort?: AbortController;
  private readonly lifetime = new AbortController();

  constructor(private readonly context: vscode.ExtensionContext, modelWriteLock?: UserModelWriteLock, readonly platform = false) {
    this.userModels = new UserModels(context.secrets, () => { this.modelChanges.fire(); this.publishSettings(); },
      modelWriteLock);
    this.account = new Account(this.configuredServer(), {
      get: async () => {
        const current = await context.secrets.get(SECRET_KEY);
        if (current !== undefined) return current || undefined;
        const legacy = await context.secrets.get(LEGACY_SECRET_KEY);
        try { if (legacy && new ServerClient(JSON.parse(legacy).serverUrl).serverUrl === new ServerClient(this.configuredServer()).serverUrl) return legacy; } catch {}
        return undefined;
      },
      store: (value) => context.secrets.store(SECRET_KEY, value),
      delete: () => context.secrets.store(SECRET_KEY, ''),
    }, (state) => {
      this.change.fire(state);
      void vscode.commands.executeCommand('setContext', 'studio.authenticated', !!this.account.getSession());
      void vscode.commands.executeCommand('studio.internalUpdateAccountMenuState', accountMenuState(state)).then(undefined, () => undefined);
      void this.panel?.webview.postMessage({ type: 'account', state });
      this.publishLogin();
      const session = this.authenticationSession();
      if (JSON.stringify(session) !== JSON.stringify(this.previousSession)) {
        this.sessionChange.fire({
          added: session && session.id !== this.previousSession?.id ? [session] : [],
          removed: this.previousSession && this.previousSession.id !== session?.id ? [this.previousSession] : [],
          changed: session && session.id === this.previousSession?.id ? [session] : [],
        });
        this.previousSession = session;
      }
    });
    this.disposables.push(
      this.change, this.sessionChange, this.modelChanges, this.userModels,
      ...(platform ? [
      vscode.window.registerUriHandler({ handleUri: uri => {
        const pending = this.pendingLogin;
        if (uri.scheme !== studioProtocols[studioAuthChannel] || uri.authority !== 'studio.studio-workstation' || uri.path !== '/auth/callback' || uri.fragment || !pending) return;
        const query = new URLSearchParams(uri.query);
        if (query.size !== 1 || query.get('state') !== pending.state) return;
        this.publishLogin();
      } }),
      registerProjectConnectionStatus(this),
      vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, 'SteamHarness', {
        onDidChangeSessions: this.sessionChange.event,
        getSessions: async (scopes, options) => {
          const session = this.authenticationSession();
          return session && (!options.account || options.account.id === session.account.id) && (!scopes || scopes.every((scope) => scope === 'workflow')) ? [session] : [];
        },
        createSession: async (scopes) => {
          if (scopes.some((scope) => scope !== 'workflow')) { throw new Error('Unsupported Workflow authentication scope.'); }
          await this.connect();
          const existing = this.authenticationSession();
          if (existing) { return existing; }
          this.openLogin();
          return new Promise<vscode.AuthenticationSession>((resolve, reject) => {
            const listeners: vscode.Disposable[] = [];
            const finish = (session?: vscode.AuthenticationSession): void => {
              for (const listener of listeners) { listener.dispose(); }
              if (session) { resolve(session); } else { reject(new Error(t("Sign-in cancelled."))); }
            };
            listeners.push(this.onDidChange(() => {
              const session = this.authenticationSession();
              if (session) { finish(session); }
            }), this.loginPanel!.onDidDispose(() => finish()));
          });
        },
        removeSession: async (sessionId) => {
          this.cancelLogin();
          if (this.authenticationSession()?.id === sessionId) { await this.account.logout(); }
        },
      }, { supportsMultipleAccounts: false }),
      vscode.commands.registerCommand('studio.openAccount', () => this.open()),
      vscode.commands.registerCommand('studio.launchpadSignIn', async () => {
        if (this.loginBusy || await this.connect() || this.loginBusy) return;
        this.loginBusy = true;
        const abort = this.loginAbort = new AbortController();
        try { await this.signInWithBrowser(this.configuredServer(), abort.signal); }
        finally { this.loginBusy = false; this.loginAbort = undefined; this.pendingLogin = undefined; this.publishLogin(); }
      }),
      vscode.commands.registerCommand('studio.openLogin', async () => { await this.connect(); this.openLogin(); }),
      vscode.window.registerWebviewPanelSerializer('studio.login', {
        deserializeWebviewPanel: async panel => {
          if (this.loginPanel && this.loginPanel !== panel) { panel.dispose(); this.loginPanel.reveal(); return; }
          this.attachLoginPanel(panel);
        },
      }),
      vscode.commands.registerCommand('studio.internalGetAccountMenuState', () => accountMenuState(this.getState())),
      vscode.commands.registerCommand('studio.refreshAccount', () => this.connect()),
      vscode.commands.registerCommand('studio.validateLogin', () => this.connect()),
      vscode.commands.registerCommand('studio.logout', async () => { await this.connect(); this.cancelLogin(); return this.account.logout(); }),
      vscode.commands.registerCommand('studio.disconnectSystemAi', () => this.disconnectAi()),
      ] : []),
      vscode.commands.registerCommand('studio.openLaunchpadResource', async (resource: string) => {
        const server = this.getState().serverUrl;
        if (resource === 'docs') {
          const { docs } = publicServiceUrls(this.platform ? serviceChannelFromServerUrl(server) ?? studioAuthChannel : studioAuthChannel);
          await vscode.env.openExternal(vscode.Uri.parse(docs));
        } else if (resource === 'server' && this.platform) {
          await vscode.env.openExternal(vscode.Uri.parse(normalizeProjectServerUrl(server)));
        }
      }),
      vscode.commands.registerCommand('studio.openSettings', (options?: SettingsOpenOptions) => this.open(settingsViewState(options))),
      vscode.window.registerWebviewPanelSerializer('studio.settings', {
        deserializeWebviewPanel: async (panel, state) => {
          if (this.panel && this.panel !== panel) { panel.dispose(); this.panel.reveal(); return; }
          this.viewState = settingsViewState(state);
          this.attachPanel(panel);
        },
      }),
      context.secrets.onDidChange((event) => {
        if (this.onlineOpened && event.key === SECRET_KEY) { void this.account.restore().catch(() => undefined); }
        if (event.key === USER_MODELS_SECRET) { void this.userModels.reload(); }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        this.scheduleSettings();
        if (this.platform && event.affectsConfiguration('studio.project.serverUrl')) {
          this.cancelLogin();
          void this.account.changeServer(this.configuredServer()).catch(() => undefined);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleSettings()),
      vscode.extensions.onDidChange(() => this.scheduleSettings()),
    );
  }

  private configuredServer(): string {
    return (this.platform ? vscode.workspace.getConfiguration('studio').get<string>('project.serverUrl') : undefined) || DEFAULT_STEAMHARNESS_SERVER_URL;
  }

  private authenticationSession(): vscode.AuthenticationSession | undefined {
    const session = this.account.getSession();
    if (!session) { return; }
    const account: vscode.AuthenticationSessionAccountInformation & { icon?: vscode.Uri } = {
      id: session.user.userId,
      label: session.user.displayName || session.user.email || session.user.userId,
      icon: session.user.avatarUrl ? vscode.Uri.parse(session.user.avatarUrl) : undefined,
    };
    return { id: session.apiKeyId, accessToken: session.accessToken, account, scopes: ['workflow'] };
  }

  async initialize(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'studio.accountAvailable', this.platform);
    await vscode.commands.executeCommand('setContext', 'studio.platformAvailable', this.platform);
    await this.readLanguagePreference();
    await this.userModels.reload();
  }
  async connect(): Promise<Connection | undefined> {
    if (!this.platform) return undefined;
    const loaded = this.onlineOpened;
    this.onlineOpened = true;
    this.pendingRestore ??= (loaded && this.account.getSession() ? this.account.verify() : this.account.restore())
      .finally(() => { this.pendingRestore = undefined; });
    await this.pendingRestore;
    return this.account.getState().status === 'authenticated' ? this.account.getConnection() : undefined;
  }
  getState(): AccountState {
    const state = this.account.getState();
    return { ...state, aiServerUrl: this.aiSession?.serverUrl, aiConfigured: !!this.getAiConnection() };
  }
  getUserAgentModels() { return this.userModels.models(); }
  registerModelCatalogProvider(provider: UserModelCatalogProvider): vscode.Disposable { return this.userModels.registerCatalogProvider(provider); }
  getConnection(): Connection | undefined { return this.account.getConnection(); }
  getAiConnection(): Connection | undefined {
    const session = this.aiSession;
    if (!session || session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) return undefined;
    return { serverUrl: session.serverUrl, accessToken: session.accessToken };
  }
  connectAi(): Promise<Connection | undefined> {
    if (!this.platform) return Promise.resolve(undefined);
    if (!this.aiLogin) {
      const abort = this.aiLoginAbort = new AbortController();
      this.aiLogin = this.openAiLogin(AbortSignal.any([abort.signal, this.lifetime.signal])).finally(() => {
        this.aiLogin = this.aiLoginAbort = undefined;
      });
    }
    return this.aiLogin;
  }
  private aiKey(serverUrl: string): string { return `studio.system-ai.${studioAuthChannel}.${encodeURIComponent(serverUrl)}`; }
  private async openAiLogin(lifetime: AbortSignal): Promise<Connection | undefined> {
    const title = t('Connect to System AI');
    const input = await vscode.window.showInputBox({ title, prompt: t('Enter a valid server address.'),
      value: this.aiSession?.serverUrl ?? this.configuredServer(), ignoreFocusOut: true,
      validateInput: value => { try { normalizeProjectServerUrl(value); return undefined; } catch (error) { return (error as Error).message; } } });
    if (!input || lifetime.aborted) return undefined;
    const client = new ServerAuthClient(normalizeProjectServerUrl(input), fetch, locale());
    const key = this.aiKey(client.serverUrl);
    return vscode.window.withProgress({ title, location: vscode.ProgressLocation.Notification, cancellable: true }, async (_progress, token) => {
      const abort = new AbortController();
      const cancellation = token.onCancellationRequested(() => abort.abort());
      const signal = AbortSignal.any([abort.signal, lifetime]);
      if (token.isCancellationRequested) abort.abort();
      let started: DeviceStart | undefined;
      try {
        let saved: Connection | undefined;
        try { saved = JSON.parse(await this.context.secrets.get(key) ?? 'null') ?? undefined; } catch { /* Ignore invalid cached credentials. */ }
        signal.throwIfAborted();
        if (saved?.serverUrl === client.serverUrl && typeof saved.accessToken === 'string') {
          try {
            const session = await new ServerClient(client.serverUrl).verify(saved, signal);
            signal.throwIfAborted();
            this.publishAiSession(session);
            return this.getAiConnection();
          } catch (error) {
            if (!(error instanceof AuthError) || error.status !== 401) throw error;
            await this.context.secrets.delete(key);
            if (this.aiSession?.serverUrl === client.serverUrl) this.publishAiSession(undefined);
          }
        }
        started = await client.start({ clientName: 'SteamHarness Studio (System AI)', source: 'desktop' }, signal);
        if (!await vscode.env.openExternal(vscode.Uri.parse(started.verificationUriComplete))) throw new Error(t('Sign-in cancelled.'));
        const receipt = await client.poll(started, signal);
        const session = await new ServerClient(client.serverUrl).verify({ serverUrl: client.serverUrl, accessToken: receipt.accessToken }, signal);
        signal.throwIfAborted();
        await this.context.secrets.store(key, JSON.stringify({ serverUrl: session.serverUrl, accessToken: session.accessToken }));
        signal.throwIfAborted();
        this.publishAiSession(session);
        return this.getAiConnection();
      } catch (error) {
        if (started) await client.cancel(started.deviceCode).catch(() => undefined);
        if (signal.aborted) return undefined;
        throw error instanceof Error && error.message === 'expired_token' ? new Error(t('Sign-in request expired. Start again.'))
          : error instanceof Error && error.message === 'access_denied' ? new Error(t('Sign-in request was denied.')) : error;
      } finally { cancellation.dispose(); }
    });
  }
  async disconnectAi(): Promise<void> {
    this.aiLoginAbort?.abort();
    await this.aiLogin?.catch(() => undefined);
    const session = this.aiSession;
    this.publishAiSession(undefined);
    if (session) await this.context.secrets.delete(this.aiKey(session.serverUrl));
  }
  private publishAiSession(session?: LoginSession): void {
    this.aiSession = session;
    const connection = this.getAiConnection();
    this.userModels.setConnection(connection);
    this.sections.setConnection(connection);
    this.change.fire(this.getState());
    void this.panel?.webview.postMessage({ type: 'account', state: this.getState() });
  }
  async openServerPage(path: string): Promise<void> {
    const connection = await this.connect();
    if (!connection) { this.openLogin(); return; }
    try {
      const url = await new ServerClient(connection.serverUrl).browserSession(connection, path);
      const current = this.getConnection();
      if (current?.serverUrl !== connection.serverUrl || current.accessToken !== connection.accessToken) { return; }
      await vscode.commands.executeCommand('simpleBrowser.show', url);
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) { await this.account.invalidate(connection); }
      throw error;
    }
  }
  registerSectionProvider(provider: AccountSectionProvider): vscode.Disposable {
    const disposable = this.sections.register(provider);
    this.publishSettings();
    if (this.panel?.visible) { void this.sections.refresh(); }
    return { dispose: () => { disposable.dispose(); this.publishSettings(); } };
  }
  invalidate(connection: Connection): Promise<void> { return this.account.invalidate(connection); }
  async verifyConnection(connection: Connection): Promise<void> {
    const current = this.account.getConnection();
    if (current?.serverUrl === connection.serverUrl && current.accessToken === connection.accessToken) { await this.account.verify(); }
  }

  open(options?: SettingsOpenOptions, verifyAccount = true): void {
    const target = settingsViewState(options ?? { section: this.platform ? 'account' : 'general' });
    const online = target.section === 'account' || target.section?.startsWith('provider:');
    this.viewState = online && !this.platform ? { section: 'general', target: 'user' } : target;
    if (target.section === 'account' && this.platform && verifyAccount) void this.connect().catch(() => undefined);
    if (this.panel) {
      this.panel.reveal();
      this.publishSettings();
      void this.panel.webview.postMessage({ type: 'settings-navigate', state: this.viewState });
      return;
    }
    const panel = vscode.window.createWebviewPanel('studio.settings', t('Settings'), vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    });
    this.attachPanel(panel);
  }

  private openLogin(): void {
    if (!this.platform) return;
    if (this.getState().status === 'authenticated') { this.open({ section: 'account' }, false); return; }
    if (this.loginPanel) { this.loginPanel.reveal(); this.publishLogin(); return; }
    this.attachLoginPanel(vscode.window.createWebviewPanel('studio.login', t('Sign In'), vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    }));
  }

  private cancelLogin(): void {
    this.loginAbort?.abort(); this.loginAbort = undefined;
    const pending = this.pendingLogin; this.pendingLogin = undefined;
    if (pending) void pending.client.cancel(pending.started.deviceCode).catch(() => undefined);
  }

  private publishLogin(): void {
    void this.loginPanel?.webview.postMessage({ type: 'account', state: this.getState(), busy: this.loginBusy, loginUrl: this.pendingLogin?.started.verificationUriComplete });
  }

  private attachLoginPanel(panel: vscode.WebviewPanel): void {
    this.loginPanel = panel;
    panel.title = t('Sign In');
    panel.iconPath = new vscode.ThemeIcon('sign-in');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    panel.webview.html = this.html(panel, true);
    let pageGeneration = 0;
    const listeners: vscode.Disposable[] = [];
    listeners.push(panel.onDidDispose(() => {
      if (this.loginPanel === panel) { this.cancelLogin(); this.loginPanel = undefined; }
      for (const listener of listeners) { listener.dispose(); }
    }), panel.webview.onDidReceiveMessage(async message => {
      if (this.loginPanel !== panel || !message || typeof message !== 'object') { return; }
      if (message.type === 'ready') { ++pageGeneration; this.publishLogin(); return; }
      if (message.type === 'open-account') { this.open({ section: 'account' }); panel.dispose(); return; }
      if (message.type === 'cancel-login') { this.cancelLogin(); return; }
      if (message.type !== 'login' || this.loginBusy || typeof message.serverUrl !== 'string') return;
      const generation = pageGeneration;
      const current = (): boolean => this.loginPanel === panel && generation === pageGeneration;
      this.loginBusy = true;
      this.publishLogin();
      let failure: string | undefined;
      const abort = new AbortController(); this.loginAbort = abort;
      try {
        await this.signInWithBrowser(message.serverUrl, abort.signal);
        this.pendingLogin = undefined;
        if (this.getState().status === 'authenticated') {
          if (current()) { this.open({ section: 'account' }, false); panel.dispose(); }
        }
      } catch (error) {
        failure = abort.signal.aborted ? t('Sign-in cancelled.') : error instanceof Error ? error.message === 'expired_token' ? t('Sign-in request expired. Start again.') : error.message === 'access_denied' ? t('Sign-in request was denied.') : error.message : t('Sign-in failed.');
      } finally {
        this.loginBusy = false; this.loginAbort = undefined; this.pendingLogin = undefined;
        if (current()) {
          await panel.webview.postMessage({ type: 'login-result', state: this.getState(), message: failure });
        } else { this.publishLogin(); }
      }
    }));
  }

  private async signInWithBrowser(serverUrl: string, signal: AbortSignal): Promise<void> {
    const client = new ServerAuthClient(serverUrl, fetch, locale()), state = base64State();
    await this.account.login(serverUrl, async () => {
      const started = await client.start({ clientName: 'SteamHarness Studio', source: 'desktop', context: { clientKind: 'studio', channel: studioAuthChannel, state } }, signal);
      this.pendingLogin = { client, started, state }; this.publishLogin();
      try {
        signal.throwIfAborted();
        if (!await vscode.env.openExternal(vscode.Uri.parse(started.verificationUriComplete))) throw new Error(t('Sign-in cancelled.'));
        const token = await client.poll(started, signal);
        const session = await new ServerClient(client.serverUrl).verify({ serverUrl: client.serverUrl, accessToken: token.accessToken }, signal);
        signal.throwIfAborted(); return session;
      } catch (error) { await client.cancel(started.deviceCode).catch(() => undefined); throw error; }
    }, signal);
    if (this.getState().status === 'authenticated') {
      await vscode.workspace.getConfiguration('studio').update('project.serverUrl', this.getState().serverUrl, vscode.ConfigurationTarget.Global);
    }
  }

  private runtimeStatus?: SettingsState['nodeRuntime'];
  private runtimeStatusEpoch = 0;
  private publishSettings(): void {
    if (!this.panel) { return; }
    void this.panel.webview.postMessage({ type: 'settings', state: this.settingsSnapshot() });
    void this.panel.webview.postMessage({ type: 'settings-models', state: this.userModels.state() });
    const panel = this.panel, epoch = ++this.runtimeStatusEpoch;
    void vscode.commands.executeCommand<SettingsState['nodeRuntime']>('studio.internalGetNodeRuntime').then(status => {
      if (!status || this.panel !== panel || epoch !== this.runtimeStatusEpoch) return;
      this.runtimeStatus = status;
      void panel.webview.postMessage({ type: 'settings', state: this.settingsSnapshot() });
    }, () => undefined);
  }

  private settingsSnapshot(): SettingsState {
    const state = settingsState(this.context.extension.packageJSON.version, this.viewState.target ?? 'user', this.sections.getProviders(), this.languagePreference);
    this.viewState.target = state.target;
    state.nodeRuntime = this.runtimeStatus;
    state.sidebar = this.sidebarSnapshot();
    return state;
  }

  private sidebarSnapshot(): SettingsState['sidebar'] {
    return this.sidebar ? { items: this.sidebar.items(), canAdd: this.sidebar.canAdd } : undefined;
  }

  setProjectSidebar(sidebar: ProjectSidebar): void {
    this.sidebar = sidebar;
    const publish = () => { if (this.panel?.visible) void this.panel.webview.postMessage({ type: 'settings-sidebar-state', state: this.sidebarSnapshot() }); };
    this.disposables.push(sidebar.onDidChange(publish), vscode.workspace.onDidGrantWorkspaceTrust(publish));
    publish();
  }

  private async readLanguagePreference(): Promise<void> {
    const value = await vscode.commands.executeCommand<string>('studio.internalGetDisplayLanguage').then(undefined, () => undefined);
    if (typeof value === 'string') { this.languagePreference = value; }
  }

  private scheduleSettings(): void {
    clearTimeout(this.settingsTimer);
    if (this.panel?.visible) { this.settingsTimer = setTimeout(() => this.publishSettings(), 100); }
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.title = t('Settings');
    panel.iconPath = new vscode.ThemeIcon('settings-gear');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    panel.webview.html = this.html(panel);
    let busy = false;
    let sidebarBusy = false;
    let pageGeneration = 0;
    let modelsAbort = new AbortController();
    const listeners: vscode.Disposable[] = [];
    listeners.push(panel.onDidDispose(() => {
      modelsAbort.abort();
      if (this.panel === panel) { this.panel = undefined; }
      for (const listener of listeners) { listener.dispose(); }
    }), panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.visible) this.publishSettings();
    }), panel.webview.onDidReceiveMessage(async (message) => {
      if (this.panel !== panel || !message || typeof message !== 'object') { return; }
      if (message.type === 'ready') {
        modelsAbort.abort(); modelsAbort = new AbortController();
        const generation = ++pageGeneration;
        await this.readLanguagePreference();
        if (this.panel !== panel || pageGeneration !== generation) { return; }
        this.publishSettings();
        await panel.webview.postMessage({ type: 'account', state: this.getState() });
        await panel.webview.postMessage({ type: 'account-sections', states: this.sections.getStates() });
        await panel.webview.postMessage({ type: 'settings-navigate', state: this.viewState });
        return;
      }
      if (message.type === 'settings-view-state') {
        const previous = this.viewState.section;
        this.viewState = settingsViewState(message.state);
        if (this.platform && previous !== 'account' && this.viewState.section === 'account') void this.connect();
        return;
      }
      if (this.sidebar && message.type === 'settings-sidebar' && !sidebarBusy) {
        const { action, id } = message;
        if (action !== 'add' && (!['up', 'down', 'toggle', 'remove'].includes(action) || typeof id !== 'string' || id.length > 80)) return;
        const generation = pageGeneration;
        sidebarBusy = true;
        let failure: string | undefined;
        try { await this.sidebar.edit(action === 'add' ? { action } : { action, id }); }
        catch (error) { failure = error instanceof Error ? error.message : t('Unable to save setting.'); }
        finally {
          sidebarBusy = false;
          if (this.panel === panel) await panel.webview.postMessage({ type: 'settings-sidebar-state', state: this.sidebarSnapshot(), done: true, error: generation === pageGeneration ? failure : undefined });
        }
        return;
      }
      if (this.platform && (message.type === 'settings-models-account' || message.type === 'connect-system-ai')) {
        this.open({ section: 'provider:system-ai', target: 'user' });
        try { if (await this.connectAi()) await this.sections.refresh(true); }
        catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : t('Sign-in failed.')); }
        return;
      }
      if (message.type === 'settings-models' && typeof message.requestId === 'string' && message.requestId.length <= 100) {
        const generation = pageGeneration, signal = modelsAbort.signal;
        try {
          if (message.action === 'catalog') {
            if (this.platform && !this.getAiConnection()) await this.connectAi();
            const catalog = await this.userModels.refreshCatalog();
            if (this.panel === panel && generation === pageGeneration && !signal.aborted) await panel.webview.postMessage({ type: 'settings-model-catalog', requestId: message.requestId, catalog });
          } else {
            await this.userModels.update(message, signal);
            if (this.panel === panel && generation === pageGeneration && !signal.aborted) await panel.webview.postMessage({ type: 'settings-models-result', requestId: message.requestId, state: this.userModels.state() });
          }
        } catch (error) {
          if (this.panel === panel && generation === pageGeneration && !signal.aborted) await panel.webview.postMessage({ type: message.action === 'catalog' ? 'settings-model-catalog' : 'settings-models-result', requestId: message.requestId,
            message: error instanceof Error ? error.message : t('Unable to save model.'), state: this.userModels.state() });
        }
        return;
      }
      if (message.type === 'settings-target' && ['user', 'workspace'].includes(message.target)) {
        this.viewState.target = message.target;
        this.publishSettings();
        return;
      }
      if (message.type === 'settings-update' && typeof message.key === 'string') {
        const generation = pageGeneration;
        const target = message.target as SettingsTarget;
        const write = this.settingWrites.then(() => updateSetting(message.key, message.value, target, message.reset === true));
        this.settingWrites = write.catch(() => undefined);
        let failure: string | undefined;
        try {
          await write;
        } catch (error) {
          failure = error instanceof Error ? error.message : t('Unable to save setting.');
        }
        if (this.panel !== panel || pageGeneration !== generation) { this.publishSettings(); return; }
        await panel.webview.postMessage({
          type: failure === undefined ? 'settings-saved' : 'settings-error', key: message.key, target,
          message: failure, state: this.settingsSnapshot(),
        });
        return;
      }
      if (message.type === 'settings-language') {
        const generation = pageGeneration;
        let failure: string | undefined;
        const write = this.languageWrites.then(async () => {
          if (!['system', 'en', 'zh-cn'].includes(message.value)) { throw new Error(t('Unsupported display language.')); }
          const value = await vscode.commands.executeCommand<string>('studio.internalSetDisplayLanguage', message.value);
          if (typeof value !== 'string') { throw new Error(t('Unable to save display language.')); }
          this.languagePreference = value;
        });
        this.languageWrites = write.catch(() => undefined);
        try {
          await write;
        } catch (error) {
          failure = error instanceof Error ? error.message : t('Unable to save display language.');
        }
        if (this.panel !== panel || pageGeneration !== generation) { this.publishSettings(); return; }
        await panel.webview.postMessage({ type: 'settings-language-result', value: this.languagePreference, message: failure });
        return;
      }
      if (message.type === 'settings-action') {
        const commands: Record<string, string> = {
          keybindings: 'workbench.action.openGlobalKeybindings',
          'json-user': 'workbench.action.openSettingsJson', 'json-workspace': 'workbench.action.openWorkspaceSettingsFile',
        };
        try {
          if (Object.hasOwn(commands, message.action)) { await vscode.commands.executeCommand(commands[message.action]); }
          else if (message.action === 'documentation') {
            await vscode.env.openExternal(vscode.Uri.parse(publicServiceUrls(serviceChannelFromServerUrl(this.getState().serverUrl) ?? 'main').docs));
          }
        } catch { await panel.webview.postMessage({ type: 'settings-error', message: t('Unable to complete settings action.') }); }
        return;
      }
      if (message.type === 'open-login') { this.openLogin(); return; }
      if (!this.platform) return;
      const exclusive = ['verify', 'logout'].includes(message.type);
      if (exclusive && busy) { return; }
      if (exclusive) { busy = true; }
      try {
        if (message.type === 'verify') { await this.connect(); }
        else if (message.type === 'logout') { await this.account.logout(); }
        else if (message.type === 'refresh-sections') { await this.sections.refresh(true); }
        else if (message.type === 'section-action' && typeof message.providerId === 'string' && typeof message.action === 'string') {
          try { await this.sections.runAction(message.providerId, message.action); }
          catch { throw new Error(t("Unable to complete account action.")); }
        } else if (message.type === 'open-profile' || message.type === 'open-sessions') {
          const route = message.type === 'open-profile' ? '/settings/profile' : '/settings/api-keys';
          await vscode.env.openExternal(vscode.Uri.parse(`${this.getState().serverUrl}${route}`));
        } else if (message.type === 'copy' && ['userId', 'email', 'serverUrl'].includes(message.field)) {
          const state = this.getState();
          const value = message.field === 'serverUrl' ? state.serverUrl : message.field === 'userId' ? state.user?.userId : state.user?.email;
          if (value) {
            await vscode.env.clipboard.writeText(value);
            await panel.webview.postMessage({ type: 'copied', field: message.field });
          }
        }
      } catch (error) {
        await panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : t("Sign-in failed.") });
      } finally {
        if (exclusive) {
          busy = false;
          await panel.webview.postMessage({ type: 'account', state: this.getState() });
        }
      }
    }));
  }

  private html(panel: vscode.WebviewPanel, login = false): string {
    const webview = panel.webview;
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const entry = login ? 'login' : 'account';
    const title = login ? t('Sign In') : t('Settings');
    return `<!doctype html><html lang="${vscode.env.language}"><head>${webviewContextMenu(this.context, panel)}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: http: data:; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset(`${entry}-ui.css`)}"><title>${title}</title></head>
      <body data-platform="${this.platform}"><main id="${entry}-app"></main>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset(`${entry}-ui.js`)}"></script></body></html>`;
  }

  dispose(): void {
    this.lifetime.abort();
    this.cancelLogin();
    clearTimeout(this.settingsTimer);
    void vscode.commands.executeCommand('setContext', 'studio.accountAvailable', false);
    void vscode.commands.executeCommand('setContext', 'studio.platformAvailable', false);
    this.panel?.dispose();
    this.loginPanel?.dispose();
    this.sections.dispose();
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}

export async function activateProjectAccount(context: vscode.ExtensionContext, modelWriteLock?: UserModelWriteLock, platform = false): Promise<AccountController> {
  const account = new AccountController(context, modelWriteLock, platform);
  context.subscriptions.push(account);
  await account.initialize();
  return account;
}

function base64State(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
