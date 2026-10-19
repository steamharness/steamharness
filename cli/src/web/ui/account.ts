import { t, locale } from '../localization';
import type { WorkflowAccountState } from '../workflow-auth-client';
import { iconHtml } from './ui';
import './account.css';

type AccountAction = { type: 'login'; serverUrl: string; email?: string; password?: string } | { type: 'verify' | 'logout' };

export class AccountPanel {
  private readonly button = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private state?: WorkflowAccountState;
  private pending = false;
  private avatarKey = '';

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
          <label for="login-email">${t("Email")}</label><input id="login-email" type="email" required autocomplete="username">
          <label for="login-password">${t("Password")}</label><div class="account-password"><input id="login-password" type="password" required autocomplete="current-password"><button id="show-password" type="button" class="icon-button" title="${t("Show password")}" aria-label="${t("Show password")}">${iconHtml('eye')}</button></div>
          <div class="account-actions"><button id="login-submit" type="submit" class="account-primary">${iconHtml('sign-in')}<span>${t("Sign in")}</span></button><button id="browser-login" type="button" class="account-secondary">${iconHtml('link-external')}<span>${t("Browser sign-in")}</span></button></div>
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
    this.dialog.addEventListener('close', () => { this.element<HTMLInputElement>('#login-password').value = ''; this.button.focus(); });
    this.element<HTMLFormElement>('#login-form').addEventListener('submit', event => {
      event.preventDefault();
      if (this.pending || !this.element<HTMLFormElement>('#login-form').reportValidity()) { return; }
      const password = this.element<HTMLInputElement>('#login-password');
      const action: AccountAction = { type: 'login', serverUrl: this.element<HTMLInputElement>('#server-url').value, email: this.element<HTMLInputElement>('#login-email').value, password: password.value };
      password.value = '';
      void this.perform(action);
    });
    this.element<HTMLButtonElement>('#browser-login').addEventListener('click', () => {
      const server = this.element<HTMLInputElement>('#server-url');
      if (!this.pending && server.reportValidity()) { void this.perform({ type: 'login', serverUrl: server.value }); }
    });
    this.element<HTMLButtonElement>('#show-password').addEventListener('click', event => {
      const password = this.element<HTMLInputElement>('#login-password');
      const visible = password.type === 'password';
      password.type = visible ? 'text' : 'password';
      const button = event.currentTarget as HTMLButtonElement;
      button.innerHTML = iconHtml(visible ? 'eye-closed' : 'eye');
      button.title = button.ariaLabel = visible ? t("Hide password") : t("Show password");
    });
    this.element<HTMLButtonElement>('#verify-login').addEventListener('click', () => { if (!this.pending) { void this.perform({ type: 'verify' }); } });
    this.element<HTMLButtonElement>('#account-logout').addEventListener('click', () => { if (!this.pending) { void this.perform({ type: 'logout' }); } });
  }

  private element<T extends HTMLElement>(selector: string): T { return this.dialog.querySelector<T>(selector)!; }

  open(): void {
    if (this.openHostAccount) { this.openHostAccount(); return; }
    this.render();
    if (!this.dialog.open) { this.dialog.showModal(); }
  }

  update(state: WorkflowAccountState): void {
    this.state = state;
    this.button.hidden = false;
    this.pending = state.status === 'checking';
    this.render();
  }

  private render(): void {
    const state = this.state;
    if (!state) { return; }
    const signedIn = !!state.user && ['authenticated', 'checking', 'error'].includes(state.status);
    const name = signedIn ? state.user!.displayName || state.user!.email || 'Workflow' : this.pending ? t("Signing in...") : t("Sign in to Workflow");
    this.button.querySelector('.web-account-name')!.textContent = name;
    this.button.title = this.button.ariaLabel = state.error || state.user?.email || name;
    const avatarKey = `${state.serverUrl}\n${state.user?.avatarUrl ?? ''}`;
    if (avatarKey !== this.avatarKey) {
      this.avatarKey = avatarKey;
      for (const avatar of [this.button.querySelector<HTMLElement>('.web-avatar')!, this.element<HTMLElement>('.account-avatar')]) {
        avatar.innerHTML = iconHtml('account');
        if (!state.user?.avatarUrl) { continue; }
        let url: URL;
        try { url = new URL(state.user.avatarUrl, `${state.serverUrl}/`); } catch { continue; }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { continue; }
        const image = document.createElement('img');
        image.src = url.toString(); image.alt = ''; image.hidden = true; image.referrerPolicy = 'no-referrer';
        image.addEventListener('load', () => { image.hidden = false; (avatar.firstElementChild as HTMLElement).hidden = true; });
        image.addEventListener('error', () => { image.hidden = true; (avatar.firstElementChild as HTMLElement).hidden = false; });
        avatar.append(image);
      }
    }
    this.element<HTMLFormElement>('#login-form').hidden = signedIn;
    this.element<HTMLElement>('#account-profile').hidden = !signedIn;
    const server = this.element<HTMLInputElement>('#server-url');
    if (!server.value || signedIn && document.activeElement !== server) { server.value = state.serverUrl; }
    this.dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, #login-submit, #browser-login, #verify-login, #account-logout').forEach(element => { element.disabled = this.pending; });
    this.element('#login-submit > span:last-child').textContent = this.pending ? t("Signing in...") : t("Sign in");
    const status = this.element('#account-status');
    status.textContent = state.status === 'authenticated' ? t("Signed in; account verified") : this.pending ? t("Verifying account...") : state.status === 'expired' ? t("Sign-in expired") : state.status === 'error' && state.user ? t("Connection not verified") : t("Signed out");
    status.classList.toggle('connected', state.status === 'authenticated');
    this.showError(state.error);
    if (state.user) {
      this.element('#account-display-name').textContent = state.user.displayName || state.user.email;
      this.element('#account-email').textContent = state.user.email;
      this.element('#account-server').textContent = state.serverUrl;
      this.element('#account-expiry').textContent = state.expiresAt ? new Date(state.expiresAt).toLocaleString(locale()) : t("Managed by server");
    }
  }

  private showError(message?: string): void {
    const error = this.element('#account-error');
    error.textContent = message ?? ''; error.hidden = !message;
  }

  private async perform(action: AccountAction): Promise<void> {
    this.pending = true; this.render(); this.showError();
    try { await this.request(action); }
    catch (error) { this.pending = false; this.render(); this.showError((error as Error).message); }
  }
}
