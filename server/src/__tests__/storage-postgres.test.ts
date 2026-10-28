import { projectFixtureFiles } from '../../scripts/test-project-fixture.mjs';
import { AccountRepository } from "../account-db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { create as createTar } from "tar";
import type { DeclaredProjectInfo } from "@steamharness/project-info";
import { defaultProjectCardIcon, getProjectCardColorContrastRatio } from "@steamharness/project-card-metadata";
import { LocalStorage } from "../local-storage";
import { ArtifactStorage, DatabaseRepository } from "../persistence";
import { Storage } from "../storage";
import { AGENT_MODELS_CONFIGURATION_FIELD, AGENT_MODELS_CONFIGURATION_KEY as key, configurationSnapshot, type ProjectConfigurationState } from "@steamharness/project-configuration";

const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL?.trim();

test('PostgreSQL configuration profiles use inherited project roles, preserve personal values on downgrade, and honor system administrators', {
  skip: databaseUrl ? false : 'STEAMHARNESS_TEST_DATABASE_URL is not configured',
}, async () => {
  const schema=`configuration_roles_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:databaseUrl});await admin.query(`create schema ${schema}`);
  const connection=new URL(databaseUrl!);connection.searchParams.set('options',`-c search_path=${schema}`);
  const db=new DatabaseRepository(connection.toString()),accounts=new AccountRepository(connection.toString());
  const root=await mkdtemp(path.join(tmpdir(),'configuration-roles-postgres-'));
  const objects=new LocalStorage({root:path.join(root,'objects'),publicBaseUrl:'http://localhost/'});
  const storage=new Storage({serverRoot:process.cwd(),repoRoot:process.cwd(),dataRoot:path.join(root,'data'),db,objectStorage:objects,artifacts:new ArtifactStorage(objects)});
  const author={userId:'author',isSystemAdmin:false};
  try{
    await db.init();await accounts.init();
    for(const userId of ['author','developer','guest','administrator'])await accounts.upsertUserProfile({userId,email:`${userId}@test.local`});
    await accounts.setSystemAdministrator('administrator',true);
    const group=await db.access.createGroup({name:'Organization'},author);
    const child=await db.access.createGroup({name:'Team',parentId:group.id},author);
    await db.access.setMember('group',group.id,'developer','developer',author);
    await db.access.setMember('group',child.id,'developer','guest',author);
    const id=randomUUID(),projectInfo={localizedNames:{},declarations:[],platformSupport:{mode:'agnostic' as const},};
    await storage.createProject({projectId:id,projectName:'Role profiles',entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",databases:[]}],defaultEntry:"main",ownerUserId:'author',groupId:child.id,visibility:'public',projectInfo});
    const core=JSON.parse(await readFile(new URL('../../node_modules/steamharness/package.json',import.meta.url),'utf8'));
    const policy={version:1,defaultProfileKey:'ask',manageMinimumRole:'developer',profiles:[{key:'ask',name:'Ask',minimumRole:'guest',fixedValues:{mode:'ask'}},{key:'build',name:'Build',minimumRole:'developer',fixedValues:{mode:'build'}}]};
    await storage.saveDraftFiles({projectName:id,files:projectFixtureFiles([
      {path:'package.json',content:JSON.stringify({id,name:'Role profiles',version:'1.0.0',devDependencies:{steamharness:core.version},defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}],projectInfo})},
      {path:'index.ts',content:'throw new Error("Static configuration operations must not execute source");'},
      {path:'configuration.json',content:JSON.stringify({version:2,fields:[{name:'mode',type:'string',sharing:{publish:true,includeValue:true,editable:false}},{name:'model',type:'string'}],profilePolicy:policy})},
    ])});
    const owner={projectName:id,actorId:'author',actor:author};
    let state=await storage.projectConfigurations(owner,{action:'get'}) as ProjectConfigurationState;
    state=await storage.projectConfigurations(owner,{action:'publication.save',revision:state.revision,publication:state.publication}) as ProjectConfigurationState;
    await storage.publish({projectName:id,createdByUserId:'author',expectedSourceHash:state.sourceHash,expectedConfigurationRevisions:{main:state.publication!.revision}});
    const guest={projectName:id,actorId:'guest',actor:{userId:'guest',isSystemAdmin:false},target:'latest'};
    state=await storage.projectConfigurations(guest,{action:'get'}) as ProjectConfigurationState;
    const askId=state.activeConfigurationId;
    assert.deepEqual(state.configurations.map(profile=>profile.profileKey),['ask']);
    assert.equal(state.capabilities!.manageConfigurations,false);
    await assert.rejects(storage.projectConfigurations(guest,{action:'create',name:'Build',revision:state.revision}),/Developer/);
    await assert.rejects(storage.projectConfigurations(guest,{action:'save',id:askId,values:{mode:'build'},revision:state.revision}),/fixes/);
    assert.equal(JSON.stringify(await storage.projectConfigurations(guest,{action:'export'})).includes('"build"'),false);
    const developer={...guest,actorId:'developer',actor:{userId:'developer',isSystemAdmin:false}};
    state=await storage.projectConfigurations(developer,{action:'get'}) as ProjectConfigurationState;
    assert.equal(state.capabilities!.role,'developer');
    const defaultState=await storage.projectConfigurations({...developer,target:undefined},{action:'get'}) as ProjectConfigurationState;
    assert.deepEqual(defaultState.configurations.map(profile=>profile.profileKey),['ask','build']);
    const buildId=state.configurations.find(profile=>profile.profileKey==='build')!.id;
    state=await storage.projectConfigurations(developer,{action:'select',id:buildId,revision:state.revision}) as ProjectConfigurationState;
    state=await storage.projectConfigurations(developer,{action:'save',id:buildId,values:{model:'personal-model'},revision:state.revision}) as ProjectConfigurationState;
    const revision=state.revision;
    await db.access.setMember('group',group.id,'developer','guest',author);
    state=await storage.projectConfigurations(developer,{action:'get'}) as ProjectConfigurationState;
    assert.equal(state.configurations.length,1);assert.equal(state.configurations[0]!.profileKey,'ask');assert.ok(state.revision>revision);
    await assert.rejects(storage.projectConfigurations(developer,{action:'select',id:buildId,revision:state.revision}),/not available/);
    await db.access.setMember('group',group.id,'developer','developer',author);
    state=await storage.projectConfigurations(developer,{action:'get'}) as ProjectConfigurationState;
    assert.equal(state.configurations.find(profile=>profile.id===buildId)!.values.model,'personal-model');
    assert.equal(state.configurations.find(profile=>profile.id===state.activeConfigurationId)!.profileKey,'ask');
    const system=await storage.projectConfigurations({...guest,actorId:'administrator',actor:{userId:'administrator',isSystemAdmin:true}},{action:'get'}) as ProjectConfigurationState;
    assert.equal(system.capabilities!.role,'owner');assert.equal(system.canManagePublication,true);
    assert.deepEqual(system.configurations.map(profile=>profile.profileKey),['ask','build']);
  }finally{
    await accounts.close();await db.close();await rm(root,{recursive:true,force:true});
    await admin.query(`drop schema ${schema} cascade`);await admin.end();
  }
});

test("PostgreSQL preserves source AI policy through stale drafts and hidden published fields", {
  skip: databaseUrl ? false : "STEAMHARNESS_TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `ai_policy_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({connectionString:databaseUrl});
  await admin.query(`create schema ${schema}`);
  const connection = new URL(databaseUrl!); connection.searchParams.set("options",`-c search_path=${schema}`);
  const db = new DatabaseRepository(connection.toString());
  const accounts = new AccountRepository(connection.toString());
  const root = await mkdtemp(path.join(tmpdir(),"postgres-ai-policy-"));
  const objects = new LocalStorage({root:path.join(root,"objects"),publicBaseUrl:"http://localhost/"});
  const storage = new Storage({serverRoot:process.cwd(),repoRoot:process.cwd(),dataRoot:path.join(root,"data"),db,objectStorage:objects,artifacts:new ArtifactStorage(objects)});
  try {
    await db.init(); await accounts.init();
    for (const userId of ["author","recipient"]) await accounts.upsertUserProfile({userId,email:`${userId}@test.local`});
    const id=randomUUID(),projectInfo={localizedNames:{},declarations:[],platformSupport:{mode:"agnostic" as const},};
    await storage.createProject({projectId:id,projectName:"AI policy",entries:[{entryId:"main",name:"Main",type:"conversation",root:".",entry:"index.ts",databases:[]}],defaultEntry:"main",ownerUserId:"author",projectInfo});
    await db.access.setMember('project',id,'recipient','guest',{userId:'author',isSystemAdmin:false});
    const core = JSON.parse(await readFile(new URL("../../node_modules/steamharness/package.json",import.meta.url),"utf8"));
    const definition = (restricted:boolean)=>JSON.stringify({version:2,fields:[{...AGENT_MODELS_CONFIGURATION_FIELD,...(restricted?{allowThirdParty:false}:{})}]});
    await storage.saveDraftFiles({projectName:id,files:projectFixtureFiles([
      {path:"package.json",content:JSON.stringify({id,name:"AI policy",version:"1.0.0",devDependencies:{steamharness:core.version},defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"conversation",root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}],projectInfo})},
      {path:"index.ts",content:'throw new Error("must not execute"); steamharness.createAgentNode();'},
      {path:"configuration.json",content:definition(false)},
    ])});
    const options={projectName:id,actorId:"author"};
    let state=await storage.projectConfigurations(options,{action:"get"}) as ProjectConfigurationState;
    const third={id:"third",name:"Custom",source:"third-party",model:"model",apiKind:"openai-responses",baseUrl:"https://example.test/v1",apiKey:"test-only-key"};
    state=await storage.projectConfigurations(options,{action:"save",revision:state.revision,id:state.activeConfigurationId,values:{[key]:[third]}}) as ProjectConfigurationState;
    state=await storage.projectConfigurations(options,{action:"publication.save",revision:state.revision,publication:state.publication}) as ProjectConfigurationState;
    const oldRevision=state.revision;
    await storage.saveDraftFiles({projectName:id,files:[{path:"configuration.json",content:definition(true)}]});
    state=await storage.projectConfigurations(options,{action:"get"}) as ProjectConfigurationState;
    assert.ok(state.revision>oldRevision);assert.equal(state.publication!.fields[0]!.allowThirdParty,false);
    assert.deepEqual(configurationSnapshot(state).values[key],[third]);
    await assert.rejects(storage.projectConfigurations(options,{action:"save",revision:oldRevision,id:state.activeConfigurationId,values:{[key]:[]}}),/changed/);
    const publication=structuredClone(state.publication!);
    delete publication.agentModelPolicy;publication.fields[0]!.allowThirdParty=true;publication.fields[0]!.sharing={publish:false};
    state=await storage.projectConfigurations(options,{action:"publication.save",revision:state.revision,publication}) as ProjectConfigurationState;
    const preview=await storage.projectConfigurations(options,{action:"publication.preview",publication}) as ProjectConfigurationState;
    assert.deepEqual(preview.publicationPreview!.agentModelPolicy,{allowThirdParty:false});
    await storage.publish({projectName:id,createdByUserId:"author",expectedSourceHash:state.sourceHash,expectedConfigurationRevisions:{main:state.publication!.revision}});
    const template=(await db.readConfigurationTemplate(id,"main","1.0.0"))!;
    assert.deepEqual(template.agentModelPolicy,{allowThirdParty:false});assert.deepEqual(template.fields,[]);assert.ok(!JSON.stringify(template).includes(third.apiKey));
    const recipient=await storage.projectConfigurations({projectName:id,actorId:"recipient",target:"1.0.0"},{action:"get"}) as ProjectConfigurationState;
    assert.deepEqual(recipient.fields,[]);assert.deepEqual(configurationSnapshot(recipient).agentModelPolicy,{allowThirdParty:false});
  } finally {
    await accounts.close();await db.close();await rm(root,{recursive:true,force:true});
    await admin.query(`drop schema ${schema} cascade`);await admin.end();
  }
});

