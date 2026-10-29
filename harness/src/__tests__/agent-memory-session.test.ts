import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ai from "@earendil-works/pi-ai";
import { createAgentRuntime } from "../agent/runtime";
import type { AgentMemoryBinding, AgentMemoryProvider, AgentMemoryTurn } from "../agent/memory";
import type { AgentSessionSnapshot } from "../agent/session-types";
import type { PiRuntime } from "../agent/pi";
import type { AgentPermissionPolicy } from "../agent/types";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Memory session did not settle.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function memory() {
  const turns: AgentMemoryTurn[] = [], queries: string[] = [];
  let recalled = true;
  const provider: AgentMemoryProvider = {
    capabilities: async () => ({ connected: true, enabled: true, status: "ready", automatic: true, readOnly: false, scopes: ["global"] }),
    recall: async query => {
      queries.push(query);
      return recalled ? [{ id: "one", scope: "global", content: "PRIVATE_RECALL_SENTINEL", origin: "manual", version: 1, updatedAt: "2026-01-01", sources: [] }] : [];
    },
    submitTurn: async turn => { turns.push(turn); },
    list: async () => ({ items: [] }), get: async () => { throw new Error("unused"); },
    remember: async () => { throw new Error("unused"); }, update: async () => { throw new Error("unused"); }, forget: async () => ({}),
  };
  return { provider, turns, queries, remove: () => { recalled = false; } };
}
async function start(databasePath: string, binding: AgentMemoryBinding | false, resumeSession = false, permissionPolicy: AgentPermissionPolicy = "auto") {
  const faux = ai.fauxProvider({ models: [{ id: "test", contextWindow: 100_000, maxTokens: 1000 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const requests: string[] = [];
  faux.setResponses(Array.from({ length: 5 }, () => request => {
    requests.push(ai.getCurrentSystemPrompt(request.messages));
    return ai.fauxAssistantMessage([ai.fauxThinking("PRIVATE_REASONING"), ai.fauxText("Persisted final answer")]);
  }));
  const pi: PiRuntime = { Type: ai.Type, models, streamFn: models.streamSimple.bind(models) as PiRuntime["streamFn"],
    model: models.getModel("faux", "test")!, providerId: "faux", modelId: "test", supportedThinkingLevels: ["off"], clampThinkingLevel: () => "off" };
  let release!: () => void;
  const lease = new Promise<void>(resolve => { release = resolve; });
  const runtime = await createAgentRuntime({ pi, databasePath, memory: binding, session: { compaction: { enabled: false } }, sessionLease: lease, resumeSession });
  let snapshot: AgentSessionSnapshot | undefined, finished = false;
  const running = (async () => {
    for await (const event of runtime.run({ errCode: 0, errMessage: "", prompt: "Initial user preference", requestId: "initial", permissionPolicy })) {
      if (event.type === "session") snapshot = event.snapshot;
    }
  })().finally(() => { finished = true; });
  void running.catch(() => undefined);
  return { runtime, requests, running, snapshot: () => snapshot, finished: () => finished,
    close: async () => { release(); try { await running; } finally { await runtime.close(); } } };
}

test("live sessions submit persisted turns before lease release, recall follow-ups and deduplicate reopened sessions", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "memory-live-session-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const m = memory(), database = path.join(dir, "agent.sqlite");
  const first = await start(database, { provider: m.provider, outboxDirectory: path.join(dir, "outbox") }); t.after(first.close);
  await until(() => m.turns.length === 1);
  assert.equal(first.finished(), false, "Automatic memory cannot wait for the host lease to finish");
  assert.deepEqual(m.turns[0]!.messages.map(message => [message.role, message.content]), [["user", "Initial user preference"], ["assistant", "Persisted final answer"]]);
  assert.equal(first.requests[0]!.split("PRIVATE_RECALL_SENTINEL").length, 2);
  m.remove();
  await first.runtime.control!({ type: "submit", requestId: "followup", prompt: "Follow-up user preference", mode: "followUp" });
  await until(() => m.turns.length === 2);
  assert.deepEqual(m.queries, ["Initial user preference", "Follow-up user preference"]);
  assert.equal(first.requests[1]!.includes("PRIVATE_RECALL_SENTINEL"), false, "Deleted recall must leave the next live turn");
  assert.equal(m.turns[1]!.messages[0]!.content, "Follow-up user preference");
  assert.ok(m.turns.every(turn => !JSON.stringify(turn).includes("PRIVATE_")));
  await first.close();
  const reopened = await start(database, { provider: m.provider }, true); t.after(reopened.close);
  await until(() => !!reopened.snapshot());
  assert.equal(m.turns.length, 2, "Persisted delivery receipts prevent replaying old turns");
  await reopened.runtime.control!({ type: "submit", requestId: "after-restart", prompt: "New preference after restart", mode: "followUp" });
  await until(() => m.turns.length === 3);
  assert.equal(m.turns[2]!.messages[0]!.content, "New preference after restart");
  assert.equal(new Set(m.turns.map(turn => turn.turnId)).size, 3);
});

test("enabling memory does not import completed conversation history", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "memory-new-binding-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const database = path.join(dir, "agent.sqlite"), before = await start(database, false); t.after(before.close);
  await until(() => before.snapshot()?.turns.some(turn => turn.status === "done") === true);
  await before.close();
  const m = memory(), after = await start(database, { provider: m.provider }, true); t.after(after.close);
  await until(() => !!after.snapshot());
  assert.equal(m.turns.length, 0);
  await after.runtime.control!({ type: "submit", requestId: "new", prompt: "Only this new preference", mode: "followUp" });
  await until(() => m.turns.length === 1);
  assert.equal(m.turns[0]!.messages[0]!.content, "Only this new preference");
});

test("re-enabling memory never submits turns completed while project memory was disabled", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "memory-disabled-interval-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const database = path.join(dir, "agent.sqlite"), m = memory();
  const first = await start(database, { provider: m.provider }); t.after(first.close);
  await until(() => m.turns.length === 1);
  await first.close();

  const queriesBeforeDisable = m.queries.length;
  const disabled = await start(database, false, true); t.after(disabled.close);
  await until(() => !!disabled.snapshot());
  await disabled.runtime.control!({ type: "submit", requestId: "disabled", prompt: "PRIVATE_DISABLED_TURN", mode: "followUp" });
  await until(() => disabled.snapshot()?.turns.some(turn => turn.requestId === "disabled" && turn.status === "done") === true);
  assert.equal(m.turns.length, 1);
  assert.equal(m.queries.length, queriesBeforeDisable, "Disabled sessions must not recall memory");
  assert.ok(disabled.requests.every(prompt => !prompt.includes("PRIVATE_RECALL_SENTINEL")));
  await disabled.close();

  const restored = await start(database, { provider: m.provider }, true); t.after(restored.close);
  await until(() => !!restored.snapshot());
  assert.equal(m.turns.length, 1, "Enabling memory must not import the disabled interval");
  await restored.runtime.control!({ type: "submit", requestId: "enabled-again", prompt: "New preference after enabling", mode: "followUp" });
  await until(() => m.turns.length >= 2);
  assert.deepEqual(m.turns.map(turn => turn.messages[0]!.content), ["Initial user preference", "New preference after enabling"]);
});

test("a read-only live session recalls without submitting completed turns", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "memory-read-only-session-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const database = path.join(dir, "agent.sqlite"), m = memory(), f = await start(database, { provider: m.provider }, false, "read-only"); t.after(f.close);
  await until(() => f.snapshot()?.turns.some(turn => turn.status === "done") === true);
  assert.deepEqual(m.queries, ["Initial user preference"]);
  assert.equal(m.turns.length, 0);
  await f.close();
  const writable = await start(database, { provider: m.provider }, true); t.after(writable.close);
  await until(() => !!writable.snapshot());
  assert.equal(m.turns.length, 0, "A writable restart must not import previous read-only turns");
  await writable.runtime.control!({ type: "submit", requestId: "writable", prompt: "New writable preference", mode: "followUp" });
  await until(() => m.turns.length === 1);
  assert.equal(m.turns[0]!.messages[0]!.content, "New writable preference");
});

