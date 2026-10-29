import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { declareConfigurationFixture, configurationFixtureId } from "./configuration-fixture";
import { AGENT_MEMORY_CONFIGURATION_KEY, AGENT_MODELS_CONFIGURATION_FIELD, AGENT_MODELS_CONFIGURATION_KEY as key, cacheVerifiedConfigurationTemplate,
  configurationTemplatePath, createConfigurationState, createLocalProjectConfigurationStore, createPublicationDraft,
  freezeConfigurationTemplate, projectUsesConfiguredAgentModels, readProjectConfigurationDefinition, withProjectConfiguration } from "../configuration";
import { withUserSettings, type UserSettings } from "../user-settings";
import { createAgentProjectParamResolver } from "../agent/system-llm";
import { resolveAgentSystemAIInput } from "../agent/model-resolution";
import { createAgentProjectParams } from "../agent/project-params";
import { parseProjectParamValues } from "../executor/params";
import type { ConfiguredAgentModel } from "@steamharness/project-configuration";

const user: ConfiguredAgentModel = { id: "user", name: "Settings model", model: "settings-model", source: "third-party", apiKind: "openai-completions", baseUrl: "https://user.test/v1", apiKey: "fixture-user-key" };
const project: ConfiguredAgentModel = { ...user, id: "project", name: "Project model", model: "project-model", apiKey: "fixture-project-key" };
const settings = (models?: ConfiguredAgentModel[]): UserSettings => ({ agent: { permissionPolicy: "auto", ...(models === undefined ? {} : { models }) } });
const snapshot = { id: "default", name: "Default", revision: 1, values: { [key]: [project] } };
const input = { errCode: 0, errMessage: "", prompt: "Hello" };

test("settings mode excludes project models, including when Studio has an empty catalogue", async () => {
  const declarations = createAgentProjectParams({ modelSource: "user-settings" });
  for (const models of [[user], []]) await withUserSettings(settings(models), () => withProjectConfiguration(snapshot, async () => {
    assert.equal(parseProjectParamValues(declarations, []).model, models[0]?.id ?? "");
    const choices = await createAgentProjectParamResolver({ modelSource: "user-settings" })({});
    assert.deepEqual(choices.params?.model?.resolvedOptions?.map(model => model.value), models.map(model => model.id));
    assert.ok(!JSON.stringify(choices).includes("fixture-"));
    if (models.length) {
      const selected = await resolveAgentSystemAIInput(input, { modelSource: "user-settings" }, undefined);
      assert.equal(selected.input.model, user.model); assert.equal(selected.input.apiKey, user.source === "third-party" ? user.apiKey : "");
      await selected.close();
      await assert.rejects(resolveAgentSystemAIInput({ ...input, model: project.id }, {}, undefined), /no longer configured/);
    } else await assert.rejects(resolveAgentSystemAIInput(input, { modelSource: "user-settings" }, undefined), /user settings/);
    const explicit = await resolveAgentSystemAIInput(input, { modelSource: "project" }, undefined);
    assert.equal(explicit.input.model, project.model); await explicit.close();
  }));
});

test("without host model settings the same declaration uses project defaults, options and connection", async () => {
  await withUserSettings(settings(), () => withProjectConfiguration(snapshot, async () => {
    assert.equal(parseProjectParamValues(createAgentProjectParams({ modelSource: "user-settings" }), []).model, project.id);
    const choices = await createAgentProjectParamResolver({ modelSource: "user-settings" })({});
    assert.equal(choices.params?.model?.value, project.id);
    assert.deepEqual(choices.params?.model?.resolvedOptions, [{ value: project.id, label: project.name, description: project.model }]);
    const selected = await resolveAgentSystemAIInput(input, { modelSource: "user-settings" }, undefined);
    assert.equal(selected.input.model, project.model); assert.equal(selected.input.apiKey, project.source === "third-party" ? project.apiKey : "");
    await selected.close();
  }));
});

