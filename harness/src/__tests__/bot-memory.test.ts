import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLocalRuntimePersistence, createMemoryRuntimePersistence } from "../runtime-storage";
import { createSqliteBotMemoryStore, type BotMemoryEntry, type BotMemorySummary } from "../runtime-storage/bot-memory";
import { defineBot } from "../agent/bot";
import { BOT_MEMORY_CONFIGURATION_KEY } from "../agent/memory-configuration";
import { BOT_MEMORY_TOOL_NAMES, createBotMemoryTools } from "../agent/memory";
import { createTestResources } from "./entry-test-resources";
import { createProjectConversationContext } from "../conversation";
import { testConversationStorage } from "./runtime-test-storage";
import { createDisabledProjectTokenUsageContext } from "../token-usage";
import type { RunContext } from "../types";
import type { AgentInput } from "../agent/types";
import { createProjectToolPermissionContext } from "../tool-permissions";
import { withBotToolCall } from "../agent/bot-lifecycle";
import { serializeProjectError } from "../workflow/errors";

test("Bot memories survive reopen, share conversations and isolate projects, entries and categories", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bot-memory-"));
  let persistence = createLocalRuntimePersistence({ directory });
  t.after(async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = { projectId: "project-a", entryId: "assistant" };
  const store = persistence.botMemory!(scope);
  const saved = await store.execute({ action: "save", category: "decisions", key: "language", content: "项目文档使用中文。" });
  assert.ok((saved.memory as BotMemorySummary).revision > 0);
  await store.execute({ action: "save", category: "procedures", key: "language", content: "运行测试后再提交。" });
  await persistence.close(); persistence = createLocalRuntimePersistence({ directory });
  const reopened = persistence.botMemory!(scope);
  assert.equal(((await reopened.execute({ action: "get", category: "decisions", key: "language" })).memory as BotMemoryEntry).content, "项目文档使用中文。");
  assert.deepEqual(await reopened.execute({ action: "get" }), { categories: [{ category: "decisions", count: 1 }, { category: "procedures", count: 1 }] });
  assert.equal(((await reopened.execute({ action: "get", query: "文档 中文" })).memories as unknown[]).length, 1);
  for (const other of [{ ...scope, projectId: "project-b" }, { ...scope, entryId: "other" }]) {
    assert.deepEqual(await persistence.botMemory!(other).execute({ action: "get" }), { categories: [] });
  }
});

