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
import { accountMenuState, accountScopeKey } from './account-menu-state';
import { readStudioRuntimeVersions, settingsState, settingsViewState, updateSetting } from './settings';
import type { SettingsOpenOptions, SettingsState, SettingsTarget, SettingsViewState, StudioProductInfo, StudioRuntimeVersions } from './settings-types';
import type { ProjectSidebar } from './project-sidebar';
import { UserModels, USER_MODELS_SECRET } from './user-models';
import type { UserModelCatalogProvider, UserModelWriteLock } from './user-model-types';
import type { RemoteAccessHandler, RemoteAccessAction } from './remote-access-types';
import type { AccountSessions } from './account-sessions-node';
import type { AccountWorkspace } from './account-workspace-data';
import { publicServiceUrls, serviceChannelFromServerUrl } from '../../../../shared/service-urls/index';
import {
  DEFAULT_STEAMHARNESS_SERVER_URL, Account, AuthError, ServerClient, normalizeProjectServerUrl,
  type AccountState, type Connection, type LoginSession,
} from './workflow-auth-client';

const SECRET_KEY = `studio.project.account.${studioAuthChannel}`;
const LEGACY_SECRET_KEY = 'studio.project.account';
const PROVIDER_ID = 'studio-steamharness';
const LAUNCHPAD_SETTINGS_VIEW = 'studio.launchpadSettings';
type SettingsSurface = vscode.WebviewPanel | vscode.WebviewView;

export class AccountController implements vscode.Disposable {
  private readonly modelChanges = new vscode.EventEmitter<void>();
  readonly onDidChangeUserModels = this.modelChanges.event;
  private readonly userModels: UserModels;
  private userModelsLoad?: Promise<void>;
  private readonly change = new vscode.EventEmitter<AccountState>();
  readonly onDidChange = this.change.event;
  private readonly sessionChange = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private previousSession?: vscode.AuthenticationSession;
  private panel?: SettingsSurface;
  private launchpad = false;
  private loginPanel?: vscode.WebviewPanel;
  private loginBusy = false;
  private loginAbort?: AbortController;
  private pendingLogin?: { state?: string; client: ServerAuthClient; started: DeviceStart };
  private viewState: SettingsViewState = { section: 'general', target: 'user' };
  private productInfo?: StudioProductInfo;
  private runtimeVersions?: StudioRuntimeVersions;
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
  private initialWorkspaceAccount?: Promise<void>;
  private activeWorkspace?: AccountWorkspace;
  private aiSession?: LoginSession;
  private aiLogin?: Promise<Connection | undefined>;
  private aiLoginAbort?: AbortController;
  private aiRestore?: Promise<Connection | undefined>;
  private aiRestoreAbort?: AbortController;
  private aiRestoreFailed = false;
  private aiSecretRevision = 0;
  private pendingLogout?: Promise<void>;
  private readonly lifetime = new AbortController();

