import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalDatabaseRegistry, createDatabasesContext, createLocalDatabaseResolver, type DatabaseRequirement } from "../databases/index";

const all = { mode: "all" as const };
const requirement = (): DatabaseRequirement => ({ alias: "data", host: "local", permissions: { kv: { read: all, write: all }, knowledge: { read: all, write: all } } });

test("local spaces require approval, share data between projects, isolate conversations and revoke live handles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "database-approval-"));
  try {
    const registry = new LocalDatabaseRegistry(directory);
    const one = { projectId: randomUUID(), entryId: "one" }; const two = { projectId: randomUUID(), entryId: "two" };
    const declared = requirement();
    const first = registry.request({ ...one, alias: declared.alias, target: { kind: "create", name: "Shared" }, permissions: declared.permissions });
    const unbound = createDatabasesContext({ ...one, requirements: [declared], resolver: createLocalDatabaseResolver(registry) }).get("data");
    await assert.rejects(unbound.kv.getValue("a"), /approved local binding/);
    assert.equal((await readdir(directory)).includes("spaces"), false);
    assert.equal(new LocalDatabaseRegistry(directory).read().requests[0]!.status, "pending");
    const approved = registry.review(first.requestId, { approve: true });
    const spaceId = registry.authorization(approved.bindingRef!)!.space.spaceId;
    const second = registry.request({ ...two, alias: "data", target: { kind: "access", spaceId }, permissions: declared.permissions });
    const shared = registry.review(second.requestId, { approve: true });
    const context = (consumer: typeof one, bindingRef: string) => createDatabasesContext({ ...consumer, conversationId: "same-conversation", requirements: [{ ...declared, bindingRef }], resolver: createLocalDatabaseResolver(new LocalDatabaseRegistry(directory)) }).get("data");
    const a = context(one, approved.bindingRef!); const b = context(two, shared.bindingRef!);
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
    await assert.rejects(retained.readBuffer(), /no longer valid/);
    await assert.rejects(b.getRevision(), /no longer valid/);
    await assert.rejects(b.kv.getValue("shared"), /no longer valid/);
    assert.deepEqual(await a.kv.getValue("shared"), { count: 1 });
    assert.equal(registry.read().spaces.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a binding cannot be reused by another entry or host and grants can be narrowed live", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "database-binding-"));
  try {
    const registry = new LocalDatabaseRegistry(directory); const consumer = { projectId: randomUUID(), entryId: "agent" }; const declared = requirement();
    const request = registry.request({ ...consumer, alias: "data", target: { kind: "create", name: "Data" }, permissions: declared.permissions });
    const approval = registry.review(request.requestId, { approve: true }); const bindingRef = approval.bindingRef!;
    const open = (entryId: string, host: "local" | "server" = "local") => createDatabasesContext({ projectId: consumer.projectId, entryId, requirements: [{ ...declared, host, bindingRef }], resolver: createLocalDatabaseResolver(registry) }).get("data");
    const original = open("agent"); await original.kv.setValue("public:a", 1);
    await original.kv.setValue("public:b", 2);
    await original.kv.setValue("private:a", 3);
    await assert.rejects(open("other").kv.getValue("public:a"), /different consumer/);
    await assert.rejects(open("agent", "server").kv.getValue("public:a"), /approved server binding/);
    registry.narrow(registry.authorization(bindingRef)!.grant.grantId, { ...declared.permissions, kv: { read: { mode: "prefixes", prefixes: ["public:"] }, write: { mode: "none" } } });
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
    const knowledgeOnly = { ...declared.permissions, kv: { read: none, write: none } };
    const kvOnly = { ...declared.permissions, knowledge: { read: none, write: none } };
    registry.narrow(registry.authorization(bindingRef)!.grant.grantId, knowledgeOnly);
    const disjoint = createDatabasesContext({ ...consumer, requirements: [{ ...declared, bindingRef, permissions: kvOnly }], resolver: createLocalDatabaseResolver(registry) }).get("data");
    await assert.rejects(disjoint.getRevision(), /read grant/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
