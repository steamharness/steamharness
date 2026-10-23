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
import type { ProjectGroupManifestV1 } from "@steamharness/project-dependencies";
import { defaultProjectCardIcon, getProjectCardColorContrastRatio } from "@steamharness/project-card-metadata";
import { LocalStorage } from "../local-storage";
import { ArtifactStorage, DatabaseRepository } from "../persistence";
import { Storage } from "../storage";
import { AGENT_MODELS_CONFIGURATION_FIELD, AGENT_MODELS_CONFIGURATION_KEY as key, configurationSnapshot, type ProjectConfigurationState } from "@steamharness/project-configuration";

const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL?.trim();

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
    const id=randomUUID(),projectInfo={localizedNames:{},declarations:[],platformSupport:{mode:"agnostic" as const},dataStorage:{mode:"server" as const},relatedProjects:[]};
    await storage.createProject({projectId:id,projectName:"AI policy",projectType:"conversation",ownerUserId:"author",projectInfo});
    const core = JSON.parse(await readFile(new URL("../../node_modules/steamharness/package.json",import.meta.url),"utf8"));
    const definition = (restricted:boolean)=>JSON.stringify({version:2,fields:[{...AGENT_MODELS_CONFIGURATION_FIELD,...(restricted?{allowThirdParty:false}:{})}]});
    await storage.saveDraftFiles({projectName:id,files:[
      {path:"package.json",content:JSON.stringify({id,name:"AI policy",version:"1.0.0",devDependencies:{steamharness:core.version},steamHarness:{projectType:"conversation",projectInfo}})},
      {path:"index.ts",content:'throw new Error("must not execute"); steamharness.createAgentNode();'},
      {path:"configuration.json",content:definition(false)},
    ]});
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
    await storage.publish({projectName:id,createdByUserId:"author",expectedSourceHash:state.sourceHash,expectedConfigurationRevision:state.publication!.revision});
    const template=(await db.readConfigurationTemplate(id,"1.0.0"))!;
    assert.deepEqual(template.agentModelPolicy,{allowThirdParty:false});assert.deepEqual(template.fields,[]);assert.ok(!JSON.stringify(template).includes(third.apiKey));
    const recipient=await storage.projectConfigurations({projectName:id,actorId:"recipient",target:"1.0.0"},{action:"get"}) as ProjectConfigurationState;
    assert.deepEqual(recipient.fields,[]);assert.deepEqual(configurationSnapshot(recipient).agentModelPolicy,{allowThirdParty:false});
  } finally {
    await accounts.close();await db.close();await rm(root,{recursive:true,force:true});
    await admin.query(`drop schema ${schema} cascade`);await admin.end();
  }
});