test("memory updates fence concurrent writers, replay once and do not resurrect a deleted revision", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bot-memory-concurrency-"));
  const file = path.join(directory, "memory.sqlite"), scope = { projectId: "project", entryId: "bot" };
  const first = createSqliteBotMemoryStore({ ...scope, file }), second = createSqliteBotMemoryStore({ ...scope, file });
  t.after(async () => { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  const request = { action: "save" as const, category: "facts", key: "database", content: "Use PostgreSQL." };
  const saved = await first.execute(request, "save-request"), revision = (saved.memory as BotMemorySummary).revision;
  assert.deepEqual(await second.execute(request, "save-request"), saved);
  await assert.rejects(second.execute({ ...request, content: "Other" }, "save-request"), { code: "BOT_MEMORY_IDEMPOTENCY_CONFLICT" });
  await assert.rejects(second.execute(request), { code: "BOT_MEMORY_ALREADY_EXISTS" });
  const update = { ...request, action: "update" as const, expectedRevision: revision, content: "Use local SQLite for history." };
  const edited = await second.execute(update, "update-request");
  assert.deepEqual(await second.execute(update, "update-request"), edited);
  await assert.rejects(first.execute({ ...update, content: "Stale replacement" }), { code: "BOT_MEMORY_REVISION_CONFLICT" });
  await assert.rejects(first.execute({ action: "delete", category: request.category, key: request.key, expectedRevision: revision }), { code: "BOT_MEMORY_REVISION_CONFLICT" });
  const deletion = { action: "delete" as const, category: request.category, key: request.key, expectedRevision: (edited.memory as BotMemorySummary).revision };
  const deleted = await first.execute(deletion, "delete-request");
  assert.deepEqual(await second.execute(deletion, "delete-request"), deleted);
  assert.deepEqual(await second.execute({ action: "get", category: request.category, key: request.key }), { memory: null });
  const recreated = await second.execute(request);
  assert.ok((recreated.memory as BotMemorySummary).revision > deletion.expectedRevision);
  await assert.rejects(first.execute(deletion), { code: "BOT_MEMORY_REVISION_CONFLICT" });
  const database = new DatabaseSync(file, { readOnly: true });
  try { assert.doesNotMatch(JSON.stringify(database.prepare("SELECT result FROM bot_memory_receipts").all()), /PostgreSQL|SQLite for history/); }
  finally { database.close(); }
});

test("retrieval returns bounded summaries, exact reads and category pages without loading all bodies", async t => {
  const memory = createSqliteBotMemoryStore({ file: ":memory:", projectId: "test", entryId: "main" }); t.after(() => memory.close());
  for (let index = 0; index < 24; index++) await memory.execute({ action: "save", category: "decisions", key: `item-${index.toString().padStart(2, "0")}`, content: "A".repeat(8_000) });
  const page = await memory.execute({ action: "get", category: "decisions", limit: 20 });
  assert.equal((page.memories as unknown[]).length, 20); assert.equal(page.nextOffset, 20);
  assert.ok((page.memories as { excerpt: string; content?: string }[]).every(entry => entry.excerpt.length === 240 && entry.content === undefined));
  assert.equal(((await memory.execute({ action: "get", category: "decisions", offset: 20 })).memories as unknown[]).length, 4);
  assert.ok(JSON.stringify(await memory.execute({ action: "get" })).length < 100);
  for (const request of [{ action: "get", projectId: "other" }, { action: "get", key: "item-00" }, { action: "get", limit: 21 }, { action: "get", query: Array(13).fill("word").join(" ") }, { action: "save", category: "", key: "x", content: "x" }, { action: "update", category: "decisions", key: "item-00", content: "x" }]) {
    await assert.rejects(memory.execute(request as never), { code: "BOT_MEMORY_INVALID_INPUT" });
  }
});

function context(persistence: ReturnType<typeof createMemoryRuntimePersistence>, resources = createTestResources(), conversationId = "chat-one"): RunContext {
  return { ...resources, config: {}, providers: {}, metadata: { runtimePersistence: persistence },
    conversation: createProjectConversationContext({ enabled: true, conversationId, projectName: "bot", storage: testConversationStorage() }),
    tokenUsage: createDisabledProjectTokenUsageContext() };
}
const input: AgentInput = { errCode: 0, errMessage: "", prompt: "Remember and retrieve project facts.", requestId: "memory-input" };

for (const withFactory of [false, true]) test(`default memory tools preserve configured extra tools (factory: ${withFactory})`, { timeout: 15_000 }, async t => {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "memory-extra-tools", contextWindow: 100_000, maxTokens: 1_000 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const offered: string[][] = [], calls: string[] = [];
  const custom = (name: string) => ({ name, label: name, description: name, parameters: { type: "object", properties: {} },
    async execute() { calls.push(name); return { content: [{ type: "text" as const, text: name }], details: {} }; },
  });
  const definition = defineBot({ agent: { models, resolvedModel: models.getModel("faux", "memory-extra-tools")!, tools: [], permissionPolicy: "auto",
    extraTools: [custom("configured_tool") as never], ...(withFactory ? { createTools: async () => [custom("per_run_tool") as never] } : {}) },
    tools: ["configured_tool", "per_run_tool"].map(name => ({ name, enabled: true, autoApprove: true })),
  });
  faux.setResponses([
    request => { offered.push(ai.getCurrentTools(request.messages).map(tool => tool.name)); return ai.fauxAssistantMessage([ai.fauxToolCall("configured_tool", {})], { stopReason: "toolUse" }); },
    ...(withFactory ? [ai.fauxAssistantMessage([ai.fauxToolCall("per_run_tool", {})], { stopReason: "toolUse" })] : []),
    ai.fauxAssistantMessage("Done"),
  ]);
  const run = context(persistence);
  run.toolPermissions = createProjectToolPermissionContext({ definitions: definition.tools ?? [], projectName: "bot", runId: "custom-tools" });
  assert.equal((await definition.workflow.run(input, run)).errCode, 0);
  assert.ok(offered[0]?.includes("configured_tool"));
  assert.equal(offered[0]?.includes("per_run_tool"), withFactory);
  assert.deepEqual(offered[0]?.filter(name => name.startsWith("memory_")), BOT_MEMORY_TOOL_NAMES);
  assert.deepEqual(calls, withFactory ? ["configured_tool", "per_run_tool"] : ["configured_tool"]);
});

for (const enabled of [true, false]) test(`configured extra tools cannot replace Core memory tools (enabled: ${enabled})`, async t => {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "reserved-memory-tools", contextWindow: 100_000, maxTokens: 500 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const definition = defineBot({ memory: { enabled }, agent: { models, resolvedModel: models.getModel("faux", "reserved-memory-tools")!, tools: [],
    extraTools: [{ name: "memory_get", label: "Memory", description: "Conflicting tool", parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "Wrong tool" }], details: {} }; } } as never] } });
  faux.setResponses([ai.fauxAssistantMessage("Done")]);
  await assert.rejects(async () => definition.workflow.run(input, context(persistence)), error => {
    assert.match(JSON.stringify(serializeProjectError(error)), /memory_\* tool names are reserved/);
    return true;
  });
});

