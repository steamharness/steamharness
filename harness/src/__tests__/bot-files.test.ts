import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getCurrentTools, fauxAssistantMessage, fauxProvider, fauxToolCall, createModels } from "@earendil-works/pi-ai";
import { defineBot } from "../agent/bot";
import { BOT_FILE_TOOL_NAMES } from "../agent/bot-files";
import { createLLMBotToolRunner, llmBotTools } from "../agent/llm-bot-tools";
import { createProjectConversationContext } from "../conversation";
import { createLocalRuntimePersistence } from "../runtime-storage";
import { createBotFileWorkspace } from "../runtime-storage/bot-files";
import { createRuntimeStateStorage } from "../runtime-storage/state";
import { createDisabledProjectTokenUsageContext } from "../token-usage";
import { createProjectToolPermissionContext } from "../tool-permissions";
import type { RunContext } from "../types";
import { withUserSettings } from "../user-settings";
import { createTestResources } from "./entry-test-resources";
import { testConversationStorage } from "./runtime-test-storage";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "steamharness-bot-files-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Bot files are lazy and persist across conversations but not across instance roots or entries", async t => {
  const directory = await fixture(t), resources = createTestResources();
  const open = (name: string) => createLocalRuntimePersistence({ directory: path.join(directory, name) });
  const persistence = open("original"), clone = open("folder-bots/clone"), reopened = open("original");
  t.after(async () => { await persistence.close(); await clone.close(); await reopened.close(); });
  const run = createRuntimeStateStorage({ ...resources, runId: "one", conversationId: "first", rootDir: directory, persistence });
  const files = run.persistence.botFiles!(resources)!;
  const original = await files.list(undefined, 0, 40);
  assert.match(original.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(original.exists, false);
  await assert.rejects(stat(original.root), { code: "ENOENT" });
  const ref = `${original.artifacts}/任务/报告.md`;
  const saved = await files.write(ref, "original", false);
  await run.close();
  await persistence.close();
  const next = createRuntimeStateStorage({ ...resources, runId: "two", conversationId: "second", rootDir: directory, persistence: reopened });
  assert.equal((await next.persistence.botFiles!(resources)!.read(ref, 0)).text, "original");
  await next.close();
  const cloneFiles = clone.botFiles!(resources)!;
  await assert.rejects(cloneFiles.read(ref, 0), /does not exist/);
  const cloneFile = await cloneFiles.write(ref, "clone", false);
  assert.notEqual(cloneFile.absolutePath, saved.absolutePath);
  assert.equal(await readFile(saved.absolutePath, "utf-8"), "original");
  for (const scope of [{ ...resources, entryId: "another-entry" }, { ...resources, projectId: "another-project" }]) {
    await assert.rejects(reopened.botFiles!(scope)!.read(ref, 0), /does not exist/);
  }
});

test("dated folders support paged UTF-8 reads, guarded updates, and binary moves", async t => {
  const directory = await fixture(t);
  let now = new Date(2026, 10, 24, 23, 50);
  const files = createBotFileWorkspace(directory, "scope", () => now);
  const { root, temp } = await files.list(undefined, 0, 1);
  assert.equal(temp, "temp/2026-11-24");
  const text = "a".repeat(16_382) + "中文内容";
  const ref = `${temp}/report.txt`;
  await files.write(ref, text, false);
  const page = await files.read(ref, 0);
  assert.equal(page.nextByteOffset, 16_382);
  assert.equal(page.text + (await files.read(ref, page.nextByteOffset!)).text, text);
  await assert.rejects(files.read(ref, page.nextByteOffset! + 1), /UTF-8/);
  await assert.rejects(files.write(ref, "no", false), /already exists/);
  await assert.rejects(files.write(ref, "汉".repeat(44_000), true), /128 KiB/);
  await files.write(ref, "updated", true);
  assert.equal((await files.read(ref, 0)).text, "updated");

  const data = Buffer.from([0, 0xf1, 0x80, 0xff]);
  const input = `${temp}/input.bin`;
  await writeFile(path.join(root, input), data);
  await assert.rejects(files.read(input, 0), /UTF-8/);
  await assert.rejects(files.move(input, ref), /already exists/);
  now = new Date(2026, 10, 25, 0, 1);
  const { artifacts } = await files.list(undefined, 0, 40);
  assert.equal(artifacts, "artifacts/2026-11-25");
  const dest = `${artifacts}/out.bin`;
  const moved = await files.move(input, dest);
  assert.deepEqual(await readFile(moved.absolutePath), data);
  await assert.rejects(files.read(input, 0), /does not exist/);
  assert.deepEqual((await files.list("artifacts", 0, 1)).entries, [{ name: "2026-11-25", kind: "directory" }]);
  assert.equal((await files.list(undefined, 0, 1)).nextOffset, 1);
  assert.deepEqual(await files.delete(dest), { path: dest, deleted: true });
  await mkdir(path.join(root, artifacts, "folder"));
  await assert.rejects(files.delete(`${artifacts}/folder`), /regular file/);
  const same = `${artifacts}/race.txt`;
  const creates = await Promise.allSettled([files.write(same, "first", false), files.write(same, "second", false)]);
  assert.equal(creates.filter(item => item.status === "fulfilled").length, 1);
});