  constructor(private readonly context: vscode.ExtensionContext, modelWriteLock?: UserModelWriteLock, readonly platform = false,
    private readonly serverUrl = DEFAULT_STEAMHARNESS_SERVER_URL, private readonly digest?: (value: string) => string,
    private readonly remoteAccess?: RemoteAccessHandler, private readonly sessions: AccountSessions = context.secrets,
    private readonly workspaceFactory?: (owner: string) => AccountWorkspace) {
    this.userModels = new UserModels(context.secrets, () => { this.modelChanges.fire(); this.publishSettings(); },
      modelWriteLock);
    this.account = new Account(this.configuredServer(), {
      get: async () => {
        const current = await this.sessions.get(SECRET_KEY);
        // Never read the previous OS-backed credential during desktop restore.
        if (current !== undefined || this.sessions !== context.secrets) return current || undefined;
        const legacy = await context.secrets.get(LEGACY_SECRET_KEY);
        try { if (legacy && new ServerClient(JSON.parse(legacy).serverUrl).serverUrl === new ServerClient(this.configuredServer()).serverUrl) return legacy; } catch {}
        return undefined;
      },
      store: (value) => this.sessions.store(SECRET_KEY, value),
      delete: () => this.sessions === context.secrets ? this.sessions.store(SECRET_KEY, '') : this.sessions.delete(SECRET_KEY),
    }, () => {
      this.syncPlatformConnection();
      const state = this.getState();
      this.change.fire(state);
      void vscode.commands.executeCommand('setContext', 'studio.authenticated', !!this.account.getSession());
      void vscode.commands.executeCommand('studio.internalUpdateAccountMenuState', this.menuState()).then(undefined, () => undefined);
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
        if (uri.scheme !== studioProtocols[studioAuthChannel] || uri.authority !== 'studio.studio-workstation' || uri.path !== '/auth/callback' || uri.fragment || !pending?.state) return;
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
          if (this.authenticationSession()?.id === sessionId) { await this.logout(); }
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
      vscode.commands.registerCommand('studio.refreshAccount', () => this.connect()),
      vscode.commands.registerCommand('studio.validateLogin', () => this.connect()),
      vscode.commands.registerCommand('studio.logout', async () => { await this.connect(); await this.logout(); }),
      vscode.commands.registerCommand('studio.disconnectSystemAi', () => this.disconnectAi()),
      ] : []),
      vscode.commands.registerCommand('studio.internalGetAccountMenuState', () => this.menuState()),
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
          if (this.launchpad) { panel.dispose(); return; }
          if (this.panel && this.panel !== panel) {
            panel.dispose();
            if ('reveal' in this.panel) this.panel.reveal();
            return;
          }
          this.viewState = settingsViewState(state);
          this.attachPanel(panel);
        },
      }),
      this.sessions.onDidChange((event) => {
        if (this.onlineOpened && event.key === SECRET_KEY) { void this.account.restore().catch(() => undefined); }
        if (this.platform && event.key === this.aiKey(this.account.getState().serverUrl)) {
          const revision = ++this.aiSecretRevision;
          if (this.aiSession) void this.reconcileAiSession(event.key, this.aiSession, revision);
        }
      }),
      context.secrets.onDidChange((event) => {
        if (event.key === USER_MODELS_SECRET && this.userModelsLoad) { void this.userModels.reload(); }
      }),
      vscode.workspace.onDidChangeConfiguration(() => this.scheduleSettings()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleSettings()),
      vscode.extensions.onDidChange(() => this.scheduleSettings()),
    );
    if (vscode.window.onDidChangeWindowState) {
      this.disposables.push(vscode.window.onDidChangeWindowState(state => {
        if (state.focused && this.viewState.section === 'notifications') this.scheduleSettings();
      }));
    }
  }

  private configuredServer(): string {
    return this.serverUrl;
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
    const [launchpad, productInfo, runtimeVersions] = await Promise.all([
      vscode.commands.executeCommand<boolean>('studio.internalIsLaunchpad').then(value => value === true, () => false),
      vscode.commands.executeCommand<StudioProductInfo>('studio.internalGetProductInfo').then(undefined, () => undefined),
      readStudioRuntimeVersions(),
    ]);
    this.launchpad = launchpad;
    this.productInfo = productInfo;
    this.runtimeVersions = runtimeVersions;
    if (this.launchpad) {
      this.disposables.push(vscode.window.registerWebviewViewProvider(LAUNCHPAD_SETTINGS_VIEW, {
        resolveWebviewView: (view, _context, token) => {
          if (!token.isCancellationRequested) this.attachPanel(view);
        },
      }));
    }
    await vscode.commands.executeCommand('setContext', 'studio.accountAvailable', this.platform);
    await vscode.commands.executeCommand('setContext', 'studio.platformAvailable', this.platform);
    await this.readLanguagePreference();
    // Rendering the launchpad or signing in does not need third-party model keys.
    if (this.sessions === this.context.secrets) await this.loadUserModels();
    if (this.platform && (this.workspaceFactory || vscode.env.uiKind === vscode.UIKind.Web)) {
      // Both entry points need the account before choosing the initial run-history directory.
      const restoring = this.connect().then(() => undefined, () => undefined).finally(() => {
        this.initialWorkspaceAccount = undefined;
        if (!this.lifetime.signal.aborted) this.change.fire(this.getState());
      });
      this.initialWorkspaceAccount = restoring;
    }
  }
  private menuState() {
    const workspaceOwner = this.workspace()?.owner;
    return { ...accountMenuState(this.getState(), this.platform, this.digest), workspaceOwner };
  }
  waitForWorkspaceAccount(): Promise<unknown> | undefined { return this.initialWorkspaceAccount; }
  get sharesWorkspace(): boolean { return !!this.workspaceFactory; }
  get workspaceRestoring(): boolean { return this.sharesWorkspace && !!this.initialWorkspaceAccount; }
  workspace(): AccountWorkspace | undefined {
    const session = this.account.getSession();
    const owner = this.workspaceFactory && session && (!session.expiresAt || Date.parse(session.expiresAt) > Date.now())
      ? accountScopeKey(this.account.getState(), this.digest) : undefined;
    if (!owner || !this.workspaceFactory) { this.activeWorkspace = undefined; return; }
    if (this.activeWorkspace?.owner !== owner) this.activeWorkspace = this.workspaceFactory(owner);
    return this.activeWorkspace;
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
    return { ...state, aiServerUrl: this.aiSession?.serverUrl, aiConfigured: !!this.getAiConnection(),
      aiRestoring: !!(this.aiRestore || this.aiLogin), aiRestoreFailed: this.aiRestoreFailed };
  }
  getAccountScopeKey(): string | undefined {
    const state = this.account.getState();
    return this.platform && state.status === 'authenticated' ? accountScopeKey(state, this.digest) : undefined;
  }
  getUserAgentModels() { return this.userModels.models(); }
  loadUserModels(): Promise<void> { return this.userModelsLoad ??= this.userModels.reload(); }
  getSystemModelCatalog(signal: AbortSignal) { return this.userModels.catalog(signal); }
  registerModelCatalogProvider(provider: UserModelCatalogProvider): vscode.Disposable {
    const disposable = this.userModels.registerCatalogProvider(provider);
    this.loadSettingsAi();
    return disposable;
  }
  getConnection(): Connection | undefined { return this.account.getConnection(); }
  getAiConnection(): Connection | undefined {
    // Account.getSession() only returns a verified session. A background check
    // must not drop that connection or discard its visible catalogue and usage.
    const session = [this.aiSession, this.account.getSession()].find(candidate =>
      candidate && (!candidate.expiresAt || Date.parse(candidate.expiresAt) > Date.now()));
    return session ? { serverUrl: session.serverUrl, accessToken: session.accessToken } : undefined;
  }
  connectAi(): Promise<Connection | undefined> {
    if (!this.platform || this.pendingLogout) return Promise.resolve(undefined);
    const current = this.getAiConnection();
    if (current) return Promise.resolve(current);
    if (!this.aiLogin) {
      const abort = this.aiLoginAbort = new AbortController();
      const signal = AbortSignal.any([abort.signal, this.lifetime.signal]);
      this.aiLogin = this.restoreAiConnection().then(connection => {
        if (signal.aborted) return undefined;
        if (connection) return connection;
        if (this.aiRestoreFailed || this.account.getState().status === 'error') throw new Error(t('Account verification failed.'));
        return this.openAiLogin(signal);
      }).finally(() => {
        this.aiLogin = this.aiLoginAbort = undefined;
        if (!this.lifetime.signal.aborted) void this.panel?.webview.postMessage({ type: 'account', state: this.getState() });
      });
    }
    return this.aiLogin;
  }
  private aiKey(serverUrl: string): string { return `studio.system-ai.${studioAuthChannel}.${encodeURIComponent(serverUrl)}`; }
  private parseCachedAiSession(encoded: string | undefined, serverUrl: string): Connection | undefined {
    try {
      const saved = encoded ? JSON.parse(encoded) as Partial<Connection> | null : undefined;
      if (saved?.serverUrl === serverUrl && typeof saved.accessToken === 'string' && saved.accessToken) return { serverUrl, accessToken: saved.accessToken };
    } catch { /* Ignore malformed credentials. */ }
  }
  private async reconcileAiSession(key: string, session: LoginSession, revision: number): Promise<void> {
    let saved: Connection | undefined;
    try { saved = this.parseCachedAiSession(await this.sessions.get(key), session.serverUrl); } catch { /* Treat an unreadable changed credential as unavailable. */ }
    if (this.lifetime.signal.aborted || this.aiSession !== session || this.aiSecretRevision !== revision) return;
    if (saved?.accessToken !== session.accessToken) this.publishAiSession(undefined);
  }
  private async readCachedAiSession(client: ServerClient, signal: AbortSignal): Promise<LoginSession | undefined> {
    const key = this.aiKey(client.serverUrl);
    const encoded = await this.sessions.get(key);
    signal.throwIfAborted();
    const saved = this.parseCachedAiSession(encoded, client.serverUrl);
    if (!saved) return;
    try {
      const verified = await client.verify(saved, signal);
      if (await this.sessions.get(key) === encoded) return verified;
    }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof AuthError) || error.status !== 401) throw error;
      if (await this.sessions.get(key) === encoded) {
        signal.throwIfAborted();
        await this.sessions.delete(key);
      }
    }
  }
  private restoreAiConnection(): Promise<Connection | undefined> {
    if (!this.platform || this.pendingLogout) return Promise.resolve(undefined);
    const current = this.getAiConnection();
    if (current) return Promise.resolve(current);
    if (this.aiRestore) return this.aiRestore;
    const controller = this.aiRestoreAbort = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.aiRestoreFailed = false;
    const pending = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      await this.connect();
      signal.throwIfAborted();
      if (!this.getAiConnection() && this.account.getState().status !== 'error') {
        const revision = this.aiSecretRevision;
        const session = await this.readCachedAiSession(new ServerClient(this.configuredServer()), signal);
        signal.throwIfAborted();
        if (session && revision === this.aiSecretRevision && !this.getAiConnection()) this.publishAiSession(session);
      }
      return this.getAiConnection();
    }).catch(() => {
      if (!signal.aborted) this.aiRestoreFailed = true;
      return undefined;
    }).finally(() => {
      if (this.aiRestoreAbort !== controller) return;
      this.aiRestore = this.aiRestoreAbort = undefined;
      if (!signal.aborted) void this.panel?.webview.postMessage({ type: 'account', state: this.getState() });
    });
    this.aiRestore = pending;
    void this.panel?.webview.postMessage({ type: 'account', state: this.getState() });
    return pending;
  }
  private async openAiLogin(lifetime: AbortSignal): Promise<Connection | undefined> {
    const title = t('Connect to System AI');
    if (lifetime.aborted) return undefined;
    const client = new ServerAuthClient(this.configuredServer(), fetch, locale());
    const key = this.aiKey(client.serverUrl);
    return vscode.window.withProgress({ title, location: vscode.ProgressLocation.Notification, cancellable: true }, async (_progress, token) => {
      const abort = new AbortController();
      const cancellation = token.onCancellationRequested(() => abort.abort());
      const signal = AbortSignal.any([abort.signal, lifetime]);
      if (token.isCancellationRequested) abort.abort();
      let started: DeviceStart | undefined;
      try {
        signal.throwIfAborted();
        const existing = this.getAiConnection();
        if (existing) return existing;
        started = await client.start({ clientName: 'SteamHarness Studio (System AI)', source: 'desktop' }, signal);
        if (!await vscode.env.openExternal(vscode.Uri.parse(started.verificationUriComplete))) throw new Error(t('Sign-in cancelled.'));
        const receipt = await client.poll(started, signal);
        const session = await new ServerClient(client.serverUrl).verify({ serverUrl: client.serverUrl, accessToken: receipt.accessToken }, signal);
        signal.throwIfAborted();
        await this.sessions.store(key, JSON.stringify({ serverUrl: session.serverUrl, accessToken: session.accessToken }));
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
    this.cancelAiRestore();
    this.aiLoginAbort?.abort();
    await this.aiLogin?.catch(() => undefined);
    this.publishAiSession(undefined);
    await this.sessions.delete(this.aiKey(this.account.getState().serverUrl));
  }
  private cancelAiRestore(): void {
    this.aiRestoreAbort?.abort();
    this.aiRestore = this.aiRestoreAbort = undefined;
    this.aiRestoreFailed = false;
  }
  private logout(): Promise<void> {
    if (this.pendingLogout) return this.pendingLogout;
    this.cancelLogin();
    // A pending device flow may be finishing a session write when sign-out starts.
    this.aiLoginAbort?.abort();
    const login = this.aiLogin;
    this.aiSession = undefined;
    this.expirePlatformConnection();
    const key = this.aiKey(normalizeProjectServerUrl(this.configuredServer()));
    this.pendingLogout = Promise.all([this.account.logout(), Promise.resolve(login).catch(() => undefined).then(() => this.sessions.delete(key))])
      .then(() => undefined).finally(() => { this.pendingLogout = undefined; });
    return this.pendingLogout;
  }
  private publishAiSession(session?: LoginSession): void {
    this.aiSession = session;
    this.syncPlatformConnection();
    this.change.fire(this.getState());
    void this.panel?.webview.postMessage({ type: 'account', state: this.getState() });
  }
  private syncPlatformConnection(): void {
    const connection = this.getAiConnection();
    this.userModels.setConnection(connection);
    this.sections.setConnection(connection);
    if (connection && this.hasVisibleProviderSettings()) void this.sections.refresh();
  }
  private expirePlatformConnection(): void {
    this.cancelAiRestore();
    this.userModels.setConnection(undefined);
    this.sections.setConnection(undefined);
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
    if (error instanceof AuthError && error.status === 401) { this.expirePlatformConnection(); await this.account.invalidate(connection); }
      throw error;
    }
  }
  registerSectionProvider(provider: AccountSectionProvider): vscode.Disposable {
    const disposable = this.sections.register(provider);
    this.publishSettings();
    this.loadSettingsAi();
    return { dispose: () => { disposable.dispose(); this.publishSettings(); } };
  }
  invalidate(connection: Connection): Promise<void> { this.expirePlatformConnection(); return this.account.invalidate(connection); }
  async verifyConnection(connection: Connection): Promise<void> {
    const current = this.account.getConnection();
    if (current?.serverUrl === connection.serverUrl && current.accessToken === connection.accessToken) { await this.account.verify(); }
  }

  open(options?: SettingsOpenOptions, verifyAccount = true): void | Thenable<void> {
    const target = settingsViewState(options ?? { section: this.platform ? 'account' : 'general' });
    const online = target.section === 'account' || target.section?.startsWith('provider:');
    this.viewState = online && !this.platform ? { section: 'general', target: 'user' } : target;
    if (target.section === 'account' && this.platform && verifyAccount) void this.connect().catch(() => undefined);
    const existing = this.panel;
    if (this.launchpad) {
      return vscode.commands.executeCommand('studio.internalShowLaunchpadSettings', t('Settings')).then(() => {
        // A newly mounted view receives its initial navigation in the ready handshake.
        if (existing && this.panel === existing) this.navigateSettings(existing);
      }, () => { void vscode.window.showErrorMessage(t('Unable to complete settings action.')); });
    }
    if (existing && 'reveal' in existing) {
      existing.reveal();
      this.navigateSettings(existing);
      return;
    }
    const panel = vscode.window.createWebviewPanel('studio.settings', t('Settings'), vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    });
    this.attachPanel(panel);
  }

  private navigateSettings(panel: SettingsSurface): void {
    this.loadSettingsAi();
    this.publishSettings();
    void panel.webview.postMessage({ type: 'settings-navigate', state: this.viewState });
  }

  private hasVisibleProviderSettings(): boolean {
    return !!(this.platform && this.panel?.visible && this.sections.getProviders().some(({ id }) => this.viewState.section === `provider:${id}`));
  }

  private loadSettingsAi(force = false): void {
    if (!this.platform || !this.panel?.visible) return;
    const provider = this.hasVisibleProviderSettings();
    if (!provider && !(this.viewState.section === 'models' && this.userModels.state().systemAvailable)) return;
    if (this.getAiConnection()) { if (provider) void this.sections.refresh(force); }
    else if (!this.aiLogin) void this.restoreAiConnection();
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
      if (message.type !== 'login' || this.loginBusy) return;
      const generation = pageGeneration;
      const current = (): boolean => this.loginPanel === panel && generation === pageGeneration;
      this.loginBusy = true;
      this.publishLogin();
      let failure: string | undefined;
      const abort = new AbortController(); this.loginAbort = abort;
      try {
        await this.signInWithBrowser(this.configuredServer(), abort.signal);
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
    const client = new ServerAuthClient(serverUrl, fetch, locale());
    const desktop = vscode.env.uiKind === vscode.UIKind.Desktop;
    const state = desktop ? base64State() : undefined;
    await this.account.login(serverUrl, async () => {
      const started = await client.start({
        clientName: desktop ? 'SteamHarness Studio' : 'SteamHarness Studio Web',
        source: 'desktop',
        // A Studio device context requests a native app link. Web only needs polling.
        context: state ? { clientKind: 'studio', channel: studioAuthChannel, state } : undefined,
      }, signal);
      this.pendingLogin = { client, started, state }; this.publishLogin();
      try {
        signal.throwIfAborted();
        if (!await vscode.env.openExternal(vscode.Uri.parse(started.verificationUriComplete))) throw new Error(t('Sign-in cancelled.'));
        const token = await client.poll(started, signal);
        const session = await new ServerClient(client.serverUrl).verify({ serverUrl: client.serverUrl, accessToken: token.accessToken }, signal);
        signal.throwIfAborted(); return session;
      } catch (error) { await client.cancel(started.deviceCode).catch(() => undefined); throw error; }
    }, signal);
  }

  private runtimeStatus?: SettingsState['nodeRuntime'];
  private desktopNotificationStatus?: SettingsState['desktopNotificationStatus'];
  private settingsStatusEpoch = 0;

  private get hasDesktopNotifications(): boolean {
    return this.platform && vscode.env.uiKind === vscode.UIKind.Desktop;
  }

  private publishSettings(): void {
    if (!this.panel) { return; }
    void this.panel.webview.postMessage({ type: 'settings', state: this.settingsSnapshot() });
    this.publishModels();
    const panel = this.panel, epoch = ++this.settingsStatusEpoch;
    void Promise.all([
      vscode.commands.executeCommand<SettingsState['nodeRuntime']>('studio.internalGetNodeRuntime').then(value => value, () => undefined),
      this.hasDesktopNotifications ? vscode.commands.executeCommand<SettingsState['desktopNotificationStatus']>('studio.internalGetDesktopNotificationStatus').then(value => value, () => undefined) : undefined,
    ]).then(([runtime, notifications]) => {
      if (this.panel !== panel || epoch !== this.settingsStatusEpoch || (!runtime && !notifications)) return;
      this.runtimeStatus = runtime;
      this.desktopNotificationStatus = notifications;
      void panel.webview.postMessage({ type: 'settings', state: this.settingsSnapshot() });
    }, () => undefined);
  }

  private publishModels(forcePlans = false): void {
    const panel = this.panel;
    if (!panel) return;
    const visible = panel.visible && this.viewState.section === 'models';
    if (visible) void this.loadUserModels();
    const plans = visible ? this.userModels.refreshPlans(forcePlans) : undefined;
    const post = () => { void this.panel?.webview.postMessage({ type: 'settings-models', state: this.userModels.state() }); };
    post();
    if (plans) void plans.then(post);
  }

  private settingsSnapshot(): SettingsState {
    const state = settingsState(this.productInfo?.studioVersion, this.viewState.target ?? 'user', this.sections.getProviders(),
      this.languagePreference, this.hasDesktopNotifications, this.runtimeVersions);
    state.studioLogo = this.productInfo?.logo;
    this.viewState.target = state.target;
    state.nodeRuntime = this.runtimeStatus;
    state.remoteAccess = !!this.remoteAccess;
    state.desktopNotificationStatus = this.desktopNotificationStatus;
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

  private attachPanel(panel: SettingsSurface): void {
    this.panel = panel;
    panel.title = t('Settings');
    if ('reveal' in panel) panel.iconPath = new vscode.ThemeIcon('settings-gear');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    panel.webview.html = this.html(panel);
    let busy = false;
    let sidebarBusy = false;
    let pageGeneration = 0;
    let modelsAbort = new AbortController();
    const listeners: vscode.Disposable[] = [];
    const onVisible = (): void => {
      if (!panel.visible) return;
      this.loadSettingsAi(); this.publishSettings();
    };
    listeners.push('reveal' in panel ? panel.onDidChangeViewState(onVisible) : panel.onDidChangeVisibility(onVisible));
    listeners.push(panel.onDidDispose(() => {
      modelsAbort.abort();
      if (this.panel === panel) { this.panel = undefined; }
      for (const listener of listeners) { listener.dispose(); }
    }), panel.webview.onDidReceiveMessage(async (message) => {
      if (this.panel !== panel || !message || typeof message !== 'object') { return; }
      if (message.type === 'ready') {
        modelsAbort.abort(); modelsAbort = new AbortController();
        const generation = ++pageGeneration;
        await this.readLanguagePreference();
        if (this.panel !== panel || pageGeneration !== generation) { return; }
        this.loadSettingsAi();
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
        if (previous !== this.viewState.section) this.loadSettingsAi();
        if (previous !== 'models' && this.viewState.section === 'models') this.publishModels();
        return;
      }
      if (this.remoteAccess && message.type === 'settings-remote-access' && typeof message.requestId === 'string' && message.requestId.length <= 64) {
        const input = message.input as RemoteAccessAction | { action: 'copy'; value: string } | undefined;
        if (!input || !['status', 'start', 'stop', 'logout', 'generate', 'revoke', 'copy'].includes(input.action)) return;
        const generation = pageGeneration;
        let result: unknown;
        try {
          if (input.action === 'copy') {
            if (typeof input.value !== 'string' || input.value.length > 512) return;
            await vscode.env.clipboard.writeText(input.value);
            result = { copied: true };
          } else result = await this.remoteAccess(input);
        } catch { result = { error: 'unavailable' }; }
        if (this.panel === panel && generation === pageGeneration) await panel.webview.postMessage({ type: 'settings-remote-access-result', requestId: message.requestId, result });
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
      if (this.platform && message.type === 'settings-models-account') {
        this.open({ section: 'provider:system-ai', target: 'user' });
        return;
      }
      if (this.platform && message.type === 'connect-system-ai' && this.hasVisibleProviderSettings()) {
        try {
          if (await this.connectAi()) await this.sections.refresh();
        }
        catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : t('Sign-in failed.')); }
        return;
      }
      if (message.type === 'retry-system-ai' && this.hasVisibleProviderSettings()) { this.loadSettingsAi(true); return; }
      if (message.type === 'retry-model-plans' && this.platform && panel.visible && this.viewState.section === 'models') {
        this.publishModels(true); return;
      }
      if (message.type === 'settings-models' && typeof message.requestId === 'string' && message.requestId.length <= 100) {
        const generation = pageGeneration, signal = modelsAbort.signal;
        try {
          await this.loadUserModels();
          if (message.action === 'catalog') {
            if (this.platform) await this.restoreAiConnection();
            const catalog = await this.userModels.refreshCatalog(true);
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
          if (!this.launchpad && Object.hasOwn(commands, message.action)) { await vscode.commands.executeCommand(commands[message.action]); }
          else if (message.action === 'notification-settings' && this.hasDesktopNotifications) {
            if (!await vscode.commands.executeCommand<boolean>('studio.internalOpenNotificationSettings')) throw new Error('Notification settings unavailable');
          } else if (message.action === 'documentation') {
            await vscode.env.openExternal(vscode.Uri.parse(publicServiceUrls(serviceChannelFromServerUrl(this.getState().serverUrl) ?? 'main').docs));
          }
        } catch { await panel.webview.postMessage({ type: 'settings-error', message: t('Unable to complete settings action.') }); }
        return;
      }
      if (message.type === 'open-login') {
        if (this.launchpad) {
          try { await vscode.commands.executeCommand('studio.launchpadSignIn'); }
          catch (error) { if (this.panel === panel) await panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : t('Sign-in failed.') }); }
        } else { this.openLogin(); }
        return;
      }
      if (!this.platform) return;
      const exclusive = ['verify', 'logout'].includes(message.type);
      if (exclusive && busy) { return; }
      if (exclusive) { busy = true; }
      try {
        if (message.type === 'verify') { await this.connect(); }
        else if (message.type === 'logout') { await this.logout(); }
        else if (message.type === 'refresh-sections') { await this.sections.refresh(true); }
        else if (message.type === 'section-action' && typeof message.providerId === 'string' && typeof message.action === 'string') {
          try { await this.sections.runAction(message.providerId, message.action); }
          catch { throw new Error(t("Unable to complete account action.")); }
        } else if (message.type === 'open-profile' || message.type === 'open-sessions') {
          const route = message.type === 'open-profile' ? '/settings/profile' : '/settings/api-keys';
          await vscode.env.openExternal(vscode.Uri.parse(`${this.getState().serverUrl}${route}`));
        } else if (message.type === 'copy' && ['userId', 'email'].includes(message.field)) {
          const state = this.getState();
          const value = message.field === 'userId' ? state.user?.userId : state.user?.email;
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

  private html(panel: SettingsSurface, login = false): string {
    const webview = panel.webview;
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const entry = login ? 'login' : 'account';
    const title = login ? t('Sign In') : t('Settings');
    return `<!doctype html><html lang="${vscode.env.language}"><head>${webviewContextMenu(this.context, panel)}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: http: data:; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset(`${entry}-ui.css`)}"><title>${title}</title></head>
      <body data-platform="${this.platform}"${this.launchpad ? ' data-launchpad="true"' : ''}><main id="${entry}-app"></main>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset(`${entry}-ui.js`)}"></script></body></html>`;
  }

  dispose(): void {
    this.lifetime.abort();
    this.cancelLogin();
    clearTimeout(this.settingsTimer);
    void vscode.commands.executeCommand('setContext', 'studio.accountAvailable', false);
    void vscode.commands.executeCommand('setContext', 'studio.platformAvailable', false);
    if (this.panel) {
      if ('dispose' in this.panel) this.panel.dispose();
      else void vscode.commands.executeCommand('studio.internalCloseLaunchpadSettings').then(undefined, () => undefined);
    }
    this.loginPanel?.dispose();
    this.sections.dispose();
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}

export async function activateProjectAccount(context: vscode.ExtensionContext, modelWriteLock?: UserModelWriteLock, platform = false,
  serverUrl?: string, digest?: (value: string) => string, remoteAccess?: RemoteAccessHandler, sessions?: AccountSessions,
  workspaceFactory?: (owner: string) => AccountWorkspace): Promise<AccountController> {
  const account = new AccountController(context, modelWriteLock, platform, serverUrl, digest, remoteAccess, sessions, workspaceFactory);
  context.subscriptions.push(account);
  await account.initialize();
  return account;
}

function base64State(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