test("separate Bot conversations retrieve the same project memory while a disabled switch blocks calls", async t => {
  const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const resources = createTestResources(), first = context(persistence, resources), second = context(persistence, resources, "chat-two");
  second.actor = { userId: "another-user", isSystemAdmin: false };
  const tools = (run: RunContext) => createBotMemoryTools({ context: run, defaultEnabled: true, readOnly: false, input });
  const save = tools(first).find(tool => tool.name === "memory_save")!;
  await save.execute("call-save", { category: "facts", key: "timezone", content: "All dates use Asia/Shanghai." });
  const get = tools(second).find(tool => tool.name === "memory_get")!;
  assert.match(JSON.stringify(await get.execute("call-get", { category: "facts", key: "timezone" })), /Asia\/Shanghai/);
  second.config[BOT_MEMORY_CONFIGURATION_KEY] = false;
  await assert.rejects(get.execute("blocked", {}), /disabled/);
  second.config[BOT_MEMORY_CONFIGURATION_KEY] = true;
  assert.match(JSON.stringify(await get.execute("enabled", { category: "facts", key: "timezone" })), /Asia\/Shanghai/);
  const scopedSave = (task: string, key: string) => withBotToolCall(task, () => save.execute("reused-model-call-id", { category: "facts", key, content: key }));
  const firstResult = await scopedSave("durable-task-one", "one");
  assert.deepEqual(await scopedSave("durable-task-one", "one"), firstResult);
  await scopedSave("durable-task-two", "two");
  assert.match(JSON.stringify(await get.execute("separate-task", { category: "facts", key: "two" })), /two/);
});

