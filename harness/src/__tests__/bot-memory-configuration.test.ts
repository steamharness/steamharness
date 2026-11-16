import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeProjectFixture } from "../../scripts/test-project-fixture.mjs";
import { cacheVerifiedConfigurationTemplate, configurationTemplatePath, createConfigurationState, createLocalProjectConfigurationStore, createPublicationDraft, freezeConfigurationTemplate, readProjectConfigurationDefinition, type ProjectConfigurationState } from "../configuration";
import { BOT_MEMORY_CONFIGURATION_KEY as key } from "../agent/memory-configuration";
import { defineBot } from "../agent/bot";

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
