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
import { BOT_MEMORY_TOOL_NAMES, botMemoryKeywords, createBotMemoryRecall, createBotMemoryTools } from "../agent/memory";
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

test("keyword search ranks coverage and keys, supports Chinese, all/any and literal matching, and returns focused excerpts", async t => {
  const memory = createSqliteBotMemoryStore({ file: ":memory:", projectId: "test", entryId: "main" }); t.after(() => memory.close());
  const save = (category: string, key: string, content: string) => memory.execute({ action: "save", category, key, content });
  await save("decisions", "postgresql", "数据库连接池固定为 5。PostgreSQL 用于业务数据。");
  await save("procedures", "database", "其他信息。".repeat(800) + "数据库维护前需要备份。PostgreSQL 连接池需要监控。");
  await save("facts", "postgresql-old", "数据库使用 PostgreSQL。");
  await save("facts", "wildcards", "字面字符 %_ ' ? 必须原样匹配。");
  await save("unrelated", "image", "图片输出格式为 PNG。");
  const search = (extra = {}) => memory.execute({ action: "search", keywords: ["PostgreSQL", "连接池"], ...extra });
  const any = await search();
  const entries = any.memories as (BotMemorySummary & { excerpt: string; content?: string; matchedKeywords: string[] })[];
  assert.deepEqual(entries.map(entry => entry.key), ["postgresql", "database", "postgresql-old"]);
  assert.deepEqual(entries[0]!.matchedKeywords, ["postgresql", "连接池"]);
  assert.ok(entries.every(entry => entry.excerpt.length <= 240 && entry.content === undefined));
  assert.match(entries[1]!.excerpt, /数据库维护前需要备份/);
  assert.equal(((await search({ match: "all" })).memories as unknown[]).length, 2);
  assert.equal(((await search({ category: "procedures" })).memories as unknown[]).length, 1);
  assert.equal(((await search({ keywords: ["SQLITE"] })).memories as unknown[]).length, 0);
  assert.equal(((await search({ keywords: ["%_ '"] })).memories as unknown[]).length, 1);
  const first = await search({ limit: 1 }); assert.equal(first.nextOffset, 1);
  assert.equal(((await search({ limit: 1, offset: first.nextOffset })).memories as BotMemorySummary[])[0]!.key, "database");
  assert.equal(((await search({ keywords: [" PostGreSQL ", "POSTGRESQL"], match: "all" })).memories as unknown[]).length, 3);
  for (const invalid of [{ keywords: [] }, { keywords: [""] }, { keywords: ["x\0"] }, { keywords: ["x".repeat(81)] },
    { keywords: Array(13).fill("词") }, { keywords: Array(12).fill("长".repeat(80)) }, { keywords: [1] }, { keywords: Array(2) }, { limit: 11 }, { match: "fuzzy" }, { query: "postgresql" }, { projectId: "other" }]) {
    await assert.rejects(search(invalid), { code: "BOT_MEMORY_INVALID_INPUT" });
  }
});

test("search has count and whole-response budgets and pagination never drops matches", async t => {
  const memory = createSqliteBotMemoryStore({ file: ":memory:", projectId: "test", entryId: "main" }); t.after(() => memory.close());
  const keywords = Array.from({ length: 6 }, (_, index) => `${index}-` + "词".repeat(70));
  const content = keywords.join(" ") + "正文".repeat(2_000);
  for (let index = 0; index < 24; index++) await memory.execute({ action: "save", category: "c".repeat(100), key: `${index}-` + "k".repeat(190), content });
  const first = await memory.execute({ action: "search", keywords });
  assert.equal((first.memories as unknown[]).length, 5);
  const keys: string[] = [];
  let offset = 0;
  do {
    const page = await memory.execute({ action: "search", keywords, limit: 10, offset });
    assert.ok(JSON.stringify(page).length <= 6_000);
    const entries = page.memories as BotMemorySummary[];
    assert.ok(entries.length > 0 && entries.length < 10, "Long summaries should hit the response budget before the count limit");
    keys.push(...entries.map(entry => entry.key));
    if (page.nextOffset === undefined) break;
    assert.equal(page.nextOffset, offset + entries.length); offset = page.nextOffset as number;
  } while (true);
  assert.equal(keys.length, 24); assert.equal(new Set(keys).size, 24);
  const escapedKeywords = Array.from({ length: 6 }, (_, index) => String.fromCharCode(index + 1).repeat(80));
  await memory.execute({ action: "save", category: "\u0001".repeat(100), key: "\u0002".repeat(200), content: escapedKeywords.join(" ") });
  const escapedPage = await memory.execute({ action: "search", keywords: escapedKeywords, match: "all" });
  assert.equal((escapedPage.memories as unknown[]).length, 1); assert.equal(escapedPage.nextOffset, undefined);
  assert.ok(JSON.stringify(escapedPage).length <= 6_000);
});