test("a Bot can save memory and a new conversation can retrieve, update and delete it through model tool calls", { timeout: 15_000 }, async t => {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "memory-tools", contextWindow: 100_000, maxTokens: 1_000 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const resources = createTestResources(), address = { category: "decisions", key: "database" };
  const bot = () => defineBot({ agent: { models, resolvedModel: models.getModel("faux", "memory-tools")!, tools: [], permissionPolicy: "auto", ...{ retryDelayMs: 0 } } });
  const run = async (requestId: string, conversationId: string) => {
    const definition = bot(), execution = context(persistence, resources, conversationId);
    execution.toolPermissions = createProjectToolPermissionContext({ definitions: definition.tools ?? [], projectName: "bot", runId: requestId });
    return definition.workflow.run({ ...input, requestId }, execution);
  };
  const call = (name: string, args: Record<string, string | number>) => ai.fauxAssistantMessage([ai.fauxToolCall(name, args)], { stopReason: "toolUse" });
  faux.setResponses([call("memory_save", { ...address, content: "Use PostgreSQL." }), ai.fauxAssistantMessage("Saved")]);
  const outcome = await run("save-turn", "original-chat");
  assert.equal(outcome.errCode, 0);
  const store = persistence.botMemory!({ projectId: resources.projectId, entryId: resources.entryId });
  const saved = (await store.execute({ action: "get", ...address })).memory as BotMemoryEntry;
  assert.ok(saved, JSON.stringify(outcome));
  assert.equal(saved.content, "Use PostgreSQL.");
  const observed: string[] = [];
  faux.setResponses([
    call("memory_get", address),
    request => { observed.push(JSON.stringify(request)); return call("memory_update", { ...address, content: "Use SQLite.", expectedRevision: saved.revision }); },
    call("memory_get", address),
    request => { observed.push(JSON.stringify(request)); return call("memory_delete", { ...address, expectedRevision: saved.revision + 1 }); },
    call("memory_get", address),
    request => { observed.push(JSON.stringify(request)); return ai.fauxAssistantMessage("Forgotten"); },
  ]);
  assert.equal((await run("edit-turn", "new-chat")).errCode, 0);
  assert.match(observed[0]!, /Use PostgreSQL/);
  assert.match(observed[1]!, /Use SQLite/);
  assert.match(observed[2]!, /memory.*null/);
  assert.deepEqual(await store.execute({ action: "get", ...address }), { memory: null });
});

for (const mode of ["enabled", "disabled", "source-disabled", "source-disabled-ui-enabled", "plan", "read-only", "host-disabled"] as const) {
  test(`Bot memory tools and built-in guidance honor ${mode} with a prepared persona`, { timeout: 10_000 }, async t => {
    const ai = await import("@earendil-works/pi-ai");
    const faux = ai.fauxProvider({ models: [{ id: "memory-test", contextWindow: 100_000, maxTokens: 500 }] });
    const models = ai.createModels(); models.setProvider(faux.provider);
    const requests: string[] = [], offered: string[][] = [];
    faux.setResponses([(request: unknown) => {
      const value = request as { messages: Parameters<typeof ai.getCurrentTools>[0] };
      requests.push(JSON.stringify(value)); offered.push(ai.getCurrentTools(value.messages).map(tool => tool.name));
      return ai.fauxAssistantMessage([ai.fauxText("Ready")]);
    }] as never[]);
    const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
    const run = context(persistence);
    if (mode === "disabled") run.config[BOT_MEMORY_CONFIGURATION_KEY] = false;
    if (mode === "source-disabled-ui-enabled") run.config[BOT_MEMORY_CONFIGURATION_KEY] = true;
    const bot = defineBot({ memory: { enabled: !mode.startsWith("source-disabled") },
      agent: { models, resolvedModel: models.getModel("faux", "memory-test")!, tools: [], permissionPolicy: mode === "read-only" ? "read-only" : "workspace", ...{ retryDelayMs: 0 } },
      prepareInput(value) { return { ...value, systemPrompt: "Custom prepared persona." }; },
    });
    if (mode === "host-disabled") run.toolPermissions = createProjectToolPermissionContext({ definitions: bot.tools!.map(tool => tool.name === "memory_save" ? { ...tool, enabled: false } : tool), projectName: "bot", runId: "disabled-tool" });
    const output = await bot.workflow.run({ ...input, agent: mode === "plan" ? "plan" : "build" }, run);
    assert.equal(output.errCode, 0); assert.ok(requests.length > 0);
    assert.match(requests[0]!, /Custom prepared persona/);
    const active = mode !== "disabled" && mode !== "source-disabled";
    const expected = !active ? [] : mode === "plan" || mode === "read-only" ? ["memory_get"] : BOT_MEMORY_TOOL_NAMES.filter(name => mode !== "host-disabled" || name !== "memory_save");
    assert.deepEqual(offered[0]!.filter(name => name.startsWith("memory_")), expected);
    if (active) assert.match(requests[0]!, /Memories belong only to this Bot project and entry/);
    else assert.doesNotMatch(requests[0]!, /Project memory is available/);
  });
}