test("PostgreSQL stores static project groups, immutable versions and independent project data", {
  skip: databaseUrl ? false : "STEAMHARNESS_TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  const schema = `storage_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`create schema ${schema}`);
  const connection = new URL(databaseUrl);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const db = new DatabaseRepository(connection.toString());
  const pool = new pg.Pool({ connectionString: connection.toString() });
  const root = await mkdtemp(path.join(tmpdir(), "workflow-storage-postgres-"));
  const objects = new LocalStorage({ root: path.join(root, "objects"), publicBaseUrl: "http://localhost/" });
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(),
    dataRoot: path.join(root, "data"), db, objectStorage: objects, artifacts: new ArtifactStorage(objects) });
  const boardId = randomUUID();
  const workerId = randomUUID();
  const packageVersion = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"))
    .dependencies["steamharness"] as string;
  const projectInfo = (alias: string, projectId: string): DeclaredProjectInfo => ({
    localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" }, dataStorage: { mode: "server" },
    relatedProjects: [{ alias, projectId, grantToRelatedProject: { read: { mode: "all" }, write: { mode: "all" } } }],
  });
  try {
    await db.init();
    const accounts=new AccountRepository(connection.toString());
    await accounts.init();
    for(const userId of ["owner","maintainer","developer","guest","viewer","copier"])await accounts.upsertUserProfile({userId,email:`${userId}@test.local`});
    await accounts.close();
    const groupDir = path.join(root, "group");
    await mkdir(groupDir);
    for (const [id, type, info] of [
      [boardId, "kanban", projectInfo("worker", workerId)],
      [workerId, "workflow", projectInfo("board", boardId)],
    ] as const) {
      const created = await storage.createProject({ projectId: id, projectName: type,
        projectType: type, projectInfo: info, ownerUserId: "owner", createdByUserId: "owner" });
      assert.equal(created.visibility, "private");
      const card = (await db.getProject(id))!.projectCard;
      assert.equal(card.icon, defaultProjectCardIcon(type));
      assert.ok(getProjectCardColorContrastRatio(card.iconColor!, card.iconBackgroundColor) >= 4.5);
      await storage.createProject({ projectId: id, projectName: type, projectType: type, projectInfo: info, ownerUserId: "owner" });
      assert.deepEqual((await db.getProject(id))!.projectCard, card);
      assert.equal((await storage.getProjectAccessSummary(id, "owner")).member?.role, "owner");
      for (const role of ["maintainer", "developer", "guest"] as const) {
        await db.access.setMember("project",id,role,role,{userId:"owner",isSystemAdmin:false});
        assert.equal((await storage.getProjectAccessSummary(id, role)).member?.role, role);
      }
      const manifest = { id, name: type, version: "1.0.0",
        devDependencies: { "steamharness": packageVersion },
        scripts: { build: "node must-not-run.cjs", postinstall: "node must-not-run.cjs" },
        steamHarness: { projectType: type, projectCard: card, projectInfo: info, ...(type === "kanban" ? { kanban: {} } : {}) } };
      const files = [
        { path: "package.json", content: JSON.stringify(manifest) },
        { path: type === "kanban" ? "index.html" : "index.ts", content: type === "kanban"
          ? "<!doctype html><title>Static board</title>" : "throw new Error('never execute uploaded code');" },
        { path: "must-not-run.cjs", content: `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "executed"))}, 'executed');` },
      ];
      await storage.saveDraftFiles({ projectName: id, files });
      const source = path.join(root, id);
      await mkdir(source);
      for (const file of files) await writeFile(path.join(source, file.path), file.content);
      await createTar({ cwd: source, file: path.join(groupDir, `${id}.tar.gz`), gzip: true }, ["."]);
    }
    const configurationOptions={projectName:boardId,actorId:"owner",target:"draft"};
    const state=await storage.projectConfigurations(configurationOptions,{action:"get"}) as import("@steamharness/project-configuration").ProjectConfigurationState;
    const results=await Promise.allSettled([
      storage.projectConfigurations(configurationOptions,{action:"create",revision:state.revision,name:"First"}),
      storage.projectConfigurations(configurationOptions,{action:"create",revision:state.revision,name:"Second"}),
    ]);
    assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
    const other=await storage.projectConfigurations({...configurationOptions,actorId:"developer"},{action:"get"}) as typeof state;
    assert.equal(other.configurations.length,1);
    assert.notEqual(other.activeConfigurationId,state.activeConfigurationId);
    const saved=await storage.projectConfigurations(configurationOptions,{action:"get"}) as typeof state;
    assert.equal(saved.configurations.length,2);
    await assert.rejects(storage.projectConfigurations(configurationOptions,{action:"import",revision:saved.revision,document:{version:1,kind:"steamharness-project-configurations",fields:[{name:"x",type:"number"}],configurations:[{name:"good",values:{x:1}},{name:"invalid",values:{x:"bad"}}]}}));
    assert.deepEqual(await storage.projectConfigurations(configurationOptions,{action:"get"}),saved);
    const manifest: ProjectGroupManifestV1 = { version: 1, rootProjectId: boardId,
      projects: [
        { projectId: boardId, role: "root", archivePath: `${boardId}.tar.gz`, version: "1.0.0" },
        { projectId: workerId, role: "dependency", alias: "worker", archivePath: `${workerId}.tar.gz`, version: "1.0.0" },
      ], dependencies: [{ alias: "worker", projectId: workerId, delivery: "included" }] };
    await writeFile(path.join(groupDir, "project-group.json"), JSON.stringify(manifest));
    const groupArchive = path.join(root, "group.tar.gz");
    await createTar({ cwd: groupDir, file: groupArchive, gzip: true }, ["."]);
    const deployment = await storage.createProjectGroupDeployment({ manifest, releaseLog: "Static snapshots", createdByUserId: "owner" });
    assert.equal((await storage.prepareProjectGroupDeployment({ deploymentId: deployment.id,
      archiveName: "group.tar.gz", archiveBuffer: await readFile(groupArchive) })).status, "prepared");
    const ownerActor = {userId:"owner",isSystemAdmin:false};
    await db.access.setMember("project",workerId,"developer","guest",ownerActor);
    await assert.rejects(storage.publishProjectGroupDeployment(deployment.id,{actorId:"developer"}), /Permission denied/);
    assert.equal((await storage.listVersions(boardId)).latest,null);
    await db.access.setMember("project",workerId,"developer","developer",ownerActor);
    await db.access.setMember("project",boardId,"developer","guest",ownerActor);
    await assert.rejects(storage.publishProjectGroupDeployment(deployment.id,{actorId:"developer"}), /Permission denied/);
    assert.equal((await storage.listVersions(boardId)).latest,null);
    await db.access.setMember("project",boardId,"developer","developer",ownerActor);
    assert.equal((await storage.publishProjectGroupDeployment(deployment.id,{actorId:"developer"})).status, "published");
    const versions = await storage.listVersions(boardId);
    assert.equal(versions.latest, "1.0.0");
    assert.equal(versions.versions[0]?.dependencies[0]?.version, "1.0.0");
    await storage.saveDraftFiles({projectName:boardId,files:[{path:"configuration.json",content:JSON.stringify({version:1,fields:[{name:"newField",type:"string"}]})}]});
    const draftConfiguration=await storage.projectConfigurations(configurationOptions,{action:"get"}) as typeof state;
    await storage.projectConfigurations(configurationOptions,{action:"save",revision:draftConfiguration.revision,id:draftConfiguration.activeConfigurationId,values:{newField:"saved"}});
    const olderConfiguration=await storage.projectConfigurations({...configurationOptions,target:"1.0.0"},{action:"get"}) as typeof state;
    await storage.projectConfigurations({...configurationOptions,target:"1.0.0"},{action:"rename",revision:olderConfiguration.revision,id:olderConfiguration.activeConfigurationId,name:"Retained"});
    const restoredConfiguration=await storage.projectConfigurations(configurationOptions,{action:"get"}) as typeof state;
    assert.equal(restoredConfiguration.configurations.find(item=>item.id===draftConfiguration.activeConfigurationId)!.values.newField,"saved");
    const snapshot = await storage.getDownloadableSourceFiles({ projectName: boardId, target: "1.0.0" });
    const copyId = randomUUID();
    await storage.cloneProject({ projectName: boardId, sourceTarget: "1.0.0",
      targetProjectName: copyId, ownerUserId: "copier" });
    const copied = await storage.getProjectAccessSummary(copyId, "copier");
    assert.equal(copied.ownerUserId, "copier");
    assert.equal(copied.member?.role, "owner");
    assert.equal(copied.visibility, "private");
    assert.equal((await storage.getFiles({ projectName: copyId, target: "draft" })).files.length, snapshot.files.length);
    await assert.rejects(storage.publish({ projectName: boardId }), /already published|already exists/);
    await assert.rejects(storage.uploadPackage({ projectName: boardId, archiveName: "bad.tgz", archiveBuffer: Buffer.from("invalid") }));
    assert.deepEqual(await storage.getDownloadableSourceFiles({ projectName: boardId, target: "1.0.0" }), snapshot);
    assert.equal((await storage.getProjectGroupDownload({ projectName: boardId, canDownloadProject: async () => true })).projects.length, 2);
    const skipped = await storage.getProjectGroupDownload({ projectName: boardId, canDownloadProject: async () => false });
    assert.equal(skipped.skippedDependencies[0]?.reason, "permission_required");
    assert.equal(skipped.copyAllowed, false);

    const publicationId=randomUUID();
    await storage.createProject({projectId:publicationId,projectName:'Shared config',projectType:'workflow',ownerUserId:'owner',projectInfo:{localizedNames:{},declarations:[],platformSupport:{mode:'agnostic'},dataStorage:{mode:'server'},relatedProjects:[]}});
    await storage.saveDraftFiles({projectName:publicationId,files:[
      {path:'package.json',content:JSON.stringify({id:publicationId,name:'Shared config',version:'1.0.0',devDependencies:{steamharness:packageVersion},steamHarness:{projectType:'workflow',projectInfo:{localizedNames:{},declarations:[],platformSupport:{mode:'agnostic'},dataStorage:{mode:'server'},relatedProjects:[]}}})},
      {path:'index.ts',content:'throw new Error("never execute");'},
      {path:'configuration.json',content:JSON.stringify({version:2,fields:[{name:'fixed',type:'boolean',defaultValue:false,sharing:{includeValue:true,editable:false}},{name:'privateKey',type:'string',defaultValue:'do-not-ship',sharing:{publish:false}}]})},
    ]});
    const officialOptions={projectName:publicationId,actorId:'owner'};
    const official=await storage.projectConfigurations(officialOptions,{action:'get'}) as typeof state;
    const draftWrites=await Promise.allSettled([1,2].map(()=>storage.projectConfigurations(officialOptions,{action:'publication.save',revision:official.revision,publication:official.publication})));
    assert.equal(draftWrites.filter(result=>result.status==='fulfilled').length,1,JSON.stringify(draftWrites.map(result=>result.status==='rejected'?(result.reason as Error).message:'saved')));
    await assert.rejects(storage.projectConfigurations({...officialOptions,actorId:'developer'},{action:'publication.save',revision:official.revision,publication:official.publication}),/Maintainer/);
    await storage.publish({projectName:publicationId,createdByUserId:'owner',expectedConfigurationRevision:1,expectedSourceHash:official.sourceHash});
    const immutable=(await db.readConfigurationTemplate(publicationId,'1.0.0'))!;
    assert.equal(immutable.configurations[0]!.values.fixed,false);assert.ok(!JSON.stringify(immutable).includes('do-not-ship'));
    await assert.rejects(db.saveConfigurationTemplate(publicationId,'1.0.0',immutable),/duplicate/);
    const recipient=await storage.projectConfigurations({projectName:publicationId,actorId:'viewer',target:'1.0.0'},{action:'get'}) as typeof state;
    await assert.rejects(storage.projectConfigurations({projectName:publicationId,actorId:'viewer',target:'1.0.0'},{action:'save',revision:recipient.revision,id:recipient.activeConfigurationId,values:{fixed:true}}),/locked/);
    assert.equal((await storage.projectConfigurations({projectName:publicationId,actorId:'viewer',target:'1.0.0'},{action:'get'}) as typeof state).revision,recipient.revision);

    const entry = { storageKind: "kv" as const, scope: "project" as const, projectId: workerId, key: "stock" };
    await storage.setProjectStorageValue({ ...entry, value: 1, source: { projectId: workerId, runId: "local-run" } });
    const initial = await storage.getProjectStorageValue(entry);
    const outcomes = await Promise.all([2, 3].map(value => storage.compareAndSetProjectStorageValue({
      ...entry, value, expectedRevision: initial.revision!, source: { projectId: workerId, runId: "local-run" },
    })));
    assert.equal(outcomes.filter(item => item.applied).length, 1);
    assert.equal((await storage.getProjectKVEntry({ projectId: workerId, scope: "project", key: "stock" })).lastRunId, "local-run");
    assert.equal((await storage.resolveRelatedProjectKVAccess({ consumerProjectId: boardId, alias: "worker", key: "stock", operation: "write" })).targetProjectId, workerId);
    await storage.removeRelatedProject({ projectId: workerId, alias: "board", updateTarget: false });
    await assert.rejects(storage.resolveRelatedProjectKVAccess({ consumerProjectId: boardId, alias: "worker", key: "stock", operation: "read" }), /unavailable|confirmation/);

    const document = await storage.createKnowledgeDocument({ projectName: workerId, title: "Guide", markdown: "# Guide\nStorage only" });
    await storage.editKnowledgeDocument({ projectName: workerId, documentId: document.id, markdown: "# Guide\nUpdated storage" });
    assert.equal((await storage.listKnowledgeDocuments(workerId)).total, 1);
    assert.equal((await storage.searchKnowledgeDocuments({ projectName: workerId, query: "Updated" })).matches.length, 1);
    const file = (await storage.saveManagedFiles({ projectName: workerId, files: [{ name: "note.txt", buffer: Buffer.from("saved") }] }))[0]!;
    assert.equal(await readFile((await storage.getManagedFile(file.id)).filePath, "utf8"), "saved");
    await storage.deleteManagedFile(file.id);
    await assert.rejects(storage.getManagedFile(file.id));
    await storage.deleteKnowledgeDocument({ projectName: workerId, documentId: document.id });
    assert.equal((await storage.listKnowledgeDocuments(workerId)).total, 0);

    await pool.query("create table project_runs (record text); insert into project_runs values ('historical data')");
    await db.init();
    assert.equal((await pool.query("select record from project_runs")).rows[0]?.record, "historical data");
    assert.equal((await storage.listVersions(boardId)).latest, "1.0.0");
    await assert.rejects(readFile(path.join(root, "executed")), { code: "ENOENT" });
  } finally {
    await storage.close();
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
