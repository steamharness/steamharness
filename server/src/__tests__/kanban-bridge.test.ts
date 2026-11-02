import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKnowledgeBaseContext } from 'steamharness';
import { invokeServerKanbanBridge, readKanbanBridgeCall } from '../kanban-bridge';
import type { Storage } from '../storage';
import type { KanbanBridgeCall } from '@steamharness/kanban-project';

const actor={userId:'reader',isSystemAdmin:false};
const options={entryId:'board',actor,target:'1.0.0'};
const all={mode:'all' as const};

test('Kanban pins table queries and independent knowledge calls to the selected entry',async()=>{
  const projectId=randomUUID(), bytes=Buffer.from([0,137,255,13,10]);
  const file={id:randomUUID(),spaceId:randomUUID(),storage:'database',name:'map.png',mimeType:'image/png',size:bytes.length,kind:'image',createdAt:new Date().toISOString()};
  const binding={id:randomUUID(),alias:'data',databaseId:randomUUID(),revision:1,accessRevision:4};
  let knowledgeReads=0, queries=0;
  const knowledge=createKnowledgeBaseContext(async<T>(operation:string,input:any):Promise<T>=> {
    if(operation==='knowledge.listDocuments')return {items:[],total:0,hasMore:false} as T;
    if(operation==='knowledge.revision')return {revision:'knowledge-2'} as T;
    if(operation==='files.stat')return file as T;
    if(operation==='files.readFile'){assert.equal(input.fileId,file.id);return {file,base64:bytes.toString('base64')} as T;}
    throw new Error('Unexpected knowledge operation.');
  });
  const storage={
    entryDatabaseRequirements:async(...args:unknown[])=>{assert.deepEqual(args,[projectId,'board','1.0.0']);return ['data'];},
    relationalDatabases:{
      resolveQueryBinding:async(userId:string,consumer:any)=>{assert.equal(userId,actor.userId);assert.deepEqual(consumer,{projectId,entryId:'board',alias:'data',schemaHash:'a'.repeat(64)});return binding;},
      data:async(userId:string,id:string,request:any,consumer:any)=>{queries++;assert.equal(userId,actor.userId);assert.equal(id,binding.databaseId);assert.equal(consumer.binding.id,binding.id);assert.equal(consumer.accessRevision,4);assert.equal(request.operation,'rows');return {items:[]};},
    },
    entryKnowledgeBases:async(...args:unknown[])=>{assert.deepEqual(args,[projectId,'board',actor,'1.0.0']);knowledgeReads++;return {get:(alias:string)=>{assert.equal(alias,'data');return knowledge;}};},
  } as unknown as Storage;
  const call=(operation:KanbanBridgeCall['operation'],input:Record<string,unknown>={})=>invokeServerKanbanBridge(storage,projectId,{requestId:randomUUID(),operation,input:{[operation.startsWith('knowledge.')||operation.startsWith('files.')?'knowledgeBase':'database']:'data',...input}},options);
  assert.deepEqual(await call('database.resolve',{schemaHash:'a'.repeat(64)}),binding);
  assert.deepEqual(await call('database.query',{schemaHash:'a'.repeat(64),binding,request:{operation:'rows',model:'Task'}}),{items:[]});
  await assert.rejects(call('database.query',{schemaHash:'a'.repeat(64),binding:{...binding,alias:'other'},request:{operation:'rows',model:'Task'}}),{code:'DATABASE_INVALID_REQUEST'});
  assert.equal(queries,1);
  assert.equal((await call('knowledge.listDocuments') as {total:number}).total,0);
  assert.equal(await call('knowledge.revision'),'knowledge-2');
  assert.deepEqual(Buffer.from((await call('files.readFile',{fileId:file.id}) as {base64:string}).base64,'base64'),bytes);
  assert.equal(knowledgeReads,3);
});

test('Kanban locale does not access storage and removed or undeclared operations are rejected',async()=>{
  assert.equal(await invokeServerKanbanBridge({} as Storage,'demo',{requestId:'locale',operation:'runtime.getLocale',input:{}},{...options,runtimeLocale:'zh-CN'}),'zh-CN');
  assert.equal(await invokeServerKanbanBridge({} as Storage,'demo',{requestId:'locale',operation:'runtime.getLocale',input:{}},options),'en');
  for(const operation of ['relatedProject.kv.getValue','exec','kv.getValue'])assert.throws(()=>readKanbanBridgeCall({requestId:'bad',operation,input:{key:'board'}}),/invalid/);
});
