import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteBotMemoryStore, type BotMemoryEntry } from "../runtime-storage/bot-memory";
import type { BotMemoryChange } from "../runtime-storage/bot-memory-journal";

const user = { actor: "user" } as const;
const bot = { actor: "bot", runId: "run-fixture", conversationId: "chat-fixture", requestId: "turn-fixture" } as const;
const scope = { projectId: "fixture", entryId: "agent" };

test("manual and Bot writes share the scoped journal and revision fence; links resolve current fields", async t => {
  const folder = await mkdtemp(path.join(tmpdir(), "bot-memory-management-"));
  const file = path.join(folder, "memory.sqlite");
  const first = createSqliteBotMemoryStore({ ...scope, file });
  const second = createSqliteBotMemoryStore({ ...scope, file });
  const other = createSqliteBotMemoryStore({ ...scope, file, entryId: "other" });
  t.after(async () => { first.close(); second.close(); other.close(); await rm(folder, { recursive: true, force: true }); });
  const save = async (key: string) => (await first.execute({ action: "save", category: "test", key, title: key, properties: { status: "old" } }, `save-${key}`, bot)).memory as BotMemoryEntry;
  const a = await save("A"), b = await save("B"), c = await save("C");
  for (const source of [a, b]) await first.execute({ action: "link", sourceId: source.id, targetId: c.id, relation: "mentions", expectedRevision: source.revision }, undefined, bot);
  const changed = (await second.manage!({ action: "update", id: c.id, title: "C new", properties: { status: "active" }, expectedRevision: c.revision }, user)).memory as BotMemoryEntry;
  const matching = await first.manage!({ action: "list", query: "new", category: "test", where: { status: "active" } }, user);
  assert.deepEqual((matching.memories as BotMemoryEntry[]).map(row => row.id), [c.id]);
  for (const from of [a, b]) {
    const result = await first.execute({ action: "get", id: from.id, relations: "outgoing" });
    assert.deepEqual((result.relations as { memory: BotMemoryEntry }[]).map(({ memory }) => [memory.id, memory.title, memory.properties.status]), [[c.id, "C new", "active"]]);
  }
  assert.equal((await other.manage!({ action: "get", id: c.id }, user)).memory, null);
  assert.deepEqual(await other.manage!({ action: "history", id: c.id }, user), { changes: [] });
  const changes = (await first.manage!({ action: "history", id: c.id }, user)).changes as BotMemoryChange[];
  assert.equal(changes[0]!.canUndo, true);
  assert.equal(changes[0]!.previousRevision, c.revision);
  assert.deepEqual(changes[0]!.source, user);
  assert.deepEqual(changes[1]!.source, bot);
  assert.ok(changes[0]!.delta && "fields" in changes[0]!.delta);
  await assert.rejects(first.execute({ action: "update", id: c.id, title: "stale", expectedRevision: c.revision }), { code: "BOT_MEMORY_REVISION_CONFLICT" });
  await assert.rejects(first.manage!({ action: "forget", id: c.id, expectedRevision: changed.revision }, user), { code: "BOT_MEMORY_REFERENCED" });
  const incoming = (await first.execute({ action: "get", id: c.id, relations: "incoming" })).relations as { memory: BotMemoryEntry }[];
  assert.deepEqual(new Set(incoming.map(row => row.memory.id)), new Set([a.id, b.id]));
  const undo = { action: "undo", id: c.id, revision: changed.revision, expectedRevision: changed.revision };
  const restored = (await first.manage!(undo, user)).memory as BotMemoryEntry;
  assert.deepEqual([restored.title, restored.properties.status], ["C", "old"]);
  assert.ok(restored.revision > changed.revision);
  await assert.rejects(second.manage!(undo, user), { code: "BOT_MEMORY_REVISION_CONFLICT" });
  assert.equal(((await first.manage!({ action: "history", id: c.id }, user)).changes as BotMemoryChange[])[0]!.undoOf, changed.revision);
  const unlink = await second.manage!({ action: "unlink", sourceId: a.id, targetId: c.id, relation: "mentions", expectedRevision: incoming.find(row => row.memory.id === a.id)!.memory.revision }, user);
  const unlinked = (unlink.memory as BotMemoryEntry).revision;
  await first.manage!({ action: "undo", id: a.id, revision: unlinked, expectedRevision: unlinked }, user);
  assert.equal((await first.execute({ action: "get", id: c.id, relations: "incoming" })).relations instanceof Array, true);
  assert.equal(((await first.execute({ action: "get", id: c.id, relations: "incoming" })).relations as unknown[]).length, 2);
});

