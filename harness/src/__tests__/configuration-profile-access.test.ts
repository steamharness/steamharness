import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { configurationTemplatePath } from "../configuration";
import { configurationFixtureId, declareConfigurationFixture, writeConfigurationFixtureManifest, configurationFixtureStore } from "./configuration-fixture";
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createServer} from 'node:http';
import {assertProjectConfigurationAccess,createLocalProjectConfigurationStore,createConfigurationState,bindConfigurationProfiles,createPublicationDraft,freezeConfigurationTemplate,cacheVerifiedConfigurationTemplate,readCachedConfigurationFile,configurationSnapshot,type ConfigurationAccess,type ProjectConfigurationState} from '../configuration';
import {resolveProjectConfigurationAccess} from '../configuration-access';

test('restricted local stores isolate accounts, preserve overrides, and reject a stored Build resume after downgrade',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-profile-'));
  try{
    await declareConfigurationFixture(project);
    await writeProjectFixture(path.join(project,'package.json'),JSON.stringify({name:"aggregate-fixture",version: "0.1.0", defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",databases:[],configuration:"configuration.json"}],id:'00000000-0000-4000-8000-000000000061'}));
    await writeFile(path.join(project,'configuration.json'),JSON.stringify({version:2,fields:[{name:'mode',type:'string'},{name:'model',type:'string'}],profilePolicy:{version:1,defaultProfileKey:'ask',manageMinimumRole:'developer',profiles:[{key:'ask',name:'Ask',minimumRole:'guest',fixedValues:{mode:'ask'}},{key:'build',name:'Build',minimumRole:'developer',fixedValues:{mode:'build'}}]}}));
    const access:ConfigurationAccess={subject:'server:alice',role:'developer',online:true};
    const options={rootDir:path.join(project,'store'),access};
    const store=await configurationFixtureStore(project,options);
    let state=await store.read();
    state=await store.dispatch({action:'select',id:'profile-build',revision:state.revision}) as ProjectConfigurationState;
    await store.dispatch({action:'save',id:'profile-build',revision:state.revision,values:{model:'alice-model'}});
    const snapshot=await store.snapshot({runId:'original'});
    assert.equal(snapshot.values.mode,'build');assert.equal(snapshot.values.model,'alice-model');
    await assert.rejects(store.snapshot({runId:'pre-policy-run',requireExisting:true}),/no verified configuration snapshot/);
    access.role='guest';
    const guest=await store.read();
    assert.deepEqual(guest.configurations.map(profile=>profile.profileKey),['ask']);
    assert.equal(guest.activeConfigurationId,'profile-ask');
    assert.equal(guest.revision,snapshot.revision);
    await assert.rejects(store.snapshot({runId:'original'}),/not available/);
    await assert.rejects(store.snapshot({configuration:snapshot}),/not available/);
    await store.dispatch({action:'save',id:guest.activeConfigurationId,revision:guest.revision,values:{model:'ask-model'}});
    assert.ok(!JSON.stringify(await store.dispatch({action:'export'})).includes('alice-model'));
    access.role='developer';access.online=false;
    const offlineWindow=await configurationFixtureStore(project,options);
    const offline=await offlineWindow.snapshot({runId:'offline'});
    assert.equal(offline.values.mode,'ask');
    assert.equal(offline.values.model,'ask-model');
    access.online=true;
    assert.equal((await store.snapshot()).values.mode,'build');
    assert.equal((await store.snapshot()).values.model,'alice-model');
    assert.deepEqual(await store.snapshot({runId:'original'}),snapshot);
    assert.deepEqual(await store.snapshot({runId:'offline'}),offline);
    const bob=await configurationFixtureStore(project,{...options,access:{...access,subject:'server:bob'}});
    assert.equal((await bob.snapshot()).values.mode,'ask');assert.equal((await bob.snapshot()).values.model,undefined);
    const secondWindow=await configurationFixtureStore(project,options);
    assert.equal((await secondWindow.snapshot()).values.model,'alice-model');
    access.online=false;
    state=await secondWindow.read();
    await secondWindow.dispatch({action:'select',id:state.activeConfigurationId,revision:state.revision});
    access.online=true;
    assert.equal((await store.snapshot()).values.mode,'ask');
    assert.equal((await (await configurationFixtureStore(project,options)).snapshot()).values.model,'ask-model');
  }finally{await rm(project,{recursive:true,force:true});}
});

test('project role comes from authenticated Server access and a failed refresh never reuses Build permission',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-access-'));
  const original=globalThis.fetch;
  try{
    await declareConfigurationFixture(project);
    await writeProjectFixture(path.join(project,'package.json'),JSON.stringify({name:"aggregate-fixture",version: "0.1.0", defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",databases:[],configuration:"configuration.json"}],id:'00000000-0000-4000-8000-000000000062'}));
    globalThis.fetch=async(input)=>new Response(JSON.stringify({errCode:0,data:String(input).endsWith('/api/auth/me')?{profile:{userId:'alice'}}:{access:{effectiveRole:'developer'}}}));
    const connection={serverUrl:'https://configuration.test',accessToken:project};
    const options={cacheDir:path.join(project,'identity-cache')};
    assert.equal((await resolveProjectConfigurationAccess(project,connection,true,options)).role,'developer');
    globalThis.fetch=async()=>{throw new Error('offline');};
    assert.equal((await resolveProjectConfigurationAccess(project,connection,false,options)).role,'developer');
    const offline=await resolveProjectConfigurationAccess(project,connection,true,options);
    assert.equal(offline.role,'guest');assert.equal(offline.online,false);
    assert.equal(offline.subject,JSON.stringify([connection.serverUrl,'alice']));
    assert.equal((await resolveProjectConfigurationAccess(project,null,true)).role,'guest');
  }finally{globalThis.fetch=original;await rm(project,{recursive:true,force:true});}
});

test('project roles remain available when authenticated access takes more than five seconds',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-slow-access-'));
  const server=createServer((request,response)=>{
    const reply=()=>response.end(JSON.stringify({errCode:0,data:request.url==='/api/auth/me'?{profile:{userId:'alice'}}:{access:{effectiveRole:'owner'}}}));
    if(request.url==='/api/auth/me')reply();else setTimeout(reply,5_200);
  });
  try{
    await declareConfigurationFixture(project);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address() as {port:number};
    const access=await resolveProjectConfigurationAccess(project,{serverUrl:`http://127.0.0.1:${address.port}`,accessToken:'test'},true,{cacheDir:path.join(project,'identity-cache')});
    assert.equal(access.role,'owner');assert.equal(access.online,true);
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(project,{recursive:true,force:true});
  }
});

test('parallel agent checks share a fresh role lookup and retry transient failures without reusing a grant',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-agent-access-')),original=globalThis.fetch;
  try{
    await declareConfigurationFixture(project);
    await writeFile(path.join(project,'steamharness.json'),JSON.stringify({id:randomUUID()}));
    const connection={serverUrl:'https://configuration-agents.test',accessToken:'fixture-only'};
    const options={cacheDir:path.join(project,'identity-cache')};
    let accounts=0,projects=0,denied=false;
    globalThis.fetch=async input=>{
      if(String(input).endsWith('/api/auth/me')){accounts++;return Response.json({errCode:0,data:{profile:{userId:'alice'}}});}
      projects++;
      if(denied)return new Response('',{status:403});
      if(projects<3)return new Response('',{status:503});
      return Response.json({errCode:0,data:{access:{effectiveRole:'developer'}}});
    };
    const results=await Promise.all(Array.from({length:4},()=>resolveProjectConfigurationAccess(project,connection,true,options)));
    assert.ok(results.every(access=>access.role==='developer'&&access.online));assert.equal(accounts,1);assert.equal(projects,3);
    denied=true;
    const revoked=await resolveProjectConfigurationAccess(project,connection,true,options);
    assert.equal(revoked.role,'guest');assert.equal(revoked.online,false);assert.equal(projects,4,'An explicit denial must not be retried or reuse the previous role');
  }finally{globalThis.fetch=original;await rm(project,{recursive:true,force:true});}
});

test('restricted downloads still require the verified template and keep locked values when account storage is scoped',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-template-role-'));
  try{
    await declareConfigurationFixture(project);
    const fields=[{name:'mode',type:'string' as const,sharing:{publish:true,includeValue:true,editable:false}},{name:'locked',type:'string' as const,sharing:{publish:true,includeValue:true,editable:false}}];
    const policy={version:1 as const,defaultProfileKey:'ask',manageMinimumRole:'developer' as const,profiles:[{key:'ask',name:'Ask',minimumRole:'guest' as const,fixedValues:{mode:'ask'}},{key:'build',name:'Build',minimumRole:'developer' as const,fixedValues:{mode:'build'}}]};
    let state=bindConfigurationProfiles(createConfigurationState(fields,()=> 'legacy'),policy);
    state.configurations.find(profile=>profile.profileKey==='ask')!.values.locked='official';
    const template=freezeConfigurationTemplate(createPublicationDraft(state),{projectId:await configurationFixtureId(project),entryId:"main",projectVersion:'1',sourceHash:'0'.repeat(64)});
    await writeConfigurationFixtureManifest(project,await configurationFixtureId(project));
    await writeFile(path.join(project,'configuration.json'),JSON.stringify({version:2,fields:[],profilePolicy:undefined}));
    await writeFile(path.join(project,configurationTemplatePath("main")),JSON.stringify(template));
    const access:ConfigurationAccess={subject:'alice',role:'developer',online:true};
    const options={rootDir:path.join(project,'store'),templateCacheDir:path.join(project,'cache'),access};
    const store=await configurationFixtureStore(project,options);
    await assert.rejects(store.read(),/Download this configuration/);
    await cacheVerifiedConfigurationTemplate(template,[],{cacheDir:options.templateCacheDir});
    state=await store.read();
    assert.equal(configurationSnapshot(state).values.locked,'official');
    await assert.rejects(store.dispatch({action:'save',revision:state.revision,id:state.activeConfigurationId,values:{locked:'personal'}}),/locked/);
    const snapshot=await store.snapshot();
    await assert.rejects(store.snapshot({configuration:{...snapshot,values:{...snapshot.values,locked:'forged'}}}),/locked/);
    const ask=await store.snapshot({runId:'ask'});
    const buildId=state.configurations.find(profile=>profile.profileKey==='build')!.id;
    const build=await store.snapshot({id:buildId,runId:'build'});
    const next=structuredClone(template);next.projectVersion='2';
    next.configurations.find(profile=>profile.profileKey==='ask')!.values.locked='new official';
    await cacheVerifiedConfigurationTemplate(next,[],{cacheDir:options.templateCacheDir});
    await writeFile(path.join(project,configurationTemplatePath("main")),JSON.stringify(next));
    assert.equal((await store.snapshot()).values.locked,'new official');
    assert.deepEqual(await store.snapshot({runId:'ask'}),ask);
    assert.deepEqual(await store.snapshot({runId:'build'}),build);
    state=await store.read();
    state=await store.dispatch({action:'select',id:buildId,revision:state.revision}) as ProjectConfigurationState;
    access.role='guest';
    const guest=await store.read();
    assert.equal(guest.revision,state.revision);
    assert.equal((await store.snapshot()).profileKey,'ask');
    assert.deepEqual(await store.snapshot({runId:'ask'}),ask);
    await assert.rejects(store.snapshot({runId:'build'}),/not available/);
    await assert.rejects(store.snapshot({id:'profile-build'}),/not available/);
    access.role='developer';
    const reopened=await configurationFixtureStore(project,options);
    assert.equal((await reopened.snapshot()).id,buildId);
    assert.equal((await reopened.snapshot()).values.mode,'build');
  }finally{await rm(project,{recursive:true,force:true});}
});

test('supplied and resumed snapshots cannot relax the source system-only model policy',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-profile-models-'));
  try{
    await declareConfigurationFixture(project);
    await writeConfigurationFixtureManifest(project,await configurationFixtureId(project));
    const fields=[{name:'STEAMHARNESS_AGENT_MODELS',type:'json',control:'ai-models',allowThirdParty:false}];
    await writeFile(path.join(project,'configuration.json'),JSON.stringify({version:2,fields}));
    const store=await configurationFixtureStore(project,{rootDir:path.join(project,'store')});
    const original=await store.snapshot();
    const forged={...original,agentModelPolicy:{allowThirdParty:true},values:{STEAMHARNESS_AGENT_MODELS:[{id:'third',name:'Third',source:'third-party',apiKind:'openai-responses',model:'model',baseUrl:'https://must-not-run.test/v1',apiKey:'fixture-only'}]}};
    await assert.rejects(store.snapshot({configuration:forged}),/only allows system AI/);
    const restored=await store.snapshot({configuration:{...original,agentModelPolicy:undefined}});
    assert.equal(restored.agentModelPolicy?.allowThirdParty,false);
    // A pre-policy run is revalidated after the author restricts the source.
    await writeFile(path.join(project,'configuration.json'),JSON.stringify({version:2,fields:[{...fields[0],allowThirdParty:true}]}));
    await store.snapshot({runId:'old',configuration:forged});
    await writeFile(path.join(project,'configuration.json'),JSON.stringify({version:2,fields}));
    await assert.rejects(store.snapshot({runId:'old'}),/only allows system AI/);
  }finally{await rm(project,{recursive:true,force:true});}
});

