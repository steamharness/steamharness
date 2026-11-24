import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteBotMemoryStore, type BotMemoryEntry, type BotMemoryProperties, type BotMemorySummary } from "../runtime-storage/bot-memory";

const scope = { projectId: "project", entryId: "assistant" };
type Relation = { relation: string; memory: BotMemorySummary & { properties: BotMemoryProperties; content?: never } };

test("a legacy database migrates once without changing text, revisions, or write receipts", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "legacy-bot-memory-"));
  const file = path.join(directory, "memory.sqlite");
  const first = createSqliteBotMemoryStore({ ...scope, file }), second = createSqliteBotMemoryStore({ ...scope, file });
  t.after(async () => { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); });
  const request = { action: "save" as const, category: "facts", key: "legacy", content: "Keep this old fact." };
  const now = "2026-01-02T03:04:05.000Z";
  const receipt = { memory: { category: request.category, key: request.key, revision: 41, createdAt: now, updatedAt: now } };
  const database = new DatabaseSync(file);
  try {
    database.exec(`CREATE TABLE bot_memories(project_id TEXT NOT NULL,entry_id TEXT NOT NULL,category TEXT NOT NULL,key TEXT NOT NULL,content TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,entry_id,category,key));
      CREATE TABLE bot_memory_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
      INSERT INTO bot_memory_sequence VALUES(1,41);
      CREATE TABLE bot_memory_receipts(project_id TEXT NOT NULL,entry_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project_id,entry_id,request_id));`);
    database.prepare("INSERT INTO bot_memories VALUES(?,?,?,?,?,?,?,?)").run(scope.projectId, scope.entryId, request.category, request.key, request.content, 41, now, now);
    database.prepare("INSERT INTO bot_memory_receipts VALUES(?,?,?,?,?)").run(scope.projectId, scope.entryId, "old-save",
      createHash("sha256").update(JSON.stringify(request)).digest("hex"), JSON.stringify(receipt));
  } finally { database.close(); }

  assert.deepEqual(await first.execute(request, "old-save"), receipt);
  const old = (await first.execute({ action: "get", category: request.category, key: request.key })).memory as BotMemoryEntry;
  assert.match(old.id, /^[a-f0-9]{32}$/);
  assert.deepEqual(old, { ...receipt.memory, id: old.id, content: request.content, properties: {} });
  first.close();
  assert.deepEqual(await second.execute({ action: "get", id: old.id }), { memory: old });
  const edited = (await second.execute({ action: "update", category: old.category, key: old.key, content: "Legacy call still works.", expectedRevision: 41 })).memory as BotMemorySummary;
  assert.equal(edited.id, old.id);
  assert.equal(edited.revision, 42);
  assert.equal(edited.createdAt, now);
  const olderWorker = new DatabaseSync(file);
  try {
    olderWorker.prepare("INSERT INTO bot_memories(project_id,entry_id,category,key,content,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(scope.projectId, scope.entryId, "facts", "old-worker", "Inserted by an older worker", 43, now, now);
  } finally { olderWorker.close(); }
  const inserted = (await second.execute({ action: "get", category: "facts", key: "old-worker" })).memory as BotMemoryEntry;
  assert.match(inserted.id, /^[a-f0-9]{32}$/);
  assert.notEqual(inserted.id, old.id);
});

