import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalDatabaseRegistry, createDatabasesContext, createLocalDatabaseResolver, type DatabaseRequirement } from "../databases/index";

const all = { mode: "all" as const };
const permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };
const requirement = (): DatabaseRequirement => ({ alias: "data", databaseId: randomUUID() });

test("entry aliases support many databases, shared databases and replacing only the recorded ID", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "database-aliases-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new LocalDatabaseRegistry(directory), resolver = createLocalDatabaseResolver(registry);
  const projectId = randomUUID();
  const create = (name: string) => {
    const request = registry.request({ projectId, entryId: "writer", alias: "data", permissions, target: { kind: "create", name } });
    return registry.review(request.requestId, { approve: true }).databaseId!;
  };
  const first = create("first"), second = create("second");
  for (const databaseId of [first, second]) {
    const request = registry.request({ projectId, entryId: "reader", alias: "host-label", permissions, target: { kind: "access", spaceId: databaseId } });
    registry.review(request.requestId, { approve: true });
  }
  const writer = createDatabasesContext({ projectId, entryId: "writer", requirements: [{ alias: "data", databaseId: first }, { alias: "archive", databaseId: second }], resolver });
  await writer.get("data").kv.setValue("value", "first");
  await writer.get("archive").kv.setValue("value", "second");
  const open = (databaseId: string) => createDatabasesContext({ projectId, entryId: "reader", requirements: [{ alias: "data", databaseId }], resolver }).get("data");
  assert.equal(await open(first).kv.getValue("value"), "first");
  assert.equal(await open(second).kv.getValue("value"), "second");
  assert.throws(() => writer.get(first), /alias/);
  const denied = createDatabasesContext({ projectId: randomUUID(), entryId: "reader", requirements: [{ alias: "data", databaseId: first }], resolver }).get("data");
  await assert.rejects(denied.kv.getValue("value"), /host authorization/);
});