test("live-session delivery failures survive restart through the durable outbox", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "memory-session-outbox-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const database = path.join(dir, "agent.sqlite"), outbox = path.join(dir, "outbox"), m = memory();
  const failed: AgentMemoryTurn[] = [];
  const offline: AgentMemoryBinding = { provider: { ...m.provider, submitTurn: async turn => { failed.push(turn); throw new Error("offline"); } }, outboxDirectory: outbox };
  const first = await start(database, offline); t.after(first.close);
  await until(() => first.snapshot()?.turns.some(turn => turn.status === "done") === true);
  assert.equal(first.finished(), false);
  assert.equal(failed.length, 1, "Snapshot updates must not repeatedly send an already staged turn");
  assert.equal((await readdir(outbox)).filter(name => name.endsWith(".json")).length, 1);
  await first.close();
  const restored = await start(database, { provider: m.provider, outboxDirectory: outbox }, true); t.after(restored.close);
  await until(() => !!restored.snapshot() && m.turns.length === 1);
  assert.equal(m.turns[0]!.turnId, failed[0]!.turnId);
  assert.deepEqual(m.turns[0]!.messages, failed[0]!.messages);
  await until(async () => (await readdir(outbox)).length === 0);
  await restored.runtime.control!({ type: "submit", requestId: "after-outage", prompt: "Next preference", mode: "followUp" });
  await until(() => m.turns.length === 2);
});
