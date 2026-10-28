import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { declareConfigurationFixture, writeConfigurationFixtureManifest, configurationFixtureStore } from "./configuration-fixture";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {cacheVerifiedConfigurationTemplate,readCachedConfigurationFile,createConfigurationState,createPublicationDraft,freezeConfigurationTemplate,configurationTemplatePath, createLocalProjectConfigurationStore, getConfig, withProjectConfiguration, currentConfigurationValues, type ProjectConfigurationState } from "../configuration";

test("local configuration uses canonical paths, atomic versions and persisted run snapshots", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(),"project-config-"));
  try {
    const project = path.join(temp,"project"), other = path.join(temp,"other"), rootDir = path.join(temp,"values");
    await mkdir(project); await mkdir(other);
    await writeFile(path.join(project,"configuration.json"),JSON.stringify({version:1,fields:[{name:"token",type:"string",secret:true}]}));
    await writeFile(path.join(project,".env"),"token=must-not-load");
    const a = await configurationFixtureStore(project,{rootDir});
    const b = await configurationFixtureStore(project,{rootDir});
    const initial = await a.read();
    const writes = await Promise.allSettled([a.dispatch({action:"save",revision:0,id:initial.activeConfigurationId,values:{token:"one"}}),b.dispatch({action:"save",revision:0,id:initial.activeConfigurationId,values:{token:"two"}})]);
    assert.equal(writes.filter(item => item.status === "fulfilled").length,1);
    const frozen = await a.snapshot({runId:"waiting"});
    const latest = await b.read();
    await b.dispatch({action:"save",revision:latest.revision,id:latest.activeConfigurationId,values:{token:"new"}});
    assert.deepEqual(await b.snapshot({runId:"waiting"}),frozen);
    assert.equal((await a.snapshot()).values.token,"new");
    assert.deepEqual((await (await configurationFixtureStore(other,{rootDir})).snapshot()).values,{});
    const link = path.join(temp,"linked"); await symlink(project,link,"junction");
    assert.deepEqual(await (await configurationFixtureStore(link,{rootDir})).read(),await a.read());
    const before = await a.read();
    await assert.rejects(a.dispatch({action:"import",revision:before.revision,document:{version:1,kind:"steamharness-project-configurations",fields:[{name:"token",type:"number"}],configurations:[{name:"bad",values:{token:2}}]}}));
    assert.deepEqual(await a.read(),before);
  } finally { await rm(temp,{recursive:true,force:true}); }
});
test("configuration scope isolates asynchronous runs and freezes nested values", async () => {
  process.env.PROJECT_CONFIG_TEST = "environment";
  try {
    assert.equal(getConfig("PROJECT_CONFIG_TEST"),undefined);
    await Promise.all(["a","b"].map(value => withProjectConfiguration({id:value,name:value,revision:0,values:{PROJECT_CONFIG_TEST:value,nested:{value}}},async () => {
      await new Promise(resolve => setTimeout(resolve,5));
      assert.equal(getConfig("PROJECT_CONFIG_TEST"),value);
      assert.throws(() => { (currentConfigurationValues().nested as any).value = "mutated"; });
    })));
    assert.equal(getConfig("PROJECT_CONFIG_TEST"),undefined);
    assert.equal(process.env.PROJECT_CONFIG_TEST,"environment");
  } finally { delete process.env.PROJECT_CONFIG_TEST; }
});

