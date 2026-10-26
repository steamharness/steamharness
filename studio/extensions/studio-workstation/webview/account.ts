import { t, locale } from './localization';
import './account.css';
import { createSettingsView } from './settings';
import type { AccountState } from '../src/workflow-auth-client';
import { installContextMenu, type ContextAction } from './context-menu';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState?(): import('../src/settings-types').SettingsViewState | undefined; setState?(state: import('../src/settings-types').SettingsViewState): void };

const vscode = acquireVsCodeApi();
const settings = createSettingsView(document.querySelector<HTMLElement>('#account-app')!, vscode);
const app = settings.accountRoot;
const icon = (name: string): string => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
const copyButton = (field: string, label: string): string => `<button type="button" class="icon-button copy-button" data-copy="${field}" title="${label}" aria-label="${label}">${icon('copy')}</button>`;
app.innerHTML = `
  <header class="page-header"><p class="muted">${t('Manage your account and Server connection.')}</p><button id="verify-login" class="icon-button" title="${t("Refresh account")}" aria-label="${t("Refresh account")}" hidden>${icon('refresh')}</button></header>
  <div id="account-status" role="status"></div>
  <section id="account-sign-in" class="settings-card account-sign-in">
    <span class="codicon codicon-account" aria-hidden="true"></span><h2>${t('Sign in to SteamHarness')}</h2>
    <p class="muted">${t('Connect your account to access projects and services.')}</p>
    <p id="account-server" class="mono"></p>
    <button id="open-login" type="button" class="primary">${icon('sign-in')}<span>${t('Sign In')}</span></button>
  </section>
  <section id="profile" hidden>
    <div class="identity"><div class="avatar">${icon('account')}<img id="avatar-image" alt="" hidden></div><div class="identity-text"><h2 id="display-name"></h2><div class="inline-value"><span id="user-email" class="muted"></span>${copyButton('email', t("Copy email"))}</div><div class="inline-value user-id"><span class="muted">${t("User ID")}</span><span id="user-id" class="mono"></span>${copyButton('userId', t("Copy user ID"))}</div></div>
      <button id="edit-profile" class="secondary">${icon('edit')}<span>${t("Edit profile")}</span></button>
    </div>
    <div class="account-details">
      <section><h3>${icon('remote')}${t("Connection")}</h3><dl><dt>${t("Server")}</dt><dd class="inline-value"><span id="profile-server" class="mono"></span>${copyButton('serverUrl', t("Copy server address"))}</dd><dt>${t("Transport")}</dt><dd id="profile-transport"></dd></dl></section>
      <section><h3>${icon('shield')}${t("Session")}</h3><dl><dt>${t("Validity")}</dt><dd><span id="profile-expiry"></span><div id="profile-remaining" class="muted"></div></dd></dl><button id="manage-sessions" class="text-button">${icon('link-external')}<span>${t("Manage sessions")}</span></button></section>
    </div>
    <div class="account-actions"><button id="logout" class="text-button">${icon('sign-out')}<span>${t("Sign out")}</span></button><span id="copy-status" class="muted" role="status"></span></div>
  </section>
  <div id="account-error" role="alert" hidden></div>`;

const signIn = document.querySelector<HTMLElement>('#account-sign-in')!;
const openLogin = document.querySelector<HTMLButtonElement>('#open-login')!;
const error = document.querySelector<HTMLDivElement>('#account-error')!;
const status = document.querySelector<HTMLDivElement>('#account-status')!;
const image = document.querySelector<HTMLImageElement>('#avatar-image')!;
const verify = document.querySelector<HTMLButtonElement>('#verify-login')!;
let state: AccountState | undefined;
let pending = false;
let copyTimer: ReturnType<typeof setTimeout> | undefined;
installContextMenu(vscode, target => {
  if (!target.closest('#settings-account')) { return []; }
  const actions: ContextAction[] = [];
  const copy = target.closest('.inline-value')?.querySelector<HTMLButtonElement>('[data-copy]');
  if (copy && !copy.disabled) { actions.push({ id: 'copy', run: () => copy.click() }); }
  if (state?.user && !pending) {
    actions.push({ id: 'editProfile', run: () => vscode.postMessage({ type: 'open-profile' }) },
      { id: 'manageSessions', run: () => vscode.postMessage({ type: 'open-sessions' }) },
      { id: 'refresh', run: () => verify.click() }, { id: 'signOut', run: () => vscode.postMessage({ type: 'logout' }) });
  }
  return actions;
}, () => JSON.stringify([state?.status, state?.user?.userId, state?.serverUrl, pending]));

