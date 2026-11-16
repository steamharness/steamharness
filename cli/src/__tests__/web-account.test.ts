import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebAccountLogin, sharedWebLogin } from '../web/account-auth';
import { readCliAuthConfig } from '../auth-config';
const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const directory of directories.splice(0)) await rm(directory,{recursive:true,force:true}); });
const envelope = (data: object) => new Response(JSON.stringify({errCode:0,data}));
it('keeps the device secret in the host and saves the verified nullable-email identity',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sh-auth-'));directories.push(dir);vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR',dir);
 const fetcher=vi.fn().mockResolvedValueOnce(envelope({deviceCode:'host-secret',userCode:'ABCD-1234',verificationUriComplete:'https://server.test/login/device?user_code=ABCD-1234',expiresAt:new Date(Date.now()+60000).toISOString(),intervalSeconds:1}))
 .mockResolvedValueOnce(envelope({accessToken:'token',apiKey:{id:'key'},user:{userId:'user',email:null,displayName:'Test'}}));
 vi.stubGlobal('fetch',fetcher);
 const login=new WebAccountLogin(); const done=new Promise<void>(resolve=>login.subscribe(()=>{if(!login.busy)resolve();}));
 await login.start('https://server.test','http://127.0.0.1:8123/entries/test/');
 expect(JSON.stringify(login.info)).not.toContain('host-secret');
 const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body.context).toMatchObject({clientKind:'cli-web',returnUrl:'http://127.0.0.1:8123/entries/test/'});
 await done;expect(await readCliAuthConfig()).toMatchObject({apiKey:'token',user:{email:null},source:'device_flow'});
});
it('shares one authorization lifecycle across aggregate entries and cancels without persisting',async()=>{
 const owner={};expect(sharedWebLogin(owner)).toBe(sharedWebLogin(owner));
 const fetcher=vi.fn().mockResolvedValueOnce(envelope({deviceCode:'secret',userCode:'ABCD-1234',verificationUriComplete:'https://server.test/login/device?user_code=ABCD-1234',expiresAt:new Date(Date.now()+60000).toISOString(),intervalSeconds:1}))
 .mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('cancelled'))))).mockResolvedValue(envelope({cancelled:true}));vi.stubGlobal('fetch',fetcher);
 const login=sharedWebLogin(owner);await login.start('https://server.test');login.cancel();expect(login.info).toBeUndefined();expect(login.busy).toBe(false);
 await vi.waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/device/cancel'))).toBe(true));
});

it('can retry browser sign-in after rejecting an invalid server address', async () => {
 const fetcher = vi.fn()
  .mockResolvedValueOnce(envelope({deviceCode:'secret',userCode:'ABCD-1234',verificationUriComplete:'https://server.test/login/device?user_code=ABCD-1234',expiresAt:new Date(Date.now()+60000).toISOString(),intervalSeconds:1}))
  .mockImplementationOnce((_url,options) => new Promise((_resolve,reject) => options.signal.addEventListener('abort',() => reject(new Error('cancelled')))))
  .mockResolvedValue(envelope({cancelled:true}));
 vi.stubGlobal('fetch',fetcher);
 const login = new WebAccountLogin();
 await expect(login.start('ftp://server.test')).rejects.toThrow('Invalid server address.');
 expect(login.busy).toBe(false);
 expect(fetcher).not.toHaveBeenCalled();
 try {
  await login.start('https://server.test');
  expect(login.info?.userCode).toBe('ABCD-1234');
 } finally { login.cancel(); }
 await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/device/cancel'))).toBe(true));
});
