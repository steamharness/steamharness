// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProjectDeclaration, projectEntryDeclarationPath } from "../index";
import { readProjectDeclarationFromDirectory, readProjectDeclarationFromDirectorySync, readProjectManifestFromDirectory } from "../node";
import { createProjectUploadPlan, copyProjectUploadFiles } from "../../project-upload/node";
const id = "00000000-0000-4000-8000-000000000001";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, {recursive:true,force:true}))); });
const rootDocument = () => ({id,name:"Product name",version:"1.2.3",defaultEntry:"agent",entries:[{entryId:"agent",root:"agent"}]});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "declaration-files-")); directories.push(root);
  await mkdir(path.join(root,"agent")); await mkdir(path.join(root,"unregistered"));
  await writeFile(path.join(root,"package.json"), JSON.stringify({name:"npm-package",version:"9.8.7",private:true,type:"module"}));
  await writeFile(path.join(root,"steamharness.json"), JSON.stringify(rootDocument()));
  await writeFile(path.join(root,"agent/steamharness.json"), JSON.stringify({type:"conversation",name:"Agent",entry:"index.ts",projectCard:{icon:"bot",iconColor:"#ffffff",iconBackgroundColor:"#123456"},projectInfo:{localizedNames:{en:"Child name"}},databases:["data"]}));
  await writeFile(path.join(root,"agent/index.ts"), "export {};");
  await writeFile(path.join(root,"unregistered/steamharness.json"), "invalid JSON is never loaded");
  await writeFile(path.join(root,"config.json"), JSON.stringify({version:1,databases:{data:id}}));
  return root;
}
it("uses only registered child declarations and keeps identity independent from npm metadata", async () => {
  const root = await fixture(), manifest = await readProjectManifestFromDirectory(root, {});
  expect(manifest).toMatchObject({projectId:id,name:"Product name",version:"1.2.3",entries:[{entryId:"agent",name:"Agent",root:"agent",type:"conversation",projectCard:{icon:"bot",iconBackgroundColor:"#123456"},projectInfo:{localizedNames:{en:"Child name"}},databases:[{alias:"data",databaseId:id}]}]});
  expect(readProjectDeclarationFromDirectorySync(root)).toEqual(await readProjectDeclarationFromDirectory(root));
  expect(projectEntryDeclarationPath(rootDocument(), "agent")).toBe("agent/steamharness.json");
});
it("requires the new root file and never falls back to a package declaration", async () => {
  const root = await fixture(); await rm(path.join(root,"steamharness.json"));
  await writeFile(path.join(root,"package.json"), JSON.stringify({...rootDocument(),steamHarness:{defaultEntry:"agent",entries:[]}}));
  await expect(readProjectManifestFromDirectory(root)).rejects.toThrow(/steamharness.json/);
  expect(() => readProjectDeclaration({id,name:"old",steamHarness:{entries:[]}})).toThrow();
});
it("keeps parent presentation separate from a child's optional metadata", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "steamharness.json"), JSON.stringify({
    ...rootDocument(),
    projectCard: { icon: "workflow", iconBackgroundColor: "#2563eb" },
    projectInfo: { localizedNames: { en: "Parent title" }, declarations: ["multilingual"] },
  }));
  await writeFile(path.join(root, "agent/steamharness.json"), JSON.stringify({
    type: "conversation", name: "Child title", entry: "index.ts", databases: [],
  }));
  const declaration = await readProjectDeclarationFromDirectory(root);
  expect(declaration.projectInfo?.localizedNames.en).toBe("Parent title");
  expect(declaration.projectCard?.icon).toBe("workflow");
  expect(declaration.entries[0]).toMatchObject({ name: "Child title", databases: [] });
  expect(declaration.entries[0]?.projectInfo).toBeUndefined();
  expect(declaration.entries[0]?.projectCard).toBeUndefined();
});
it("rejects missing children, parent overrides and child project identities", async () => {
  const root = await fixture();
  await writeFile(path.join(root,"agent/steamharness.json"), JSON.stringify({id,type:"conversation",name:"Agent",entry:"index.ts"}));
  await expect(readProjectDeclarationFromDirectory(root)).rejects.toThrow(/child entries/);
  await rm(path.join(root,"agent/steamharness.json"));
  await expect(readProjectDeclarationFromDirectory(root)).rejects.toThrow(/steamharness.json/);
  expect(() => readProjectDeclaration({...rootDocument(),entries:[{entryId:"agent",root:"agent",entry:"index.ts"}]})).toThrow(/only entryId and root/);
});
it("rejects symlinks in child roots and child configuration files that escape their declared directories", async () => {
  const root = await fixture(), outside = await fixture();
  await rm(path.join(root,"agent"),{recursive:true}); await symlink(path.join(outside,"agent"),path.join(root,"agent"),"dir");
  await expect(readProjectDeclarationFromDirectory(root)).rejects.toThrow(/inside/);
  await rm(path.join(root,"agent"));await mkdir(path.join(root,"agent"));
  await symlink(path.join(outside,"agent/steamharness.json"),path.join(root,"agent/steamharness.json"));
  await expect(readProjectDeclarationFromDirectory(root)).rejects.toThrow(/inside/);
});
it("requires referenced declarations in source uploads and preserves references through a round trip", async () => {
  const root = await fixture();
  await writeFile(path.join(root,".steamharnessignore"),"agent/steamharness.json\n");
  await expect(createProjectUploadPlan(root)).rejects.toThrow(/Required upload path/);
  await writeFile(path.join(root,".steamharnessignore"),"unregistered/\n");
  const target = await mkdtemp(path.join(os.tmpdir(),"declaration-copy-"));directories.push(target);
  const npm = await readFile(path.join(root,"package.json"),"utf8");
  await copyProjectUploadFiles(root,target);
  expect(await readFile(path.join(target,"package.json"),"utf8")).toBe(npm);
  expect(JSON.parse(await readFile(path.join(target,"steamharness.json"),"utf8"))).toEqual(rootDocument());
  expect(await readProjectManifestFromDirectory(target,{})).toEqual(await readProjectManifestFromDirectory(root,{}));
});
