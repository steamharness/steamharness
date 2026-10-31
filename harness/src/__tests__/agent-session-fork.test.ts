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