test("dedicated tools reject outside paths, unsafe filenames and filesystem aliases", async t => {
  const directory = await fixture(t);
  const files = createBotFileWorkspace(directory, "scope");
  const { root, temp } = await files.list(undefined, 0, 40);
  const outside = path.join(directory, "outside.txt");
  await writeFile(outside, "unrelated");
  for (const ref of [outside, `${temp}/../../outside.txt`, `${temp}/x\\y`, `${temp}/test:alternate`, `${temp}/NUL.txt`, "temp/2026-02-30/a", `${temp}/end.`, "artifacts/other-scope/file"]) {
    await assert.rejects(files.write(ref, "bad", true), /Bot-relative path/);
  }
  await files.write(`${temp}/regular.txt`, "inside", false);
  const hard = `${temp}/hard.txt`;
  await link(outside, path.join(root, hard));
  await assert.rejects(files.read(hard, 0), /regular file/);
  await assert.rejects(files.write(hard, "bad", true), /regular file/);
  const alias = `${temp}/outside`;
  await symlink(directory, path.join(root, alias), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(files.list(alias, 0, 40), /symbolic links/);
  await assert.rejects(files.write(`${alias}/outside.txt`, "bad", true), /symbolic links/);
  await assert.rejects(files.move(`${temp}/regular.txt`, `${alias}/destination.txt`), /symbolic links/);
  assert.equal(await readFile(outside, "utf-8"), "unrelated");
});

function context(metadata: RunContext["metadata"], resources = createTestResources()): RunContext {
  return { ...resources, config: {}, providers: {}, metadata,
    conversation: createProjectConversationContext({ enabled: true, conversationId: `${resources.projectId}-file-test`, projectName: "bot", storage: testConversationStorage() }),
    tokenUsage: createDisabledProjectTokenUsageContext() };
}

test("Agent Bot receives file guidance with a prepared persona and actually routes Shell temporary files", { timeout: 15_000 }, async t => {
  const directory = await fixture(t);
  const workspace = path.join(directory, "project"); await mkdir(workspace);
  const persistence = createLocalRuntimePersistence({ directory: path.join(directory, "runtime") });
  t.after(() => persistence.close());
  const mock = fauxProvider({ models: [{ id: "bot-files", contextWindow: 100_000, maxTokens: 1000 }] });
  const models = createModels(); models.setProvider(mock.provider);
  const bot = defineBot({ engine: "agent", memory: { enabled: false }, agent: {
    models, resolvedModel: models.getModel("faux", "bot-files")!, tools: ["bash"], workdir: workspace, permissionPolicy: "workspace", ...{ retryDelayMs: 0 },
  }, prepareInput: input => ({ ...input, systemPrompt: "Custom prepared persona." }) });
  const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const lastResult = (request: { messages: readonly unknown[] }) => {
    const result = request.messages.at(-1) as { content: { text: string }[]; isError?: boolean };
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0]!.text);
  };
  const current = context({ runtimePersistence: persistence });
  const locations = await persistence.botFiles!(current)!.list(undefined, 0, 40);
  const tempPath = path.join(locations.root, locations.temp);
  const artifactPath = path.join(locations.root, locations.artifacts);
  const checkDir = `node -e "const f=require('node:fs'); const os=require('node:os'); const p=require('node:path'); f.writeFileSync(p.join(os.tmpdir(),'native.log'),'temp'); console.log(JSON.stringify({cwd: f.realpathSync('.'), temp: os.tmpdir(), env: process.env.STEAMHARNESS_BOT_ARTIFACT_DIR}));"`;
  current.toolPermissions = createProjectToolPermissionContext({ definitions: bot.tools, projectName: "bot", runId: "file-tools" });
  mock.setResponses([
    request => {
      const offered = getCurrentTools(request.messages).map(tool => tool.name);
      assert.deepEqual(offered.filter(name => name.startsWith("bot_files_")), BOT_FILE_TOOL_NAMES);
      assert.match(JSON.stringify(request), /Custom prepared persona/);
      assert.match(JSON.stringify(request), /Put drafts, downloaded working copies/);
      return call("bot_files_list", {});
    },
    request => { assert.equal(lastResult(request).temp, locations.temp); return call("bash", { command: checkDir }); },
    request => {
      assert.deepEqual(lastResult(request), { cwd: workspace, temp: tempPath, env: artifactPath });
      return call("bash", { directory: "artifacts", command: checkDir });
    },
    request => {
      assert.equal(lastResult(request).cwd, artifactPath);
      return call("bot_files_read", { path: `${locations.temp}/native.log` });
    },
    request => {
      assert.equal(lastResult(request).text, "temp");
      return call("bot_files_write", { path: `${locations.artifacts}/report.md`, text: "Finished" });
    },
    request => { assert.equal(lastResult(request).absolutePath, path.join(artifactPath, "report.md")); return fauxAssistantMessage("Done"); },
  ]);
  assert.equal((await bot.workflow.run({ errCode: 0, errMessage: "", prompt: "Generate the report" }, current)).errCode, 0);
  assert.equal(await readFile(path.join(artifactPath, "report.md"), "utf-8"), "Finished");
});

