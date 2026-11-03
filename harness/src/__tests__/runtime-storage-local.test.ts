import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { createLocalRuntimePersistence, createMemoryRuntimePersistence, copyRuntimePersistence, emptyRuntimeRecord, agentRuntimeSessionKey, SnapshotMemoryStorage } from "../runtime-storage";
import { forkStoredAgentConversation, isolateStoredAgentConversation } from "../agent/stored-session";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "local-runtime-"));
  const persistence = createLocalRuntimePersistence({ directory });
  return { directory, persistence, async close() { await persistence.close(); await rm(directory, { recursive: true, force: true }); } };
}
const assertions = {
  ok: (value: unknown, message?: string) => assert.ok(value, message),
  strictEqual: (actual: unknown, expected: unknown) => assert.strictEqual(actual, expected),
  deepEqual: (actual: unknown, expected: unknown) => assert.deepEqual(actual, expected),
  partialDeepEqual: (actual: unknown, expected: unknown) => assert.partialDeepStrictEqual(actual, expected),
  greaterThan: (actual: number, expected: number) => assert.ok(actual > expected),
  rejects: async (operation: Promise<unknown>, message: string) => { await assert.rejects(operation, error => error instanceof Error && error.message.includes(message)); },
};
for (const item of createStorageConformance({ assertions, withStorage: async use => {
  const f = await fixture();
  try { const opened = await f.persistence.agentStorage("thread", "main").open(); await use(opened.storage); await opened.release?.(); }
  finally { await f.close(); }
} })) test(`local runtime conformance: ${item.name}`, item.run);

test("local history survives restart, fences stale revisions and permits independent conversations", async () => {
  const f = await fixture(), other = createLocalRuntimePersistence({ directory: f.directory });
  try {
    const a = await f.persistence.acquire("thread"), b = await other.acquire("other");
    await assert.rejects(other.acquire("thread"), { code: "RUNTIME_STORAGE_OWNER_CONFLICT" });
    const saved = await a.write({ ...emptyRuntimeRecord("conversation", "thread"), messages: [{ id: "message", value: { text: "hello\0world" } }] });
    await b.write(emptyRuntimeRecord("conversation", "other"));
    assert.equal((await other.list("conversation")).length, 2);
    await assert.rejects(a.write(emptyRuntimeRecord("conversation", "thread")), { code: "RUNTIME_STORAGE_REVISION_CONFLICT" });
    await a.delete(saved); await a.close();
    const next = await other.acquire("thread");
    await assert.rejects(next.write(saved), { code: "RUNTIME_STORAGE_REVISION_CONFLICT" });
    await f.persistence.close();
    assert.deepEqual((await other.list("conversation")).map(record => record.key), ["other"]);
    await assert.rejects(a.write(saved), /closed/);
  } finally { await other.close(); await f.close(); }
});

test("snapshots are consistent while active, preserve reserved IDs, and reopen without cloud access", async () => {
  const f = await fixture();
  try {
    const opened = await f.persistence.agentStorage("source", "main").open();
    await opened.storage.commit([
      { type: "conversation", value: { id: 1 as never } },
      { type: "document.create", record: { id: 2 as never, kind: "plan", scope: { kind: "conversation", conversationId: 1 as never }, history: "rewindable", fork: "asOf" }, content: { kind: "base", version: 1, value: { text: "old" } } },
      { type: "entry", value: { id: 3 as never, conversationId: 1 as never, kind: "message" } },
    ], context);
    await opened.storage.commit([{ type: "document.change", id: 2 as never, content: { kind: "base", version: 2, value: { text: "new" } } }], context);
    const reserved = await opened.storage.mintId();
    const key = agentRuntimeSessionKey("source", "main"), snapshot = await f.persistence.exportSession(key);
    assert.equal(snapshot.nextId, reserved + 1);
    await opened.release?.();
    const reopened = await f.persistence.agentStorage("source", "main").open();
    assert.equal(await reopened.storage.mintId(), snapshot.nextId);
    await f.persistence.importSession(agentRuntimeSessionKey("imported", "main"), snapshot);
    const detached = new SnapshotMemoryStorage(await f.persistence.exportSession(agentRuntimeSessionKey("imported", "main")));
    assert.equal((await detached.document(2 as never, 1 as never, context))?.value.text, "old");
    assert.equal((await detached.document(2 as never, "current", context))?.version, 2);
    await assert.rejects(f.persistence.importSession(agentRuntimeSessionKey("imported", "main"), snapshot), { code: "RUNTIME_STORAGE_REVISION_CONFLICT" });
    await assert.rejects(f.persistence.deleteSession(key), { code: "RUNTIME_STORAGE_OWNER_CONFLICT" });
    await reopened.release?.(); await f.persistence.deleteSession(key);
    await assert.rejects(f.persistence.agentStorage("source", "main").open(), { code: "RUNTIME_STORAGE_NOT_FOUND" });
  } finally { await f.close(); }
});

