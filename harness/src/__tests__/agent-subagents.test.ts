import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import * as ai from "@earendil-works/pi-ai";
import { DurableAgent } from "../agent/durable-agent";
import type { AgentDefinition, AgentSessionSnapshot, AgentSessionOptions } from "../agent/session-types";
import { AgentWorkProgressDoc, waitForAgentWorkChange } from "../agent/subagents";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { BUILTIN_AGENT_SKILLS_PROMPT } from "../agent/builtin-skills";

function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (!check()) { if (Date.now() > end) throw new Error("Agent work did not settle"); await new Promise(done => setTimeout(done, 5)); }
}
const roles: AgentDefinition[] = [
  { id: "researcher", description: "Research one source", systemPrompt: "RESEARCH ROLE ONLY", tools: ["research"], maxConcurrency: 3 },
  { id: "writer", description: "Record one source", systemPrompt: "WRITER ROLE ONLY", tools: ["record"], maxConcurrency: 1 },
];

test("admission races release losing task subscriptions on every wakeup and on failure", async () => {
  let active = 0;
  const ids = [1, 2, 3] as TaskId[];
  for (let tick = 0; tick < 30; tick++) {
    const winner = latch();
    const waiting = waitForAgentWorkChange(ids, (id, context) => {
      active++;
      return new Promise<void>((resolve, reject) => {
        context.abortSignal!.addEventListener("abort", () => { active--; reject(new Error("cancelled waiter")); }, { once: true });
        if (id === 1) void winner.promise.then(resolve);
      });
    }, BACKGROUND_CONTEXT);
    winner.resolve();
    await waiting;
    assert.equal(active, 0, "A wakeup must release all three subscriptions before waiting again");
  }
  await assert.rejects(waitForAgentWorkChange(ids, async () => { throw new Error("storage unavailable"); }, BACKGROUND_CONTEXT), /storage unavailable/);
});
function fixture(databasePath?: string, definitions = roles, resumeSession = false, interruptSession = false, allowedModels: { provider: string; modelId: string }[] = [], nativeTools: AgentSessionOptions["nativeTools"] = []) {
  const faux = ai.fauxProvider({ models: [{ id: "test", contextWindow: 100_000, maxTokens: 200 }, { id: "alternate", reasoning: true, contextWindow: 100_000, maxTokens: 200 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const lease = latch(), suspend = latch();
  let snapshot: AgentSessionSnapshot | undefined;
  const agent = new DurableAgent({ models, databasePath, retryDelayMs: 0, sessionLease: lease.promise, sessionSuspend: suspend.promise, resumeSession, interruptSession,
    session: { nativeTools, compaction: { enabled: false }, subagents: { tools: ["research", "record"], definitions, models: allowedModels, maxAgents: 4 } },
    initialState: { model: models.getModel("faux", "test")!, systemPrompt: "ROOT COORDINATOR ONLY", tools: [], messages: [], thinkingLevel: "off" } });
  agent.subscribe(event => { const value = event as unknown as { type: string; snapshot: AgentSessionSnapshot }; if (value.type === "project_session") snapshot = value.snapshot; });
  return { agent, faux, lease, suspend, snapshot: () => snapshot! };
}

test("named management uses its action when a gateway populates legacy result fields", async t => {
  const f = fixture();
  let result: ai.ToolResultMessage | undefined;
  f.faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("subagent", { action: "list", agentId: "researcher", workId: "unused", task: "status", taskId: 1,
      background: true, mode: "followUp", resultTaskId: 1, resultOffset: 0, resultLimit: 20000, resultHash: "a".repeat(64) })], { stopReason: "toolUse" }),
    (request: ai.TranscriptContext) => {
      result = request.messages.find(message => message.role === "toolResult") as ai.ToolResultMessage;
      return ai.fauxAssistantMessage("Listed");
    },
  ]);
  const run = f.agent.prompt("List current work");
  t.after(async () => { f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!result);
  assert.equal(result!.isError, false);
  assert.deepEqual(JSON.parse(result!.content.filter(part => part.type === "text").map(part => part.text).join("")), []);
  assert.equal(f.snapshot().agents?.length, 0, "Listing must never spawn the filled placeholder work");
});

test("30 named work items overlap at 3 researchers and 1 writer, with durable FIFO admission and isolated prompts", async t => {
  const f = fixture(), gate = latch(); let researchers = 0, writers = 0, maxResearchers = 0, maxWriters = 0;
  const finished: string[] = [];
  for (const [name, writer] of [["research", false], ["record", true]] as const) f.agent.state.tools.push({
    name, label: name, description: name, replay: "safe", parameters: ai.Type.Object({ id: ai.Type.String() }),
    execute: async (_id, args, signal) => {
      if (writer) maxWriters = Math.max(maxWriters, ++writers); else maxResearchers = Math.max(maxResearchers, ++researchers);
      try { await Promise.race([gate.promise, new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
        await new Promise(done => setTimeout(done, 5)); finished.push((args as { id: string }).id);
        return { content: [ai.fauxText("Stored receipt")], details: {} };
      } finally { if (writer) --writers; else --researchers; }
    },
  });
  const respond = (request: ai.TranscriptContext) => {
    const user = request.messages.find(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith("work-"));
    if (!user || request.messages.some(message => message.role === "toolResult")) return ai.fauxAssistantMessage("Done");
    const text = JSON.stringify(request.messages);
    assert.ok(request.messages.some(message => message.role === "system"
      && Object.values(message.sections ?? {}).some(section => section?.includes(BUILTIN_AGENT_SKILLS_PROMPT))));
    assert.doesNotMatch(text, /ROOT COORDINATOR ONLY/);
    const writer = String(user.content).includes("writer");
    assert.match(text, writer ? /WRITER ROLE ONLY/ : /RESEARCH ROLE ONLY/);
    assert.doesNotMatch(text, writer ? /RESEARCH ROLE ONLY/ : /WRITER ROLE ONLY/);
    return ai.fauxAssistantMessage([ai.fauxToolCall(writer ? "record" : "research", { id: String(user.content) })], { stopReason: "toolUse" });
  };
  f.faux.setResponses(Array.from({ length: 100 }, () => respond));
  f.agent.requestId = "root"; const run = f.agent.prompt("Start");
  t.after(async () => { gate.resolve(); f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => f.snapshot()?.turns.some(turn => turn.requestId === "root" && turn.status === "done"));
  const receipts = [];
  for (let index = 0; index < 30; ++index) {
    const agentId = index % 4 === 3 ? "writer" : "researcher";
    receipts.push(await f.agent.control({ type: "subagent", action: "spawn", requestId: `spawn-${index}`, agentId, workId: `work-${index}`,
      prompt: `work-${index}-${agentId}`, background: true }));
  }
  await until(() => researchers === 3 && writers === 1);
  assert.ok(f.snapshot().agents!.some(work => work.status === "queued"));
  const duplicate = await f.agent.control({ type: "subagent", action: "spawn", requestId: "duplicate", agentId: "researcher", workId: "work-0", prompt: "work-0-researcher", background: true });
  assert.equal(duplicate.taskId, receipts[0].taskId);
  await assert.rejects(f.agent.control({ type: "subagent", action: "spawn", requestId: "conflict", agentId: "writer", workId: "work-0", prompt: "different" }), /already used/);
  gate.resolve();
  await until(() => f.snapshot().agents?.filter(work => work.status === "completed").length === 30);
  assert.equal(new Set(finished).size, 30); assert.equal(maxResearchers, 3); assert.equal(maxWriters, 1);
  assert.equal(f.snapshot().turns.filter(turn => turn.mode === "report").length, 0);
});

test("failed business verification remains failed and retryable even when the model finishes normally", async t => {
  const f = fixture(undefined, [roles[0]], false, false, [], [{ name: "research", description: "Verify business result", replay: "safe", parameters: ai.Type.Object({}),
    execute: async (_args, api, ctx) => {
      await api.commit(async tx => {
        const owner = (await tx.conversation(api.conversationId))!.owner!;
        const progress = await tx.doc(AgentWorkProgressDoc, owner.conversationId, String(owner.taskId), null);
        progress.total = 1; progress.error = "Evidence could not be verified";
      }, ctx);
      return { output: [ai.fauxText("Verification failed")], isError: true };
    } }]);
  f.faux.setResponses(Array.from({ length: 15 }, () => (request: ai.TranscriptContext) => {
    if (request.messages.some(message => message.role === "user" && message.content === "Verify") && !request.messages.some(message => message.role === "toolResult"))
      return ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" });
    return ai.fauxAssistantMessage("Finished");
  }));
  const run = f.agent.prompt("Start");
  t.after(async () => { f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const first = await f.agent.control({ type: "subagent", action: "spawn", requestId: "verify", agentId: "researcher", workId: "verify", prompt: "Verify" });
  await until(() => f.snapshot().agents?.some(work => work.taskId === first.taskId && work.status === "failed") === true);
  assert.match(f.snapshot().agents!.find(work => work.taskId === first.taskId)!.error!, /could not be verified/);
  const retry = await f.agent.control({ type: "subagent", action: "retry", taskId: first.taskId!, requestId: "retry-verify" });
  assert.equal(retry.agents![0].attempt, 2);
});

for (const blocked of [false, true]) test(`automatic work retries reuse committed context and respect retry barriers (blocked=${blocked})`, async t => {
  let calls = 0;
  const f = fixture(undefined, [{ ...roles[0], requireProgress: true, retry: { maxAttempts: 3, delayMs: 0 } }], false, false, [], [
    { name: "research", description: "Verify evidence", replay: "safe", parameters: ai.Type.Object({}), execute: async (_args, api, ctx) => {
      calls++;
      await api.commit(async tx => {
        const owner = (await tx.conversation(api.conversationId))!.owner!;
        const progress = await tx.doc(AgentWorkProgressDoc, owner.conversationId, String(owner.taskId), null);
        progress.total = 1; progress.completed = calls > 1 ? 1 : 0;
        progress.error = calls > 1 ? "" : "Evidence temporarily unavailable"; progress.retryable = !blocked;
      }, ctx);
      return { output: [ai.fauxText(calls > 1 ? "Verified evidence" : "Saved draft checkpoint")], isError: calls === 1 };
    } },
  ]);
  f.faux.setResponses(Array.from({ length: 30 }, () => (request: ai.TranscriptContext) => {
    if (!JSON.stringify(request.messages.filter(message => message.role === "system")).includes("RESEARCH ROLE ONLY")) return ai.fauxAssistantMessage("Root");
    let lastUser = -1; request.messages.forEach((message, index) => { if (message.role === "user") lastUser = index; });
    if (calls > 0 && !request.messages.slice(lastUser+1).some(message => message.role === "toolResult"))
      assert.ok(JSON.stringify(request.messages).includes("Saved draft checkpoint"), "Retry must retain committed tools and evidence");
    return request.messages.slice(lastUser+1).some(message => message.role === "toolResult") ? ai.fauxAssistantMessage("Finished")
      : ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" });
  }));
  const run = f.agent.prompt("Start");
  t.after(async () => { f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const first = await f.agent.control({ type: "subagent", action: "spawn", requestId: "automatic", agentId: "researcher", workId: "automatic", prompt: "Verify", reportToParent: true });
  await until(() => f.snapshot().agents?.some(work => work.taskId === first.taskId && ["completed", "failed"].includes(work.status)) === true);
  const work = f.snapshot().agents!.find(work => work.taskId === first.taskId)!;
  assert.equal(work.status, blocked ? "failed" : "completed"); assert.equal(work.attempt, blocked ? 1 : 2);
  assert.equal(calls, blocked ? 1 : 2); assert.equal(f.snapshot().agents!.length, 1);
  await until(() => f.snapshot().turns.filter(turn => turn.mode === "report").length === 1);
  assert.equal(f.snapshot().turns.filter(turn => turn.conversationId === work.childConversationId).length, blocked ? 1 : 2);
});

test("a failed child turn retries after transport exhaustion without inheriting the old unanswered failure", async t => {
  const f = fixture(undefined, [{ ...roles[0], retry: { maxAttempts: 3, delayMs: 0 } }]);
  let calls = 0;
  f.faux.setResponses(Array.from({ length: 30 }, () => (request: ai.TranscriptContext) => {
    if (!JSON.stringify(request.messages.filter(message => message.role === "system")).includes("RESEARCH ROLE ONLY")) return ai.fauxAssistantMessage("Root");
    return ++calls <= 11 ? ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" })
      : ai.fauxAssistantMessage("Recovered");
  }));
  const run = f.agent.prompt("Start");
  t.after(async () => { f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const first = await f.agent.control({ type: "subagent", action: "spawn", requestId: "transport", agentId: "researcher", workId: "transport", prompt: "Verify" });
  await until(() => f.snapshot().agents?.some(work => work.taskId === first.taskId && work.status === "completed") === true);
  const work = f.snapshot().agents!.find(work => work.taskId === first.taskId)!;
  assert.equal(calls, 12); assert.equal(work.attempt, 2); assert.equal(work.result, "Recovered");
  assert.deepEqual(f.snapshot().turns.filter(turn => turn.conversationId === work.childConversationId).map(turn => turn.status), ["unanswered", "done"]);
  assert.equal(f.snapshot().agents!.length, 1);
});

for (const total of [0, -1]) test(`an invalid required completion receipt exhausts the work budget and cannot be bypassed by retry (total=${total})`, async t => {
  const f = fixture(undefined, [{ ...roles[0], requireProgress: true, retry: { maxAttempts: 3, delayMs: 0 } }], false, false, [], [
    { name: "research", description: "Save an invalid completion receipt", replay: "safe", parameters: ai.Type.Object({}), execute: async (_args, api, ctx) => {
      await api.commit(async tx => {
        const owner = (await tx.conversation(api.conversationId))!.owner!;
        const progress = await tx.doc(AgentWorkProgressDoc, owner.conversationId, String(owner.taskId), null);
        progress.total = total; progress.completed = 0;
      }, ctx);
      return { output: [ai.fauxText("Unverified receipt")] };
    } },
  ]);
  let calls = 0;
  f.faux.setResponses(Array.from({ length: 30 }, () => (request: ai.TranscriptContext) => {
    if (JSON.stringify(request.messages.filter(message => message.role === "system")).includes("RESEARCH ROLE ONLY")) {
      let lastUser = -1; request.messages.forEach((message, index) => { if (message.role === "user") lastUser = index; });
      if (!request.messages.slice(lastUser+1).some(message => message.role === "toolResult"))
        return ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" });
      calls++;
    }
    return ai.fauxAssistantMessage("Finished without a verified receipt");
  }));
  const run = f.agent.prompt("Start");
  t.after(async () => { f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const first = await f.agent.control({ type: "subagent", action: "spawn", requestId: "incomplete", agentId: "researcher", workId: "incomplete", prompt: "Verify" });
  await until(() => f.snapshot().agents?.some(work => work.taskId === first.taskId && work.status === "failed") === true);
  const failed = f.snapshot().agents!.find(work => work.taskId === first.taskId)!;
  assert.equal(calls, 3); assert.equal(failed.attempt, 3); assert.match(failed.error!, /Retry limit reached \(3\/3\).*verified progress/);
  await assert.rejects(f.agent.control({ type: "subagent", action: "retry", requestId: "bypass-budget", taskId: first.taskId! }), /retry limit reached/);
  assert.equal(f.snapshot().agents!.length, 1); assert.equal(calls, 3);
});

test("stopping during work retry backoff never starts the next attempt", async t => {
  const f = fixture(undefined, [{ ...roles[0], requireProgress: true, retry: { maxAttempts: 3, delayMs: 60000 } }]);
  let calls = 0;
  f.faux.setResponses(Array.from({ length: 10 }, () => (request: ai.TranscriptContext) => {
    if (JSON.stringify(request.messages.filter(message => message.role === "system")).includes("RESEARCH ROLE ONLY")) calls++;
    return ai.fauxAssistantMessage("Unverified");
  }));
  const run = f.agent.prompt("Start");
  t.after(async () => { f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const first = await f.agent.control({ type: "subagent", action: "spawn", requestId: "backoff", agentId: "researcher", workId: "backoff", prompt: "Verify" });
  await until(() => f.snapshot().tasks.some(task => task.id === first.taskId && task.phase === "retry"));
  const stopped = await f.agent.control({ type: "subagent", action: "stop", requestId: "stop-backoff", taskId: first.taskId! });
  assert.equal(stopped.agents![0].status, "aborted"); assert.equal(stopped.agents![0].attempt, 1); assert.equal(calls, 1);
});

for (const reduceLimit of [false, true]) test(`SQLite preserves a scheduled work retry without resetting its budget (reduceLimit=${reduceLimit})`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-work-retries-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite");
  const definition = { ...roles[0], requireProgress: true, retry: { maxAttempts: 2, delayMs: 1000 } };
  let calls = 0;
  const respond = (request: ai.TranscriptContext) => {
    if (JSON.stringify(request.messages.filter(message => message.role === "system")).includes("RESEARCH ROLE ONLY")) calls++;
    return ai.fauxAssistantMessage("Not verified");
  };
  const first = fixture(database, [definition]); first.faux.setResponses(Array.from({ length: 10 }, () => respond));
  const initial = first.agent.prompt("Start");
  await until(() => !!first.snapshot());
  const spawned = await first.agent.control({ type: "subagent", action: "spawn", requestId: "persist-retry", agentId: "researcher", workId: "persist-retry", prompt: "Verify" });
  await until(() => first.snapshot().tasks.some(task => task.id === spawned.taskId && task.phase === "retry"));
  first.suspend.resolve(); await initial; await first.agent.close();
  const second = fixture(database, [{ ...definition, retry: { ...definition.retry, maxAttempts: reduceLimit ? 1 : 2 } }], true);
  second.faux.setResponses(Array.from({ length: 10 }, () => respond));
  const resumed = second.agent.prompt("Start");
  t.after(async () => { second.lease.resolve(); await resumed; await second.agent.close(); });
  await until(() => second.snapshot()?.agents?.some(work => work.taskId === spawned.taskId && work.status === "failed") === true);
  assert.equal(calls, reduceLimit ? 1 : 2); assert.equal(second.snapshot().agents!.length, 1);
  assert.equal(second.snapshot().agents![0].attempt, reduceLimit ? 1 : 2);
  assert.match(second.snapshot().agents![0].error!, /Retry limit reached/);
});

test("invalid automatic work retry limits are rejected before starting work", async () => {
  for (const retry of [{ maxAttempts: 0 }, { maxAttempts: 11 }, { maxAttempts: 1.5 }, { maxAttempts: 3, delayMs: -1 }]) {
    const f = fixture(undefined, [{ ...roles[0], retry }]);
    await assert.rejects(f.agent.prompt("Start"), /Invalid agent role definition/);
    await f.agent.close();
  }
});

test("roles cannot call another role's tools or delegate, and explicit model/effort overrides require the allowlist", async t => {
  const definition = { ...roles[0], model: { provider: "faux", modelId: "alternate" }, effort: "high" };
  const denied = fixture(undefined, [definition]);
  await assert.rejects(denied.agent.prompt("Start"), /Invalid agent role definition/);
  await denied.agent.close();
  const f = fixture(undefined, [definition], false, false, [definition.model]); let forbidden = 0, calls = 0;
  f.agent.state.tools = ["research", "record"].map(name => ({ name, label: name, description: name, replay: "safe" as const, parameters: ai.Type.Object({}),
    execute: async () => { if (name === "record") forbidden++; else calls++; return { content: [ai.fauxText("Receipt")], details: {} }; } }));
  f.faux.setResponses(Array.from({ length: 20 }, () => (request: ai.TranscriptContext) => {
    if (!request.messages.some(message => message.role === "user" && message.content === "Isolated work")) return ai.fauxAssistantMessage("Root");
    const results = request.messages.filter(message => message.role === "toolResult");
    if (!results.length) return ai.fauxAssistantMessage([ai.fauxToolCall("record", {}), ai.fauxToolCall("subagent", { task: "Recursive" }), ai.fauxToolCall("research", {})], { stopReason: "toolUse" });
    assert.ok(results.filter(message => message.isError).length >= 2);
    return ai.fauxAssistantMessage("Only authorized research executed");
  }));
  const run = f.agent.prompt("Start");
  t.after(async () => { f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const receipt = await f.agent.control({ type: "subagent", action: "spawn", requestId: "isolated", workId: "isolated", agentId: "researcher", prompt: "Isolated work" });
  await until(() => f.snapshot().agents?.some(work => work.taskId === receipt.taskId && work.status === "completed") === true);
  assert.equal(forbidden, 0); assert.equal(calls, 1);
  const child = f.snapshot().agents!.find(work => work.taskId === receipt.taskId)!;
  assert.deepEqual(f.snapshot().contexts.find(scope => scope.conversationId === child.childConversationId)?.configuration,
    { version: 0, provider: "faux", model: "alternate", effort: "high" });
  await assert.rejects(f.agent.control({ type: "subagent", action: "spawn", requestId: "recursive", targetId: child.childConversationId, agentId: "researcher", workId: "recursive", prompt: "No" }), /parent agent/);
});

test("stopping queued work never starts it and a wait does not prevent cancellation", async t => {
  const f = fixture(undefined, [{ ...roles[0], maxConcurrency: 1 }]);
  let calls = 0;
  f.agent.state.tools = [{ name: "research", label: "Research", description: "Wait", replay: "safe", parameters: ai.Type.Object({}),
    execute: async (_id, _args, signal) => { calls++; await new Promise<void>(done => signal?.addEventListener("abort", () => done(), { once: true })); return { content: [ai.fauxText("Stopped")], details: {} }; } }];
  const respond = (request: ai.TranscriptContext) => request.messages.some(message => message.role === "user" && message.content === "Work")
    ? ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" }) : ai.fauxAssistantMessage("Root");
  f.faux.setResponses(Array.from({ length: 20 }, () => respond));
  const run = f.agent.prompt("Start");
  t.after(async () => { await f.agent.control({ type: "cancel", scope: "all", requestId: "cleanup" }); f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const first = await f.agent.control({ type: "subagent", action: "spawn", requestId: "one", agentId: "researcher", workId: "one", prompt: "Work" });
  await until(() => calls === 1);
  const second = await f.agent.control({ type: "subagent", action: "spawn", requestId: "two", agentId: "researcher", workId: "two", prompt: "Work" });
  const queuedMessage = await f.agent.control({ type: "subagent", action: "send", requestId: "queued-message", taskId: second.taskId!, prompt: "Extra" });
  assert.deepEqual(queuedMessage.agents![0].messageDelivery, { status: "not_running", nextAction: "wait" });
  await f.agent.control({ type: "subagent", action: "stop", requestId: "stop-two", taskId: second.taskId! });
  const stoppedMessage = await f.agent.control({ type: "subagent", action: "send", requestId: "stopped-message", taskId: second.taskId!, prompt: "Extra" });
  assert.deepEqual(stoppedMessage.agents![0].messageDelivery, { status: "not_running", nextAction: "retry" });
  const waiting = f.agent.control({ type: "subagent", action: "wait", requestId: "wait-one", taskId: first.taskId! });
  await f.agent.control({ type: "subagent", action: "stop", requestId: "stop-one", taskId: first.taskId! });
  assert.equal((await waiting).agents![0].status, "aborted"); assert.equal(calls, 1);
});

test("a message sent to running work finishes in the same owned conversation before work settles", async t => {
  const f = fixture(), gate = latch(); let entered = false;
  f.agent.state.tools = [{ name: "research", label: "Research", description: "Hold the first request", replay: "safe", parameters: ai.Type.Object({}),
    execute: async () => { entered = true; await gate.promise; return { content: [ai.fauxText("Evidence")], details: {} }; } }];
  f.faux.setResponses(Array.from({ length: 30 }, () => (request: ai.TranscriptContext) => {
    const user = request.messages.filter(message => message.role === "user").at(-1);
    if (user?.content === "First" && !request.messages.some(message => message.role === "toolResult"))
      return ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" });
    return ai.fauxAssistantMessage(user?.content === "Follow up" ? "Follow-up completed" : "Completed");
  }));
  const run = f.agent.prompt("Start");
  t.after(async () => { gate.resolve(); f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const first = await f.agent.control({ type: "subagent", action: "spawn", requestId: "first", agentId: "researcher", workId: "first", prompt: "First" });
  await until(() => entered);
  await f.agent.control({ type: "subagent", action: "send", requestId: "follow-up", taskId: first.taskId!, prompt: "Follow up" });
  gate.resolve();
  await until(() => f.snapshot().agents?.some(work => work.taskId === first.taskId && work.status === "completed") === true);
  assert.ok(f.snapshot().turns.some(turn => turn.requestId === "agent-message:follow-up" && turn.status === "done"));
  assert.equal(f.snapshot().agents!.find(work => work.taskId === first.taskId)!.result, "Follow-up completed");
  const late = await f.agent.control({ type: "subagent", action: "send", requestId: "too-late", taskId: first.taskId!, prompt: "Late" });
  assert.equal(late.status, "settled");
  assert.deepEqual(late.agents![0].messageDelivery, { status: "not_running", nextAction: "get" });
  assert.equal(late.agents![0].result, "Follow-up completed");
  assert.ok(!f.snapshot().turns.some(turn => turn.prompt === "Late"), "A late send must never restart settled work");
  const child = f.snapshot().agents!.find(work => work.taskId === first.taskId)!.childConversationId!;
  await assert.rejects(f.agent.control({ type: "submit", targetId: child, mode: "followUp", requestId: "late-child", prompt: "Late" }), /settling or stopped/);
});

for (const partial of [false, true]) test(`child stream failures use the full retry budget without replaying tools (partial=${partial})`, async t => {
  const f = fixture(); let modelCalls = 0, toolCalls = 0;
  f.agent.state.tools = [{ name: "research", label: "Research", description: "Commit once", parameters: ai.Type.Object({}),
    execute: async () => { toolCalls++; return { content: [ai.fauxText("Durable evidence")], details: {} }; } }];
  f.faux.setResponses(Array.from({ length: 35 }, () => (request: ai.TranscriptContext) => {
    if (!request.messages.some(message => message.role === "user" && message.content === "Retry child")) return ai.fauxAssistantMessage("Root");
    if (!request.messages.some(message => message.role === "toolResult")) return ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" });
    if (++modelCalls <= 10) return ai.fauxAssistantMessage(partial ? "Saved partial" : [], { stopReason: modelCalls % 2 ? "aborted" : "error", errorMessage: "Upstream response stream was interrupted" });
    return ai.fauxAssistantMessage("Recovered child");
  }));
  const run = f.agent.prompt("Start");
  t.after(async () => { f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const receipt = await f.agent.control({ type: "subagent", action: "spawn", requestId: "retry-child", agentId: "researcher", workId: "retry-child", prompt: "Retry child" });
  await until(() => f.snapshot().agents?.some(work => work.taskId === receipt.taskId && work.status === "completed") === true);
  assert.equal(modelCalls, 11); assert.equal(toolCalls, 1);
  const child = f.snapshot().agents!.find(work => work.taskId === receipt.taskId)!;
  assert.equal(child.result, "Recovered child");
  assert.equal(f.snapshot().turns.find(turn => turn.conversationId === child.childConversationId)!.items.filter(item => item.metadata?.partType === "retry").length, 10);
});

test("SQLite restores queued role snapshots without adopting a changed role prompt", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-roles-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite");
  const first = fixture(database, [{ ...roles[0], maxConcurrency: 1 }]);
  let entered = false;
  first.agent.state.tools = [{ name: "research", label: "Research", description: "Wait", replay: "safe", parameters: ai.Type.Object({}),
    execute: async (_id, _args, signal) => { entered = true; await new Promise<void>(done => signal?.addEventListener("abort", () => done(), { once: true })); signal?.throwIfAborted(); return { content: [], details: {} }; } }];
  const respond = (request: ai.TranscriptContext) => request.messages.some(message => message.role === "user" && message.content === "Hold")
    ? ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" }) : ai.fauxAssistantMessage("Root");
  first.faux.setResponses(Array.from({ length: 10 }, () => respond));
  first.agent.requestId = "root"; const initial = first.agent.prompt("Start");
  await until(() => !!first.snapshot());
  await first.agent.control({ type: "subagent", action: "spawn", requestId: "one", agentId: "researcher", workId: "one", prompt: "Hold" });
  await until(() => entered);
  await first.agent.control({ type: "subagent", action: "spawn", requestId: "two", agentId: "researcher", workId: "two", prompt: "Inspect queued" });
  first.suspend.resolve(); await initial; await first.agent.close();
  const second = fixture(database, [{ ...roles[0], systemPrompt: "CHANGED ROLE", tools: [], maxConcurrency: 1 }], true);
  let revokedCalls = 0;
  second.agent.state.tools = [{ name: "research", label: "Research", description: "Read", replay: "safe", parameters: ai.Type.Object({}), execute: async () => { revokedCalls++; return { content: [ai.fauxText("Read")], details: {} }; } }];
  second.faux.setResponses(Array.from({ length: 20 }, () => (request: ai.TranscriptContext) => {
    if (request.messages.some(message => message.role === "user" && message.content === "Inspect queued")) {
      assert.match(JSON.stringify(request.messages), /RESEARCH ROLE ONLY/); assert.doesNotMatch(JSON.stringify(request.messages), /CHANGED ROLE/);
    }
    return ai.fauxAssistantMessage("Finished");
  }));
  const resumed = second.agent.prompt("Start");
  t.after(async () => { second.lease.resolve(); await resumed; await second.agent.close(); });
  await until(() => second.snapshot()?.agents?.filter(work => work.status === "completed").length === 2);
  assert.equal(revokedCalls, 0, "Restored work cannot use a tool removed from its role");
});

test("restored native tools recheck host permission before executing a saved intent", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-native-permission-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite");
  let entered = false, firstApprovals = 0, resumedCalls = 0, denied = 0;
  const first = fixture(database, [roles[0]], false, false, [], [{
    name: "research", description: "Native research", replay: "safe", parameters: ai.Type.Object({}),
    execute: async (_args, _api, ctx) => {
      entered = true;
      await new Promise<void>(done => ctx.abortSignal?.addEventListener("abort", () => done(), { once: true }));
      ctx.abortSignal?.throwIfAborted();
      return { output: [] };
    },
  }]);
  first.agent.beforeToolCall = async () => { firstApprovals++; return undefined; };
  first.faux.setResponses(Array.from({ length: 10 }, () => (request: ai.TranscriptContext) =>
    request.messages.some(message => message.role === "user" && message.content === "Native work")
      ? ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" }) : ai.fauxAssistantMessage("Root")));
  const initial = first.agent.prompt("Start");
  await until(() => !!first.snapshot());
  await first.agent.control({ type: "subagent", action: "spawn", requestId: "native", agentId: "researcher", workId: "native", prompt: "Native work" });
  await until(() => entered);
  assert.equal(firstApprovals, 1, "A fresh tool intent is approved once");
  first.suspend.resolve(); await initial; await first.agent.close();
  const second = fixture(database, [roles[0]], true, false, [], [{
    name: "research", description: "Native research", replay: "safe", parameters: ai.Type.Object({}),
    execute: async () => { resumedCalls++; return { output: [ai.fauxText("Must not execute")] }; },
  }]);
  second.agent.beforeToolCall = async () => { denied++; return { block: true, reason: "Disabled by the current host" }; };
  second.faux.setResponses(Array.from({ length: 10 }, () => (request: ai.TranscriptContext) => {
    assert.match(JSON.stringify(request.messages), /Disabled by the current host/);
    return ai.fauxAssistantMessage("Permission denied");
  }));
  const resumed = second.agent.prompt("Start");
  t.after(async () => { second.lease.resolve(); await resumed; await second.agent.close(); });
  await until(() => second.snapshot()?.agents?.some(work => work.status === "completed") === true);
  assert.equal(denied, 1); assert.equal(resumedCalls, 0);
});

test("retry keeps the work identity, history and committed tool results, and duplicate commands create one attempt", async t => {
  const f = fixture(); let calls = 0, failures = 0;
  f.agent.state.tools = [{ name: "research", label: "Research", description: "Checkpoint", replay: "safe", parameters: ai.Type.Object({}),
    execute: async () => { calls++; return { content: [ai.fauxText("COMMITTED RECEIPT")], details: {} }; } }];
  f.faux.setResponses(Array.from({ length: 30 }, () => (request: ai.TranscriptContext) => {
    if (!request.messages.some(message => message.role === "user" && String(message.content).includes("Retry work"))) return ai.fauxAssistantMessage("Root");
    if (!request.messages.some(message => message.role === "toolResult")) return ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" });
    if (failures++ < 11) { return ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 Unauthorized" }); }
    assert.match(JSON.stringify(request.messages), /COMMITTED RECEIPT/);
    return ai.fauxAssistantMessage("Completed from checkpoint");
  }));
  const run = f.agent.prompt("Start");
  t.after(async () => { f.lease.resolve(); await run; await f.agent.close(); });
  await until(() => !!f.snapshot());
  const first = await f.agent.control({ type: "subagent", action: "spawn", requestId: "initial", agentId: "researcher", workId: "retry-work", prompt: "Retry work" });
  await until(() => f.snapshot().agents?.some(work => work.taskId === first.taskId && work.status === "failed") === true);
  const command = { type: "subagent" as const, action: "retry" as const, requestId: "retry", taskId: first.taskId! };
  const next = await f.agent.control(command);
  assert.equal((await f.agent.control(command)).taskId, next.taskId);
  await until(() => f.snapshot().agents?.some(work => work.taskId === next.taskId && work.status === "completed") === true);
  const second = f.snapshot().agents!.find(work => work.taskId === next.taskId)!;
  assert.equal(calls, 1); assert.equal(second.workId, "retry-work"); assert.equal(second.attempt, 2); assert.equal(second.retryOf, first.taskId);
  assert.notEqual(second.childConversationId, f.snapshot().agents!.find(work => work.taskId === first.taskId)!.childConversationId);
});


test("a new host interrupts the entire saved execution tree before accepting another input", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-interruption-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite");
  const first = fixture(database); let started = 0;
  first.agent.state.tools = [{ name: "research", label: "Research", description: "Wait", replay: "safe", parameters: ai.Type.Object({}),
    execute: async (_id, _args, signal) => { started++; await new Promise<void>(done => signal?.addEventListener("abort", () => done(), { once: true })); signal?.throwIfAborted(); return { content: [], details: {} }; } }];
  first.faux.setResponses(Array.from({ length: 10 }, () => (request: ai.TranscriptContext) => request.messages.some(message => message.role === "user" && message.content === "Hold")
    ? ai.fauxAssistantMessage([ai.fauxToolCall("research", {})], { stopReason: "toolUse" }) : ai.fauxAssistantMessage("Root")));
  const initial = first.agent.prompt("Start");
  await until(() => !!first.snapshot());
  await first.agent.control({ type: "subagent", action: "spawn", requestId: "one", agentId: "researcher", workId: "one", prompt: "Hold" });
  await until(() => started === 1);
  first.suspend.resolve(); await initial; await first.agent.close();
  const second = fixture(database, roles, true, true);
  second.agent.state.tools = [{ name: "research", label: "Research", description: "Must not replay", replay: "safe", parameters: ai.Type.Object({}), execute: async () => { started++; throw new Error("Unexpected replay"); } }];
  const resumed = second.agent.prompt("Start");
  t.after(async () => { second.lease.resolve(); await resumed; await second.agent.close(); });
  await until(() => second.snapshot()?.agents?.some(work => work.status === "aborted") === true);
  assert.equal(started, 1); assert.equal(second.faux.state.callCount, 0);
  second.faux.setResponses([ai.fauxAssistantMessage("New request succeeded")]);
  await second.agent.control({ type: "submit", mode: "followUp", requestId: "new-input", prompt: "New input" });
  await until(() => second.snapshot().turns.some(turn => turn.requestId === "new-input" && turn.status === "done"));
});
