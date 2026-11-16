import { describe, expect, it, vi } from 'vitest';
import { deviceReturnUrl, normalizeAuthServer, parseDeviceContext, ServerAuthClient } from '../index';
const state='A'.repeat(43);
describe('browser authorization context',()=>{
 it.each([['dev','steamharness-studio-dev'],['alpha','steamharness-studio-alpha'],['main','steamharness-studio']])('routes %s to its application', (channel,scheme)=>{
  expect(deviceReturnUrl({clientKind:'studio',channel:channel as 'dev',state})).toBe(`${scheme}://studio.studio-workstation/auth/callback?state=${state}`);
 });
 it('permits only loopback HTTP return addresses and carries no credential',()=>{
  expect(deviceReturnUrl({clientKind:'cli-web',channel:'dev',state,returnUrl:'http://127.0.0.1:8123/entries/bot/'})).toBe(`http://127.0.0.1:8123/entries/bot/?auth_state=${state}`);
  for(const url of ['https://127.0.0.1/','http://example.test/','http://localhost.evil/','http://user:pass@localhost/','http://localhost/?token=x','http://localhost/#token','http://localhost/\\evil']) expect(()=>parseDeviceContext({clientKind:'cli-web',channel:'dev',state,returnUrl:url})).toThrow();
  expect(()=>parseDeviceContext({clientKind:'studio',channel:'dev',state,returnUrl:'http://localhost/'})).toThrow();
  expect(()=>parseDeviceContext({clientKind:'studio',channel:'other',state})).toThrow();
  expect(()=>parseDeviceContext({clientKind:'studio',channel:'main',state:'short'})).toThrow();
 });
 it('normalizes loopback servers and rejects embedded credentials',()=>{
  expect(normalizeAuthServer('http://localhost:7126/')).toBe('http://127.0.0.1:7126');expect(()=>normalizeAuthServer('https://user:pass@server.test')).toThrow();
 });
 it('rejects verification pages on a different origin or a lookalike path',async()=>{
  for(const verificationUriComplete of ['https://attacker.test/login/device','https://server.test/login/device-evil']) {
   const fetcher=vi.fn().mockResolvedValue(Response.json({errCode:0,data:{deviceCode:'secret',verificationUriComplete,intervalSeconds:5,expiresAt:new Date(Date.now()+60000).toISOString()}}));
   await expect(new ServerAuthClient('https://server.test',fetcher).start({clientName:'Test',source:'cli'})).rejects.toThrow('Invalid server response');
  }
 });
 it('aborts a pending authorization without another poll',async()=>{
  const fetcher=vi.fn().mockResolvedValue(Response.json({errCode:409,errMessage:'authorization_pending'}));const abort=new AbortController();
  const poll=new ServerAuthClient('https://server.test',fetcher).poll({deviceCode:'secret',userCode:'ABCD-1234',verificationUri:'',verificationUriComplete:'',intervalSeconds:5,expiresAt:new Date(Date.now()+60000).toISOString()},abort.signal);
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));abort.abort();await expect(poll).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 });
});