test("local spaces require approval, share data between projects, isolate conversations and revoke live handles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "database-approval-"));
  try {
    const registry = new LocalDatabaseRegistry(directory);
    const one = { projectId: randomUUID(), entryId: "one" }; const two = { projectId: randomUUID(), entryId: "two" };
    const declared = requirement();
    const first = registry.request({ ...one, alias: declared.alias, target: { kind: "create", name: "Shared" }, permissions: permissions });
    const unbound = createDatabasesContext({ ...one, requirements: [declared], resolver: createLocalDatabaseResolver(registry) }).get("data");
    await assert.rejects(unbound.kv.getValue("a"), /host authorization/);
    assert.equal((await readdir(directory)).includes("spaces"), false);
    assert.equal(new LocalDatabaseRegistry(directory).read().requests[0]!.status, "pending");
    const approved = registry.review(first.requestId, { approve: true });
    const spaceId = registry.authorization(approved.bindingRef!)!.space.spaceId;
    const second = registry.request({ ...two, alias: "data", target: { kind: "access", spaceId }, permissions: permissions });
    const shared = registry.review(second.requestId, { approve: true });
    const context = (consumer: typeof one, databaseId: string) => createDatabasesContext({ ...consumer, conversationId: "same-conversation", requirements: [{ ...declared, databaseId }], resolver: createLocalDatabaseResolver(new LocalDatabaseRegistry(directory)) }).get("data");
    const a = context(one, spaceId); const b = context(two, spaceId);
    await a.kv.setValue("shared", { count: 1 }); assert.deepEqual(await b.kv.getValue("shared"), { count: 1 });
    await a.kv.conversation.setValue("private", true); assert.equal(await b.kv.conversation.getValue("private"), undefined);
    assert.equal((await b.listValues({ scope: "conversation" })).total, 0);
    assert.equal((await a.listValues({ scope: "conversation" })).items[0]?.key, "private");
    await a.knowledge.createDocument({ id: "guide", title: "Shared", markdown: "# Shared\nhello" });
    assert.equal((await b.knowledge.getDocument("guide"))!.markdown, "# Shared\nhello");
    await assert.rejects(b.kv.setValue("knowledge.document.guide", "bypass"), /knowledge API/);
    await assert.rejects(a.transaction(async (database) => { await database.kv.setValue("rollback", true); await database.knowledge.editDocument({ id: "guide", markdown: "rolled back" }); throw new Error("Rollback"); }), /Rollback/);
    assert.equal(await b.kv.getValue("rollback"), undefined);
    assert.equal((await b.knowledge.getDocument("guide"))!.markdown, "# Shared\nhello");
    await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).kv.updateValue("counter", (value) => Number(value ?? 0) + 1)));
    assert.equal(await a.kv.getValue("counter"), 24);
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).knowledge.createDocument({ id: `doc-${i}`, title: `Doc ${i}`, markdown: `body ${i}` })));
    assert.equal((await b.knowledge.listDocuments()).total, 9);
    const attachment = await a.knowledge.files.createFile({ name: "shared.txt", mimeType: "text/plain", buffer: Buffer.from("shared attachment") });
    const retained = await b.knowledge.files.readFile(attachment.id);
    assert.equal((await retained.readBuffer()).toString(), "shared attachment");
    await assert.rejects(b.kv.getValue(`__knowledge_file:${attachment.id}`), /knowledge API/);
    const revision = await a.getRevision();
    await a.kv.setValue("revision-test", true);
    assert.notEqual(await b.getRevision(), revision);
    const beforeRollback = await a.getRevision();
    await assert.rejects(a.transaction(async db => { await db.knowledge.files.deleteFile(attachment.id); throw new Error("Rollback"); }), /Rollback/);
    assert.equal(await a.getRevision(), beforeRollback);
    assert.equal((await (await a.knowledge.files.readFile(attachment.id)).readBuffer()).toString(), "shared attachment");
    registry.rotate(registry.authorization(shared.bindingRef!)!.grant.grantId);
    assert.equal((await (await b.knowledge.files.readFile(attachment.id)).readBuffer()).toString(), "shared attachment");
    registry.revoke(registry.authorization(shared.bindingRef!)!.grant.grantId);
    await assert.rejects(retained.readBuffer(), /host authorization/);
    await assert.rejects(b.getRevision(), /host authorization/);
    await assert.rejects(b.kv.getValue("shared"), /host authorization/);
    assert.deepEqual(await a.kv.getValue("shared"), { count: 1 });
    assert.equal(registry.read().spaces.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a database ID cannot bypass entry authorization and host grants can be narrowed live", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "database-binding-"));
  try {
    const registry = new LocalDatabaseRegistry(directory); const consumer = { projectId: randomUUID(), entryId: "agent" }; const declared = requirement();
    const request = registry.request({ ...consumer, alias: "data", target: { kind: "create", name: "Data" }, permissions: permissions });
    const approval = registry.review(request.requestId, { approve: true }); const bindingRef = approval.bindingRef!;
    const open = (entryId: string, databaseId = approval.databaseId!) => createDatabasesContext({ projectId: consumer.projectId, entryId, requirements: [{ ...declared, databaseId }], resolver: createLocalDatabaseResolver(registry) }).get("data");
    const original = open("agent"); await original.kv.setValue("public:a", 1);
    await original.kv.setValue("public:b", 2);
    await original.kv.setValue("private:a", 3);
    await assert.rejects(open("other").kv.getValue("public:a"), /host authorization/);
    await assert.rejects(open("agent", randomUUID()).kv.getValue("public:a"), /host authorization/);
    registry.narrow(registry.authorization(bindingRef)!.grant.grantId, { ...permissions, kv: { read: { mode: "prefixes", prefixes: ["public:"] }, write: { mode: "none" } } });
    assert.equal(await original.kv.getValue("public:a"), 1);
    const first = await original.listValues({ pageSize: 1 });
    assert.deepEqual(first.items.map(item => item.key), ["public:a"]);
    assert.equal(first.total, 2);
    assert.equal(first.hasMore, true);
    const second = await original.listValues({ pageSize: 1, cursor: first.nextCursor });
    assert.deepEqual(second.items.map(item => item.key), ["public:b"]);
    assert.equal(second.hasMore, false);
    assert.deepEqual((await original.listValues({ query: "private" })).items, []);
    assert.deepEqual((await original.listValues({ query: ":B" })).items.map(item => item.key), ["public:b"]);
    await assert.rejects(original.kv.setValue("public:b", 2), /does not allow/);
    await assert.rejects(original.kv.getValue("private"), /does not allow/);
    const none = { mode: "none" as const };
    registry.narrow(registry.authorization(bindingRef)!.grant.grantId, { kv: { read: none, write: none }, knowledge: { read: none, write: none } });
    await assert.rejects(original.getRevision(), /read grant/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("attachment buffers reuse their downloaded snapshot while every read revalidates the grant", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "database-file-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new LocalDatabaseRegistry(directory);
  const consumer = { projectId: randomUUID(), entryId: "map" };
  const request = registry.request({ ...consumer, alias: "data", permissions, target: { kind: "create", name: "Map" } });
  const approved = registry.review(request.requestId, { approve: true });
  const requirement = { alias: "data", databaseId: approved.databaseId! };
  const resolver = createLocalDatabaseResolver(registry);
  const database = createDatabasesContext({ ...consumer, requirements: [requirement], resolver }).get("data");
  const reference = await database.knowledge.files.createFile({ name: "map.png", mimeType: "image/png", buffer: Buffer.from("image bytes") });
  const { store } = (await resolver.resolve(requirement, consumer))!;
  const getValue = store.getValue.bind(store);
  let downloads = 0;
  t.mock.method(store, "getValue", async (input: Parameters<typeof getValue>[0]) => {
    if (input.key === `__knowledge_file:${reference.id}`) downloads++;
    return getValue(input);
  });
  const file = await database.knowledge.files.readFile(reference.id);
  const retained = await database.knowledge.files.readFile(reference.id);
  assert.equal(downloads, 2);
  const first = await file.readBuffer();
  assert.equal(first.toString(), "image bytes");
  first.fill(0);
  assert.equal((await file.readBuffer()).toString(), "image bytes");
  assert.equal(await file.readBase64(), Buffer.from("image bytes").toString("base64"));
  assert.equal(downloads, 2);
  registry.narrow(registry.authorization(approved.bindingRef!)!.grant.grantId, {
    ...permissions, knowledge: { read: { mode: "none" }, write: { mode: "none" } },
  });
  await assert.rejects(file.readBuffer(), /does not allow/);
  await assert.rejects(retained.readBuffer(), /does not allow/);
  assert.equal(downloads, 2);
});
