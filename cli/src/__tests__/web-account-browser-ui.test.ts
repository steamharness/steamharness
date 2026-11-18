// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { AccountPanel } from '../web/ui/account';
import { rememberSignInReturn, restoreSignInReturn } from '../web/ui/account-return';
import type { AccountState, BrowserSignIn } from '../web/workflow-auth-client';

const signedOut: AccountState = { status: 'signed-out', serverUrl: 'http://localhost:7126', revision: 1 };
const localSignInUrl = 'http://127.0.0.1:7126/login/device?user_code=ABCD-1234';
const signIn = (url: string): BrowserSignIn => ({ url, userCode: 'ABCD-1234', state: 's'.repeat(43), expiresAt: '2099-01-01' });
beforeEach(() => {
  initI18n({ preference: 'en' });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

function fixture(serverUrl = signedOut.serverUrl) {
  const request = vi.fn<ConstructorParameters<typeof AccountPanel>[1]>().mockResolvedValue(undefined);
  const navigate = vi.fn();
  const menu = document.createElement('div'); document.body.append(menu);
  const panel = new AccountPanel(menu, request, undefined, navigate);
  panel.update({ ...signedOut, serverUrl }); panel.open();
  const dialog = document.querySelector<HTMLDialogElement>('#account-dialog')!;
  return { panel, request, navigate, dialog, button: dialog.querySelector<HTMLButtonElement>('#login-submit')!, cancel: dialog.querySelector<HTMLButtonElement>('#login-cancel')! };
}

it.each([
  { language: 'zh-CN', serverUrl: signedOut.serverUrl, url: localSignInUrl, label: '浏览器登录' },
  { language: 'en', serverUrl: 'https://configured.example.test/steam/', url: 'https://configured.example.test/steam/login/device?user_code=ABCD-1234', label: 'Browser sign-in' },
] as const)('opens the current tab on the configured server with one click ($language)', async ({ language, serverUrl, url, label }) => {
  initI18n({ preference: language });
  const f = fixture(serverUrl);
  const original = '/entries/bot/?projectView=bot&conversationId=other&filter=two%20words#transcript';
  history.replaceState(null, '', original);
  f.request.mockResolvedValueOnce(signIn(url));
  expect(f.dialog.querySelector('input')).toBeNull();
  expect(f.dialog.querySelector('[target="_blank"]')).toBeNull();
  expect(f.button.textContent).toBe(label);
  f.button.click(); f.button.click();
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'login', serverUrl, returnTicket: expect.any(String) });
  expect(f.cancel.hidden).toBe(false);
  f.panel.update({ ...signedOut, serverUrl: 'https://previous.example.test', status: 'checking', signInPending: true });
  await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledExactlyOnceWith(url));
  expect(window.open).not.toHaveBeenCalled();
  expect(f.dialog.open).toBe(false);

  const login = f.request.mock.calls[0][0];
  if (login.type !== 'login') throw new Error('Expected login');
  const callback = `/entries/bot/?auth_state=${signIn(url).state}`;
  history.replaceState(null, '', callback);
  expect(restoreSignInReturn()).toBe(login.returnTicket);
  expect(location.href).toBe(location.origin + original);
  history.replaceState(null, '', callback);
  expect(restoreSignInReturn()).toBeUndefined();
  expect(location.href).toBe(location.origin + '/entries/bot/');
});

it('does not navigate in response to another tab starting sign-in', () => {
  const f = fixture();
  f.panel.update({ ...signedOut, status: 'checking', signInPending: true });
  f.button.click();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
  expect(window.open).not.toHaveBeenCalled();
});

it('only restores the initiating entry and matching callback', () => {
  history.replaceState(null, '', '/entries/bot/?projectView=original');
  rememberSignInReturn('expected', crypto.randomUUID());
  history.replaceState(null, '', '/entries/bot/?auth_state=unrelated');
  expect(restoreSignInReturn()).toBeUndefined();
  expect(location.pathname).toBe('/entries/bot/');
  history.replaceState(null, '', '/entries/workflow/?auth_state=expected');
  expect(restoreSignInReturn()).toBeUndefined();
  expect(location.pathname).toBe('/entries/workflow/');
});

it.each(['https://evil.example.test/login/device', 'http://user:secret@127.0.0.1:7126/login/device', 'javascript:alert(1)', 'http://127.0.0.1:7126/other'])('rejects an unrelated or unsafe sign-in link (%#)', async url => {
  const f = fixture(); f.request.mockResolvedValueOnce(signIn(url)); f.button.click();
  await vi.waitFor(() => expect(document.querySelector('#account-error')!.textContent).toBe('Invalid sign-in link.'));
  expect(f.navigate).not.toHaveBeenCalled();
  expect(window.open).not.toHaveBeenCalled();
});

it('keeps the dialog open and re-enables sign-in after a failed start', async () => {
  const f = fixture(); f.request.mockRejectedValueOnce(new Error('Start unavailable')); f.button.click();
  await vi.waitFor(() => expect(document.querySelector('#account-error')!.textContent).toBe('Start unavailable'));
  expect(f.navigate).not.toHaveBeenCalled();
  expect(f.dialog.open).toBe(true);
  expect(f.button.disabled).toBe(false);
  expect(f.cancel.hidden).toBe(true);
});

it('ignores a late sign-in reply after cancellation and starting again', async () => {
  const f = fixture(); let resolve!: (value: BrowserSignIn) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.button.click(); f.cancel.click();
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  expect(f.request).toHaveBeenCalledWith({ type: 'cancel-login' });
  f.request.mockImplementationOnce(() => new Promise(() => {})); f.button.click();
  resolve(signIn(localSignInUrl));
  await Promise.resolve(); await Promise.resolve();
  expect(f.navigate).not.toHaveBeenCalled();
  expect(f.button.disabled).toBe(true);
});
