import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const permissions = {kv:{read:{mode:'all'},write:{mode:'all'}},knowledge:{read:{mode:'all'},write:{mode:'all'}}};

/** Test host explicitly approves a fresh space; example manifests remain unbound. */
export async function approveLocalFixtureDatabase(core, folder, manifest, directory) {
  const entry = manifest.entries.find(item => item.entryId === manifest.defaultEntry);
  const registry = new core.LocalDatabaseRegistry(directory);
  const request = registry.request({projectId:manifest.id,entryId:entry.entryId,alias:'data',permissions,target:{kind:'create',name:'UI fixture'}});
  const {databaseId} = registry.review(request.requestId,{approve:true});
  const requirements = [{alias:'data',databaseId}];
  entry.databases = ['data'];
  await writeFile(path.join(folder,'config.json'),JSON.stringify({version:1,databases:{data:databaseId}}));
  await writeProjectFixture(path.join(folder,'package.json'),JSON.stringify(manifest));
  return core.createDatabasesContext({projectId:manifest.id,entryId:entry.entryId,requirements,resolver:core.createLocalDatabaseResolver(registry)}).get('data');
}

/** A test-only remote data host, using the same approved catalog and SDK namespaces. */
export function fixtureDatabaseHost(core) {
  const state={spaces:[],requests:[],grants:[],bindings:[]};
  const actor={userId:'fixture-host',isSystemAdmin:true};
  const catalog=new core.DatabaseCatalog('server',state,randomUUID,()=>new Date().toISOString());
  const records=new Map();let revision=0;
  const key=input=>JSON.stringify([input.projectId,input.storageKind,input.scope,input.conversationId??'',input.key]);
  const current=input=>{const row=records.get(key(input));return row?{exists:true,value:structuredClone(row.value),revision:row.revision}:{exists:false};};
  const store={
    async getValue(input){return current(input).value;},
    async setValue(input){records.set(key(input),{input,value:structuredClone(input.value),revision:String(++revision)});},
    async deleteValue(input){const removed=records.delete(key(input));if(removed)revision++;return removed;},
    async updateValue(input,update){const value=update(await this.getValue(input));await this.setValue({...input,value});return value;},
    async withNamespaceLock(_input,operation){return operation();},
    async withNamespaceReadLock(_input,operation){return operation();},
    async listValues(input){const items=[...records.values()].filter(row=>row.input.projectId===input.projectId&&row.input.storageKind===input.storageKind&&row.input.scope===input.scope&&(!input.conversationId||row.input.conversationId===input.conversationId)&&(!input.keyPrefix||row.input.key.startsWith(input.keyPrefix))).map(row=>({...row.input,value:row.value,revision:row.revision}));return {items,total:items.length,hasMore:false};},
  };
  return {
    create(projectId,entryId,alias='shared'){
      const request=catalog.request({projectId,entryId,alias,permissions,target:{kind:'create',name:'Shared UI fixture'}},actor);
      const approved=catalog.review(request.requestId,{approve:true},actor);
      const requirement={alias,databaseId:approved.databaseId};
      const authorization=catalog.resolve(requirement.databaseId,{projectId,entryId});
      const database=core.createDatabasesContext({projectId,entryId,requirements:[requirement],resolver:{resolve:()=>({authorization,store})}}).get(alias);
      return {requirement,database,authorization};
    },
    revoke(grantId){catalog.revoke(grantId,actor);},
    async handle(request,response){
      const url=new URL(request.url,'http://fixture');
      if(!url.pathname.startsWith('/api/database-spaces/'))return false;
      try {
        const parts=url.pathname.split('/').filter(Boolean);
        if(parts[3]==='authorization'){
          const authorization=catalog.resolve(parts[2],{projectId:url.searchParams.get('projectId'),entryId:url.searchParams.get('entryId')});
          if(!authorization||authorization.grant.revokedAt)throw new Error('Database authorization is no longer valid.');
          response.end(JSON.stringify({errCode:0,data:authorization}));return true;
        }
        const chunks=[];for await(const chunk of request)chunks.push(chunk);
        const call=JSON.parse(Buffer.concat(chunks).toString());
        const authorization=catalog.authorization(call.bindingRef);
        if(!authorization||authorization.grant.revokedAt)throw new Error('Database authorization is no longer valid.');
        const address=entry=>({...entry,projectId:entry.spaceId});
        let data;
        if(call.operation==='get')data=current(address(call.entry));
        else if(call.operation==='set'){await store.setValue({...address(call.entry),value:call.value});data={};}
        else if(call.operation==='delete')data={removed:await store.deleteValue(address(call.entry))};
        else if(call.operation==='revision')data={revision:String(revision)};
        else if(call.operation==='list')data=await store.listValues({...address(call.entry),...call});
        else if(call.operation==='compare-and-set'){
          const before=current(address(call.entry));const applied=(before.revision??null)===call.expectedRevision;
          if(applied)await store.setValue({...address(call.entry),value:call.value});data={applied};
        }else if(call.operation==='transaction'){
          const applied=call.entries.every(item=>(current(address(item.entry)).revision??null)===item.expectedRevision);
          if(applied)for(const item of call.entries){if(item.mutation?.operation==='set')await store.setValue({...address(item.entry),value:item.mutation.value});else if(item.mutation?.operation==='delete')await store.deleteValue(address(item.entry));}
          data={applied};
        }else throw new Error('Unsupported database fixture operation.');
        response.end(JSON.stringify({errCode:0,data}));
      }catch(error){response.writeHead(403);response.end(JSON.stringify({errCode:403,errMessage:error.message}));}
      return true;
    },
  };
}
