// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { AccountPanel } from '../web/ui/account';
import type { AccountState } from '../web/workflow-auth-client';
const signedOut: AccountState = {status:'signed-out',serverUrl:'http://localhost:7126',revision:1};
const localSignInUrl = 'http://127.0.0.1:7126/login/device?user_code=ABCD-1234';
const signIn = (url: string) => ({url,userCode:'ABCD-1234',state:'s'.repeat(43),expiresAt:'2099-01-01'});
beforeEach(() => {
  initI18n({preference:'en'});
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(this:HTMLDialogElement){ this.open=true; }});
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(this:HTMLDialogElement){ this.open=false; this.dispatchEvent(new Event('close')); }});
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
function fixture(serverUrl = signedOut.serverUrl) {
  const browser = {opener:{},closed:false,close:vi.fn(),location:{replace:vi.fn()}};
  vi.spyOn(window,'open').mockReturnValue(browser as unknown as Window);
  const request = vi.fn(async (_action: any) => {});
  const menu = document.createElement('div'); document.body.append(menu);
  const panel = new AccountPanel(menu,request); panel.update({...signedOut,serverUrl}); panel.open();
  const dialog = document.querySelector<HTMLDialogElement>('#account-dialog')!;
  const button = dialog.querySelector<HTMLButtonElement>('#login-submit')!;
  const link = dialog.querySelector<HTMLAnchorElement>('#browser-login-link')!;
  return {panel,request,dialog,button,link,browser};
}
it.each([
  {language:'zh-CN',serverUrl:signedOut.serverUrl,url:localSignInUrl,label:'浏览器登录'},
  {language:'en',serverUrl:'https://configured.example.test/steam/',url:'https://configured.example.test/steam/login/device?user_code=ABCD-1234',label:'Browser sign-in'},
] as const)('opens browser sign-in on the active server with one click ($language)', ({language,serverUrl,url,label}) => {
  initI18n({preference:language});
  const f=fixture(serverUrl);
  expect(f.dialog.querySelector('input')).toBeNull();
  expect(f.button.textContent).toBe(label);
  f.button.click(); f.button.click();
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledWith({type:'login',serverUrl});
  expect(window.open).toHaveBeenCalledOnce();
  expect(f.browser.opener).toBeNull();
  expect(document.querySelector<HTMLElement>('#login-cancel')!.hidden).toBe(false);
  f.panel.update({...signedOut,serverUrl:'https://previous.example.test',status:'checking',signIn:signIn(url)});
  expect(f.browser.location.replace).toHaveBeenCalledWith(url);
});
it('shows the sign-in link if the browser blocks the new tab', () => {
  const f=fixture();
  vi.mocked(window.open).mockReturnValue(null);
  f.button.click();
  f.panel.update({...signedOut,status:'checking',signIn:signIn(localSignInUrl)});
  expect(f.link.hidden).toBe(false);
  expect(f.link.href).toBe(localSignInUrl);
});
it.each(['https://evil.example.test/login/device','http://user:secret@127.0.0.1:7126/login/device','javascript:alert(1)','http://127.0.0.1:7126/other'])('rejects an unrelated or unsafe fallback link (%#)', url => {
  const f=fixture(); f.button.click();
  f.panel.update({...signedOut,status:'checking',signIn:signIn(url)});
  expect(f.link.hidden).toBe(true);
  expect(f.browser.location.replace).not.toHaveBeenCalled();
});
it('closes the blank tab and re-enables the sign-in button after a failed start', async () => {
  const f=fixture(); f.request.mockRejectedValueOnce(new Error('Start unavailable')); f.button.click();
  await vi.waitFor(() => expect(document.querySelector('#account-error')!.textContent).toBe('Start unavailable'));
  expect(f.browser.close).toHaveBeenCalledOnce();
  expect(f.button.disabled).toBe(false);
  expect(document.querySelector<HTMLElement>('#login-cancel')!.hidden).toBe(true);
});
it('ignores a late login error after cancellation and starting another login', async () => {
  const f=fixture(); let reject!: (error:Error) => void;
  f.request.mockImplementationOnce(() => new Promise((_resolve,done) => {reject=done;}));
  f.button.click(); document.querySelector<HTMLButtonElement>('#login-cancel')!.click();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith({type:'cancel-login'}));
  f.panel.update(signedOut);
  const second={opener:{},closed:false,close:vi.fn(),location:{replace:vi.fn()}};
  vi.mocked(window.open).mockReturnValue(second as unknown as Window);
  f.request.mockImplementationOnce(() => new Promise(() => {})); f.button.click();
  reject(new Error('Stale login failed'));
  await Promise.resolve(); await Promise.resolve();
  expect(second.close).not.toHaveBeenCalled();
  expect(document.querySelector('#account-error')!.textContent).toBe('');
  expect(f.button.disabled).toBe(true);
  f.panel.update({...signedOut,status:'error',error:'Current attempt failed'});
  expect(second.close).toHaveBeenCalledOnce();
  expect(f.button.disabled).toBe(false);
});
