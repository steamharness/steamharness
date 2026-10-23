import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createLocalProjectConfigurationStore,createConfigurationState,bindConfigurationProfiles,createPublicationDraft,freezeConfigurationTemplate,cacheVerifiedConfigurationTemplate,configurationSnapshot,type ConfigurationAccess,type ProjectConfigurationState} from '../configuration';
import {resolveProjectConfigurationAccess} from '../configuration-access';

test('restricted local stores isolate accounts, preserve overrides, and reject a stored Build resume after downgrade',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-profile-'));
  try{
    await writeFile(path.join(project,'package.json'),JSON.stringify({id:'00000000-0000-4000-8000-000000000061'}));
    await writeFile(path.join(project,'configuration.json'),JSON.stringify({version:2,fields:[{name:'mode',type:'string'},{name:'model',type:'string'}],profilePolicy:{version:1,defaultProfileKey:'ask',manageMinimumRole:'developer',profiles:[{key:'ask',name:'Ask',minimumRole:'guest',fixedValues:{mode:'ask'}},{key:'build',name:'Build',minimumRole:'developer',fixedValues:{mode:'build'}}]}}));
    const access:ConfigurationAccess={subject:'server:alice',role:'developer',online:true};
    const options={rootDir:path.join(project,'store'),access};
    const store=await createLocalProjectConfigurationStore(project,options);
    let state=await store.read();
    state=await store.dispatch({action:'select',id:'profile-build',revision:state.revision}) as ProjectConfigurationState;
    await store.dispatch({action:'save',id:'profile-build',revision:state.revision,values:{model:'alice-model'}});
    const snapshot=await store.snapshot({runId:'original'});
    assert.equal(snapshot.values.mode,'build');assert.equal(snapshot.values.model,'alice-model');
    await assert.rejects(store.snapshot({runId:'pre-policy-run',requireExisting:true}),/no verified configuration snapshot/);
    access.role='guest';
    assert.deepEqual((await store.read()).configurations.map(profile=>profile.profileKey),['ask']);
    await assert.rejects(store.snapshot({runId:'original'}),/not available/);
    await assert.rejects(store.snapshot({configuration:snapshot}),/not available/);
    access.role='developer';access.online=false;
    assert.equal((await store.snapshot()).values.mode,'ask');
    access.online=true;
    assert.equal((await store.snapshot()).values.mode,'ask');
    state=await store.read();
    await store.dispatch({action:'select',id:'profile-build',revision:state.revision});
    assert.equal((await store.snapshot()).values.model,'alice-model');
    const bob=await createLocalProjectConfigurationStore(project,{...options,access:{...access,subject:'server:bob'}});
    assert.equal((await bob.snapshot()).values.mode,'ask');assert.equal((await bob.snapshot()).values.model,undefined);
    const secondWindow=await createLocalProjectConfigurationStore(project,options);
    assert.equal((await secondWindow.snapshot()).values.model,'alice-model');
  }finally{await rm(project,{recursive:true,force:true});}
});

test('project role comes from authenticated Server access and a failed refresh never reuses Build permission',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-access-'));
  const original=globalThis.fetch;
  try{
    await writeFile(path.join(project,'package.json'),JSON.stringify({id:'00000000-0000-4000-8000-000000000062'}));
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

test('restricted downloads still require the verified template and keep locked values when account storage is scoped',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'configuration-template-role-'));
  try{
    const fields=[{name:'mode',type:'string' as const,sharing:{publish:true,includeValue:true,editable:false}},{name:'locked',type:'string' as const,sharing:{publish:true,includeValue:true,editable:false}}];
    const policy={version:1 as const,defaultProfileKey:'ask',manageMinimumRole:'developer' as const,profiles:[{key:'ask',name:'Ask',minimumRole:'guest' as const,fixedValues:{mode:'ask'}},{key:'build',name:'Build',minimumRole:'developer' as const,fixedValues:{mode:'build'}}]};
    let state=bindConfigurationProfiles(createConfigurationState(fields,()=> 'legacy'),policy);
    state.configurations.find(profile=>profile.profileKey==='ask')!.values.locked='official';
    const template=freezeConfigurationTemplate(createPublicationDraft(state),{projectId:'project',projectVersion:'1',sourceHash:'0'.repeat(64)});
    await writeFile(path.join(project,'package.json'),'{}');
    await writeFile(path.join(project,'configuration.json'),JSON.stringify({version:2,fields:[],profilePolicy:undefined}));
    await writeFile(path.join(project,'configuration.template.json'),JSON.stringify(template));
    const options={rootDir:path.join(project,'store'),templateCacheDir:path.join(project,'cache'),access:{subject:'alice',role:'guest' as const,online:false}};
    const store=await createLocalProjectConfigurationStore(project,options);
    await assert.rejects(store.read(),/Download this configuration/);
    await cacheVerifiedConfigurationTemplate(template,[],{cacheDir:options.templateCacheDir});
    state=await store.read();
    assert.equal(configurationSnapshot(state).values.locked,'official');
    await assert.rejects(store.dispatch({action:'save',revision:state.revision,id:state.activeConfigurationId,values:{locked:'personal'}}),/locked/);
    await assert.rejects(store.snapshot({id:'profile-build'}),/not available/);
  }finally{await rm(project,{recursive:true,force:true});}
});
