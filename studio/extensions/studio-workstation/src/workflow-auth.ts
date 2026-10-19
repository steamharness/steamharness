import { t } from './localization';
import { localizationHtml } from './localization-host';
import * as vscode from 'vscode';
import { registerProjectConnectionStatus } from './workflow-connection-status';
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
  private readonly account: Account;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.account = new Account(this.configuredServer(), {
      get: () => context.secrets.get(SECRET_KEY),
      store: (value) => context.secrets.store(SECRET_KEY, value),
      delete: () => context.secrets.delete(SECRET_KEY),
    }, (state) => {
      this.change.fire(state);
      void vscode.commands.executeCommand('setContext', 'studio.authenticated', !!this.account.getSession());
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
      vscode.commands.registerCommand('studio.validateLogin', () => this.account.verify()),
      vscode.commands.registerCommand('studio.logout', () => this.account.logout()),
      context.secrets.onDidChange((event) => {
        if (event.key === SECRET_KEY) { void this.account.restore().catch(() => undefined); }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('studio.project.serverUrl')) {
          void this.account.changeServer(this.configuredServer()).catch(() => undefined);
        }
      }),
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
    await this.account.restore();
  }
  getState(): AccountState { return this.account.getState(); }
  getConnection(): Connection | undefined { return this.account.getConnection(); }
  setAiConnection(connection: { serverUrl: string; accessToken: string } | undefined): void {
    this.account.setAiConnection(connection);
  }
  invalidate(connection: Connection): Promise<void> { return this.account.invalidate(connection); }
  async verifyConnection(connection: Connection): Promise<void> {
    const current = this.account.getConnection();
    if (current?.serverUrl === connection.serverUrl && current.accessToken === connection.accessToken) { await this.account.verify(); }
  }

  open(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('studio.account', t("SteamHarness Account"), vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    });
    this.panel = panel;
    panel.iconPath = new vscode.ThemeIcon('account');
    panel.webview.html = this.html(panel.webview);
    let busy = false;
    const listeners: vscode.Disposable[] = [];
    listeners.push(panel.onDidDispose(() => {
      this.panel = undefined;
      for (const listener of listeners) { listener.dispose(); }
    }), panel.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== 'object') { return; }
      if (message.type === 'ready') { await panel.webview.postMessage({ type: 'account', state: this.getState() }); return; }
      if (busy) { return; }
      busy = true;
      try {
        if (message.type === 'login' && typeof message.serverUrl === 'string' && typeof message.email === 'string' && typeof message.password === 'string' && message.email.length < 320 && message.password.length <= 4096) {
          await this.account.login(message.serverUrl, message.email, message.password);
          if (this.getState().status === 'authenticated') {
            await vscode.workspace.getConfiguration('studio').update('project.serverUrl', this.getState().serverUrl, vscode.ConfigurationTarget.Global);
          }
        } else if (message.type === 'verify') { await this.account.verify(); }
        else if (message.type === 'logout') { await this.account.logout(); }
      } catch (error) {
        await panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : t("Sign-in failed.") });
      } finally {
        busy = false;
        await panel.webview.postMessage({ type: 'account', state: this.getState() });
      }
    }));
  }

  private html(webview: vscode.Webview): string {
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    return `<!doctype html><html lang="${vscode.env.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: http: data:; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('account-ui.css')}"><title>Workflow</title></head>
      <body><main id="account-app"></main>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('account-ui.js')}"></script></body></html>`;
  }

  dispose(): void {
    void vscode.commands.executeCommand('setContext', 'studio.accountAvailable', false);
    this.panel?.dispose();
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}

export async function activateProjectAccount(context: vscode.ExtensionContext): Promise<AccountController> {
  const account = new AccountController(context);
  context.subscriptions.push(account);
  await account.initialize();
  return account;
}
