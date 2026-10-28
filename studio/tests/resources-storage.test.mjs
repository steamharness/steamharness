import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, realpath, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as core from '../../harness/dist/index.js';
import { runResourceRequest } from '../extensions/studio-workstation/runtime/resources-worker.mjs';

const permissions = {kv:{read:{mode:'all'},write:{mode:'all'}},knowledge:{read:{mode:'all'},write:{mode:'all'}}};
async function fixture(t, host = 'local', approved = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-resources-')));
  const previous = process.env.STEAMHARNESS_DATABASES_DIR;
  process.env.STEAMHARNESS_DATABASES_DIR = path.join(root,'databases');
  t.after(async () => { if(previous===undefined)delete process.env.STEAMHARNESS_DATABASES_DIR;else process.env.STEAMHARNESS_DATABASES_DIR=previous;await rm(root,{recursive:true,force:true}); });
  const folderPath=path.join(root,'project');await mkdir(folderPath);
  const project={id:'294b1eec-23fa-42cf-9fd3-2417f71c0570',entryId:'main',folderPath};
  const requirement={alias:'data',databaseId:randomUUID()};
  const registry=new core.LocalDatabaseRegistry();
  if(host==='local'&&approved){
    const request=registry.request({projectId:project.id,entryId:project.entryId,alias:'data',permissions,target:{kind:'create',name:'Test data'}});
    requirement.databaseId=registry.review(request.requestId,{approve:true}).databaseId;
  }
  const manifest={id:project.id,name:'Test',version: "0.1.0", defaultEntry:'main',entries:[{entryId:'main',type:'workflow',name:'Main',root:'.',entry:'index.ts',databases:["data"]}]};
  await writeProjectFixture(path.join(folderPath,'package.json'),JSON.stringify(manifest));
  await writeFile(path.join(folderPath,'config.json'),JSON.stringify({version:1,databases:{data:requirement.databaseId}}));
  const database=core.createDatabasesContext({projectId:project.id,entryId:'main',requirements:[requirement],resolver:core.createLocalDatabaseResolver(registry)}).get('data');
  const request=(input,connection)=>runResourceRequest({project,input:{database:'data',...input},connection},core);
  return {root,project,requirement,manifest,registry,database,request};
}

test('resources use the approved space and isolate conversation namespaces and entries',async t=>{
  const f=await fixture(t);await f.database.kv.setValue('nullable',null);
  const conversation=id=>core.createDatabasesContext({projectId:f.project.id,entryId:'main',conversationId:id,requirements:[f.requirement],resolver:core.createLocalDatabaseResolver(f.registry)}).get('data');
  await conversation('first').kv.conversation.setValue('private','one');
  const page=await f.request({kind:'kv',action:'list'});assert.deepEqual([page.source,page.sources,page.total],['local',['local'],1]);
  assert.equal((await f.request({kind:'kv',action:'get',key:'nullable'})).value,null);
  assert.equal(await f.request({kind:'kv',action:'get',key:'missing'}),null);
  assert.equal((await f.request({kind:'kv',action:'get',scope:'conversation',conversationId:'first',key:'private'})).value,'one');
  assert.equal(await f.request({kind:'kv',action:'get',scope:'conversation',conversationId:'second',key:'private'}),null);
  assert.equal((await f.request({kind:'kv',action:'list',scope:'conversation',conversationId:'first'})).total,1);
});

test('KV mutations, key search and pagination use the runtime database API',async t=>{
  const f=await fixture(t);
  for(let index=0;index<32;index++)await f.request({kind:'kv',action:'save',create:true,key:`item-${index}`,value:{index}});
  const first=await f.request({kind:'kv',action:'list'}),second=await f.request({kind:'kv',action:'list',cursor:first.nextCursor});
  assert.deepEqual([first.items.length,second.items.length,first.total,first.hasMore,second.hasMore],[30,2,32,true,false]);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,32);
  await assert.rejects(f.request({kind:'kv',action:'save',create:true,key:'item-0',value:'overwrite'}),/already exists/);
  await f.request({kind:'kv',action:'save',key:'item-0',value:'updated'});
  assert.equal((await f.request({kind:'kv',action:'list',query:'item-0'})).items[0].key,'item-0');
  assert.deepEqual(await f.request({kind:'kv',action:'delete',key:'item-0'}),{removed:true});
  assert.equal((await f.request({kind:'kv',action:'list'})).total,31);
  await assert.rejects(f.request({kind:'kv',action:'save',key:'bad',value:undefined}),/undefined/);
});

test('knowledge resources share approved space data, indexes and edits with the runtime',async t=>{
  const f=await fixture(t),seeded=await f.database.knowledge.createDocument({title:'Runtime document',markdown:'# Evidence\n\nshared storage'});
  assert.equal((await f.request({kind:'knowledge',action:'list'})).items[0].documentId,seeded.id);
  const match=await f.request({kind:'knowledge',action:'list',query:'shared'});
  assert.equal(match.search,true);assert.equal(match.items[0].documentId,seeded.id);assert.equal(match.items[0].lineNumber,3);
  const created=await f.request({kind:'knowledge',action:'save',create:true,title:'Created',markdown:'original'});
  await f.request({kind:'knowledge',action:'save',documentId:created.id,title:'Edited',markdown:'changed'});
  assert.equal((await f.database.knowledge.getDocument(created.id)).markdown,'changed');
  await f.request({kind:'knowledge',action:'delete',documentId:created.id});assert.equal(await f.database.knowledge.getDocument(created.id),undefined);
});

