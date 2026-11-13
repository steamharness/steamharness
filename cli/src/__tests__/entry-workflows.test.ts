import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../web/workflow-controller';
import { EntryWorkflows } from '../web/entry-workflows';
import type { Project, Runtime } from '../web/workflow-types';

it('starts once, keeps all output pages after stop and restores the start receipt', async () => {
  let calls=0, finish: (()=>void)|undefined, saved: any;
  const project={id:'fixture',entryId:'capture',name:'Capture',fields:[],entrypoints:[{id:'listen',title:'Listen',fields:[]}]} as unknown as Project;
  const runtime={run:async (_request:any,emit:any)=>{calls++;for(let i=0;i<201;i++)emit({type:'node_chunk',chunk:{type:'output_item_start',item:{id:String(i),content:'row '+i,contentType:'text'}}});await new Promise<void>(resolve=>{finish=resolve;});return {status:'aborted',nodes:[]};},cancel:()=>finish?.()} as unknown as Runtime;
  const controller=new Controller(project,runtime,{}, {save:async value=>{saved=structuredClone(value);},changed(){},log(){}});
  const api=new EntryWorkflows(controller,project,runtime),input={entryId:'capture',action:'start',entrypointId:'listen',params:{},requestId:'request-1'};
  const [a,b]=await Promise.all([api.invoke(input,'viewer'),api.invoke(input,'viewer')]) as any[];
  expect(a.id).toBe(b.id);expect(calls).toBe(1);
  await expect(api.invoke({...input,params:{different:'value'}},'viewer')).rejects.toThrow('different parameters');
  const second=await api.invoke({entryId:'capture',action:'page',runId:a.id,page:2},'viewer') as any;
  expect(second.total).toBe(201);expect(second.items).toHaveLength(100);expect(second.items[0].id).toBe('100');
  await api.invoke({entryId:'capture',action:'stop',runId:a.id},'viewer');
  expect((await api.invoke({entryId:'capture',action:'page',runId:a.id,page:3},'viewer') as any).items).toHaveLength(1);
  const restored=new EntryWorkflows(new Controller(project,runtime,saved,{save:async()=>{},changed(){},log(){}}),project,runtime);
  expect((await restored.invoke(input,'viewer') as any).id).toBe(a.id);expect(calls).toBe(1);
  await expect(restored.invoke(input,'viewer',true)).rejects.toThrow('Read-only');
  await expect(restored.invoke({entryId:'foreign',action:'list'},'viewer')).rejects.toThrow('identity');
});

it('only reads supported images owned by the selected run',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'workflow-image-'));const file=path.join(dir,'image.png');await writeFile(file,Buffer.from([1,2,3]));
  let owner='run';const project={entryId:'capture',fields:[],entrypoints:[]} as unknown as Project;
  const runtime={readFile:async()=>({reference:{conversationId:owner,mimeType:'image/png'},path:file})} as unknown as Runtime;
  const controller=new Controller(project,runtime,{runs:[{id:'run',scopeId:'run',status:'success',items:[],events:[],files:[],resolvedInputs:[],args:[],params:{}} as any]}, {save:async()=>{},changed(){},log(){}});
  const api=new EntryWorkflows(controller,project,runtime),request={entryId:'capture',action:'file',runId:'run',fileId:'wf_'+'a'.repeat(32)};
  try{expect((await api.invoke(request,'viewer') as any).base64).toBe('AQID');owner='another-run';await expect(api.invoke(request,'viewer')).rejects.toThrow('belong');}
  finally{await rm(dir,{recursive:true,force:true});}
});