test("schema changes retain inactive values and shadowed custom definitions on disk", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(),"configuration-schema-"));
  try {
    const rootDir = path.join(temp,"values");
    const store = await configurationFixtureStore(temp,{rootDir});
    const declared = [{name:"label",type:"string"}];
    const declare = (fields:unknown[]) => writeFile(path.join(temp,"configuration.json"),JSON.stringify({version:1,fields}));
    await declare(declared);
    let state = await store.read();
    state = await store.dispatch({action:"field.save",revision:state.revision,field:{name:"custom",type:"boolean"}}) as ProjectConfigurationState;
    await store.dispatch({action:"save",revision:state.revision,id:state.activeConfigurationId,values:{label:"saved",custom:false}});
    await declare([{name:"custom",type:"boolean",label:"Declared"}]);
    assert.deepEqual((await store.snapshot()).values,{custom:false});
    state = await store.read();
    await store.dispatch({action:"rename",revision:state.revision,id:state.activeConfigurationId,name:"Changed"});
    await declare(declared);
    state = await (await configurationFixtureStore(temp,{rootDir})).read();
    assert.deepEqual(state.customFields,[{name:"custom",type:"boolean"}]);
    assert.deepEqual((await store.snapshot()).values,{label:"saved",custom:false});
  } finally { await rm(temp,{recursive:true,force:true}); }
});

test("configuration lookup returns only explicitly configured keys", () => {
  withProjectConfiguration({id:"empty", name:"Empty", revision:0, values:{}}, () => {
    assert.equal(getConfig("toString"), undefined);
    assert.equal(getConfig("hasOwnProperty"), undefined);
  });
  withProjectConfiguration({id:"named", name:"Named", revision:0, values:{toString:"configured", hasOwnProperty:false}}, () => {
    assert.equal(getConfig("toString"), "configured");
    assert.equal(getConfig("hasOwnProperty"), false);
  });
});

test("independent local processes enforce the same configuration revision", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "configuration-processes-"));
  try {
    const rootDir = path.join(temp, "values");
    const store = await configurationFixtureStore(temp, {rootDir});
    const initial = await store.read();
    const source = `
      import {createLocalProjectConfigurationStore} from ${JSON.stringify(new URL("../configuration.ts", import.meta.url).href)};
      const store = await createLocalProjectConfigurationStore(process.argv[1], {rootDir:process.argv[2]});
      try {
        await store.dispatch({action:"rename", revision:0, id:process.argv[3], name:process.argv[4]});
        process.stdout.write("saved");
      } catch (error) { process.stdout.write(error.code ?? String(error)); }
    `;
    const run = promisify(execFile);
    const writes = await Promise.all(["one", "two"].map(name => run(process.execPath, ["--import", "tsx", "--conditions=development", "--input-type=module", "-e", source, temp, rootDir, initial.activeConfigurationId, name], {timeout:15_000})));
    assert.deepEqual(writes.map(item => item.stdout).sort(), ["CONFIGURATION_CONFLICT", "saved"]);
    assert.equal((await store.read()).revision, 1);
  } finally { await rm(temp, {recursive:true, force:true}); }
});