test('Server startup preserves unsupported project rows, snapshots and storage', {
  skip: databaseUrl ? false : 'STEAMHARNESS_TEST_DATABASE_URL is not configured',
}, async () => {
  const schema = `startup_preservation_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`create schema ${schema}`);
  const url = new URL(databaseUrl!); url.searchParams.set('options', `-c search_path=${schema}`);
  const db = new DatabaseRepository(url.toString()), raw = new pg.Pool({ connectionString: url.toString() });
  const id = randomUUID();
  try {
    await db.init();
    await raw.query(`alter table projects alter column entries drop not null;
      alter table projects alter column default_entry drop not null;
      alter table projects add column project_type text not null default 'workflow';
      alter table project_versions alter column entries drop not null;
      alter table project_versions alter column default_entry drop not null;`);
    await raw.query('insert into projects(id,name) values($1,$2)', [id, 'Retained project']);
    await raw.query(`insert into project_versions(project_id,version,project_name,created_at,source_hash,source_object_path)
      values($1,'1.0.0','Retained project',now(),'hash','source.tgz')`, [id]);
    await raw.query(`insert into project_storage(storage_kind,scope,project_id,key,value) values('kv','project',$1,'retained','true')`, [id]);
    await db.init();
    assert.equal((await raw.query('select project_type from projects where id=$1', [id])).rows[0].project_type, 'workflow');
    assert.equal((await raw.query('select count(*)::int as total from project_versions where project_id=$1', [id])).rows[0].total, 1);
    assert.equal((await raw.query('select value from project_storage where project_id=$1', [id])).rows[0].value, true);
    assert.deepEqual(await db.listProjects(), []);
    assert.equal(await db.getProject(id), undefined);
    await raw.query(`insert into projects(id,name,entries,default_entry) values($1,'New project',$2,'main')`, [randomUUID(), JSON.stringify([{entryId:'main',name:'Main',type:'workflow',root:'.',entry:'index.ts',databases:[]}])]);
    assert.equal((await db.listProjects()).length, 1);
  } finally {
    await db.close(); await raw.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end();
  }
});
