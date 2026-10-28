import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalProjectConfigurationStore, type ProjectConfigurationState } from "../configuration";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "application-configuration-"));
  const rootDir = path.join(directory, "values"), applicationId = randomUUID();
  const application = async (name: string, id: string | undefined = applicationId) => {
    const project = path.join(directory, name); await mkdir(project);
    await writeFile(path.join(project, "package.json"), JSON.stringify({name:"same-package-name", id,type:"module",steamHarness:{defaultEntry:"main",entries:["main","second"].map(entryId=>({entryId,type:"workflow",name:entryId,root:".",entry:"index.ts",configuration:"configuration.json",databases:[]}))}}));
    await writeFile(path.join(project, "index.ts"),"export {};");
    await writeFile(path.join(project, "configuration.json"), JSON.stringify({version:1,fields:[{name:"label",type:"string"},{name:"enabled",type:"boolean"}]}));
    return project;
  };
  return {directory, rootDir, applicationId, application};
}

test("application copies share profiles, custom fields, values and the active selection", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, {recursive:true,force:true}));
  const a = await createLocalProjectConfigurationStore(await f.application("first"), {rootDir:f.rootDir});
  const b = await createLocalProjectConfigurationStore(await f.application("second", f.applicationId.toUpperCase()), {rootDir:f.rootDir});
  let state = await a.read();
  state = await a.dispatch({action:"field.save",revision:state.revision,field:{name:"custom",type:"number"}}) as ProjectConfigurationState;
  state = await a.dispatch({action:"save",revision:state.revision,id:state.activeConfigurationId,values:{label:"shared",enabled:false,custom:0}}) as ProjectConfigurationState;
  state = await a.dispatch({action:"duplicate",revision:state.revision,id:state.activeConfigurationId,name:"Shared copy"}) as ProjectConfigurationState;
  assert.deepEqual(await b.read(), state);
  state = await b.dispatch({action:"select",revision:state.revision,id:state.configurations[0]!.id}) as ProjectConfigurationState;
  assert.deepEqual(await a.read(), state);
  assert.deepEqual((await b.snapshot()).values, {label:"shared",enabled:false,custom:0});
  const other = await createLocalProjectConfigurationStore(await f.application("different-app", randomUUID()), {rootDir:f.rootDir});
  assert.deepEqual((await other.snapshot()).values, {});
  const accountA = await createLocalProjectConfigurationStore(await f.application("server-a"), {rootDir:f.rootDir,storageKey:"server:project:account-a"});
  const accountB = await createLocalProjectConfigurationStore(await f.application("server-b"), {rootDir:f.rootDir,storageKey:"server:project:account-b"});
  const personal = await accountA.read();
  await accountA.dispatch({action:"save",revision:personal.revision,id:personal.activeConfigurationId,values:{label:"account-a"}});
  assert.deepEqual((await accountB.snapshot()).values, {});
  assert.equal((await a.snapshot()).values.label, "shared");
});

test("entries isolate profiles and run snapshots without adopting legacy directory data", async t => {
  const f=await fixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const project=await f.application("aggregate");
  const legacy=await createLocalProjectConfigurationStore(project,{rootDir:f.rootDir,storageKey:await realpath(project)});
  let old=await legacy.read();await legacy.dispatch({action:"save",revision:old.revision,id:old.activeConfigurationId,values:{label:"legacy"}});
  const a=await createLocalProjectConfigurationStore(project,{rootDir:f.rootDir,entryId:"main"});
  const b=await createLocalProjectConfigurationStore(project,{rootDir:f.rootDir,entryId:"second"});
  assert.deepEqual((await a.snapshot()).values,{});
  let state=await a.read();await a.dispatch({action:"save",revision:state.revision,id:state.activeConfigurationId,values:{label:"first"}});
  const waiting=await a.snapshot({runId:"same-run"});
  state=await b.read();await b.dispatch({action:"save",revision:state.revision,id:state.activeConfigurationId,values:{label:"second"}});
  assert.equal((await b.snapshot({runId:"same-run"})).values.label,"second");
  assert.deepEqual(await a.snapshot({runId:"same-run"}),waiting);
  assert.equal((await legacy.snapshot()).values.label,"legacy");
});

test("independent processes editing two installations enforce one application revision", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, {recursive:true,force:true}));
  const projects = await Promise.all([f.application("window-a"),f.application("window-b")]);
  const store = await createLocalProjectConfigurationStore(projects[0]!, {rootDir:f.rootDir}), initial = await store.read();
  const source = `
    import {createLocalProjectConfigurationStore} from ${JSON.stringify(new URL("../configuration.ts", import.meta.url).href)};
    const store=await createLocalProjectConfigurationStore(process.argv[1],{rootDir:process.argv[2]});
    try { await store.dispatch({action:"rename",revision:0,id:process.argv[3],name:process.argv[4]});process.stdout.write("saved"); }
    catch(error) {process.stdout.write(error.code??String(error));}
  `;
  const run = promisify(execFile);
  const writes = await Promise.all(projects.map((project, index) => run(process.execPath, ["--import","tsx","--conditions=development","--input-type=module","-e",source,project,f.rootDir,initial.activeConfigurationId,`window-${index}`], {timeout:15_000})));
  assert.deepEqual(writes.map(item => item.stdout).sort(), ["CONFIGURATION_CONFLICT","saved"]);
  assert.equal((await store.read()).revision, 1);
  assert.deepEqual(await store.read(), await (await createLocalProjectConfigurationStore(projects[1]!, {rootDir:f.rootDir})).read());
});

test("configuration rejects unregistered projects and invalid project identities", async t => {
  const f=await fixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  for(const id of ["invalid",undefined]) {
    const project=await f.application(`invalid-${id}`,id);
    if(id===undefined)await writeFile(path.join(project,"package.json"),JSON.stringify({name:"same-package-name"}));
    await assert.rejects(createLocalProjectConfigurationStore(project,{rootDir:f.rootDir}),/aggregate project's UUID/);
  }
  const project=await f.application("legacy");await writeFile(path.join(project,"package.json"),JSON.stringify({id:f.applicationId,name:"legacy",steamHarness:{projectType:"workflow"}}));
  await assert.rejects(createLocalProjectConfigurationStore(project,{rootDir:f.rootDir}),/was removed/);
  await writeFile(path.join(project,"package.json"),"{");
  await assert.rejects(createLocalProjectConfigurationStore(project,{rootDir:f.rootDir}),SyntaxError);
});
