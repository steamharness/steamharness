import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalProjectWithReport } from "../index";
import { LocalDatabaseRegistry, createLocalDatabaseResolver, type DatabaseRequirement } from "../databases/index";

async function fixture(host: "local" | "server") {
  const directory=await mkdtemp(path.join(os.tmpdir(),"entry-storage-"));
  const projectId=randomUUID();const all={mode:"all" as const};
  const requirement:DatabaseRequirement={alias:"data",host,permissions:{kv:{read:all,write:all},knowledge:{read:all,write:all}}};
  const pkg={id:projectId,name:"storage-test",type:"module",steamHarness:{defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",databases:[requirement]}]}};
  await writeFile(path.join(directory,"package.json"),JSON.stringify(pkg));
  await writeFile(path.join(directory,"index.ts"),`
    const flow=steamharness.defineProject({name:"storage",async run(_input,context){
      if(Reflect.has(context,"storage")||Reflect.has(context,"kv")||Reflect.has(context,"persistentValue"))throw new Error("Removed database getter exists");
      const database=context.databases.get("data");await database.kv.setValue("value",context.entryId);
      return {errCode:0,errMessage:"",value:await database.kv.getValue("value")};
    }});
    export const executor=steamharness.defineExecutor({projectType:"workflow",defaultEntrypoint:"write",entrypoints:[steamharness.defineEntrypoint({id:"write",title:"Write",workflow:flow,createInput(){return {};}})]});
  `);
  const registry=new LocalDatabaseRegistry(path.join(directory,"registry"));
  return {directory,projectId,requirement,pkg,registry};
}

test("executors require explicitly approved bindings and expose databases instead of project storage",async t=>{
  const f=await fixture("local");t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const resolver=createLocalDatabaseResolver(f.registry);
  const run=()=>runLocalProjectWithReport({projectDir:f.directory,databaseResolver:resolver});
  const unbound=await run();assert.equal(unbound.status,"failed");assert.match(JSON.stringify(unbound.result),/approved local binding/);
  assert.equal(f.registry.read().spaces.length,0);
  const request=f.registry.request({projectId:f.projectId,entryId:"main",alias:"data",target:{kind:"create",name:"Data"},permissions:f.requirement.permissions});
  assert.equal((await run()).status,"failed");assert.equal(f.registry.read().spaces.length,0);
  const approved=f.registry.review(request.requestId,{approve:true});
  f.requirement.bindingRef=approved.bindingRef;
  await writeFile(path.join(f.directory,"package.json"),JSON.stringify(f.pkg));
  const report=await run();assert.equal(report.status,"success",JSON.stringify(report.result));
  assert.equal(report.result.ok&&(report.result.data as any).output.value,"main");
  f.registry.revoke(f.registry.authorization(approved.bindingRef!)!.grant.grantId);
  assert.equal((await run()).status,"failed");assert.equal(f.registry.read().spaces.length,1);
});

test("server requirements never fall back to an available local resolver",async t=>{
  const f=await fixture("server");t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const report=await runLocalProjectWithReport({projectDir:f.directory,databaseResolver:createLocalDatabaseResolver(f.registry),env:{}});
  assert.equal(report.status,"failed");assert.match(JSON.stringify(report.result),/approved server binding/);
  assert.equal(f.registry.read().spaces.length,0);
});

test("removed project database declarations are rejected without importing data",async t=>{
  const f=await fixture("local");t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const pkg=JSON.parse(await readFile(path.join(f.directory,"package.json"),"utf8"));pkg.steamHarness.projectInfo={dataStorage:{mode:"both"}};
  await writeFile(path.join(f.directory,"package.json"),JSON.stringify(pkg));
  await assert.rejects(runLocalProjectWithReport({projectDir:f.directory}),/dataStorage was removed/);
  assert.equal(f.registry.read().spaces.length,0);
});
