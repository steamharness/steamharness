import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeProjectFixture } from "../../scripts/test-project-fixture.mjs";
import { cacheVerifiedConfigurationTemplate, configurationTemplatePath, createConfigurationState, createLocalProjectConfigurationStore, createPublicationDraft, freezeConfigurationTemplate, readProjectConfigurationDefinition, type ProjectConfigurationState } from "../configuration";
import { BOT_MEMORY_CONFIGURATION_KEY as key } from "../agent/memory-configuration";
import { defineBot } from "../agent/bot";
import { inspectLocalProjectStructure } from "../executor";

async function botFixture(t: test.TestContext, source: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bot-memory-default-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeProjectFixture(path.join(directory, "package.json"), JSON.stringify({ id: randomUUID(), name: "memory-default", version: "0.1.0", defaultEntry: "main", entries: [
    { entryId: "main", type: "bot", name: "Main", root: ".", entry: "index.ts", configuration: "configuration.json", databases: [] },
  ] }));
  await writeFile(path.join(directory, "index.ts"), source);
  await writeFile(path.join(directory, "configuration.json"), JSON.stringify({ version: 1, fields: [] }));
  return directory;
}

test("memory defaults ignore TypeScript non-null wrappers", async t => {
  const directory = await botFixture(t, 'const memory = { enabled: false }; export default steamharness.defineBot({ memory: memory! });');
  assert.equal(inspectLocalProjectStructure({ projectDir: directory }).configuration?.fields.find(field => field.name === key)?.defaultValue, false);
});

test("unrelated Bot definitions do not change the registered Bot's memory default", async t => {
  const directory = await botFixture(t, 'import "./other"; export default steamharness.defineBot({});');
  await writeFile(path.join(directory, "other.ts"), 'export const other = steamharness.defineBot({ memory: { enabled: false } });');
  assert.equal(inspectLocalProjectStructure({ projectDir: directory }).configuration?.fields.find(field => field.name === key)?.defaultValue, true);
});

test("memory follows executor exports, aliases and re-exports while saved configurations keep their values", async t => {
  const directory = await botFixture(t, 'export { selected as default } from "./bots";');
  await writeFile(path.join(directory, "bots.ts"), 'import { defineBot as bot } from "steamharness"; export const unused = bot({}); const memory = { enabled: false }; export const selected = bot({ memory });');
  for (const entry of [
    'export { selected as default } from "./bots";',
    'import { selected as bot } from "./bots"; export default bot;',
    'import * as bots from "./bots"; export default bots.selected;',
    'import bot from "./forward"; export const executor = bot;',
    'export * from "./forward";',
  ]) {
    await writeFile(path.join(directory, "forward.ts"), 'export { selected as default, selected as executor } from "./bots";');
    await writeFile(path.join(directory, "index.ts"), entry);
    assert.equal(readProjectConfigurationDefinition(directory).fields.find(field => field.name === key)?.defaultValue, false, entry);
  }
  const store = await createLocalProjectConfigurationStore(directory, { rootDir: path.join(directory, "settings") });
  assert.equal((await store.snapshot()).values[key], false);
  await writeFile(path.join(directory, "index.ts"), 'import "./bots"; export const executor = steamharness.defineBot({}); export { selected as default } from "./bots";');
  const state = await store.read();
  assert.equal(state.fields.find(field => field.name === key)?.defaultValue, true);
  assert.equal((await store.snapshot()).values[key], false);
  await store.dispatch({ action: "create", revision: state.revision, name: "Updated defaults" });
  assert.equal((await store.snapshot()).values[key], true);
});

