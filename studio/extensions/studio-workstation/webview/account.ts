import { t, locale } from './localization';
import './account.css';
import type { WorkflowAccountState } from '../src/workflow-auth-client';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const app = document.querySelector<HTMLElement>('#account-app')!;
const vscode = acquireVsCodeApi();
const icon = (name: string): string => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
app.innerHTML = `
  <header><span class="brand-icon">${icon('account')}</span><h1>${t("SteamHarness Account")}</h1></header>
  <div id="account-status" role="status"></div>
  <form id="login-form"><label for="server-url">${t("Server")}</label><input id="server-url" type="url" required spellcheck="false" autocomplete="url">
    <label for="login-email">${t("Email")}</label><input id="login-email" type="email" required autocomplete="username">
    <label for="login-password">${t("Password")}</label><div class="password-input"><input id="login-password" type="password" required autocomplete="current-password"><button id="show-password" type="button" class="icon-button" title="${t("Show password")}" aria-label="${t("Show password")}">${icon('eye')}</button></div>
    <button id="login-submit" type="submit" class="primary">${icon('sign-in')}<span>${t("Sign in")}</span></button>
  </form>
  <section id="profile" hidden><div class="identity"><div id="avatar" class="avatar">${icon('account')}<img id="avatar-image" alt="" hidden></div><div><h2 id="display-name"></h2><div id="user-email" class="muted"></div></div></div>
    <dl><dt>${t("Server")}</dt><dd id="profile-server"></dd><dt>${t("Validity")}</dt><dd id="profile-expiry"></dd></dl>
    <div class="actions"><button id="verify-login" class="secondary">${icon('verified')}<span>${t("Verify sign-in")}</span></button><button id="logout" class="secondary">${icon('sign-out')}<span>${t("Sign out")}</span></button></div>
  </section>
  <div id="account-error" role="alert" hidden></div>`;

const form = document.querySelector<HTMLFormElement>('#login-form')!;
const server = document.querySelector<HTMLInputElement>('#server-url')!;
const email = document.querySelector<HTMLInputElement>('#login-email')!;
const password = document.querySelector<HTMLInputElement>('#login-password')!;
const error = document.querySelector<HTMLDivElement>('#account-error')!;
const status = document.querySelector<HTMLDivElement>('#account-status')!;
const image = document.querySelector<HTMLImageElement>('#avatar-image')!;
let state: WorkflowAccountState | undefined;
let pending = false;

function render(next: WorkflowAccountState): void {
  state = next;
  pending = next.status === 'checking';
  const signedIn = !!next.user && ['authenticated', 'checking', 'error'].includes(next.status);
  form.hidden = signedIn;
  document.querySelector<HTMLElement>('#profile')!.hidden = !signedIn;
  if (document.activeElement !== server) { server.value = next.serverUrl; }
  document.querySelectorAll<HTMLButtonElement>('#login-submit, #verify-login, #logout').forEach((button) => { button.disabled = pending; });
  for (const input of [server, email, password]) { input.disabled = pending; }
  document.querySelector('#login-submit > span:last-child')!.textContent = pending ? t("Signing in...") : t("Sign in");
  status.textContent = next.status === 'authenticated' ? t("Signed in; account verified") : next.status === 'checking' ? t("Verifying account...") : next.status === 'expired' ? t("Sign-in expired") : next.status === 'error' && next.user ? t("Connection not verified") : t("Signed out");
  status.classList.toggle('connected', next.status === 'authenticated');
  error.textContent = next.error ?? '';
  error.hidden = !next.error;
  if (next.user) {
    document.querySelector('#display-name')!.textContent = next.user.displayName || next.user.email;
    document.querySelector('#user-email')!.textContent = next.user.email;
    document.querySelector('#profile-server')!.textContent = next.serverUrl;
    document.querySelector('#profile-expiry')!.textContent = next.expiresAt ? new Date(next.expiresAt).toLocaleString(locale()) : t("Managed by server");
    if (next.user.avatarUrl && image.getAttribute('src') !== next.user.avatarUrl) { image.src = next.user.avatarUrl; image.hidden = false; }
    else if (!next.user.avatarUrl) { image.removeAttribute('src'); image.hidden = true; }
  } else { image.removeAttribute('src'); image.hidden = true; }
}

image.addEventListener('error', () => { image.hidden = true; });
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (pending || !form.reportValidity()) { return; }
  const credentials = { type: 'login', serverUrl: server.value, email: email.value, password: password.value };
  password.value = '';
  error.hidden = true;
  pending = true;
  document.querySelector<HTMLButtonElement>('#login-submit')!.disabled = true;
  vscode.postMessage(credentials);
});
document.querySelector('#show-password')!.addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  button.innerHTML = icon(visible ? 'eye-closed' : 'eye');
  button.title = visible ? t("Hide password") : t("Show password");
  button.setAttribute('aria-label', button.title);
});
document.querySelector('#verify-login')!.addEventListener('click', () => { if (!pending) { vscode.postMessage({ type: 'verify' }); } });
document.querySelector('#logout')!.addEventListener('click', () => { if (!pending) { vscode.postMessage({ type: 'logout' }); } });
window.addEventListener('message', (event) => {
  if (event.data.type === 'account') { render(event.data.state); }
  else if (event.data.type === 'error') {
    pending = false;
    if (state) { render(state); }
    error.textContent = event.data.message; error.hidden = false;
  }
});
vscode.postMessage({ type: 'ready' });