test("upgrades a legacy database without fabricated history, expires old values, and forget scrubs journal and receipts", async t => {
  const folder = await mkdtemp(path.join(tmpdir(), "bot-memory-retention-")), file = path.join(folder, "memory.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE bot_memories(project_id TEXT,entry_id TEXT,category TEXT,key TEXT,content TEXT,revision INTEGER,created_at TEXT,updated_at TEXT);
    INSERT INTO bot_memories VALUES('fixture','agent','test','legacy','legacy content',1,'2026-01-01','2026-01-01');
    CREATE TABLE bot_memory_sequence(singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
    INSERT INTO bot_memory_sequence VALUES(1,1);`);
  legacy.close();
  let now = Date.parse("2026-01-01T01:00:00Z");
  const store = createSqliteBotMemoryStore({ ...scope, file, clock: () => now });
  const stores = [store];
  t.after(async () => { for (const item of stores) item.close(); await rm(folder, { recursive: true, force: true }); });
  const row = (await store.execute({ action: "get", category: "test", key: "legacy" })).memory as BotMemoryEntry;
  assert.equal(row.content, "legacy content");
  assert.deepEqual(await store.manage!({ action: "history", id: row.id }, user), { changes: [] });
  const edit = (await store.manage!({ action: "update", id: row.id, expectedRevision: row.revision, content: "edited legacy" }, user)).memory as BotMemoryEntry;
  now += 30 * 86400_000 - 1;
  const getJournal = async () => (await store.manage!({ action: "history", id: row.id }, user)).changes as BotMemoryChange[];
  assert.equal((await getJournal())[0]!.canUndo, true);
  now += 1;
  await assert.rejects(store.manage!({ action: "undo", id: row.id, expectedRevision: edit.revision, revision: edit.revision }, user), { code: "BOT_MEMORY_UNDO_UNAVAILABLE" });
  assert.equal((await getJournal())[0]!.delta, undefined);
  // Reopening the store runs retention cleanup even without new memory edits.
  store.close();
  const reopened = createSqliteBotMemoryStore({ ...scope, file, clock: () => now });
  stores.push(reopened);
  assert.equal(((await reopened.manage!({ action: "history", id: row.id }, user)).changes as BotMemoryChange[])[0]!.canUndo, false);
  const save = { action: "save", category: "test", key: "erase-fixture", title: "erase-fixture-title", content: "erase-fixture-payload" } as const;
  const made = (await reopened.execute(save, "save-once", bot)).memory as BotMemoryEntry;
  const updated = (await reopened.execute({ action: "update", id: made.id, expectedRevision: made.revision, content: "replacement" }, "edit-once", bot)).memory as BotMemoryEntry;
  await reopened.manage!({ action: "forget", id: made.id, expectedRevision: updated.revision }, user);
  assert.equal((await reopened.execute({ action: "get", id: made.id })).memory, null);
  assert.deepEqual(await reopened.execute(save, "save-once", bot), { forgotten: true });
  const history = (await reopened.manage!({ action: "history", id: made.id }, user)).changes as BotMemoryChange[];
  assert.deepEqual(history.map(change => [change.action, change.delta, change.canUndo]), [["forget", undefined, false]]);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT delta FROM bot_memory_changes WHERE memory_id=?").get(row.id)!.delta, null);
    const records = JSON.stringify([...db.prepare("SELECT * FROM bot_memory_changes").all(), ...db.prepare("SELECT * FROM bot_memory_receipts").all()]);
    assert.doesNotMatch(records, /erase-fixture|replacement/u);
  } finally { db.close(); }
});

test('forget refuses a pinned WAL snapshot and preserves redacted backlink audit rows after retry', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'bot-memory-forget-wal-')), file = path.join(folder, 'memory.sqlite');
  const writer = createSqliteBotMemoryStore({ ...scope, file });
  const legacy = new DatabaseSync(file);
  let reader: DatabaseSync | undefined;
  t.after(async () => { reader?.close(); if (legacy.isOpen) legacy.close(); writer.close(); await rm(folder, { force: true, recursive: true }); });
  legacy.exec('PRAGMA journal_mode=WAL');
  const target = (await writer.execute({ action: 'save', category: 'fixture', key: 'target', content: 'synthetic old value' })).memory as BotMemoryEntry;
  const source = (await writer.execute({ action: 'save', category: 'fixture', key: 'source', content: 'keep' })).memory as BotMemoryEntry;
  const relation = { sourceId: source.id, targetId: target.id, relation: 'mentions' };
  const added = (await writer.execute({ action: 'link', ...relation, expectedRevision: source.revision })).memory as BotMemoryEntry;
  await writer.execute({ action: 'unlink', ...relation, expectedRevision: added.revision });
  reader = new DatabaseSync(file, { readOnly: true });
  reader.exec('BEGIN');
  assert.ok(reader.prepare('SELECT * FROM bot_memories WHERE id=?').get(target.id));
  const forget = { action: 'forget', id: target.id, expectedRevision: target.revision };
  await assert.rejects(writer.manage!(forget, user), { code: 'BOT_MEMORY_STORAGE_BUSY' });
  assert.ok((await writer.execute({ action: 'get', id: target.id })).memory);
  reader.close(); reader = undefined;
  legacy.close();
  await writer.manage!(forget, user);
  const result = await writer.manage!({ action: 'history', id: source.id }, user);
  const history = result.changes as BotMemoryChange[];
  assert.deepEqual(history.map(row => row.action), ['unlink', 'link', 'save']);
  assert.ok(history.slice(0, 2).every(row => !row.delta && !row.canUndo));
});
