import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, ProviderDoc, createRegistry, defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { agentConversationDirectory, forkAgentConversation, openAgentStorage } from "../agent/storage";
import { SessionDoc } from "../agent/session-state";
import { forkSessionConversation } from "../agent/session-state";
import { isolateAgentConversation } from "../agent/isolate";

test("offline forks preserve the selected history and document policies with durable command receipts", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-offline-fork-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const conversationId = "host-session", rootDir = agentConversationDirectory(directory, conversationId);
  await mkdir(rootDir, { recursive: true });
  const database = path.join(rootDir, "session.sqlite");
  const AsOf = defineDoc({ kind: "fixture.as-of", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", initial: () => ({ value: "initial" }) });
  const Current = defineDoc({ kind: "fixture.current", version: 1, scope: "conversation", history: "rewindable", fork: "current", initial: () => ({ value: "initial" }) });
  const Initial = defineDoc({ kind: "fixture.initial", version: 1, scope: "conversation", history: "rewindable", fork: "initial", initial: () => ({ value: "initial" }) });
  const open = async () => {
    const store = await openAgentStorage(database);
    const harness = await Harness.open(store.storage, { models: createModels(), registry: createRegistry() }, context);
    return { harness, close: async () => { try { await harness.close(context); } finally { store.release(); } } };
  };
  const first = await open();
  const root = await first.harness.root(context);
  const boundary = await root.commit(async tx => {
    for (const doc of [AsOf, Current, Initial]) (await tx.doc(doc, root.id)).value = "selected";
    await tx.appendEntry(root.id, { kind: "project.input", model: [{ role: "user", content: "First input", timestamp: 1 }] });
    return (await tx.appendEntry(root.id, { kind: "pi.assistant", model: [fauxAssistantMessage("First answer")] })).id;
  }, context);
  await root.commit(async tx => {
    for (const doc of [AsOf, Current, Initial]) (await tx.doc(doc, root.id)).value = "later";
    await tx.appendEntry(root.id, { kind: "project.input", model: [{ role: "user", content: "Later input", timestamp: 3 }] });
  }, context);
  const options = { agentStoreDir: directory, conversationId, command: { type: "fork" as const, requestId: "offline", entryId: boundary } };
  try { await assert.rejects(forkAgentConversation(options), /execution owner/); }
  finally { await first.close(); }
  const receipt = await forkAgentConversation(options);
  assert.deepEqual(await forkAgentConversation(options), receipt);
  await assert.rejects(forkAgentConversation({ ...options, command: { ...options.command, entryId: boundary + 1000 } }), /another command/);
  await assert.rejects(forkAgentConversation({ ...options, command: { ...options.command, requestId: "invalid", entryId: boundary + 1000 } }), /not visible/);
  await assert.rejects(forkAgentConversation({ ...options, command: { ...options.command, requestId: "wrong-target", targetId: 999999 } }), /does not exist/);
  const reopened = await open();
  try {
    const child = (await reopened.harness.conversation(receipt.forkId as ConversationId, context))!;
    const entries = (await child.context(context)).entries;
    assert.deepEqual(entries.flatMap(entry => entry.model ?? []).map(message => message.content), ["First input", [{ type: "text", text: "First answer" }]]);
    assert.equal((await reopened.harness.snapshot(AsOf, child.id, context))?.value, "selected");
    assert.equal((await reopened.harness.snapshot(Current, child.id, context))?.value, "later");
    assert.equal((await reopened.harness.snapshot(Initial, child.id, context))?.value ?? Initial.definition.initial().value, "initial");
    assert.notEqual((await reopened.harness.snapshot(ProviderDoc, root.id, context))?.sessionId,
      (await reopened.harness.snapshot(ProviderDoc, child.id, context))?.sessionId);
    assert.deepEqual((await reopened.harness.inspect(context)).tasks, []);
    assert.equal((await reopened.harness.commit(tx => tx.scanConversations({}, 100), context)).items.length, 2);
    assert.ok((await (await reopened.harness.root(context)).context(context)).entries.some(entry => entry.model?.some(message => message.content === "Later input")));
  } finally { await reopened.close(); }
  const nested = await forkAgentConversation({ ...options, command: { ...options.command, requestId: "nested", targetId: receipt.forkId } });
  assert.equal(nested.conversationId, receipt.forkId);
  const last = await open();
  try {
    await last.harness.commit(async tx => { (await tx.doc(SessionDoc, receipt.forkId as ConversationId)).deleted = true; }, context);
  } finally { await last.close(); }
  await assert.rejects(forkAgentConversation({ ...options, command: { ...options.command, requestId: "deleted", targetId: receipt.forkId } }), /deleted/);
});

test("isolated forks have their own root, lock, provider and document history while the source stays live", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-independent-fork-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const AsOf = defineDoc({ kind: "fixture.plan", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", initial: () => ({ value: "initial" }) });
  const Runtime = defineDoc({ kind: "fixture.runtime", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ pending: false as boolean }) });
  const open = async (id: string) => {
    const store = await openAgentStorage(path.join(agentConversationDirectory(directory, id), "session.sqlite"));
    const harness = await Harness.open(store.storage, { models: createModels(), registry: createRegistry() }, context);
    return { harness, root: await harness.root(context), close: async () => { try { await harness.close(context); } finally { store.release(); } } };
  };
  const source = await open("source");
  t.after(source.close);
  const first = await source.root.commit(async tx => {
    (await tx.doc(AsOf, source.root.id)).value = "first";
    return (await tx.appendEntry(source.root.id, { kind: "pi.user", model: [{ role: "user", content: "First /files/old.png", timestamp: 1 }] })).id;
  }, context);
  const second = await source.root.commit(async tx => {
    (await tx.doc(AsOf, source.root.id)).value = "second";
    (await tx.doc(Runtime, source.root.id)).pending = true;
    return (await tx.appendEntry(source.root.id, { kind: "pi.user", model: [{ role: "user", content: "Second", timestamp: 2 }] })).id;
  }, context);
  const receipt = await forkSessionConversation(source.harness, source.root, { type: "fork", requestId: "live-independent", entryId: second });
  const options = { agentStoreDir: directory, sourceConversationId: "source", conversationId: "branch", targetId: receipt.forkId!,
    replacements: [{ from: "/files/old.png", to: "/branch/new.png" }] };
  await isolateAgentConversation(options);
  const branch = await open("branch");
  try {
    assert.deepEqual(await branch.harness.commit(tx => tx.scanConversations({}, 100), context).then(page => page.items), [{ id: branch.root.id }]);
    assert.equal(branch.root.id, 1);
    assert.equal((await branch.harness.snapshot(Runtime, branch.root.id, context))?.pending ?? false, false);
    assert.equal((await branch.harness.snapshot(AsOf, branch.root.id, context))?.value, "second");
    assert.equal((await branch.harness.snapshotAsOf(AsOf, branch.root.id, first, context))?.value, "first");
    assert.deepEqual((await branch.harness.inspect(context)).tasks, []);
    assert.notEqual((await source.harness.snapshot(ProviderDoc, source.root.id, context))?.sessionId,
      (await branch.harness.snapshot(ProviderDoc, branch.root.id, context))?.sessionId);
    assert.match(JSON.stringify((await branch.root.context(context)).messages), /\/branch\/new.png/);
    await branch.root.commit(tx => tx.appendEntry(branch.root.id, { kind: "pi.user", model: [{ role: "user", content: "Branch only", timestamp: 3 }] }), context);
    assert.doesNotMatch(JSON.stringify((await source.root.context(context)).messages), /Branch only/);
    await source.root.abort(context, { background: true });
    assert.match(JSON.stringify((await branch.root.context(context)).messages), /Branch only/);
  } finally { await branch.close(); }
  await isolateAgentConversation(options);
  const again = await open("branch");
  try { assert.match(JSON.stringify((await again.root.context(context)).messages), /Branch only/); }
  finally { await again.close(); }
  const nested = await forkAgentConversation({ agentStoreDir: directory, conversationId: "branch", command: { type: "fork", requestId: "nested", entryId: first } });
  await isolateAgentConversation({ agentStoreDir: directory, sourceConversationId: "branch", conversationId: "nested", targetId: nested.forkId!, retireSource: true });
  const child = await open("nested");
  try {
    assert.equal((await child.harness.snapshot(AsOf, child.root.id, context))?.value, "first");
    assert.doesNotMatch(JSON.stringify((await child.root.context(context)).messages), /Second|Branch only/);
  } finally { await child.close(); }
  await assert.rejects(isolateAgentConversation({ ...options, targetId: source.root.id }), /already exists/);
});