function render(next: AccountState): void {
  state = next;
  settings.setAccount(next);
  pending = next.status === 'checking';
  const signedIn = !!next.user && ['authenticated', 'checking', 'error'].includes(next.status);
  signIn.hidden = signedIn;
  document.querySelector<HTMLElement>('#profile')!.hidden = !signedIn;
  verify.hidden = !signedIn;
  document.querySelector('#account-server')!.textContent = next.serverUrl;
  document.querySelectorAll<HTMLButtonElement>('#open-login, #verify-login, #logout, #edit-profile, #manage-sessions').forEach((button) => { button.disabled = pending; });
  status.textContent = next.status === 'authenticated' ? t("Signed in; account verified") : next.status === 'checking' ? t("Verifying account...") : next.status === 'expired' ? t("Sign-in expired") : next.status === 'error' && next.user ? t("Connection not verified") : t("Signed out");
  status.classList.toggle('connected', next.status === 'authenticated');
  verify.classList.toggle('refreshing', pending);
  error.textContent = next.error ?? '';
  error.hidden = !next.error;
  if (next.user) {
    document.querySelector('#display-name')!.textContent = next.user.displayName || next.user.email;
    document.querySelector('#user-email')!.textContent = next.user.email;
    document.querySelector('#user-id')!.textContent = next.user.userId;
    document.querySelector('#profile-server')!.textContent = next.serverUrl;
    const url = new URL(next.serverUrl);
    document.querySelector('#profile-transport')!.textContent = url.protocol === 'https:' ? t("Encrypted (HTTPS)") : ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? t("Local connection (HTTP)") : t("Unencrypted (HTTP)");
    const expiry = next.expiresAt ? Date.parse(next.expiresAt) : NaN;
    document.querySelector('#profile-expiry')!.textContent = Number.isFinite(expiry) ? new Date(expiry).toLocaleString(locale()) : t("Managed by server");
    const days = Math.ceil((expiry - Date.now()) / 86_400_000);
    document.querySelector('#profile-remaining')!.textContent = !Number.isFinite(expiry) ? '' : days <= 0 ? t("Sign-in expired") : days === 1 ? t("Expires within 24 hours") : t("Expires in {0} days", days);
    if (next.user.avatarUrl && image.getAttribute('src') !== next.user.avatarUrl) { image.src = next.user.avatarUrl; image.hidden = false; }
    else if (!next.user.avatarUrl) { image.removeAttribute('src'); image.hidden = true; }
  } else { image.removeAttribute('src'); image.hidden = true; }
}

image.addEventListener('error', () => { image.hidden = true; });
openLogin.addEventListener('click', () => { if (!pending) { vscode.postMessage({ type: 'open-login' }); } });
for (const [id, type] of [['verify-login', 'verify'], ['logout', 'logout'], ['edit-profile', 'open-profile'], ['manage-sessions', 'open-sessions']]) {
  document.getElementById(id)!.addEventListener('click', () => { if (!pending) { vscode.postMessage({ type }); } });
}
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => {
  button.addEventListener('click', () => { vscode.postMessage({ type: 'copy', field: button.dataset.copy }); });
});
window.addEventListener('message', (event) => {
  if (event.data.type === 'account') { render(event.data.state); }
  else if (event.data.type === 'copied') {
    clearTimeout(copyTimer);
    document.querySelector('#copy-status')!.textContent = t("Copied");
    copyTimer = setTimeout(() => { document.querySelector('#copy-status')!.textContent = ''; }, 2500);
  } else if (event.data.type === 'error') {
    pending = false;
    if (state) { render(state); }
    error.textContent = event.data.message; error.hidden = false;
  }
});
vscode.postMessage({ type: 'ready' });
