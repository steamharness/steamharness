import { t, locale } from '../localization';
import type { AccountState } from '../workflow-auth-client';
import { iconHtml } from './ui';
import { updateUserAvatar } from './avatar';
import { normalizeAuthServer } from '@steamharness/server-auth';
import './account.css';

type AccountAction = { type: 'login'; serverUrl: string } | { type: 'verify' | 'logout' | 'cancel-login' };

export class AccountPanel {
  private readonly button = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private state?: AccountState;
  private pending = false;
  private actionEpoch = 0;
  private browserWindow?: Window | null;
  private loginServerUrl?: string;
  private returnFocus?: HTMLElement;

  constructor(menu: HTMLElement, private readonly request: (action: AccountAction) => Promise<void>, private readonly openHostAccount?: () => void) {
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
        <form id="login-form">
          <label for="server-url">${t("Server")}</label><input id="server-url" type="url" required spellcheck="false" autocomplete="url">
          <p>${t("Continue in your browser to sign in, register or recover your account.")}</p>
          <a id="browser-login-link" target="_blank" rel="noopener noreferrer" hidden>${t("Open sign-in page")}</a>
          <div class="account-actions"><button id="login-submit" type="submit" class="account-primary">${iconHtml('link-external')}<span>${t("Browser sign-in")}</span></button><button id="login-cancel" type="button" hidden>${t("Cancel sign-in")}</button></div>
        </form>
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
    this.element<HTMLFormElement>('#login-form').addEventListener('submit', event => {
      event.preventDefault();
      if (this.pending || !this.element<HTMLFormElement>('#login-form').reportValidity()) { return; }
      this.loginServerUrl = this.element<HTMLInputElement>('#server-url').value;
      this.browserWindow = window.open('about:blank', '_blank');
      if (this.browserWindow) this.browserWindow.opener = null;
      void this.perform({ type: 'login', serverUrl: this.element<HTMLInputElement>('#server-url').value });
    });
    this.element<HTMLButtonElement>('#login-cancel').addEventListener('click', () => void this.perform({type:'cancel-login'}));
    this.element<HTMLButtonElement>('#verify-login').addEventListener('click', () => { if (!this.pending) { void this.perform({ type: 'verify' }); } });
    this.element<HTMLButtonElement>('#account-logout').addEventListener('click', () => { if (!this.pending) { void this.perform({ type: 'logout' }); } });
  }

  private element<T extends HTMLElement>(selector: string): T { return this.dialog.querySelector<T>(selector)!; }

  open(): void {
    if (this.openHostAccount) { this.openHostAccount(); return; }
    if (!this.dialog.open && document.activeElement && document.activeElement instanceof HTMLElement) { this.returnFocus = document.activeElement; }
    this.render();
    if (!this.dialog.open) { this.dialog.showModal(); }
  }

  update(state: AccountState): void {
    this.state = state;
    this.button.hidden = false;
    this.pending = state.status === 'checking';
    if (!this.pending && !state.signIn) { this.browserWindow?.close(); this.browserWindow = undefined; this.loginServerUrl = undefined; }
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
    const signingIn = !!state.signIn || !!this.loginServerUrl;
    this.element<HTMLFormElement>('#login-form').hidden = signedIn && !signingIn;
    this.element<HTMLElement>('#account-profile').hidden = !signedIn;
    const server = this.element<HTMLInputElement>('#server-url');
    if (!server.value || signedIn && !signingIn && document.activeElement !== server) { server.value = state.serverUrl; }
    this.dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, #login-submit, #browser-login, #verify-login, #account-logout').forEach(element => { element.disabled = this.pending; });
    this.element('#login-submit > span:last-child').textContent = this.pending ? t("Waiting for browser sign-in...") : t("Browser sign-in");
    this.element<HTMLButtonElement>('#login-cancel').hidden = !signingIn;
    const link = this.element<HTMLAnchorElement>('#browser-login-link'); link.hidden = true;
    if (state.signIn) { try {
      const url = new URL(state.signIn.url);
      const target = new URL(normalizeAuthServer(this.loginServerUrl || server.value));
      if (url.origin === target.origin && url.pathname === target.pathname.replace(/\/$/, '') + '/login/device' && !url.username && !url.password) {
        link.href = url.href; link.hidden = false;
        if (this.browserWindow && !this.browserWindow.closed) { this.browserWindow.location.replace(url.href); this.browserWindow = undefined; }
      }
    } catch {} }
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
    if (action.type === 'cancel-login') { this.browserWindow?.close(); this.browserWindow = undefined; this.loginServerUrl = undefined; }
    this.pending = true; this.render(); this.showError();
    try { await this.request(action); if (epoch !== this.actionEpoch) return; if (action.type === 'login' || action.type === 'cancel-login') { this.pending = this.state?.status === 'checking'; this.render(); } }
    catch (error) { if (epoch !== this.actionEpoch) return; this.browserWindow?.close(); this.browserWindow = undefined; this.loginServerUrl = undefined; this.pending = false; this.render(); this.showError((error as Error).message); }
  }
}