test("automatic lookup extracts bounded topic keywords and stays silent under host restrictions", async t => {
  assert.deepEqual(botMemoryKeywords("好的，谢谢！"), []);
  const keywords = botMemoryKeywords("请检查 PostgreSQL 数据库连接池配置，PostgreSQL 的连接池应该如何设置？");
  assert.ok(keywords.includes("postgresql")); assert.ok(keywords.some(word => "连接池".includes(word)));
  assert.ok(!keywords.includes("如何") && !keywords.includes("检查"));
  assert.ok(botMemoryKeywords(Array.from({ length: 30 }, (_, index) => `keyword${index}`).join(" ")).length <= 12);
  const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const run = context(persistence);
  let approvals = 0;
  run.userInput = { requestInput: async () => { approvals++; throw new Error("Automatic memory must not ask for approval"); } } as never;
  for (const policy of [{ enabled: false, autoApprove: true }, { enabled: true, autoApprove: false }]) {
    run.toolPermissions = createProjectToolPermissionContext({ definitions: [{ name: "memory_search", ...policy }], projectName: "bot", runId: "lookup" });
    assert.equal(await createBotMemoryRecall(run, true)("PostgreSQL 数据库"), undefined);
  }
  assert.equal(approvals, 0);
  const aborted = AbortSignal.abort(new Error("Lookup cancelled"));
  await assert.rejects(createBotMemoryRecall(run, true)("PostgreSQL", aborted), /Lookup cancelled/);
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
  const definition = defineBot({ engine: "agent", agent: { models, resolvedModel: models.getModel("faux", "memory-extra-tools")!, tools: [], permissionPolicy: "auto",
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
  const definition = defineBot({ engine: "agent", memory: { enabled }, agent: { models, resolvedModel: models.getModel("faux", "reserved-memory-tools")!, tools: [],
    extraTools: [{ name: "memory_get", label: "Memory", description: "Conflicting tool", parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "Wrong tool" }], details: {} }; } } as never] } });
  faux.setResponses([ai.fauxAssistantMessage("Done")]);
  await assert.rejects(async () => definition.workflow.run(input, context(persistence)), error => {
    assert.match(JSON.stringify(serializeProjectError(error)), /memory_\* tool names are reserved/);
    return true;
  });
});