test("Agent plan, read-only mode and host policies hide the matching Bot file mutations", { timeout: 15_000 }, async t => {
  const dir = await fixture(t), persistence = createLocalRuntimePersistence({ directory: dir });
  t.after(() => persistence.close());
  const mock = fauxProvider({ models: [{ id: "file-policy", contextWindow: 100_000, maxTokens: 1000 }] });
  const models = createModels(); models.setProvider(mock.provider);
  const bot = defineBot({ engine: "agent", agent: { models, resolvedModel: models.getModel("faux", "file-policy")!, tools: ["bash"], ...{ retryDelayMs: 0 } } });
  for (const mode of ["plan", "read-only", "host-disabled"] as const) {
    const current = context({ runtimePersistence: persistence });
    const denied = new Set<string>(mode === "host-disabled" ? ["bot_files_write", "bot_files_move", "bot_files_delete", "bash"] : []);
    current.toolPermissions = createProjectToolPermissionContext({ definitions: bot.tools,
      policies: Object.fromEntries([...denied].map(name => [name, { enabled: false }])), projectName: "bot", runId: mode });
    let offered: string[] = [];
    mock.setResponses([request => {
      offered = getCurrentTools(request.messages).map(tool => tool.name);
      return fauxAssistantMessage("Done");
    }]);
    const output = await withUserSettings({ agent: { permissionPolicy: mode === "read-only" ? "read-only" : "workspace" } }, () =>
      bot.workflow.run({ errCode: 0, errMessage: "", prompt: "Inspect files", ...(mode === "plan" ? { agent: mode } : {}) }, current));
    assert.equal(output.errCode, 0);
    assert.deepEqual(offered.filter(name => name.startsWith("bot_files_")), ["bot_files_list", "bot_files_read"], mode);
    assert.ok(!offered.includes("bash"), mode);
    assert.equal((await persistence.botFiles!(current)!.list(undefined, 0, 40)).exists, false);
  }
});

test("a Workspace Bot file write with auto-approve off parks without creating a file", { timeout: 15_000 }, async t => {
  const directory = await fixture(t), persistence = createLocalRuntimePersistence({ directory });
  t.after(() => persistence.close());
  const mock = fauxProvider({ models: [{ id: "file-approval", contextWindow: 100_000, maxTokens: 1000 }] });
  const models = createModels(); models.setProvider(mock.provider);
  const bot = defineBot({ engine: "agent", agent: { models, resolvedModel: models.getModel("faux", "file-approval")!, tools: [], ...{ retryDelayMs: 0 } } });
  const current = context({ runtimePersistence: persistence });
  const files = persistence.botFiles!(current)!;
  const { artifacts } = await files.list(undefined, 0, 40);
  const approvals: string[] = [];
  current.userInput = { getResolvedInput: async () => undefined, requestInput: async request => { approvals.push(request.requestId); } };
  current.toolPermissions = createProjectToolPermissionContext({ definitions: bot.tools, userInput: current.userInput,
    policies: { bot_files_write: { autoApprove: false } }, projectName: "bot", runId: "approval" });
  mock.setResponses([fauxAssistantMessage([fauxToolCall("bot_files_write", { path: `${artifacts}/report.md`, text: "pending" })], { stopReason: "toolUse" })]);
  await assert.rejects(async () => withUserSettings({ agent: { permissionPolicy: "workspace" } }, () =>
    bot.workflow.run({ errCode: 0, errMessage: "", prompt: "Write a report" }, current)), /waiting for approval/);
  assert.equal(approvals.length, 1);
  assert.equal((await files.list(undefined, 0, 40)).exists, false);
});

