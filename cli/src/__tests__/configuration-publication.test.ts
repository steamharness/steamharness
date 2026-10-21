import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createConfigurationState,createPublicationDraft} from '@steamharness/project-configuration';
import {configurationPublication} from '../configuration-publication';
import {ProjectConfigurations} from '../web/project-configurations';
let root:string;
const connection={serverUrl:'https://configuration.test',accessToken:'account-token'};
const local=()=>createConfigurationState([{name:'token',type:'string',defaultValue:'local-personal-value'}],()=> 'local-profile');
const remote=()=>({...createConfigurationState([],()=> 'server-profile'),revision:8,canManagePublication:true});
beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),'publication-cli-'));await writeFile(path.join(root,'package.json'),JSON.stringify({id:'project'}));});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
const response=(data:unknown)=>new Response(JSON.stringify({errCode:0,data}));
it('reads author capabilities without uploading local personal values or replacing local profile IDs',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(remote()));
 const state=await configurationPublication(root,local(),{action:'get'},connection);
 expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]![1]?.body).toBeUndefined();
 expect(state.configurations[0]!.id).toBe('local-profile');expect(state.publication!.configurations[0]!.id).toBe('local-profile');
 expect(state.canManagePublication).toBe(true);
});
it('rejects stale local drafts before sending a request and requires an online connection',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch');
 await expect(configurationPublication(root,local(),{action:'publication.save',revision:1,publication:createPublicationDraft(local())},connection)).rejects.toMatchObject({code:'CONFIGURATION_CONFLICT'});
 await expect(configurationPublication(root,local(),{action:'publication.save',revision:0},undefined)).rejects.toThrow('online');expect(fetch).not.toHaveBeenCalled();
});
it('sends only an explicit draft and uses the server personal revision without losing the local selection',async()=>{
 const draft=createPublicationDraft(local()),saved={...remote(),publication:{...draft,revision:1,configurationRevision:8}};
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response(remote())).mockResolvedValueOnce(response(saved));
 const result=await configurationPublication(root,local(),{action:'publication.save',revision:0,publication:draft},connection);
 const body=JSON.parse(String(fetch.mock.calls[1]![1]!.body));expect(body.call).toEqual({action:'publication.save',revision:8,publication:draft});expect(body.target).toBe('draft');
 expect(result.activeConfigurationId).toBe('local-profile');expect(result.publication).toEqual(saved.publication);
});
it('keeps verified local values available offline and refuses official writes',async()=>{
 vi.spyOn(globalThis,'fetch').mockRejectedValue(new TypeError('offline'));
 const initial=local(),state=await configurationPublication(root,initial,{action:'get'},connection);
 expect(state.configurations).toEqual(initial.configurations);expect(state.canManagePublication).toBe(false);
 await expect(configurationPublication(root,state,{action:'publication.save',revision:0},connection)).rejects.toThrow('offline');
});
it('retains author controls after personal edits and removes remote drafts immediately when the account changes',async()=>{
 vi.spyOn(os,'homedir').mockReturnValue(path.join(root,'host'));
 await writeFile(path.join(root,'configuration.json'),JSON.stringify({version:1,fields:local().fields}));
 vi.spyOn(globalThis,'fetch').mockResolvedValue(response({...remote(),publication:{...createPublicationDraft(local()),revision:1}}));
 let current:typeof connection|undefined=connection;
 const service=new ProjectConfigurations(root,()=>{},()=>current);
 try {
  await service.initialize();let state=await service.dispatch({action:'get'}) as ReturnType<typeof local>;
  expect(state.canManagePublication).toBe(true);
  state=await service.dispatch({action:'save',id:state.activeConfigurationId,revision:state.revision,values:{token:'personal-change'}}) as ReturnType<typeof local>;
  expect(state.canManagePublication).toBe(true);expect(state.publication?.revision).toBe(1);
  current={...connection,accessToken:'another-account'};
  expect(service.state.canManagePublication).toBe(false);expect(service.state.publication).toBeUndefined();
  expect((await service.refresh()).publication).toBeUndefined();
 } finally {service.close();}
});
it('discards configuration responses from an account that is no longer active',async()=>{
 vi.spyOn(os,'homedir').mockReturnValue(path.join(root,'host'));
 let finish!:(response:Response)=>void;
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 let current:typeof connection|undefined=connection;
 const service=new ProjectConfigurations(root,()=>{},()=>current);
 try {
  await service.initialize();const pending=service.dispatch({action:'get'});
  const rejected=expect(pending).rejects.toMatchObject({code:'CONFIGURATION_ACCOUNT_CHANGED'});
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalled());current=undefined;
  finish(response({...remote(),publication:{...createPublicationDraft(local()),revision:1}}));
  await rejected;
  expect(service.state.publication).toBeUndefined();expect(service.state.canManagePublication).toBe(false);
 } finally {service.close();}
});
