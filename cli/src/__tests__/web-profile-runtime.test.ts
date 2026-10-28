import {expect,it} from 'vitest';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalProjectConfigurationStore} from 'steamharness';
import {createWebRuntime,type WebConnection} from '../web/runtime';
import {resolveHarnessRoot} from './harness-source';

it('enforces verified profiles through the real child worker, including downgrade, logout, and old resumes',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'profile-runtime-')),id=crypto.randomUUID();
  let role='developer';
  const server=createServer((request,response)=>{
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({errCode:0,data:request.url==='/api/auth/me'?{profile:{userId:'alice'}}:{access:{effectiveRole:role}}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  let connection:WebConnection|undefined={serverUrl:origin,accessToken:'fixture-only'};
  const runtime=createWebRuntime(directory,path.join(directory,'data'),()=>connection);
  const root=path.join(os.homedir(),'.steamharness','configurations');
  try{
    await mkdir(path.join(directory,'node_modules'));
    await symlink(await resolveHarnessRoot(),path.join(directory,'node_modules/steamharness'),process.platform==='win32'?'junction':'dir');
    await writeFile(path.join(directory,'package.json'),JSON.stringify({id,name:'restricted-profile',type:'module',version:'1.0.0',steamHarness:{ defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',configuration:'configuration.json',databases:[]}],  }}));
    await writeFile(path.join(directory,'configuration.json'),JSON.stringify({version:2,fields:[{name:'mode',type:'string'}],profilePolicy:{version:1,defaultProfileKey:'ask',manageMinimumRole:'developer',profiles:[{key:'ask',name:'Ask',minimumRole:'guest',fixedValues:{mode:'ask'}},{key:'build',name:'Build',minimumRole:'developer',fixedValues:{mode:'build'}}]}}));
    await writeFile(path.join(directory,'index.ts'),`
      const answer=steamharness.createOutputNode({name:'answer-node',async format(){return steamharness.createOutputPayload({items:[{id:'answer',title:'Mode',content:String(steamharness.getConfig('mode')),contentType:'text'}]});}});
      const workflow=steamharness.defineProject({name:'restricted',async run(input,context){return steamharness.runNode(answer,input,context);}});
      export const executor=steamharness.defineExecutor({projectType:'conversation',workflow,params:[],createInput(){return {};}});
    `);
    const inspected=await runtime.inspect([directory]);expect(inspected.errors).toEqual([]);
    const project={...inspected.projects[0],uri:''};
    const store=await createLocalProjectConfigurationStore(directory,{connection:()=>connection??null});
    const state=await store.read(true),profile=state.configurations!.find(profile=>profile.profileKey==='build')!;
    const selection={id:profile.id,profileKey:'build',subject:JSON.stringify([origin,'alice'])};
    const request={project,conversationId:'session',runId:'build',args:[],configurationSelection:selection};
    const report=await runtime.run(request,()=>{});
    expect(report.status).toBe('success');expect(report.output?.items?.[0].content).toBe('build');
    role='guest';
    await expect(runtime.run({...request,resumeConfiguration:true},()=>{})).rejects.toThrow(/not available/);
    await expect(runtime.run({...request,runId:'forged-build'},()=>{})).rejects.toThrow(/not available/);
    connection=undefined;
    await expect(runtime.run({...request,runId:'logged-out'},()=>{})).rejects.toThrow(/not available/);
    const offline=await runtime.run({project,conversationId:'session',runId:'offline-ask',args:[]},()=>{});
    expect(offline.status).toBe('success');expect(offline.output?.items?.[0].content).toBe('ask');
    await expect(runtime.run({project,conversationId:'session',runId:'pre-policy',args:[],resumeConfiguration:true},()=>{})).rejects.toThrow(/no verified configuration snapshot/);
  }finally{
    runtime.dispose();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
    await rm(directory,{recursive:true,force:true});
    for(const subject of [JSON.stringify([origin,'alice']),'local:guest']){
      const key=createHash('sha256').update(JSON.stringify([`application:${id}`,subject])).digest('hex');
      await rm(path.join(root,key+'.json'),{force:true});await rm(path.join(root,key+'.json.lock.sqlite'),{force:true});await rm(path.join(root,'snapshots',key),{recursive:true,force:true});
    }
  }
},30_000);