test("artifact delivery is lazy, immutable, separately scoped, and fenced by a durable call receipt", async t => {
  const directory = await fixture(t), scope = createTestResources();
  const persistence = createLocalRuntimePersistence({ directory });
  const isolate = createLocalRuntimePersistence({ directory: path.join(directory, 'folder-bots', 'copy') });
  t.after(async () => { await isolate.close(); await persistence.close(); });
  const store = persistence.botArtifacts!(scope)!;
  assert.deepEqual(store.list(), { artifacts: [] });
  await assert.rejects(stat(path.join(directory, 'bot-deliveries')), { code: 'ENOENT' });
  const files = persistence.botFiles!(scope)!;
  const { artifacts, temp, root } = await files.list(undefined, 0, 1);
  const ref = `${artifacts}/报告.md`;
  const source = { conversationId: 'original', requestId: 'send', runId: 'worker', outputId: 'tool' };
  await files.write(ref, 'original', false);
  await files.write(`${temp}/tmp.txt`, 'temporary', false);
  await assert.rejects(store.publish({ path: `${temp}/tmp.txt` }, source, 'tmp'), /Only files under artifacts/);
  await assert.rejects(store.publish({ path: `${artifacts}/../report` }, source, 'escape'), /Bot-relative path/);
  const large = await files.write(`${artifacts}/large.txt`, '', false);
  await truncate(large.absolutePath, 50 * 1024 * 1024 + 1);
  await assert.rejects(store.publish({ path: `${artifacts}/large.txt` }, source, 'large'), /50 MiB/);
  await mkdir(path.join(root, artifacts, 'folder'));
  await assert.rejects(store.publish({ path: `${artifacts}/folder` }, source, 'folder'), /regular file/);
  await link(large.absolutePath, path.join(root, artifacts, 'alias.txt'));
  await assert.rejects(store.publish({ path: `${artifacts}/alias.txt` }, source, 'alias'), /regular file/);
  const [first, duplicate] = await Promise.all([store.publish({ path: ref }, source, 'once'), store.publish({ path: ref }, source, 'once')]);
  assert.deepEqual(first, duplicate);
  await files.write(ref, 'replacement', true);
  assert.deepEqual(await store.publish({ path: ref }, { ...source, runId: 'reconnected' }, 'once'), first);
  await assert.rejects(store.publish({ path: ref, title: 'Changed' }, source, 'once'), /different file/);
  const second = await store.publish({ path: ref, title: 'Second delivery' }, { ...source, conversationId: 'later' }, 'again');
  const page = store.list(undefined, 1);
  assert.deepEqual(page.artifacts, [second]); assert.deepEqual(store.list(page.nextBefore, 1).artifacts, [first]);
  assert.equal(isolate.botArtifacts!(scope)!.get(first.id), undefined);
  assert.equal(persistence.botArtifacts!({ ...scope, entryId: 'another' })!.get(first.id), undefined);
  await persistence.close();
  const reopened = createLocalRuntimePersistence({ directory }); t.after(() => reopened.close());
  const saved = reopened.botArtifacts!(scope)!;
  assert.equal(Buffer.from(saved.read(first.id)!.bytes).toString(), 'original');
  assert.equal(saved.delete(first.id), true);
  assert.equal(saved.get(first.id), undefined);
  assert.equal(saved.read(first.id), undefined);
  assert.equal(saved.delete(first.id), false);
  await assert.rejects(saved.publish({ path: ref }, source, 'once'), /removed by the user/);
  assert.equal((await reopened.botFiles!(scope)!.read(ref, 0)).text, 'replacement');
});