test("structured properties are patched and queried by exact value without replacing the body", async t => {
  const store = createSqliteBotMemoryStore({ ...scope, file: ":memory:" }); t.after(() => store.close());
  const save = { action: "save" as const, category: "services", key: "release", title: "旧发布服务", summary: "管理部署发布", content: "原始正文",
    properties: { status: "testing", owner: "ops", active: true, score: 1, note: null, "目标.列表": [{ region: "CN", priority: 1 }] } };
  const original = await store.execute(save, "structured-save");
  assert.deepEqual(await store.execute({ ...save, properties: Object.fromEntries(Object.entries(save.properties).reverse()) }, "structured-save"), original);
  assert.doesNotMatch(JSON.stringify(original), /旧发布服务|管理部署发布|原始正文|testing/);
  const { id, revision } = original.memory as BotMemorySummary;
  await store.execute({ action: "update", id, expectedRevision: revision, title: "发布中心", properties: { status: "live" }, removeProperties: ["owner"] });
  const result = (await store.execute({ action: "get", id })).memory as BotMemoryEntry;
  assert.equal(result.title, "发布中心"); assert.equal(result.summary, save.summary); assert.equal(result.content, save.content);
  const { owner: _owner, ...remaining } = save.properties;
  assert.deepEqual(result.properties, { ...remaining, status: "live" });
  assert.equal(((await store.execute({ action: "search", keywords: ["发布中心", "管理部署"], match: "all", where: { status: "live", active: true } })).memories as BotMemorySummary[])[0]?.id, id);
  assert.equal(((await store.execute({ action: "get", query: "发布中心 管理部署", where: { score: 1, note: null } })).memories as BotMemorySummary[])[0]?.id, id);
  const mismatches: Record<string, string | number | boolean | null>[] = [{ score: true }, { active: 1 }, { status: "LIVE" }, { owner: null }];
  for (const where of mismatches) {
    assert.deepEqual(await store.execute({ action: "get", where }), { memories: [] });
  }
  await store.execute({ action: "update", id, expectedRevision: result.revision, title: null, summary: null, content: null });
  const cleared = (await store.execute({ action: "get", id })).memory as BotMemoryEntry;
  assert.equal(cleared.title, undefined); assert.equal(cleared.summary, undefined); assert.equal(cleared.content, "");
  assert.deepEqual(cleared.properties, result.properties);
  for (const bad of [
    { action: "save", category: "services", key: "empty", properties: {} },
    { action: "get", id, category: "services" }, { action: "get", category: "services", relations: "outgoing" },
    { action: "get", where: { status: ["live"] } }, { action: "update", id, expectedRevision: cleared.revision },
    { action: "update", id, expectedRevision: cleared.revision, properties: { status: "live" }, removeProperties: ["status"] },
    { action: "update", id, expectedRevision: cleared.revision, properties: { score: Infinity } },
    { action: "update", id, expectedRevision: cleared.revision, properties: { score: "x".repeat(4_000) } },
  ]) await assert.rejects(store.execute(bad as never), { code: "BOT_MEMORY_INVALID_INPUT" });
  await assert.rejects(store.execute({ action: "update", id, expectedRevision: cleared.revision, properties: { large: "a".repeat(3_980) } }),
    { code: "BOT_MEMORY_INVALID_INPUT" }, "the resulting merged properties must also fit the limit");
  assert.deepEqual(await store.execute({ action: "get", id }), { memory: cleared });
});

