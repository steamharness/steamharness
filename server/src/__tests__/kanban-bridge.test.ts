import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalDatabaseRegistry, createDatabasesContext, createLocalDatabaseResolver, createKnowledgeBaseContext } from 'steamharness';
import { invokeServerKanbanBridge, readKanbanBridgeCall } from '../kanban-bridge';
import type { Storage } from '../storage';
import type { KanbanBridgeCall } from '@steamharness/kanban-project';

const actor={userId:'reader',isSystemAdmin:false};
const options={entryId:'board',actor,target:'1.0.0'};
const all={mode:'all' as const};

test('Kanban dispatches KV, knowledge, attachments and revisions through the selected entry database',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'kanban-space-'));
  try{
    const registry=new LocalDatabaseRegistry(root),projectId=randomUUID();
    const permissions={kv:{read:all,write:all},knowledge:{read:all,write:all}};
    const request=registry.request({projectId,entryId:'board',alias:'data',permissions,target:{kind:'create',name:'Board'}});
    const approved=registry.review(request.requestId,{approve:true});
    const databases=createDatabasesContext({projectId,entryId:'board',requirements:[{alias:'data',databaseId:approved.databaseId!}],resolver:createLocalDatabaseResolver(registry)});
    const bytes=Buffer.from([0,137,255,13,10]);
    const file={id:randomUUID(),spaceId:randomUUID(),storage:'database',name:'map.png',mimeType:'image/png',size:bytes.length,kind:'image',createdAt:new Date().toISOString()};
    let knowledgeReads=0;
    const knowledge=createKnowledgeBaseContext(async<T>(operation:string,input:any):Promise<T>=> {
      if(operation==='knowledge.listDocuments')return {items:[],total:0,hasMore:false} as T;
      if(operation==='knowledge.revision')return {revision:'knowledge-2'} as T;
      if(operation==='files.readFile'){assert.equal(input.fileId,file.id);return {file,base64:bytes.toString('base64')} as T;}
      if(operation==='files.stat')return file as T;
      throw new Error('Unexpected knowledge operation.');
    });
    const storage={
      entryDatabases:async(...args:unknown[])=>{assert.deepEqual(args,[projectId,'board',actor,'1.0.0']);return databases;},
      entryKnowledgeBases:async(...args:unknown[])=>{assert.deepEqual(args,[projectId,'board',actor,'1.0.0']);knowledgeReads++;return {get:(alias:string)=>{assert.equal(alias,'data');return knowledge;}};},
    } as unknown as Storage;
    const call=(operation:KanbanBridgeCall['operation'],input:Record<string,unknown>={})=>invokeServerKanbanBridge(storage,projectId,{requestId:randomUUID(),operation,input:{[operation.startsWith('knowledge.')||operation.startsWith('files.')?'knowledgeBase':'database']:'data',...input}},options);
    await call('kv.setValue',{key:'board',value:{version:1}});
    assert.deepEqual(await call('kv.getValue',{key:'board'}),{version:1});
    const before=await call('database.revision');
    assert.equal((await call('knowledge.listDocuments') as {total:number}).total,0);
    assert.equal(await call('knowledge.revision'),'knowledge-2');
    assert.equal(await call('database.revision'),before,'knowledge resources do not change KV revisions');
    assert.deepEqual(Buffer.from((await call('files.readFile',{fileId:file.id}) as {base64:string}).base64,'base64'),bytes);
    assert.equal(knowledgeReads,3);
    registry.revoke(registry.authorization(approved.bindingRef!)!.grant.grantId);
    await assert.rejects(call('kv.getValue',{key:'board'}),/host authorization/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Kanban locale does not access storage and removed or undeclared operations are rejected',async()=>{
  assert.equal(await invokeServerKanbanBridge({} as Storage,'demo',{requestId:'locale',operation:'runtime.getLocale',input:{}},{...options,runtimeLocale:'zh-CN'}),'zh-CN');
  assert.equal(await invokeServerKanbanBridge({} as Storage,'demo',{requestId:'locale',operation:'runtime.getLocale',input:{}},options),'en');
  for(const operation of ['relatedProject.kv.getValue','exec','kv.getValue'])assert.throws(()=>readKanbanBridgeCall({requestId:'bad',operation,input:{key:'board'}}),/invalid/);
});