test('tool access retains a waiting run template after an upgrade but rechecks the current role',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-tool-upgrade-'));
  const id=randomUUID(),origin='https://role-upgrade.test',token=randomUUID();
  const originalFetch=globalThis.fetch;
  const env={STEAMHARNESS_SERVER_URL:origin,STEAMHARNESS_SERVER_ADMIN_KEY:token};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
  const templates:unknown[]=[];
  let role='developer';
  Object.assign(process.env,env);
  globalThis.fetch=async(input)=>new Response(JSON.stringify({errCode:0,data:String(input).endsWith('/api/auth/me')?{profile:{userId:'alice'}}:{access:{effectiveRole:role}}}));
  try {
    await declareConfigurationFixture(project);
    await writeConfigurationFixtureManifest(project,id);
    const fields=[{name:'mode',type:'string' as const,sharing:{includeValue:true,editable:false}},{name:'locked',type:'string' as const,defaultValue:'original',sharing:{includeValue:true,editable:false}}];
    const policy={version:1 as const,defaultProfileKey:'ask',manageMinimumRole:'developer' as const,profiles:[{key:'ask',name:'Ask',minimumRole:'guest' as const,fixedValues:{mode:'ask'}},{key:'build',name:'Build',minimumRole:'developer' as const,fixedValues:{mode:'build'}}]};
    const author=bindConfigurationProfiles(createConfigurationState(fields,()=> 'legacy'),policy);
    const first=freezeConfigurationTemplate(createPublicationDraft(author),{projectId:id,entryId:"main",projectVersion:'1',sourceHash:'0'.repeat(64)});
    templates.push(first);await cacheVerifiedConfigurationTemplate(first);
    const source=path.join(project,configurationTemplatePath("main"));
    await writeFile(source,JSON.stringify(first));
    const store=await configurationFixtureStore(project),state=await store.read(true);
    const buildId=state.configurations.find(profile=>profile.profileKey==='build')!.id;
    const snapshot=await store.snapshot({id:buildId,runId:'waiting'});
    const next=structuredClone(first);next.projectVersion='2';
    next.configurations.find(profile=>profile.profileKey==='build')!.values.locked='updated';
    templates.push(next);await cacheVerifiedConfigurationTemplate(next);await writeFile(source,JSON.stringify(next));
    assert.equal((await store.snapshot({id:buildId})).values.locked,'updated');
    assert.deepEqual(await store.snapshot({runId:'waiting'}),snapshot);
    await assertProjectConfigurationAccess(project,snapshot);
    role='guest';
    await assert.rejects(assertProjectConfigurationAccess(project,snapshot),/not available/);
  } finally {
    globalThis.fetch=originalFetch;
    for(const envKey of Object.keys(env)){if(previous[envKey]===undefined)delete process.env[envKey];else process.env[envKey]=previous[envKey];}
    const root=path.join(homedir(),'.steamharness');
    const key=createHash('sha256').update(JSON.stringify([`application:${id}`,JSON.stringify([origin,'alice'])])).digest('hex');
    for(const entry of [key+'.json',key+'.json.lock.sqlite',path.join('snapshots',key)])await rm(path.join(root,'configurations',entry),{recursive:true,force:true});
    const accessKey=createHash('sha256').update(JSON.stringify([origin,token,id])).digest('hex');
    await rm(path.join(root,'configuration-access',accessKey+'.json'),{force:true});
    for(const template of templates)await rm(path.join(root,'configuration-templates',createHash('sha256').update(JSON.stringify(template)).digest('hex')+'.json'),{force:true});
    await rm(project,{recursive:true,force:true});
  }
});

