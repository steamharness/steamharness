import { t } from './localization';
import type { AccountState } from '../src/workflow-auth-client';
import { installContextMenu } from './context-menu';
import './login.css';
declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(state: Record<string, never>): void };
const host = acquireVsCodeApi(); host.setState({});
const app = document.querySelector<HTMLElement>('#login-app')!;
app.innerHTML = `<div class="login-shell"><header class="login-header"><p class="muted">SteamHarness Studio</p><h1>${t('Sign in to SteamHarness')}</h1><p class="muted">${t('Continue in your browser to sign in, register or recover your account.')}</p></header>
<section class="login-card"><form id="login-form"><label for="server-url">${t('Server')}</label><input id="server-url" type="url" required spellcheck="false" autocomplete="url">
<p id="login-error" role="alert" hidden></p><p id="login-status" class="muted" role="status"></p><a id="login-link" hidden target="_blank" rel="noopener noreferrer">${t('Open sign-in page')}</a>
<button id="login-submit" type="submit" class="primary">${t('Browser sign-in')}</button><button id="login-cancel" type="button" hidden>${t('Cancel sign-in')}</button></form>
<div id="login-success" hidden><h2>${t('Signed in; account verified')}</h2><p id="login-account"></p><button id="open-account" type="button">${t('View account')}</button></div></section></div>`;
const form = document.querySelector<HTMLFormElement>('#login-form')!;
const server = document.querySelector<HTMLInputElement>('#server-url')!;
const submit = document.querySelector<HTMLButtonElement>('#login-submit')!;
const cancel = document.querySelector<HTMLButtonElement>('#login-cancel')!;
let pending = false;
let hostServer: string | undefined;
form.addEventListener('submit', event => { event.preventDefault(); if (!pending && form.reportValidity()) { pending = true; submit.disabled = true; host.postMessage({ type: 'login', serverUrl: server.value }); } });
cancel.addEventListener('click', () => host.postMessage({ type: 'cancel-login' }));
document.querySelector('#open-account')!.addEventListener('click', () => host.postMessage({ type: 'open-account' }));
window.addEventListener('message', event => {
  if (!['account','login-result'].includes(event.data.type)) return;
  const state = event.data.state as AccountState;
  const signedIn = state.status === 'authenticated';
  if (hostServer !== state.serverUrl) { server.value = state.serverUrl; hostServer = state.serverUrl; }
  pending = event.data.busy === true;
  server.disabled = submit.disabled = pending;
  cancel.hidden = !pending;
  form.hidden = signedIn;
  document.querySelector<HTMLElement>('#login-success')!.hidden = !signedIn;
  document.querySelector('#login-account')!.textContent = state.user?.displayName || state.user?.email || '';
  document.querySelector('#login-status')!.textContent = pending ? t('Waiting for browser sign-in...') : '';
  const error = document.querySelector<HTMLElement>('#login-error')!;
  error.textContent = event.data.message || state.error || (state.status === 'expired' ? t('Sign-in expired. Sign in again.') : ''); error.hidden = !error.textContent;
  const link = document.querySelector<HTMLAnchorElement>('#login-link')!;
  link.hidden = true;
  if (typeof event.data.loginUrl === 'string') {
    try { const url = new URL(event.data.loginUrl); if (url.origin === new URL(server.value).origin && url.pathname === new URL(server.value).pathname.replace(/\/$/, '') + '/login/device') { link.href = url.href; link.hidden = false; } } catch {}
  }
});
installContextMenu(host, () => []);
host.postMessage({ type: 'ready' });