for (const explicit of [false,true]) test(`an automatically assigned run ID keeps its ${explicit ? "explicit" : "local"} configuration when waiting input resumes`, async () => {
  const {runLocalProjectWithReport} = await import("../index");
  const project = await mkdtemp(path.join(os.tmpdir(), "configuration-resume-"));
  const applicationId = randomUUID();
  const key = createHash("sha256").update(`${applicationId}:main`).digest("hex");
  const runKey = key;
  const root = path.join(os.homedir(), ".steamharness", "configurations");
  try {
    await writeProjectFixture(path.join(project, "package.json"), JSON.stringify({id:applicationId, name:"config-resume", type:"module", version: "0.1.0", defaultEntry:"main",entries:[{entryId:"main",type:"workflow",name:"Main",root:".",entry:"index.ts",databases:[], configuration:"configuration.json"}], projectInfo:{}}));
    await writeFile(path.join(project, "configuration.json"), JSON.stringify({version:1, fields:[{name:"label", type:"string", defaultValue:"before"}]}));
    await writeFile(path.join(project, "index.ts"), `
      const approvalNode = steamharness.createUserInputNode({name:"confirm", params:[{name:"approved", type:"boolean", flag:"--approved"}]});
      const task = steamharness.defineProject({name:"config-resume", async run(input, context) {
        await steamharness.runNode(approvalNode, {}, context);
        return {errCode:0, errMessage:"", label:context.config.label};
      }});
      export const executor = steamharness.defineExecutor({projectType:"workflow", defaultEntrypoint:"main", entrypoints:[steamharness.defineEntrypoint({id:"main", title:"Main", workflow:task, createInput(){return {};}})]});
      export default task;
    `);
    const waiting = await runLocalProjectWithReport({projectDir:project, configuration:explicit ? {id:"provided",name:"Provided",revision:4,values:{label:"explicit"}} : undefined, userInput:{requestInput() {}, getResolvedInput() {return undefined;}}});
    assert.equal(waiting.status, "waiting_for_input", JSON.stringify(waiting.result));
    const store = await configurationFixtureStore(project);
    const state = await store.read();
    await store.dispatch({action:"save", revision:state.revision, id:state.activeConfigurationId, values:{label:"after"}});
    const userInput = {requestInput() {}, getResolvedInput(requestId: string) {return {requestId, nodeName:"confirm", values:{approved:true}, submittedAt:new Date()};}};
    const resumed = await runLocalProjectWithReport({projectDir:project, runId:waiting.runId, userInput});
    assert.equal(resumed.result.ok, true);
    assert.equal(resumed.result.ok && (resumed.result.data as any).output.label, explicit ? "explicit" : "before");
    const next = await runLocalProjectWithReport({projectDir:project, userInput});
    assert.equal(next.result.ok && (next.result.data as any).output.label, "after");
  } finally {
    await rm(project, {recursive:true, force:true});
    await Promise.all([rm(path.join(root, `${key}.json`), {force:true}), rm(path.join(root, `${key}.json.lock.sqlite`), {force:true}), rm(path.join(root, "snapshots", runKey), {recursive:true, force:true})]);
  }
});

test("executor, parameter resolver, nodes and provider factory share one immutable run configuration", async () => {
  const {runLocalProjectWithReport,resolveLocalProjectParams,createLLMProviderFromConfig}=await import("../index");
  const project=await mkdtemp(path.join(os.tmpdir(),"configuration-executor-"));
  const applicationId=randomUUID();
  const key=createHash("sha256").update(`${applicationId}:main`).digest("hex");
  const runKey=key;
  const root=path.join(os.homedir(),".steamharness","configurations");
  try {
    await writeProjectFixture(path.join(project,"package.json"),JSON.stringify({id:applicationId,name:"Configuration",type:"module",version: "0.1.0", defaultEntry:"main",entries:[{entryId:"main",type:"workflow",name:"Main",root:".",entry:"index.ts",databases:[], configuration:"configuration.json"}], projectInfo:{}}));
    await writeFile(path.join(project,"index.ts"), `
const task=steamharness.defineProject({name:"configuration",async run(_input,context){return {errCode:0,errMessage:"",value:steamharness.getConfig("label"),nested:context.config.nested};}});
export const executor=steamharness.defineExecutor({projectType:"workflow",defaultEntrypoint:"main",entrypoints:[steamharness.defineEntrypoint({id:"main",title:"Main",workflow:task,params:[{name:"label",type:"string",flag:"--label"}],createInput({paramValues}){return paramValues;},resolveParams(context){return {params:{label:{value:context.config.label}}};}})]});
export default task;
`);
    await declareConfigurationFixture(project);
    const configuration={id:"test",name:"Test",revision:1,values:{label:"frozen",nested:{active:true}}};
    const result=await runLocalProjectWithReport({projectDir:project,configuration});
    assert.equal((result.result.ok ? result.result.data as any : undefined)?.output?.value,"frozen");
    assert.deepEqual((result.result.ok ? result.result.data as any : undefined)?.output?.nested,{active:true});
    const generation=`${result.runId}:configuration:2`;
    const changed={...configuration,revision:2,values:{label:"updated",nested:{active:false}}};
    const reloaded=await runLocalProjectWithReport({projectDir:project,runId:result.runId,configurationRunId:generation,configuration:changed});
    assert.equal((reloaded.result.ok ? reloaded.result.data as any : undefined)?.output?.value,"updated");
    const recovered=await runLocalProjectWithReport({projectDir:project,runId:result.runId,configurationRunId:generation});
    assert.equal((recovered.result.ok ? recovered.result.data as any : undefined)?.output?.value,"updated");
    const original=await runLocalProjectWithReport({projectDir:project,runId:result.runId});
    assert.equal((original.result.ok ? original.result.data as any : undefined)?.output?.value,"frozen");
    const resolved=await resolveLocalProjectParams({projectDir:project,configuration,request:{draftText:"",args:[],inputMode:"form",trigger:{kind:"init"}}});
    assert.equal(resolved.params?.label?.value,"frozen");
    assert.throws(()=>createLLMProviderFromConfig({}),/Missing required configuration/);
  }finally{
    await rm(project,{recursive:true,force:true});
    await Promise.all([rm(path.join(root,`${key}.json`),{force:true}),rm(path.join(root,`${key}.json.lock.sqlite`),{force:true}),rm(path.join(root,"snapshots",runKey),{recursive:true,force:true})]);
  }
});


