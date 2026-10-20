import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLocalProjectConfigurationStore, getConfig, withProjectConfiguration, currentConfigurationValues, type ProjectConfigurationState } from "../configuration";

test("local configuration uses canonical paths, atomic versions and persisted run snapshots", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(),"project-config-"));
  try {
    const project = path.join(temp,"project"), other = path.join(temp,"other"), rootDir = path.join(temp,"values");
    await mkdir(project); await mkdir(other);
    await writeFile(path.join(project,"configuration.json"),JSON.stringify({version:1,fields:[{name:"token",type:"string",secret:true}]}));
    await writeFile(path.join(project,".env"),"token=must-not-load");
    const a = await createLocalProjectConfigurationStore(project,{rootDir});
    const b = await createLocalProjectConfigurationStore(project,{rootDir});
    const initial = await a.read();
    const writes = await Promise.allSettled([a.dispatch({action:"save",revision:0,id:initial.activeConfigurationId,values:{token:"one"}}),b.dispatch({action:"save",revision:0,id:initial.activeConfigurationId,values:{token:"two"}})]);
    assert.equal(writes.filter(item => item.status === "fulfilled").length,1);
    const frozen = await a.snapshot({runId:"waiting"});
    const latest = await b.read();
    await b.dispatch({action:"save",revision:latest.revision,id:latest.activeConfigurationId,values:{token:"new"}});
    assert.deepEqual(await b.snapshot({runId:"waiting"}),frozen);
    assert.equal((await a.snapshot()).values.token,"new");
    assert.deepEqual((await (await createLocalProjectConfigurationStore(other,{rootDir})).snapshot()).values,{});
    const link = path.join(temp,"linked"); await symlink(project,link,"junction");
    assert.deepEqual(await (await createLocalProjectConfigurationStore(link,{rootDir})).read(),await a.read());
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

test("independent local processes enforce the same configuration revision", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "configuration-processes-"));
  try {
    const rootDir = path.join(temp, "values");
    const store = await createLocalProjectConfigurationStore(temp, {rootDir});
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

test("an automatically assigned run ID keeps its configuration when waiting input resumes", async () => {
  const {runLocalProjectWithReport} = await import("../index");
  const project = await mkdtemp(path.join(os.tmpdir(), "configuration-resume-"));
  const key = createHash("sha256").update(project).digest("hex");
  const root = path.join(os.homedir(), ".steamharness", "configurations");
  try {
    await writeFile(path.join(project, "package.json"), JSON.stringify({id:"793fdc09-0b24-4750-9f88-3a19fa777712", name:"config-resume", type:"module", steamHarness:{projectInfo:{dataStorage:{mode:"local"}}}}));
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
    const waiting = await runLocalProjectWithReport({projectDir:project, userInput:{requestInput() {}, getResolvedInput() {return undefined;}}});
    assert.equal(waiting.status, "waiting_for_input", JSON.stringify(waiting.result));
    const store = await createLocalProjectConfigurationStore(project);
    const state = await store.read();
    await store.dispatch({action:"save", revision:state.revision, id:state.activeConfigurationId, values:{label:"after"}});
    const userInput = {requestInput() {}, getResolvedInput(requestId: string) {return {requestId, nodeName:"confirm", values:{approved:true}, submittedAt:new Date()};}};
    const resumed = await runLocalProjectWithReport({projectDir:project, runId:waiting.runId, userInput});
    assert.equal(resumed.result.ok, true);
    assert.equal(resumed.result.ok && (resumed.result.data as any).output.label, "before");
    const next = await runLocalProjectWithReport({projectDir:project, userInput});
    assert.equal(next.result.ok && (next.result.data as any).output.label, "after");
  } finally {
    await rm(project, {recursive:true, force:true});
    await Promise.all([rm(path.join(root, `${key}.json`), {force:true}), rm(path.join(root, `${key}.json.lock.sqlite`), {force:true}), rm(path.join(root, "snapshots", key), {recursive:true, force:true})]);
  }
});

test("executor, parameter resolver, nodes and provider factory share one immutable run configuration", async () => {
  const {runLocalProjectWithReport,resolveLocalProjectParams,createLLMProviderFromConfig}=await import("../index");
  const project=await mkdtemp(path.join(os.tmpdir(),"configuration-executor-"));
  const rootDir=path.join(project,"private-values");
  try {
    await writeFile(path.join(project,"package.json"),JSON.stringify({id:"4c225ac1-1ab8-4196-8cba-4d5548eefcb0",name:"Configuration",type:"module",steamHarness:{projectInfo:{dataStorage:{mode:"local"}}}}));
    await writeFile(path.join(project,"index.ts"), `
const task=steamharness.defineProject({name:"configuration",async run(_input,context){return {errCode:0,errMessage:"",value:steamharness.getConfig("label"),nested:context.config.nested};}});
export const executor=steamharness.defineExecutor({projectType:"workflow",defaultEntrypoint:"main",entrypoints:[steamharness.defineEntrypoint({id:"main",title:"Main",workflow:task,params:[{name:"label",type:"string",flag:"--label"}],createInput({paramValues}){return paramValues;},resolveParams(context){return {params:{label:{value:context.config.label}}};}})]});
export default task;
`);
    const configuration={id:"test",name:"Test",revision:1,values:{label:"frozen",nested:{active:true}}};
    const result=await runLocalProjectWithReport({projectDir:project,configuration});
    assert.equal((result.result.ok ? result.result.data as any : undefined)?.output?.value,"frozen");
    assert.deepEqual((result.result.ok ? result.result.data as any : undefined)?.output?.nested,{active:true});
    const resolved=await resolveLocalProjectParams({projectDir:project,configuration,request:{draftText:"",args:[],inputMode:"form",trigger:{kind:"init"}}});
    assert.equal(resolved.params?.label?.value,"frozen");
    assert.throws(()=>createLLMProviderFromConfig({}),/Missing required configuration/);
  }finally{await rm(project,{recursive:true,force:true});}
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