test('offline role-filtered attachments use the verified template cache and never expose Build files to guests',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-profile-assets-'));
  try{
    await declareConfigurationFixture(project);
    const fields=[{name:'mode',type:'string' as const,sharing:{publish:true,includeValue:true,editable:false}},{name:'image',type:'file' as const,sharing:{publish:true,includeValue:true}}];
    const policy={version:1 as const,defaultProfileKey:'ask',manageMinimumRole:'developer' as const,profiles:[{key:'ask',name:'Ask',minimumRole:'guest' as const,fixedValues:{mode:'ask'}},{key:'build',name:'Build',minimumRole:'developer' as const,fixedValues:{mode:'build'}}]};
    const state=bindConfigurationProfiles(createConfigurationState(fields,()=> 'legacy'),policy);
    const attachments=policy.profiles.map((definition,index)=>{
      const id='wf_'+String(index+1).repeat(32),bytes=Buffer.from(definition.key);
      state.configurations.find(profile=>profile.profileKey===definition.key)!.values.image={id,name:definition.key+'.png',mimeType:'image/png',size:bytes.length,storage:'server'};
      return {id,bytes};
    });
    const template=freezeConfigurationTemplate(createPublicationDraft(state),{projectId:await configurationFixtureId(project),entryId:"main",projectVersion:'1',sourceHash:'0'.repeat(64)});
    template.attachments=attachments.map(asset=>({id:asset.id,path:'configuration-assets/'+asset.id,sha256:createHash('sha256').update(asset.bytes).digest('hex')}));
    await writeConfigurationFixtureManifest(project,await configurationFixtureId(project));
    await writeFile(path.join(project,configurationTemplatePath("main")),JSON.stringify(template));
    const options={rootDir:path.join(project,'store'),templateCacheDir:path.join(project,'cache')};
    await cacheVerifiedConfigurationTemplate(template,attachments,{cacheDir:options.templateCacheDir});
    const allowed=await readCachedConfigurationFile(project,attachments[0]!.id,options);
    assert.equal(allowed?.base64,attachments[0]!.bytes.toString('base64'));
    assert.equal(await readCachedConfigurationFile(project,attachments[1]!.id,options),undefined);
  }finally{await rm(project,{recursive:true,force:true});}
});