test("two references resolve the same current memory and protect it from deletion across workers", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bot-memory-links-"));
  const file = path.join(directory, "memory.sqlite");
  const first = createSqliteBotMemoryStore({ ...scope, file }), second = createSqliteBotMemoryStore({ ...scope, file });
  const otherEntry = createSqliteBotMemoryStore({ ...scope, entryId: "clone", file });
  const otherProject = createSqliteBotMemoryStore({ ...scope, projectId: "other", file });
  t.after(async () => { first.close(); second.close(); otherEntry.close(); otherProject.close(); await rm(directory, { recursive: true, force: true }); });
  const save = async (key: string, store = first) => (await store.execute({ action: "save", category: "facts", key, content: `${key} body.` })).memory as BotMemorySummary;
  const a = await save("A"), b = await save("B");
  const c = (await first.execute({ action: "save", category: "services", key: "C", title: "Old release service", properties: { status: "testing" } })).memory as BotMemorySummary;
  const linkA = { action: "link" as const, sourceId: a.id, targetId: c.id, relation: "depends_on", expectedRevision: a.revision };
  const linkB = { action: "link" as const, sourceId: b.id, targetId: c.id, relation: "mentions", expectedRevision: b.revision };
  const linked = await first.execute(linkA, "link-a");
  assert.deepEqual(await second.execute(linkA, "link-a"), linked);
  assert.equal(linked.linked, true);
  const aRevision = (linked.memory as BotMemorySummary).revision;
  await assert.rejects(second.execute({ ...linkA, relation: "other" }, "link-a"), { code: "BOT_MEMORY_IDEMPOTENCY_CONFLICT" });
  await assert.rejects(second.execute({ ...linkA, expectedRevision: aRevision }), { code: "BOT_MEMORY_RELATION_ALREADY_EXISTS" });
  await assert.rejects(second.execute({ action: "update", id: a.id, title: "Stale", expectedRevision: a.revision }), { code: "BOT_MEMORY_REVISION_CONFLICT" });
  const bRevision = ((await second.execute(linkB)).memory as BotMemorySummary).revision;
  for (const [source, expected] of [[a, linkA.relation], [b, linkB.relation]] as const) {
    const page = await first.execute({ action: "get", id: source.id, relations: "outgoing" });
    const [relation] = page.relations as Relation[];
    assert.equal(relation!.relation, expected); assert.equal(relation!.memory.title, "Old release service");
  }
  const cRevision = ((await second.execute({ action: "update", id: c.id, expectedRevision: c.revision, title: "Release center", properties: { status: "live" } }, "edit-c")).memory as BotMemorySummary).revision;
  for (const source of [a, b]) {
    const { memory, relations } = await first.execute({ action: "get", id: source.id, relations: "outgoing" });
    assert.equal((memory as BotMemoryEntry).content, `${source.key} body.`);
    const [relation] = relations as Relation[];
    assert.equal(relation!.memory.id, c.id); assert.equal(relation!.memory.title, "Release center");
    assert.equal(relation!.memory.revision, cRevision); assert.equal(relation!.memory.properties.status, "live");
    assert.equal(relation!.memory.content, undefined);
  }
  const incoming = await second.execute({ action: "get", id: c.id, relations: "incoming", limit: 1 });
  assert.equal((incoming.relations as Relation[])[0]?.memory.id, a.id); assert.equal(incoming.nextOffset, 1);
  const tail = await second.execute({ action: "get", id: c.id, relations: "incoming", limit: 1, offset: 1 });
  assert.equal((tail.relations as Relation[])[0]?.memory.id, b.id); assert.equal(tail.nextOffset, undefined);
  for (const other of [otherEntry, otherProject]) {
    assert.deepEqual(await other.execute({ action: "get", id: c.id, relations: "incoming" }), { memory: null });
    const unrelated = await save("A", other);
    await assert.rejects(other.execute({ ...linkA, sourceId: unrelated.id, expectedRevision: unrelated.revision }), { code: "BOT_MEMORY_NOT_FOUND" });
  }
  const deletion = { action: "delete" as const, category: c.category, key: c.key, expectedRevision: cRevision };
  await assert.rejects(first.execute(deletion), { code: "BOT_MEMORY_REFERENCED" });
  const readOnly = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(readOnly.prepare("PRAGMA foreign_key_check").all(), []);
    assert.doesNotMatch(JSON.stringify(readOnly.prepare("SELECT result FROM bot_memory_receipts").all()), /Old release service|Release center|testing|live/);
  } finally { readOnly.close(); }
  const unlink = { ...linkA, action: "unlink" as const, expectedRevision: aRevision };
  const unlinked = await second.execute(unlink, "unlink-a");
  assert.equal(unlinked.unlinked, true);
  assert.deepEqual(await first.execute(unlink, "unlink-a"), unlinked);
  await assert.rejects(first.execute({ ...unlink, expectedRevision: (unlinked.memory as BotMemorySummary).revision }), { code: "BOT_MEMORY_RELATION_NOT_FOUND" });
  await assert.rejects(first.execute(deletion), { code: "BOT_MEMORY_REFERENCED" });
  await first.execute({ action: "delete", id: b.id, expectedRevision: bRevision });
  assert.deepEqual((await second.execute({ action: "get", id: c.id, relations: "incoming" })).relations, []);
  await second.execute(deletion);
  const recreated = (await first.execute({ action: "save", category: c.category, key: c.key, title: "A new record" })).memory as BotMemorySummary;
  assert.notEqual(recreated.id, c.id);
  assert.deepEqual(await first.execute({ action: "get", id: c.id }), { memory: null });
});