test('a bundled worker launched through the managed extension symlink uses the same user registry',async t=>{
  const f=await fixture(t),extension=path.join(f.root,'extension');await mkdir(extension);
  const worker=path.join(extension,'resources-worker.mjs');
  await build({entryPoints:[fileURLToPath(new URL('../extensions/studio-workstation/runtime/resources-worker.mjs',import.meta.url))],outfile:worker,bundle:true,platform:'node',format:'esm',target:'node24',logLevel:'silent'});
  const managed=path.join(f.root,'managed');await symlink(extension,managed,'dir');
  await mkdir(path.join(f.project.folderPath,'node_modules'));
  await symlink(await realpath(new URL('../../harness',import.meta.url)),path.join(f.project.folderPath,'node_modules/steamharness'),'dir');
  const child=spawn(process.execPath,[path.join(managed,'resources-worker.mjs')],{cwd:f.project.folderPath,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  child.stdin.end(JSON.stringify({project:f.project,input:{kind:'kv',action:'list',database:'data'}}));
  assert.equal(await exited,0,stderr);assert.deepEqual(JSON.parse(stdout).value.items,[]);
});

test('unapproved, revoked, undeclared, mismatched host and changed identity cannot access data',async t=>{
  const f=await fixture(t,'local',false);
  await assert.rejects(f.request({kind:'kv',action:'list'}),/host authorization/);assert.equal(f.registry.read().spaces.length,0);
  const approved=await fixture(t);
  await assert.rejects(approved.request({kind:'kv',action:'list',source:'server'}),/host mismatch/);
  await assert.rejects(f.request({kind:'kv',action:'list',database:'other'}),/alias/);
  await writeProjectFixture(path.join(f.project.folderPath,'package.json'),JSON.stringify({...f.manifest,id:'615e6cf6-b40a-456a-8d19-b71c63454c7a'}));
  await assert.rejects(f.request({kind:'kv',action:'delete',key:'secret'}),/identity changed/);
});

test('revoking an approved alias removes resource access immediately',async t=>{
  const f=await fixture(t);await f.database.kv.setValue('retained',true);
  f.registry.revoke((await f.database.getBinding()).grant.grantId);
  await assert.rejects(f.request({kind:'kv',action:'get',key:'retained'}),/host authorization/);
});

test('open data tabs reject migrated aliases while fresh requests follow config and environment overrides', async t => {
  const f = await fixture(t), original = f.requirement.databaseId;
  await f.database.kv.setValue('draft', 'original');
  const pending = f.registry.request({ projectId: f.project.id, entryId: 'main', alias: 'data', permissions, target: { kind: 'create', name: 'Replacement' } });
  const replacement = f.registry.review(pending.requestId, { approve: true }).databaseId;
  await writeFile(path.join(f.project.folderPath, 'config.json'), JSON.stringify({ version: 1, databases: { data: replacement } }));
  for (const action of ['list', 'get', 'save', 'delete']) {
    await assert.rejects(f.request({ kind: 'kv', action, key: 'draft', value: 'stale draft', expectedDatabaseId: original }), /reference changed/);
  }
  await assert.rejects(f.request({ kind: 'knowledge', action: 'save', create: true, title: 'Stale', markdown: 'draft', expectedDatabaseId: original }), /reference changed/);
  await f.request({ kind: 'kv', action: 'save', key: 'fresh', value: 'replacement', expectedDatabaseId: replacement });
  assert.equal((await f.request({ kind: 'kv', action: 'get', key: 'fresh' })).value, 'replacement');
  assert.equal(await f.database.kv.getValue('draft'), 'original');
  assert.equal(await f.database.kv.getValue('fresh'), undefined);
  const previous = process.env.STEAMHARNESS_PROJECT_CONFIG;
  try {
    process.env.STEAMHARNESS_PROJECT_CONFIG = JSON.stringify({ databases: { data: original } });
    await assert.rejects(f.request({ kind: 'kv', action: 'save', key: 'draft', value: 'stale', expectedDatabaseId: replacement }), /reference changed/);
    assert.equal((await f.request({ kind: 'kv', action: 'get', key: 'draft', expectedDatabaseId: original })).value, 'original');
  } finally { if (previous === undefined) delete process.env.STEAMHARNESS_PROJECT_CONFIG; else process.env.STEAMHARNESS_PROJECT_CONFIG = previous; }
});

test('declared server requirements never fall back to a local registry',async t=>{
  const f=await fixture(t,'server');
  await assert.rejects(f.request({kind:'kv',action:'list'}),/host authorization/);
  assert.equal(f.registry.read().spaces.length,0);
});
