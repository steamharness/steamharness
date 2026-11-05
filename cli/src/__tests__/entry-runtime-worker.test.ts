import { testDataDirectory } from './test-data-directory';
import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebRuntime } from '../web/runtime';
import { runtimeStorageService } from './runtime-storage-service';
import { resolveHarnessRoot } from './harness-source';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import type { AggregateEntryCall } from '../web/entry-conversations';

it('routes real worker entry IPC with host-derived provenance and cancellation', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'entry-runtime-worker-'));
  const connection=await runtimeStorageService().start();
  const id=randomUUID();const calls:AggregateEntryCall[]=[];
  let signal:AbortSignal|undefined,waiting:Promise<unknown>|undefined;
  const runtime=createWebRuntime(directory,path.join(testDataDirectory(directory)),()=>connection,{
    actor:()=>({userId:'trusted-user',isSystemAdmin:false}),
    entryRuntime:async call=>{
      calls.push(call);signal=call.abortSignal;
      if(call.input.requestId==='slow')await delay(16_000,undefined,{signal:call.abortSignal});
      if(call.input.requestId==='wait')return new Promise((resolve,reject)=>call.abortSignal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
      return {conversationId:call.input.conversationId,requestId:call.input.requestId,messageId:call.input.requestId,status:'queued'};
    },
  });
  try{
    await mkdir(path.join(directory,'node_modules'));
    await symlink(await resolveHarnessRoot(),path.join(directory,'node_modules/steamharness'),process.platform==='win32'?'junction':'dir');
    await writeProjectFixture(path.join(directory,'package.json'),JSON.stringify({name:'entry-runtime-worker',type:'module',id,version:'1.0.0',defaultEntry:'api',entries:[
      {entryId:'api',name:'API',type:'workflow',root:'.',entry:'api.ts',databases:[]},
      {entryId:'bot',name:'Bot',type:'bot',root:'.',entry:'bot.ts',databases:[]},
    ]}));
    await writeFile(path.join(directory,'api.ts'),`
      const ipcProject=steamharness.defineProject({name:'ipc',async run(input,context){
        const receipt=await context.entries.conversations.get('bot').submit({conversationId:'target',requestId:input.requestId,text:'hello'});
        return {errCode:0,errMessage:'',receipt,caller:context.entries.caller};
      }});
      export const executor=steamharness.defineExecutor({projectType:'workflow',defaultEntrypoint:'main',entrypoints:[steamharness.defineEntrypoint({id:'main',title:'Main',workflow:ipcProject,params:[{name:'request',flag:'--request',type:'string'}],createInput({args}){return {errCode:0,errMessage:'',requestId:args[1]};}})]});
    `);
    await writeFile(path.join(directory,'bot.ts'),`export const executor=steamharness.defineBot({});`);
    const inspected=await runtime.inspect([directory]);expect(inspected.errors).toEqual([]);
    const project={...inspected.projects.find(project=>project.entryId==='api')!,uri:''};
    const entryCall={entryId:'bot',conversationId:'source',runId:'bot-run'};
    const report=await runtime.run({project,conversationId:'api-conversation',runId:'api-run',args:['--request','send'],entryCall},()=>{});
    expect(report.status).toBe('success');
    expect(calls[0]).toMatchObject({projectId:id,sourceEntryId:'api',sourceConversationId:'api-conversation',sourceRunId:'api-run',actor:{userId:'trusted-user'},action:'submit',entryId:'bot'});
    expect(JSON.stringify(report)).toContain('bot-run');
    const slow=await runtime.run({project,conversationId:'slow-conversation',runId:'slow-run',args:['--request','slow'],entryCall},()=>{});
    expect(slow.status).toBe('success');
    expect(calls.filter(call=>call.input.requestId==='slow')).toHaveLength(1);
    waiting=runtime.run({project,conversationId:'cancel-conversation',runId:'cancel-run',args:['--request','wait'],entryCall},()=>{});
    await expect.poll(()=>calls.length).toBe(3);
    runtime.cancel('cancel-run');await waiting;waiting=undefined;
    expect(signal?.aborted).toBe(true);
  }finally{
    runtime.dispose();await waiting?.catch(()=>undefined);await connection.close();
    const key=createHash('sha256').update(`application:${id}`).digest('hex');
    await rm(path.join(os.homedir(),'.steamharness/configurations',`${key}.json`),{force:true});
    await rm(path.join(os.homedir(),'.steamharness/configurations',`${key}.json.lock.sqlite`),{force:true});
    await rm(directory,{recursive:true,force:true});
  }
},60000);