test("host configuration views omit project AI while preserving saved models for CLI and frozen snapshots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-model-modes-"));
  try {
    await declareConfigurationFixture(directory);
    await writeFile(path.join(directory, "index.ts"), "throw new Error('do not execute'); steamharness.createAgentConversationProject({ modelSource: 'user-settings' });");
    await writeFile(path.join(directory, "configuration.json"), JSON.stringify({ version: 1, fields: [AGENT_MODELS_CONFIGURATION_FIELD, { name: "title", type: "string" }] }));
    let host = settings();
    const store = await createLocalProjectConfigurationStore(directory, { rootDir: path.join(directory, ".profiles"), userSettings: () => host });
    let state = await store.read();
    state = await store.dispatch({ action: "save", id: state.activeConfigurationId, revision: state.revision, values: { [key]: [project], title: "Original" } }) as typeof state;
    const frozen = await store.snapshot({ runId: "cli-run" });
    assert.deepEqual(frozen.values[key], [project]);
    for (const models of [[user], []]) {
      host = settings(models);
      state = await store.read();
      assert.deepEqual(state.fields.map(field => field.name), [AGENT_MEMORY_CONFIGURATION_KEY, "title"]);
      assert.ok(!JSON.stringify(state).includes("fixture-project-key"));
      assert.equal((await store.snapshot()).values[key], undefined);
      assert.equal((await store.snapshot({ runId: "cli-run" })).values[key], undefined);
      assert.equal((await store.snapshot({ configuration: frozen })).values[key], undefined);
      assert.deepEqual(withUserSettings(host, () => readProjectConfigurationDefinition(directory)).fields.map(field => field.name), [AGENT_MEMORY_CONFIGURATION_KEY, "title"]);
    }
    state = await store.dispatch({ action: "save", id: state.activeConfigurationId, revision: state.revision, values: { title: "Updated" } }) as typeof state;
    host = settings();
    assert.deepEqual((await store.snapshot()).values, { [AGENT_MEMORY_CONFIGURATION_KEY]:false, [key]: [project], title: "Updated" });
    assert.deepEqual((await store.snapshot({ runId: "cli-run" })).values, frozen.values);
    assert.equal((await store.read()).fields[0]?.name, key);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("model-source discovery follows static aliases and refreshes without changing Agent detection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-source-discovery-"));
  try {
    await declareConfigurationFixture(directory);
    const store = await createLocalProjectConfigurationStore(directory, { rootDir: path.join(directory, ".profiles"), userSettings: () => settings([]) });
    const cases: [string, boolean][] = [
      ["steamharness.createAgentConversationProject();", false],
      ["import { createAgentNode as agent } from 'steamharness/agent'; agent({ modelSource: 'project' });", true],
      ["const mode = 'user-settings' as const; const options = { modelSource: mode }; steamharness.createAgentConversationProject(options);", false],
      ["const options = {modelSource:'project'}; steamharness.createAgentProjectParamResolver({...options, modelSource:'user-settings'});", false],
      ["const options = {modelSource:'project'}; steamharness.createAgentProjectParamResolver({...options, ...{tools:[]}});", true],
      ["steamharness.createAgentConversationProject(unknownOptions);", true],
      ["steamharness.createAgentConversationProject({ modelSource:'user-settings' }); steamharness.createAgentNode({modelSource:'project'});", true],
    ];
    for (const [source, expected] of cases) {
      await writeFile(path.join(directory, "index.ts"), source);
      assert.equal(projectUsesConfiguredAgentModels(directory), true);
      assert.equal((await store.read()).fields.some(field => field.name === key), expected, source);
      assert.equal(withUserSettings(settings([]), () => readProjectConfigurationDefinition(directory)).fields.some(field => field.name === key), expected, source);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("verified configuration templates retain their original data while host views omit AI fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-source-template-"));
  try {
    await declareConfigurationFixture(directory);
    await writeFile(path.join(directory, "index.ts"), "steamharness.createAgentConversationProject({ modelSource:'user-settings' });");
    const template = freezeConfigurationTemplate(createPublicationDraft(createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD], () => "official")), {
      projectId: await configurationFixtureId(directory), entryId: "main", projectVersion: "1.0.0", sourceHash: "a".repeat(64),
    });
    const file = path.join(directory, configurationTemplatePath("main")), cache = path.join(directory, ".cache");
    await writeFile(file, JSON.stringify(template));
    await cacheVerifiedConfigurationTemplate(template, [], { cacheDir: cache });
    let host = settings([]);
    const store = await createLocalProjectConfigurationStore(directory, { rootDir: path.join(directory, ".profiles"), templateCacheDir: cache, userSettings: () => host });
    assert.deepEqual((await store.read()).fields, []);
    assert.equal((await store.snapshot({ runId: "host-run" })).values[key], undefined);
    assert.equal((await store.snapshot({ runId: "host-run" })).values[key], undefined);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), template);
    host = settings();
    assert.equal((await store.read()).fields[0]?.name, key);
    assert.equal((await store.snapshot()).values[key], undefined, "Published structure does not include personal model values");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("each registered entry discovers its own model mode and imported Agent declarations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-source-entries-"));
  try {
    await declareConfigurationFixture(directory);
    const file = path.join(directory, "steamharness.json"), manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.entries.push({ entryId: "project-agent", name: "Project Agent", type: "workflow", root: ".", entry: "project.ts", configuration: "configuration.json", databases: [] });
    await writeFile(file, JSON.stringify(manifest));
    await writeFile(path.join(directory, "index.ts"), "steamharness.createAgentConversationProject({modelSource:'user-settings'});");
    await writeFile(path.join(directory, "project.ts"), "import './project-agent';");
    await writeFile(path.join(directory, "project-agent.ts"), "steamharness.createAgentNode({modelSource:'project'});");
    const options = { rootDir: path.join(directory, ".profiles"), userSettings: () => settings([]) };
    const main = await createLocalProjectConfigurationStore(directory, options);
    const explicit = await createLocalProjectConfigurationStore(directory, { ...options, entryId: "project-agent" });
    assert.deepEqual((await main.read()).fields.map(f=>f.name), [AGENT_MEMORY_CONFIGURATION_KEY]);
    assert.equal((await explicit.read()).fields[0]?.name, key);
    await writeFile(path.join(directory, "project-agent.ts"), "steamharness.createAgentNode({modelSource:'user-settings'});");
    assert.deepEqual((await explicit.read()).fields.map(f=>f.name), [AGENT_MEMORY_CONFIGURATION_KEY]);
    assert.deepEqual((await main.read()).fields.map(f=>f.name), [AGENT_MEMORY_CONFIGURATION_KEY]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("Core Agent project memory has portable opt-in defaults and persisted per-profile overrides",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'agent-memory-config-'));
 try{
  await declareConfigurationFixture(directory);
  const store=await createLocalProjectConfigurationStore(directory,{rootDir:path.join(directory,'.profiles')});
  for(const [options,expected] of [["{}",false],["{memory:true}",true],["{...{memory:true},modelSource:'user-settings'}",true],["{memory:true,...{memory:false}}",false],["{memory:false,...{memory:true}}",true]] as const){
   await writeFile(path.join(directory,'index.ts'),`throw new Error('Configuration discovery must be static'); const options=${options}; steamharness.createAgentConversationProject(options);`);
   const declared=readProjectConfigurationDefinition(directory).fields.find(f=>f.name===AGENT_MEMORY_CONFIGURATION_KEY);
   assert.equal(declared?.type,'boolean');assert.equal(declared.defaultValue,expected);
   const sample=await createLocalProjectConfigurationStore(directory,{rootDir:path.join(directory,'.samples',Buffer.from(options).toString('hex'))});
   const state=await sample.read();assert.equal((await sample.snapshot({required:false})).values[AGENT_MEMORY_CONFIGURATION_KEY],expected);
   assert.equal(state.fields.find(f=>f.name===AGENT_MEMORY_CONFIGURATION_KEY)?.defaultValue,expected);
  }
  let state=await store.read();
  state=await store.dispatch({action:'save',revision:state.revision,id:state.activeConfigurationId,values:{[AGENT_MEMORY_CONFIGURATION_KEY]:false}}) as typeof state;
  assert.equal((await store.snapshot({required:false})).values[AGENT_MEMORY_CONFIGURATION_KEY],false);
  const frozen=await store.snapshot({required:false});
  await store.dispatch({action:'save',revision:state.revision,id:state.activeConfigurationId,values:{[AGENT_MEMORY_CONFIGURATION_KEY]:true}});
  assert.equal(frozen.values[AGENT_MEMORY_CONFIGURATION_KEY],false,'in-flight runs keep their configuration');
  assert.equal((await store.snapshot({required:false})).values[AGENT_MEMORY_CONFIGURATION_KEY],true);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test("memory defaults resolve constants in their lexical scope without borrowing shadowed opt-ins", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-memory-shadowed-"));
  try {
    await declareConfigurationFixture(directory);
    const cases: [string, boolean][] = [
      ["const options = {}; steamharness.createAgentConversationProject(options); function unused() { const options = {memory:true}; }", false],
      ["const memory = true; function make(memory) { steamharness.createAgentConversationProject({memory}); }", false],
      ["const options = {memory:true}; function make() { const options = {}; steamharness.createAgentConversationProject(options); }", false],
      ["const options = {}; function make() { const options = {memory:true}; steamharness.createAgentConversationProject(options); }", true],
      ["const memory = true; function unused(memory) {} steamharness.createAgentConversationProject({memory});", true],
      ["const memory = true; { let memory; steamharness.createAgentConversationProject({memory}); }", false],
      ["const memory = true; function make({memory}) { steamharness.createAgentConversationProject({memory}); }", false],
      ["const memory = true; try {} catch (memory) { steamharness.createAgentConversationProject({memory}); }", false],
      ["const memory = true; for (const memory of []) { steamharness.createAgentConversationProject({memory}); }", false],
      ["const memory = true; function make() { if (true) { var memory; } steamharness.createAgentConversationProject({memory}); }", false],
      ["const memory = true; (function memory() { steamharness.createAgentConversationProject({memory}); });", false],
      ["const memory = true; (class memory { make() { steamharness.createAgentConversationProject({memory}); } });", false],
    ];
    for (const [source, expected] of cases) {
      await writeFile(path.join(directory, "index.ts"), source);
      assert.equal(readProjectConfigurationDefinition(directory).fields.find(field => field.name === AGENT_MEMORY_CONFIGURATION_KEY)?.defaultValue, expected, source);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
