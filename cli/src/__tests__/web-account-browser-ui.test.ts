// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { AccountPanel } from '../web/ui/account';
import type { AccountState } from '../web/workflow-auth-client';
const signedOut: AccountState = {status:'signed-out',serverUrl:'https://old.example.test',revision:1};
beforeEach(() => {
  initI18n({preference:'en'});
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(this:HTMLDialogElement){ this.open=true; }});
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(this:HTMLDialogElement){ this.open=false; this.dispatchEvent(new Event('close')); }});
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
function fixture() {
  const browser = {opener:{},closed:false,close:vi.fn(),location:{replace:vi.fn()}};
  vi.spyOn(window,'open').mockReturnValue(browser as unknown as Window);
  const request = vi.fn(async (_action: any) => {});
  const menu = document.createElement('div'); document.body.append(menu);
  const panel = new AccountPanel(menu,request); panel.update(signedOut); panel.open();
  const server = document.querySelector<HTMLInputElement>('#server-url')!;
  const submit = () => document.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  return {panel,request,server,submit,browser};
}
it.each(['en','zh-CN'] as const)('keeps the chosen server and opens its normalized localhost authorization URL (%s)', async language => {
  initI18n({preference:language});
  const f=fixture(); f.server.value='http://localhost:7126'; f.submit(); f.submit();
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.browser.opener).toBeNull();
  expect(document.querySelector<HTMLElement>('#login-cancel')!.hidden).toBe(false);
  f.panel.update({...signedOut,status:'checking',user:{userId:'old',email:null,displayName:'Old account'},signIn:{url:'http://127.0.0.1:7126/login/device?user_code=ABCD-1234',userCode:'ABCD-1234',state:'s'.repeat(43),expiresAt:'2099-01-01'}});
  expect(f.server.value).toBe('http://localhost:7126');
  expect(document.querySelector<HTMLAnchorElement>('#browser-login-link')!.hidden).toBe(false);
  expect(f.browser.location.replace).toHaveBeenCalledWith('http://127.0.0.1:7126/login/device?user_code=ABCD-1234');
});
it.each(['https://evil.example.test/login/device','http://user:secret@127.0.0.1:7126/login/device','javascript:alert(1)','http://127.0.0.1:7126/other'])('rejects an unrelated or unsafe fallback link (%#)', url => {
  const f=fixture(); f.server.value='http://localhost:7126'; f.submit();
  f.panel.update({...signedOut,status:'checking',signIn:{url,userCode:'ABCD-1234',state:'s'.repeat(43),expiresAt:'2099-01-01'}});
  expect(document.querySelector<HTMLAnchorElement>('#browser-login-link')!.hidden).toBe(true);
  expect(f.browser.location.replace).not.toHaveBeenCalled();
});
it('closes the blank tab and restores the form after a failed start', async () => {
  const f=fixture(); f.request.mockRejectedValueOnce(new Error('Start unavailable')); f.submit();
  await vi.waitFor(() => expect(document.querySelector('#account-error')!.textContent).toBe('Start unavailable'));
  expect(f.browser.close).toHaveBeenCalledOnce();
  expect(document.querySelector<HTMLButtonElement>('#login-submit')!.disabled).toBe(false);
  expect(document.querySelector<HTMLElement>('#login-cancel')!.hidden).toBe(true);
});
it('ignores a late login error after cancellation and starting another login', async () => {
  const f=fixture(); let reject!: (error:Error) => void;
  f.request.mockImplementationOnce(() => new Promise((_resolve,done) => {reject=done;}));
  f.submit(); document.querySelector<HTMLButtonElement>('#login-cancel')!.click();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith({type:'cancel-login'}));
  f.panel.update(signedOut);
  const second={opener:{},closed:false,close:vi.fn(),location:{replace:vi.fn()}};
  vi.mocked(window.open).mockReturnValue(second as unknown as Window);
  f.request.mockImplementationOnce(() => new Promise(() => {})); f.submit();
  reject(new Error('Stale login failed'));
  await Promise.resolve(); await Promise.resolve();
  expect(second.close).not.toHaveBeenCalled();
  expect(document.querySelector('#account-error')!.textContent).toBe('');
  expect(document.querySelector<HTMLButtonElement>('#login-submit')!.disabled).toBe(true);
  f.panel.update({...signedOut,status:'error',error:'Current attempt failed'});
  expect(second.close).toHaveBeenCalledOnce();
  expect(document.querySelector<HTMLButtonElement>('#login-submit')!.disabled).toBe(false);
});
