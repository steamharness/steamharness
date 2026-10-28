import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalDatabaseRegistry, createDatabasesContext, createLocalDatabaseResolver } from 'steamharness';
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
    const storage={entryDatabases:async(...args:unknown[])=>{assert.deepEqual(args,[projectId,'board',actor,'1.0.0']);return databases;}} as unknown as Storage;
    const call=(operation:KanbanBridgeCall['operation'],input:Record<string,unknown>={})=>invokeServerKanbanBridge(storage,projectId,{requestId:randomUUID(),operation,input:{database:'data',...input}},options);
    await call('kv.setValue',{key:'board',value:{version:1}});
    assert.deepEqual(await call('kv.getValue',{key:'board'}),{version:1});
    const before=await call('database.revision');
    await call('knowledge.createDocument',{id:'guide',title:'Guide',markdown:'# Guide\nshared'});
    assert.equal((await call('knowledge.listDocuments') as {total:number}).total,1);
    assert.equal((await call('knowledge.getDocument',{documentId:'guide'}) as {markdown:string}).markdown,'# Guide\nshared');
    await call('knowledge.editDocument',{documentId:'guide',markdown:'updated'});
    assert.equal((await call('knowledge.searchDocuments',{query:'updated'}) as {totalMatches:number}).totalMatches,1);
    assert.equal((await call('knowledge.readDocumentLines',{documentId:'guide',startLine:1,endLine:1}) as {totalLines:number}).totalLines,1);
    assert.notEqual(await call('database.revision'),before);
    const bytes=Buffer.from([0,137,255,13,10]);
    const file=await call('files.createFile',{name:'map.png',mimeType:'image/png',base64:bytes.toString('base64')}) as {id:string};
    assert.deepEqual(Buffer.from((await call('files.readFile',{fileId:file.id}) as {base64:string}).base64,'base64'),bytes);
    assert.equal(await call('files.deleteFile',{fileId:file.id}),true);
    await call('knowledge.deleteDocument',{documentId:'guide'});
    assert.equal(await call('knowledge.getDocument',{documentId:'guide'}),null);
    registry.revoke(registry.authorization(approved.bindingRef!)!.grant.grantId);
    await assert.rejects(call('kv.getValue',{key:'board'}),/host authorization/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Kanban locale does not access storage and removed or undeclared operations are rejected',async()=>{
  assert.equal(await invokeServerKanbanBridge({} as Storage,'demo',{requestId:'locale',operation:'runtime.getLocale',input:{}},{...options,runtimeLocale:'zh-CN'}),'zh-CN');
  assert.equal(await invokeServerKanbanBridge({} as Storage,'demo',{requestId:'locale',operation:'runtime.getLocale',input:{}},options),'en');
  for(const operation of ['relatedProject.kv.getValue','exec','kv.getValue'])assert.throws(()=>readKanbanBridgeCall({requestId:'bad',operation,input:{key:'board'}}),/invalid/);
});