test("an admitted Agent Bot publishes a dedicated card; Plan and non-admitted hosts never offer delivery", { timeout: 15_000 }, async t => {
  const directory = await fixture(t);
  const allowed = createLocalRuntimePersistence({ directory, allowBotArtifactPublish: true });
  const denied = createLocalRuntimePersistence({ directory });
  t.after(async () => { await allowed.close(); await denied.close(); });
  const mock = fauxProvider({ models: [{ id: "delivery", contextWindow: 100_000, maxTokens: 1000 }] });
  const models = createModels(); models.setProvider(mock.provider);
  const bot = defineBot({ engine: "agent", memory: { enabled: false }, agent: { models, resolvedModel: models.getModel("faux", "delivery")!, tools: [], ...{ retryDelayMs: 0 } } });
  const run = async (persistence: typeof allowed, mode: "build" | "plan", invoke: boolean) => {
    const current = context({ runtimePersistence: persistence, runId: "workflow-run" });
    const files = persistence.botFiles!(current)!;
    const locations = await files.list(undefined, 0, 40);
    const ref = `${locations.artifacts}/report.md`;
    if (invoke) await files.write(ref, "report", false);
    current.toolPermissions = createProjectToolPermissionContext({ definitions: bot.tools, projectName: "bot", runId: "workflow-run" });
    let offered = false;
    mock.setResponses([request => {
      offered = getCurrentTools(request.messages).some(tool => tool.name === "bot_files_publish");
      return invoke ? fauxAssistantMessage([fauxToolCall("bot_files_publish", { path: ref, title: "Report" })], { stopReason: "toolUse" }) : fauxAssistantMessage("Done");
    }, fauxAssistantMessage("Done")]);
    const output = await withUserSettings({ agent: { permissionPolicy: "workspace" } }, () => bot.workflow.run({
      errCode: 0, errMessage: "", agent: mode, requestId: "stable-request", prompt: "Deliver the report" }, current));
    assert.equal(offered, invoke);
    return { current, output };
  };
  await run(denied, 'build', false);
  await run(allowed, 'plan', false);
  const { current, output } = await run(allowed, 'build', true);
  const [artifact] = allowed.botArtifacts!(current)!.list().artifacts;
  assert.ok(artifact);
  assert.equal(artifact.source.requestId, 'stable-request');
  assert.equal(artifact.source.conversationId, current.conversation.conversationId);
  const card = output.items.find(item => item.metadata?.kind === 'bot-artifact');
  assert.equal(card?.id, artifact.id);
  assert.deepEqual(card?.content, { id: artifact.id, name: 'report.md', size: 6 });
});

test("LLM Bot file tools are opt-in, respect read-only, and use the same host storage", async t => {
  const dir = await fixture(t), persistence = createLocalRuntimePersistence({ directory: dir });
  t.after(() => persistence.close());
  const current = context({ runtimePersistence: persistence });
  assert.deepEqual((await createLLMBotToolRunner(llmBotTools(), current)).tools.map(tool => tool.name), ["runtime_info"]);
  const definitions = llmBotTools(["bot_files_list", "bot_files_write"].map(name => ({ name, enabled: true, autoApprove: true })));
  const readOnly = await createLLMBotToolRunner(definitions, current, undefined, "read-only");
  assert.deepEqual(readOnly.tools.map(tool => tool.name), ["runtime_info", "bot_files_list"]);
  assert.match(readOnly.botFileGuidance!, /Put drafts/);
  const runner = await createLLMBotToolRunner(definitions, current);
  const locations = await persistence.botFiles!(current)!.list(undefined, 0, 40);
  const file = `${locations.artifacts}/report.md`;
  const result = await runner.execute(fauxToolCall("bot_files_write", { path: file, text: "LLM artifact" }));
  assert.equal(result.result.isError, false);
  assert.equal((await persistence.botFiles!(current)!.read(file, 0)).text, "LLM artifact");
});

test("LLM Bot uses the host's automatic approval mode without enabling denied tools or rewriting settings", async () => {
  const current = context({});
  current.userInput = { getResolvedInput: async () => undefined, requestInput: async () => assert.fail("Unexpected approval prompt") };
  const definitions = llmBotTools([{ name: "custom", autoApprove: false }, { name: "restricted", enabled: false }]);
  current.toolPermissions = createProjectToolPermissionContext({ definitions, userInput: current.userInput, projectName: "bot", runId: "llm-auto" });
  const runner = await withUserSettings({ agent: { permissionPolicy: "auto" } }, () => createLLMBotToolRunner(definitions, current,
    scoped => ["custom", "restricted"].map(name => ({ name, label: name, description: name, parameters: { type: "object", properties: {} },
      async execute() {
        await scoped.toolPermissions!.requireToolApproval({ name });
        return { content: [{ type: "text" as const, text: name }], details: {} };
      } }))));
  assert.equal((await runner.execute(fauxToolCall("custom", {}))).executed, true);
  assert.equal((await runner.execute(fauxToolCall("restricted", {}))).executed, false);
  assert.equal(current.toolPermissions.getTool("custom")?.autoApprove, false);
});
