import { t } from './localization';
import type { AccountState } from '../src/workflow-auth-client';
import { installContextMenu } from './context-menu';
import './login.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(state: Record<string, never>): void };

const host = acquireVsCodeApi();
// Restoring this tab must never restore credentials or form drafts.
host.setState({});
const app = document.querySelector<HTMLElement>('#login-app')!;
const icon = (name: string): string => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
app.innerHTML = `
  <div class="login-shell">
    <header class="login-header"><div class="login-mark">${icon('terminal')}</div><p class="muted">SteamHarness Studio</p>
      <h1>${t('Sign in to SteamHarness')}</h1><p class="muted">${t('Connect your account to access projects and services.')}</p></header>
    <section class="login-card" aria-label="${t('Sign In')}">
      <form id="login-form">
        <label for="server-url">${t('Server')}</label><input id="server-url" type="url" required spellcheck="false" autocomplete="url">
        <label for="login-email">${t('Email')}</label><input id="login-email" type="email" required autocomplete="username" maxlength="319">
        <label for="login-password">${t('Password')}</label><div class="password-input"><input id="login-password" type="password" required autocomplete="current-password" maxlength="4096"><button id="show-password" type="button" class="icon-button" title="${t('Show password')}" aria-label="${t('Show password')}">${icon('eye')}</button></div>
        <p id="login-error" role="alert" hidden></p><p id="login-status" class="muted" role="status" aria-live="polite"></p>
        <button id="login-submit" type="submit" class="primary">${icon('sign-in')}<span>${t('Sign In')}</span></button>
      </form>
      <div id="login-success" hidden><span class="codicon codicon-pass" aria-hidden="true"></span><h2>${t('Signed in; account verified')}</h2><p id="login-account" class="muted"></p><button id="open-account" type="button" class="primary">${t('View account')}</button></div>
    </section>
    <p class="login-footer muted">${t('Your sign-in is shared across Studio projects.')}</p>
  </div>`;

const form = document.querySelector<HTMLFormElement>('#login-form')!;
const server = document.querySelector<HTMLInputElement>('#server-url')!;
const email = document.querySelector<HTMLInputElement>('#login-email')!;
const password = document.querySelector<HTMLInputElement>('#login-password')!;
const visibility = document.querySelector<HTMLButtonElement>('#show-password')!;
const submit = document.querySelector<HTMLButtonElement>('#login-submit')!;
const error = document.querySelector<HTMLElement>('#login-error')!;
const status = document.querySelector<HTMLElement>('#login-status')!;
let pending = false;
let previousServer: string | undefined;

function hidePassword(): void {
  password.type = 'password';
  visibility.innerHTML = icon('eye');
  visibility.title = t('Show password');
  visibility.setAttribute('aria-label', visibility.title);
  visibility.setAttribute('aria-pressed', 'false');
}

function setPending(value: boolean): void {
  pending = value;
  form.setAttribute('aria-busy', String(value));
  for (const input of [server, email, password, submit, visibility]) { input.disabled = value; }
  submit.querySelector('span:last-child')!.textContent = value ? t('Signing in...') : t('Sign In');
  status.textContent = value ? t('Signing in...') : '';
}

function render(state: AccountState, busy = false, failure?: string): void {
  if (previousServer === undefined || previousServer !== state.serverUrl) {
    if (previousServer !== undefined) { email.value = ''; password.value = ''; hidePassword(); }
    server.value = state.serverUrl;
    previousServer = state.serverUrl;
  }
  const signedIn = state.status === 'authenticated';
  if (signedIn) { password.value = ''; hidePassword(); }
  form.hidden = signedIn;
  document.querySelector<HTMLElement>('#login-success')!.hidden = !signedIn;
  document.querySelector('#login-account')!.textContent = signedIn ? state.user?.email ?? '' : '';
  setPending(busy || state.status === 'checking');
  error.textContent = failure ?? state.error ?? '';
  error.hidden = !error.textContent;
  if (state.status === 'expired' && !error.textContent) {
    error.textContent = t('Sign-in expired. Sign in again.'); error.hidden = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (pending || !form.reportValidity()) { return; }
  const message = { type: 'login', serverUrl: server.value, email: email.value, password: password.value };
  password.value = ''; hidePassword();
  error.textContent = ''; error.hidden = true;
  setPending(true);
  host.postMessage(message);
});
visibility.addEventListener('click', () => {
  if (password.type === 'text') { hidePassword(); return; }
  password.type = 'text'; visibility.innerHTML = icon('eye-closed');
  visibility.title = t('Hide password'); visibility.setAttribute('aria-label', visibility.title); visibility.setAttribute('aria-pressed', 'true');
});
document.querySelector('#open-account')!.addEventListener('click', () => host.postMessage({ type: 'open-account' }));
document.addEventListener('visibilitychange', () => { if (document.hidden) { password.value = ''; hidePassword(); } });
window.addEventListener('pagehide', () => { password.value = ''; });
window.addEventListener('message', event => {
  if (event.data.type === 'account' || event.data.type === 'login-result') {
    render(event.data.state, event.data.busy === true, event.data.message);
  }
});
installContextMenu(host, () => []);
hidePassword();
host.postMessage({ type: 'ready' });