test("built-in Agent providers use isolated configuration credentials and never process env", async () => {
  const { createPiRuntime } = await import("../agent/pi");
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "environment-must-not-be-used";
  try {
    const runtimes = await Promise.all(["one", "two"].map(key => withProjectConfiguration({ id: key, name: key, revision: 0, values: { OPENAI_API_KEY: key } },
      () => createPiRuntime({ provider: "openai", model: "gpt-4.1-mini" }))));
    for (const [index, runtime] of runtimes.entries()) {
      assert.equal((await runtime.models.getAuth(runtime.model))?.auth.apiKey, ["one", "two"][index]);
    }
    const runtime = await createPiRuntime({ provider: "openai", model: "gpt-4.1-mini" });
    assert.equal(await runtime.models.getAuth(runtime.model), undefined);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
});

test("unverified source upgrades reject reads and writes without falling back to an older template",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'configuration-upgrade-'));
  try {
    const project=path.join(root,'project'),cacheDir=path.join(root,'cache'),rootDir=path.join(root,'personal');await mkdir(project);await declareConfigurationFixture(project);
    const author=createConfigurationState([{name:'settings',type:'json',defaultValue:{locked:0,open:1},sharing:{includeValue:true},paths:{'/locked':{editable:false}}}],()=> 'official');
    const first=freezeConfigurationTemplate(createPublicationDraft(author),{projectId:JSON.parse(await readFile(path.join(project,'steamharness.json'),'utf8')).id,entryId:"main",projectVersion:'1.0.0',sourceHash:'a'.repeat(64)});
    const sourceFile=path.join(project,configurationTemplatePath("main"));
    await cacheVerifiedConfigurationTemplate(first,[],{cacheDir});await writeFile(sourceFile,JSON.stringify(first));
    const store=await configurationFixtureStore(project,{rootDir,templateCacheDir:cacheDir});
    let state=await store.read();
    state=await store.dispatch({action:'save',revision:state.revision,id:state.activeConfigurationId,values:{settings:{locked:0,open:9}}}) as ProjectConfigurationState;
    const waiting=await store.snapshot({runId:'waiting'});
    const key=createHash('sha256').update(JSON.parse(await readFile(path.join(project,'steamharness.json'),'utf8')).id+':main').digest('hex'),savedFile=path.join(rootDir,`${key}.json`),saved=await readFile(savedFile,'utf8');
    const next=structuredClone(first);next.projectVersion='2.0.0';next.configurations[0]!.values.settings={locked:2,open:2};
    await writeFile(sourceFile,JSON.stringify(next));
    await assert.rejects(store.read(),/online/);
    await assert.rejects(store.snapshot(),/online/);
    await assert.rejects(store.dispatch({action:'rename',revision:state.revision,id:state.activeConfigurationId,name:'Unverified'}),/online/);
    assert.equal(await readFile(savedFile,'utf8'),saved);
    assert.deepEqual(await store.snapshot({runId:'waiting'}),waiting);
    await cacheVerifiedConfigurationTemplate(next,[],{cacheDir});
    state=await store.read();assert.equal(state.template?.projectVersion,'2.0.0');
    assert.deepEqual((await store.snapshot()).values.settings,{locked:2,open:9});
    assert.deepEqual(await store.snapshot({runId:'waiting'}),waiting);
    await rm(sourceFile);
    assert.deepEqual((await store.snapshot()).values.settings,{locked:2,open:9});
    const frozenFile=path.join(rootDir,'snapshots',key,createHash('sha256').update('waiting').digest('hex')+'.json');
    const persisted=JSON.parse(await readFile(frozenFile,'utf8'));
    persisted.snapshot.values.settings.locked=3;
    await writeFile(frozenFile,JSON.stringify(persisted));
    await assert.rejects(store.snapshot({runId:'waiting'}),/locked/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("verified templates enforce offline edits, preserve waiting runs, and cache immutable attachments outside source",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'configuration-offline-'));
  try {
    const project=path.join(root,'project'),cacheDir=path.join(root,'cache'),rootDir=path.join(root,'personal');await mkdir(project);await declareConfigurationFixture(project);
    const bytes=Buffer.from('versioned-image'),reference={id:'wf_abcdef',name:'background.png',mimeType:'image/png',size:bytes.length,storage:'server' as const};
    const author=createConfigurationState([{name:'settings',type:'json',defaultValue:{locked:0,open:1},sharing:{includeValue:true},paths:{'/locked':{editable:false}}},{name:'background',type:'file',defaultValue:reference,sharing:{includeValue:true,editable:false}}],()=> 'profile');
    const template=freezeConfigurationTemplate(createPublicationDraft(author),{projectId:JSON.parse(await readFile(path.join(project,'steamharness.json'),'utf8')).id,entryId:"main",projectVersion:'1.0.0',sourceHash:'a'.repeat(64)});
    template.attachments=[{id:reference.id,path:`configuration-assets/${reference.id}`,sha256:createHash('sha256').update(bytes).digest('hex')}];
    await writeFile(path.join(project,configurationTemplatePath("main")),JSON.stringify(template));
    const options={rootDir,templateCacheDir:cacheDir};
    const store=await configurationFixtureStore(project,options);
    await assert.rejects(store.read(),/online/);
    await assert.rejects(cacheVerifiedConfigurationTemplate(template,[{id:reference.id,bytes:Buffer.from('wrong')}],{cacheDir}),/hash mismatch/);
    await cacheVerifiedConfigurationTemplate(template,[{id:reference.id,bytes}],{cacheDir});
    let state=await store.read();assert.equal((await store.read()).revision,state.revision);
    const waiting=await store.snapshot({runId:'waiting'});
    await assert.rejects(store.dispatch({action:'save',revision:state.revision,id:state.activeConfigurationId,values:{settings:{locked:3,open:4}}}),/locked/);
    state=await store.dispatch({action:'save',revision:state.revision,id:state.activeConfigurationId,values:{settings:{locked:0,open:4}}}) as ProjectConfigurationState;
    assert.deepEqual((await store.snapshot()).values.settings,{locked:0,open:4});
    assert.deepEqual(await store.snapshot({runId:'waiting'}),waiting);
    await rm(path.join(project,configurationTemplatePath("main")));
    assert.deepEqual((await store.snapshot()).values.settings,{locked:0,open:4});
    const file=await readCachedConfigurationFile(project,reference.id,options);assert.equal(Buffer.from(file!.base64,'base64').toString(),bytes.toString());
    await assert.rejects(store.dispatch({action:'publication.save',revision:state.revision,publication:createPublicationDraft(state)}),/online/);
  } finally {await rm(root,{recursive:true,force:true});}
});