test("local stored forks and isolation retain committed history without resolving a model", async () => {
  const f = await fixture();
  try {
    const opened = await f.persistence.agentStorage("source", "main").open();
    await opened.storage.commit([{ type: "conversation", value: { id: 1 as never } }, { type: "entry", value: { id: 2 as never, conversationId: 1 as never, kind: "message", model: [] } }], context);
    await isolateStoredAgentConversation({ persistence: f.persistence, sourceConversationId: "source", conversationId: "branch", targetId: 1 });
    const receipt = await forkStoredAgentConversation({ persistence: f.persistence, conversationId: "branch", command: { type: "fork", requestId: "fork", entryId: 2 } });
    assert.equal(receipt.status, "accepted");
    await opened.release?.();
  } finally { await f.close(); }
});

test("process death releases local ownership and committed agent state remains recoverable", { timeout: 15_000 }, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createLocalRuntimePersistence } from ${JSON.stringify(new URL("../runtime-storage/local.ts", import.meta.url).href)};
    const p = createLocalRuntimePersistence({directory:process.argv[1]});
    await p.acquire('thread');
    const opened = await p.agentStorage('thread','main').open();
    await opened.storage.commit([{type:'conversation',value:{id:1}}],{});
    process.send('ready'); setInterval(()=>{},1000);
  `, f.directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors || "Child exited before acquiring storage"); })]);
    await assert.rejects(f.persistence.acquire("thread"), { code: "RUNTIME_STORAGE_OWNER_CONFLICT" });
    await assert.rejects(f.persistence.agentStorage("thread", "main").open(), { code: "RUNTIME_STORAGE_OWNER_CONFLICT" });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const reopened = await f.persistence.agentStorage("thread", "main").open();
    assert.deepEqual(await reopened.storage.conversation(1 as never, context), { id: 1 });
    await reopened.release?.();
    await (await f.persistence.acquire("thread")).close();
  } finally { child.kill("SIGKILL"); await f.close(); }
});

test("explicit background backup copies history and checkpoints without blocking local writes", async () => {
  const f = await fixture(), target = createMemoryRuntimePersistence();
  try {
    const lease = await f.persistence.acquire("thread");
    const first = await lease.write(emptyRuntimeRecord("conversation", "thread"));
    const opened = await f.persistence.agentStorage("thread", "main").open();
    await opened.storage.commit([{ type: "conversation", value: { id: 1 as never } }], context);
    await opened.release?.();
    const acquire = target.acquire.bind(target);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    target.acquire = async scope => { await gate; return acquire(scope); };
    const syncing = copyRuntimePersistence({ source: f.persistence, target });
    await lease.write({ ...first, state: { text: "Local progress while cloud is slow" } });
    resume(); await syncing;
    assert.equal((await f.persistence.list("conversation"))[0]!.state.text, "Local progress while cloud is slow");
    assert.equal((await target.list("conversation")).length, 1);
    assert.deepEqual(await target.exportSession(agentRuntimeSessionKey("thread", "main")), await f.persistence.exportSession(agentRuntimeSessionKey("thread", "main")));
    await assert.rejects(copyRuntimePersistence({ source: f.persistence, target }), { code: "RUNTIME_STORAGE_REVISION_CONFLICT" });
  } finally { await target.close(); await f.close(); }
});