test("separate Bot conversations can create, link, read and unlink a structured memory through the offered tools", async t => {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "memory-relations", contextWindow: 100_000, maxTokens: 1_000 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const resources = createTestResources();
  const definition = defineBot({ engine: "agent", agent: { models, resolvedModel: models.getModel("faux", "memory-relations")!, tools: [], permissionPolicy: "auto" } });
  const run = (requestId: string) => {
    const execution = context(persistence, resources, requestId);
    execution.toolPermissions = createProjectToolPermissionContext({ definitions: definition.tools, projectName: "bot", runId: requestId });
    return definition.workflow.run({ ...input, requestId }, execution);
  };
  const call = (name: string, args: Parameters<typeof ai.fauxToolCall>[1]) => ai.fauxAssistantMessage([ai.fauxToolCall(name, args)], { stopReason: "toolUse" });
  faux.setResponses([
    call("memory_save", { category: "procedures", key: "deploy", content: "Follow the linked service." }),
    call("memory_save", { category: "services", key: "release", title: "Old service", properties: { status: "testing" } }),
    ai.fauxAssistantMessage("Saved"),
  ]);
  assert.equal((await run("save-structure")).errCode, 0);
  const store = persistence.botMemory!(resources);
  const source = (await store.execute({ action: "get", category: "procedures", key: "deploy" })).memory as BotMemoryEntry;
  const target = (await store.execute({ action: "get", category: "services", key: "release" })).memory as BotMemoryEntry;
  assert.equal(target.properties.status, "testing");
  const relation = { sourceId: source.id, targetId: target.id, relation: "depends_on" };
  faux.setResponses([
    call("memory_link", { ...relation, expectedRevision: source.revision }),
    call("memory_update", { id: target.id, expectedRevision: target.revision, title: "Release center", properties: { status: "live" } }),
    call("memory_get", { id: source.id, relations: "outgoing" }),
    request => {
      const payload = JSON.stringify(request.messages.at(-1));
      assert.match(payload, /Release center/); assert.match(payload, /live/); assert.doesNotMatch(payload, /Old service|testing/);
      const result = request.messages.at(-1) as { content: { text: string }[] };
      const { memory } = JSON.parse(result.content[0]!.text) as { memory: BotMemoryEntry };
      return call("memory_unlink", { ...relation, expectedRevision: memory.revision });
    },
    ai.fauxAssistantMessage("Updated"),
  ]);
  assert.equal((await run("relate-structure")).errCode, 0);
  assert.deepEqual((await store.execute({ action: "get", id: target.id, relations: "incoming" })).relations, []);
  const changes = (await store.manage!({ action: "history", id: target.id }, { actor: "user" })).changes as import("../runtime-storage/bot-memory-journal").BotMemoryChange[];
  assert.equal(changes[0]!.action, "update");
  assert.equal(changes[0]!.source.actor, "bot");
  assert.equal(changes[0]!.source.requestId, "relate-structure");
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

test("directory-aware memory tools route every operation and skip ambiguous background recall", async t => {
  const primary = createMemoryRuntimePersistence(), secondary = createMemoryRuntimePersistence();
  t.after(async () => { await primary.close(); await secondary.close(); });
  const a = path.join(os.tmpdir(), "memory-a"), b = path.join(os.tmpdir(), "memory-b");
  const run = context(primary);
  const scope = { projectId: run.projectId, entryId: run.entryId };
  const address = { category: "facts", key: "storage" };
  const read = { action: "get", ...address } as const;
  await primary.botMemory!(scope).execute({ action: "save", ...address, content: "AlphaSQLite" });
  const tools = () => createBotMemoryTools({ context: run, defaultEnabled: true, readOnly: false, input });
  const legacy = tools().find(tool => tool.name === "memory_save")!;
  assert.doesNotMatch(JSON.stringify(legacy.parameters), /projectPath/);
  await assert.rejects(legacy.execute("legacy-explicit", { ...address, projectPath: b, content: "No fallback" }), /authorized project directory/);

  primary.botMemoryDirectories = { kind: "workspace-roots", primary: a, roots: [a, b], async withStore(bot, directory, use) {
    assert.deepEqual(bot, scope);
    if (directory !== a && directory !== b) throw new Error("Directory not authorized");
    return use((directory === a ? primary : secondary).botMemory!(bot));
  } };
  const offered = tools();
  assert.ok(offered.every(tool => JSON.stringify(tool.parameters).includes("projectPath")));
  const save = offered.find(tool => tool.name === "memory_save")!, get = offered.find(tool => tool.name === "memory_get")!;
  await save.execute("linked-save", { ...address, content: "BetaSQLite", projectPath: b });
  assert.match(JSON.stringify(await get.execute("linked-get", { projectPath: b, ...address })), /BetaSQLite/);
  assert.match(JSON.stringify(await get.execute("default-get", address)), /AlphaSQLite/);
  await assert.rejects(save.execute("invalid-save", { ...address, key: "blocked", content: "No fallback", projectPath: os.tmpdir() }), /not authorized/);
  assert.deepEqual(await primary.botMemory!(scope).execute({ ...read, key: "blocked" }), { memory: null });
  assert.equal(((await primary.botMemory!(scope).execute(read)).memory as BotMemoryEntry).content, "AlphaSQLite");

  run.toolPermissions = createProjectToolPermissionContext({ definitions: [{ name: "memory_search", enabled: true, autoApprove: true }], projectName: "bot", runId: "scoped-lookup" });
  const recall = createBotMemoryRecall(run, true);
  assert.equal(await recall("AlphaSQLite"), undefined);
  primary.botMemoryDirectories = { ...primary.botMemoryDirectories, kind: "folder-context", roots: [a] };
  assert.equal(await recall("AlphaSQLite"), undefined);
  primary.botMemoryDirectories = { ...primary.botMemoryDirectories, kind: "workspace-roots" };
  assert.match(await recall("AlphaSQLite") ?? "", /AlphaSQLite/);
});

test("a Bot can save memory and a new conversation can retrieve, update and delete it through model tool calls", { timeout: 15_000 }, async t => {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "memory-tools", contextWindow: 100_000, maxTokens: 1_000 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const resources = createTestResources(), address = { category: "decisions", key: "database" };
  const bot = () => defineBot({ engine: "agent", agent: { models, resolvedModel: models.getModel("faux", "memory-tools")!, tools: [], permissionPolicy: "auto", ...{ retryDelayMs: 0 } } });
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
    const bot = defineBot({ engine: "agent", memory: { enabled: !mode.startsWith("source-disabled") },
      agent: { models, resolvedModel: models.getModel("faux", "memory-test")!, tools: [], permissionPolicy: mode === "read-only" ? "read-only" : "workspace", ...{ retryDelayMs: 0 } },
      prepareInput(value) { return { ...value, systemPrompt: "Custom prepared persona." }; },
    });
    const disabledTools = new Set(["memory_save", "memory_link", "memory_unlink"]);
    if (mode === "host-disabled") run.toolPermissions = createProjectToolPermissionContext({ definitions: bot.tools!.map(tool => disabledTools.has(tool.name) ? { ...tool, enabled: false } : tool), projectName: "bot", runId: "disabled-tool" });
    const output = await bot.workflow.run({ ...input, agent: mode === "plan" ? "plan" : "build" }, run);
    assert.equal(output.errCode, 0); assert.ok(requests.length > 0);
    assert.match(requests[0]!, /Custom prepared persona/);
    const active = mode !== "disabled" && mode !== "source-disabled";
    const expected = !active ? [] : mode === "plan" || mode === "read-only" ? ["memory_get", "memory_search"] : BOT_MEMORY_TOOL_NAMES.filter(name => mode !== "host-disabled" || !disabledTools.has(name));
    assert.deepEqual(offered[0]!.filter(name => name.startsWith("memory_")), expected);
    if (active) assert.match(requests[0]!, /Memories belong only to this Bot project and entry/);
    else assert.doesNotMatch(requests[0]!, /Project memory is available/);
  });
}

test("Bot searches project memory before its first model request and refreshes after automatic writes", { timeout: 15_000 }, async t => {
  const ai = await import("@earendil-works/pi-ai");
  const faux = ai.fauxProvider({ models: [{ id: "automatic-memory", contextWindow: 100_000, maxTokens: 1_000 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const run = context(persistence), address = { category: "decisions", key: "database" };
  const store = persistence.botMemory!({ projectId: run.projectId, entryId: run.entryId });
  const saved = await store.execute({ action: "save", ...address, content: "数据库使用 PostgreSQL。" });
  const revision = (saved.memory as BotMemorySummary).revision;
  await store.execute({ action: "save", category: "images", key: "format", content: "图片输出 PNG。" });
  await persistence.botMemory!({ projectId: "other-project", entryId: run.entryId }).execute({ action: "save", ...address, content: "数据库使用 OTHER_PROJECT_SECRET。" });
  const bot = defineBot({ engine: "agent", agent: { models, resolvedModel: models.getModel("faux", "automatic-memory")!, tools: [], permissionPolicy: "auto" },
    prepareInput(value) { return { ...value, systemPrompt: "Prepared database assistant." }; } });
  run.toolPermissions = createProjectToolPermissionContext({ definitions: bot.tools, projectName: "bot", runId: "auto" });
  const snapshots: string[] = [];
  const observe = (request: { messages: readonly { role: string }[] }) => {
    assert.equal(request.messages.at(-1)?.role, snapshots.length === 0 ? "user" : "toolResult", "Memory context must preserve the current input/tool boundary");
    const value = JSON.stringify(request.messages.find(message => JSON.stringify(message).includes("Automatically retrieved Bot project memory"))); snapshots.push(value);
    assert.match(value, /Automatically retrieved Bot project memory/);
    assert.doesNotMatch(value, /OTHER_PROJECT_SECRET|图片输出 PNG/);
    assert.match(JSON.stringify(request), /Do not wait for the user to ask/);
    assert.match(JSON.stringify(request), /Do not report routine memory operations/i);
  };
  faux.setResponses([
    request => { observe(request); assert.match(snapshots[0]!, /PostgreSQL/); return ai.fauxAssistantMessage([ai.fauxToolCall("memory_update", { ...address, content: "数据库使用 SQLite。", expectedRevision: revision })], { stopReason: "toolUse" }); },
    request => { observe(request); assert.match(snapshots[1]!, /SQLite/); assert.doesNotMatch(snapshots[1]!, /PostgreSQL/); return ai.fauxAssistantMessage([ai.fauxToolCall("memory_delete", { ...address, expectedRevision: revision + 2 })], { stopReason: "toolUse" }); },
    request => { observe(request); return ai.fauxAssistantMessage("配置已更新。"); },
  ]);
  assert.equal((await bot.workflow.run({ ...input, prompt: "数据库怎样配置？" }, run)).errCode, 0);
  assert.doesNotMatch(snapshots[2]!, /数据库使用/);
  assert.equal(snapshots.length, 3);
});
