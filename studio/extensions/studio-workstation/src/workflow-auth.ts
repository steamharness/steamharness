import { t } from './localization';
import { localizationHtml } from './localization-host';
import { webviewContextMenu } from './webview-context-menu';
import * as vscode from 'vscode';
import { registerProjectConnectionStatus } from './workflow-connection-status';
import { AccountSections } from './account-sections';
import type { AccountSectionProvider } from './account-section-types';
import { accountMenuState } from './account-menu-state';
import { settingsState, settingsViewState, updateSetting } from './settings';
import type { SettingsOpenOptions, SettingsState, SettingsTarget, SettingsViewState } from './settings-types';
import { publicServiceUrls, serviceChannelFromServerUrl } from '../../../../shared/service-urls/index';
import {
  DEFAULT_STEAMHARNESS_SERVER_URL, Account,
  type AccountState, type Connection,
} from './workflow-auth-client';

const SECRET_KEY = 'studio.project.account';
const PROVIDER_ID = 'studio-steamharness';

export class AccountController implements vscode.Disposable {
  private readonly change = new vscode.EventEmitter<AccountState>();
  readonly onDidChange = this.change.event;
  private readonly sessionChange = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private previousSession?: vscode.AuthenticationSession;
  private panel?: vscode.WebviewPanel;
  private viewState: SettingsViewState = { section: 'general', target: 'user' };
  private settingsTimer?: ReturnType<typeof setTimeout>;
  private settingWrites: Promise<void> = Promise.resolve();
  private languagePreference = 'system';
  private languageWrites: Promise<void> = Promise.resolve();
  private readonly account: Account;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sections = new AccountSections(states => {
    void this.panel?.webview.postMessage({ type: 'account-sections', states });
  });