for (const enabled of [true, false]) {
  test(`an explicit memory field without a default inherits the source default (${enabled})`, async t => {
    const directory = await botFixture(t, `export default steamharness.defineBot({ memory: { enabled: ${enabled} } });`);
    await writeFile(path.join(directory, "configuration.json"), JSON.stringify({ version: 1, fields: [{ name: key, type: "boolean", label: "Custom label" }] }));
    const store = await createLocalProjectConfigurationStore(directory, { rootDir: path.join(directory, "settings") });
    const state = await store.read();
    assert.equal(state.fields.find(field => field.name === key)?.defaultValue, enabled);
    assert.equal((await store.snapshot()).values[key], enabled);
    const saved = await store.dispatch({ action: "save", revision: state.revision, id: state.activeConfigurationId, values: { [key]: !enabled } }) as ProjectConfigurationState;
    assert.equal((await store.snapshot()).values[key], !enabled);
    await store.dispatch({ action: "save", revision: saved.revision, id: saved.activeConfigurationId, unset: [key] });
    assert.equal((await store.snapshot()).values[key], enabled);
    assert.equal((await store.read()).fields.find(field => field.name === key)?.label, "Custom label");
  });
}

test("configuration inspection overrides resolve inside the registered entry root", async t => {
  const directory = await botFixture(t, 'export default steamharness.defineBot({});');
  await writeProjectFixture(path.join(directory, "package.json"), JSON.stringify({ id: randomUUID(), name: "nested-memory", version: "0.1.0", defaultEntry: "main", entries: [
    { entryId: "main", type: "bot", name: "Main", root: "bot", entry: "index.ts", configuration: "configuration.json", databases: [] },
  ] }));
  await writeFile(path.join(directory, "bot/index.ts"), 'export default steamharness.defineBot({});');
  await writeFile(path.join(directory, "bot/release.ts"), 'export default steamharness.defineBot({ memory: { enabled: false } });');
  await writeFile(path.join(directory, "bot/configuration.json"), JSON.stringify({ version: 1, fields: [{ name: key, type: "boolean", defaultValue: true }] }));
  await writeFile(path.join(directory, "bot/release-configuration.json"), JSON.stringify({ version: 1, fields: [{ name: key, type: "boolean" }] }));
  const definition = readProjectConfigurationDefinition(directory, "main", { sourceEntry: "release.ts", configurationFile: "release-configuration.json" });
  assert.equal(definition.fields.find(field => field.name === key)?.defaultValue, false);
  assert.equal(readProjectConfigurationDefinition(directory).fields.find(field => field.name === key)?.defaultValue, true);
  for (const options of [{ sourceEntry: "../index.ts" }, { configurationFile: "../configuration.json" }]) {
    assert.throws(() => readProjectConfigurationDefinition(directory, "main", options), /stay inside/);
  }
  try { await symlink(path.join(directory, "configuration.json"), path.join(directory, "bot/linked.json"), "file"); }
  catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
  assert.throws(() => readProjectConfigurationDefinition(directory, "main", { configurationFile: "linked.json" }), /stay inside/);
});

