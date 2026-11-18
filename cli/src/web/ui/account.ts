import { t, locale } from '../localization';
import type { AccountState, BrowserSignIn } from '../workflow-auth-client';
import { iconHtml } from './ui';
import { updateUserAvatar } from './avatar';
import { normalizeAuthServer } from '@steamharness/server-auth';
import { rememberSignInReturn } from './account-return';
import './account.css';

type AccountAction = { type: 'login'; serverUrl: string; returnTicket: string } | { type: 'verify' | 'logout' | 'cancel-login' };

export class AccountPanel {
  private readonly button = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private state?: AccountState;
  private action?: AccountAction['type'];
  private actionEpoch = 0;
  private returnFocus?: HTMLElement;

  constructor(menu: HTMLElement, private readonly request: (action: AccountAction) => Promise<BrowserSignIn | void>,
    private readonly openHostAccount?: () => void, private readonly navigate = (url: string) => location.assign(url)) {
    this.button.id = 'web-account';
    this.button.className = 'web-account';
    this.button.type = 'button';
    this.button.hidden = true;
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.setAttribute('aria-controls', 'account-dialog');
    this.button.innerHTML = '<span class="web-avatar"></span><span class="web-account-name"></span>';
    this.button.addEventListener('click', () => this.open());
    menu.append(this.button);
    this.dialog.id = 'account-dialog';
    this.dialog.className = 'conversation-dialog account-dialog';
    this.dialog.setAttribute('aria-labelledby', 'account-title');
    this.dialog.innerHTML = `
      <header><span class="codicon codicon-account" aria-hidden="true"></span><h2 id="account-title">${t("SteamHarness Account")}</h2><button id="close-account" type="button" class="icon-button" title="${t("Close account")}" aria-label="${t("Close account")}">${iconHtml('close')}</button></header>
      <div class="dialog-body account-body">
        <div id="account-status" role="status"></div>
        <div id="account-sign-in" class="account-actions">
          <button id="login-submit" type="button" class="account-primary" disabled>${iconHtml('sign-in')}<span>${t("Browser sign-in")}</span></button>
          <button id="login-cancel" type="button" hidden>${t("Cancel sign-in")}</button>
        </div>
        <section id="account-profile" hidden>
          <div class="account-identity"><span class="account-avatar"></span><div><h3 id="account-display-name"></h3><div id="account-email" class="account-muted"></div></div></div>
          <dl><dt>${t("Server")}</dt><dd id="account-server"></dd><dt>${t("Validity")}</dt><dd id="account-expiry"></dd></dl>
          <div class="account-actions"><button id="verify-login" type="button" class="account-secondary">${iconHtml('verified')}<span>${t("Verify sign-in")}</span></button><button id="account-logout" type="button" class="account-secondary">${iconHtml('sign-out')}<span>${t("Sign out")}</span></button></div>
        </section>
        <div id="account-error" role="alert" hidden></div>
      </div>`;
    document.body.append(this.dialog);
    this.element<HTMLButtonElement>('#close-account').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => { (this.returnFocus?.isConnected ? this.returnFocus : this.button).focus({ preventScroll: true }); });
    this.element<HTMLButtonElement>('#login-submit').addEventListener('click', () => {
      const serverUrl = this.state?.serverUrl;
      if (this.pending || !serverUrl) { return; }
      void this.perform({ type: 'login', serverUrl, returnTicket: crypto.randomUUID() });
    });
    this.element<HTMLButtonElement>('#login-cancel').addEventListener('click', () => { if (this.action !== 'cancel-login') void this.perform({ type: 'cancel-login' }); });
    this.element<HTMLButtonElement>('#verify-login').addEventListener('click', () => { if (!this.pending) { void this.perform({ type: 'verify' }); } });
    this.element<HTMLButtonElement>('#account-logout').addEventListener('click', () => { if (!this.pending) { void this.perform({ type: 'logout' }); } });
  }

  private element<T extends HTMLElement>(selector: string): T { return this.dialog.querySelector<T>(selector)!; }
  private get pending(): boolean { return !!this.action || this.state?.status === 'checking' || !!this.state?.signInPending; }

  open(): void {
    if (this.openHostAccount) { this.openHostAccount(); return; }
    if (!this.dialog.open && document.activeElement && document.activeElement instanceof HTMLElement) { this.returnFocus = document.activeElement; }
    this.render();
    if (!this.dialog.open) { this.dialog.showModal(); }
  }

  update(state: AccountState): void {
    this.state = state;
    this.button.hidden = false;
    this.render();
  }

  private render(): void {
    const state = this.state;
    if (!state) { return; }
    const signedIn = !!state.user && ['authenticated', 'checking', 'error'].includes(state.status);
    const name = signedIn ? state.user!.displayName || state.user!.email || 'SteamHarness' : this.pending ? t("Signing in...") : t("Sign in to SteamHarness");
    this.button.querySelector('.web-account-name')!.textContent = name;
    this.button.title = this.button.ariaLabel = state.error || state.user?.email || name;
    for (const avatar of [this.button.querySelector<HTMLElement>('.web-avatar')!, this.element<HTMLElement>('.account-avatar')]) { updateUserAvatar(avatar, state); }
    const signingIn = !!state.signInPending || this.action === 'login';
    this.element('#account-sign-in').hidden = signedIn && !signingIn;
    this.element<HTMLElement>('#account-profile').hidden = !signedIn;
    this.dialog.querySelectorAll<HTMLButtonElement>('#login-submit, #verify-login, #account-logout').forEach(element => { element.disabled = this.pending; });
    this.element('#login-submit > span:last-child').textContent = this.pending ? t("Waiting for browser sign-in...") : t("Browser sign-in");
    this.element<HTMLButtonElement>('#login-cancel').hidden = !signingIn;
    this.element<HTMLButtonElement>('#login-cancel').disabled = this.action === 'cancel-login';
    const status = this.element('#account-status');
    status.textContent = state.status === 'authenticated' ? t("Signed in; account verified") : this.pending ? t("Verifying account...") : state.status === 'expired' ? t("Sign-in expired") : state.status === 'error' && state.user ? t("Connection not verified") : t("Signed out");
    status.classList.toggle('connected', state.status === 'authenticated');
    this.showError(state.error);
    if (state.user) {
      this.element('#account-display-name').textContent = state.user.displayName || state.user.email || '';
      this.element('#account-email').textContent = state.user.email || '';
      this.element('#account-server').textContent = state.serverUrl;
      this.element('#account-expiry').textContent = state.expiresAt ? new Date(state.expiresAt).toLocaleString(locale()) : t("Managed by server");
    }
  }

  private showError(message?: string): void {
    const error = this.element('#account-error');
    error.textContent = message ?? ''; error.hidden = !message;
  }

  private async perform(action: AccountAction): Promise<void> {
    const epoch = ++this.actionEpoch;
    this.action = action.type; this.render(); this.showError();
    let errorMessage: string | undefined;
    try {
      const signIn = await this.request(action);
      if (epoch !== this.actionEpoch || action.type !== 'login') return;
      if (!signIn) {
        if (this.state?.signInPending) return;
        throw new Error(t('Sign-in failed.'));
      }
      let url: URL;
      try {
        url = new URL(signIn.url);
        const server = new URL(normalizeAuthServer(action.serverUrl));
        if (url.origin !== server.origin || url.pathname !== server.pathname.replace(/\/$/, '') + '/login/device' || url.username || url.password) throw new Error();
      } catch { throw new Error(t('Invalid sign-in link.')); }
      rememberSignInReturn(signIn.state, action.returnTicket);
      this.dialog.close();
      this.navigate(url.href);
    } catch (error) { errorMessage = (error as Error).message; }
    finally {
      if (epoch === this.actionEpoch) {
        this.action = undefined; this.render();
        if (errorMessage) this.showError(errorMessage);
      }
    }
  }
}