  constructor(private readonly context: vscode.ExtensionContext) {
    this.account = new Account(this.configuredServer(), {
      get: () => context.secrets.get(SECRET_KEY),
      store: (value) => context.secrets.store(SECRET_KEY, value),
      delete: () => context.secrets.delete(SECRET_KEY),
    }, (state) => {
      this.sections.setConnection(this.account.getConnection());
      if (this.panel?.visible) { void this.sections.refresh(); }
      this.change.fire(state);
      void vscode.commands.executeCommand('setContext', 'studio.authenticated', !!this.account.getSession());
      void vscode.commands.executeCommand('studio.internalUpdateAccountMenuState', accountMenuState(state)).then(undefined, () => undefined);
      void this.panel?.webview.postMessage({ type: 'account', state });
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
      this.change, this.sessionChange,
      registerProjectConnectionStatus(this),
      vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, 'SteamHarness', {
        onDidChangeSessions: this.sessionChange.event,
        getSessions: async (scopes, options) => {
          const session = this.authenticationSession();
          return session && (!options.account || options.account.id === session.account.id) && (!scopes || scopes.every((scope) => scope === 'workflow')) ? [session] : [];
        },
        createSession: async (scopes) => {
          if (scopes.some((scope) => scope !== 'workflow')) { throw new Error('Unsupported Workflow authentication scope.'); }
          this.open();
          return new Promise<vscode.AuthenticationSession>((resolve, reject) => {
            const listeners: vscode.Disposable[] = [];
            const finish = (session?: vscode.AuthenticationSession): void => {
              for (const listener of listeners) { listener.dispose(); }
              if (session) { resolve(session); } else { reject(new Error(t("Sign-in cancelled."))); }
            };
            listeners.push(this.onDidChange(() => {
              const session = this.authenticationSession();
              if (session) { finish(session); }
            }), this.panel!.onDidDispose(() => finish()));
          });
        },
        removeSession: async (sessionId) => {
          if (this.authenticationSession()?.id === sessionId) { await this.account.logout(); }
        },
      }, { supportsMultipleAccounts: false }),
      vscode.commands.registerCommand('studio.openAccount', () => this.open()),
      vscode.commands.registerCommand('studio.openSettings', (options?: SettingsOpenOptions) => this.open(settingsViewState(options))),
      vscode.window.registerWebviewPanelSerializer('studio.settings', {
        deserializeWebviewPanel: async (panel, state) => {
          if (this.panel && this.panel !== panel) { panel.dispose(); this.panel.reveal(); return; }
          this.viewState = settingsViewState(state);
          this.attachPanel(panel);
        },
      }),
      vscode.commands.registerCommand('studio.internalGetAccountMenuState', () => accountMenuState(this.getState())),
      vscode.commands.registerCommand('studio.refreshAccount', () => this.account.verify()),
      vscode.commands.registerCommand('studio.validateLogin', () => this.account.verify()),
      vscode.commands.registerCommand('studio.logout', () => this.account.logout()),
      context.secrets.onDidChange((event) => {
        if (event.key === SECRET_KEY) { void this.account.restore().catch(() => undefined); }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        this.scheduleSettings();
        if (event.affectsConfiguration('studio.project.serverUrl')) {
          void this.account.changeServer(this.configuredServer()).catch(() => undefined);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleSettings()),
      vscode.extensions.onDidChange(() => this.scheduleSettings()),
    );
  }

  private configuredServer(): string {
    return vscode.workspace.getConfiguration('studio').get<string>('project.serverUrl') || DEFAULT_STEAMHARNESS_SERVER_URL;
  }

  private authenticationSession(): vscode.AuthenticationSession | undefined {
    const session = this.account.getSession();
    if (!session) { return; }
    const account: vscode.AuthenticationSessionAccountInformation & { icon?: vscode.Uri } = {
      id: session.user.userId,
      label: session.user.displayName || session.user.email,
      icon: session.user.avatarUrl ? vscode.Uri.parse(session.user.avatarUrl) : undefined,
    };
    return { id: session.apiKeyId, accessToken: session.accessToken, account, scopes: ['workflow'] };
  }

  async initialize(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'studio.accountAvailable', true);
    await this.readLanguagePreference();
    await this.account.restore();
    const refresh = (): void => {
      if (vscode.window.state.focused) {
        void this.account.refresh().catch(() => undefined);
        if (this.panel?.visible) { void this.sections.refresh(); }
      }
    };
    const timer = setInterval(refresh, 30_000);
    timer.unref?.();
    this.disposables.push(
      { dispose: () => clearInterval(timer) },
      vscode.window.onDidChangeWindowState(({ focused }) => { if (focused) { refresh(); } }),
    );
  }
  getState(): AccountState { return this.account.getState(); }
  getConnection(): Connection | undefined { return this.account.getConnection(); }
  registerSectionProvider(provider: AccountSectionProvider): vscode.Disposable {
    const disposable = this.sections.register(provider);
    this.publishSettings();
    if (this.panel?.visible) { void this.sections.refresh(); }
    return { dispose: () => { disposable.dispose(); this.publishSettings(); } };
  }
  setAiConnection(connection: { serverUrl: string; accessToken: string } | undefined): void {
    this.account.setAiConnection(connection);
  }
  invalidate(connection: Connection): Promise<void> { return this.account.invalidate(connection); }
  async verifyConnection(connection: Connection): Promise<void> {
    const current = this.account.getConnection();
    if (current?.serverUrl === connection.serverUrl && current.accessToken === connection.accessToken) { await this.account.verify(); }
  }

  open(options: SettingsOpenOptions = { section: 'account' }): void {
    this.viewState = settingsViewState(options);
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

  private publishSettings(): void {
    if (!this.panel) { return; }
    void this.panel.webview.postMessage({ type: 'settings', state: this.settingsSnapshot() });
  }

  private settingsSnapshot(): SettingsState {
    const state = settingsState(this.context.extension.packageJSON.version, this.viewState.target ?? 'user', this.sections.getProviders(), this.languagePreference);
    this.viewState.target = state.target;
    return state;
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
    let pageGeneration = 0;
    const listeners: vscode.Disposable[] = [];
    listeners.push(panel.onDidDispose(() => {
      if (this.panel === panel) { this.panel = undefined; }
      for (const listener of listeners) { listener.dispose(); }
    }), panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.visible) { this.publishSettings(); void this.sections.refresh(); }
    }), panel.webview.onDidReceiveMessage(async (message) => {
      if (this.panel !== panel || !message || typeof message !== 'object') { return; }
      if (message.type === 'ready') {
        const generation = ++pageGeneration;
        await this.readLanguagePreference();
        if (this.panel !== panel || pageGeneration !== generation) { return; }
        this.publishSettings();
        await panel.webview.postMessage({ type: 'account', state: this.getState() });
        await panel.webview.postMessage({ type: 'account-sections', states: this.sections.getStates() });
        await panel.webview.postMessage({ type: 'settings-navigate', state: this.viewState });
        void this.sections.refresh();
        return;
      }
      if (message.type === 'settings-view-state') {
        this.viewState = settingsViewState(message.state);
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
      const exclusive = ['login', 'verify', 'logout'].includes(message.type);
      if (exclusive && busy) { return; }
      if (exclusive) { busy = true; }
      try {
        if (message.type === 'login' && typeof message.serverUrl === 'string' && typeof message.email === 'string' && typeof message.password === 'string' && message.email.length < 320 && message.password.length <= 4096) {
          await this.account.login(message.serverUrl, message.email, message.password);
          if (this.getState().status === 'authenticated') {
            await vscode.workspace.getConfiguration('studio').update('project.serverUrl', this.getState().serverUrl, vscode.ConfigurationTarget.Global);
          }
        } else if (message.type === 'verify') { await this.account.verify(); void this.sections.refresh(true); }
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

  private html(panel: vscode.WebviewPanel): string {
    const webview = panel.webview;
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    return `<!doctype html><html lang="${vscode.env.language}"><head>${webviewContextMenu(this.context, panel)}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: http: data:; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('account-ui.css')}"><title>${t('Settings')}</title></head>
      <body><main id="account-app"></main>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('account-ui.js')}"></script></body></html>`;
  }

  dispose(): void {
    clearTimeout(this.settingsTimer);
    void vscode.commands.executeCommand('setContext', 'studio.accountAvailable', false);
    this.panel?.dispose();
    this.sections.dispose();
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}

export async function activateProjectAccount(context: vscode.ExtensionContext): Promise<AccountController> {
  const account = new AccountController(context);
  context.subscriptions.push(account);
  await account.initialize();
  return account;
}