test("each Bot exposes its own default-on project configuration switch and preserves saved overrides", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bot-memory-configuration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeProjectFixture(path.join(directory, "package.json"), JSON.stringify({ id: randomUUID(), name: "memory-config", version: "0.1.0", defaultEntry: "first", entries: [
    { entryId: "first", type: "bot", name: "First", root: ".", entry: "first.ts", databases: [] },
    { entryId: "second", type: "bot", name: "Second", root: ".", entry: "second.ts", databases: [] },
    { entryId: "workflow", type: "workflow", name: "Workflow", root: ".", entry: "workflow.ts", databases: [] },
  ] }));
  await writeFile(path.join(directory, "first.ts"), "export default steamharness.defineBot({});");
  await writeFile(path.join(directory, "second.ts"), 'import { defineBot as bot } from "steamharness"; const enabled = false; const memory = { enabled }; export default bot({ memory });');
  await writeFile(path.join(directory, "workflow.ts"), "export {};");
  const options = { rootDir: path.join(directory, "settings") };
  const first = await createLocalProjectConfigurationStore(directory, { ...options, entryId: "first" });
  const second = await createLocalProjectConfigurationStore(directory, { ...options, entryId: "second" });
  assert.equal((await first.snapshot()).values[key], true);
  assert.equal((await second.snapshot()).values[key], false);
  assert.equal(readProjectConfigurationDefinition(directory, "first").fields.find(field => field.name === key)?.defaultValue, true);
  assert.equal(readProjectConfigurationDefinition(directory, "workflow").fields.some(field => field.name === key), false);
  let state = await first.read();
  state = await first.dispatch({ action: "save", revision: state.revision, id: state.activeConfigurationId, values: { [key]: false } }) as ProjectConfigurationState;
  const reopened = await createLocalProjectConfigurationStore(directory, { ...options, entryId: "first" });
  assert.equal((await reopened.snapshot()).values[key], false);
  await writeFile(path.join(directory, "second.ts"), 'export default steamharness.defineBot({ memory: { enabled: true } });');
  assert.equal(readProjectConfigurationDefinition(directory, "second").fields.find(field => field.name === key)?.defaultValue, true);
  assert.equal((await second.snapshot()).values[key], false);
  const secondState = await second.read();
  await second.dispatch({ action: "create", revision: secondState.revision, name: "New defaults" });
  assert.equal((await second.snapshot()).values[key], true);
  assert.equal((await reopened.snapshot()).values[key], false);
  await reopened.dispatch({ action: "save", revision: state.revision, id: state.activeConfigurationId, values: { [key]: true } });
  assert.equal((await first.snapshot()).values[key], true);
});

test("Bot memory configuration rejects malformed source options", () => {
  for (const memory of [false, null, [], { enabled: "false" }, { enabled: false, account: true }]) {
    assert.throws(() => defineBot({ memory: memory as never }), /Bot memory must be/);
  }
});

test("verified legacy templates gain the memory switch without changing template bytes or locked fields", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bot-memory-template-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectId = randomUUID();
  await writeProjectFixture(path.join(directory, "package.json"), JSON.stringify({ id: projectId, name: "legacy-memory", version: "0.1.0", defaultEntry: "main", entries: [
    { entryId: "main", type: "bot", name: "Main", root: ".", entry: "index.ts", databases: [] },
  ] }));
  await writeFile(path.join(directory, "index.ts"), "export default steamharness.defineBot({});");
  const author = createConfigurationState([{ name: "locked", type: "string", defaultValue: "original", sharing: { includeValue: true, editable: false } }], () => "legacy");
  const template = freezeConfigurationTemplate(createPublicationDraft(author), { projectId, entryId: "main", projectVersion: "0.1.0", sourceHash: "a".repeat(64) });
  const file = path.join(directory, configurationTemplatePath("main"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(template));
  const options = { rootDir: path.join(directory, "settings"), templateCacheDir: path.join(directory, "cache") };
  await cacheVerifiedConfigurationTemplate(template, [], { cacheDir: options.templateCacheDir });
  const store = await createLocalProjectConfigurationStore(directory, options);
  let state = await store.read();
  assert.deepEqual(state.template, template);
  assert.equal(state.fields.find(field => field.name === key)?.defaultValue, true);
  assert.equal((await store.read()).revision, state.revision);
  const waiting = await store.snapshot({ runId: "waiting" });
  state = await store.dispatch({ action: "save", revision: state.revision, id: state.activeConfigurationId, values: { [key]: false } }) as ProjectConfigurationState;
  assert.equal((await store.snapshot()).values[key], false);
  assert.equal((await store.read()).revision, state.revision);
  const reopened = await createLocalProjectConfigurationStore(directory, options);
  assert.equal((await reopened.snapshot()).values[key], false);
  assert.deepEqual((await reopened.read()).template, template);
  assert.deepEqual(await reopened.snapshot({ runId: "waiting" }), waiting);
  await assert.rejects(reopened.dispatch({ action: "save", revision: state.revision, id: state.activeConfigurationId, values: { locked: "changed" } }), /locked/);
});
