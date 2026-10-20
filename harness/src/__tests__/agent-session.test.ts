import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ai from "@earendil-works/pi-ai";
import { DurableAgent } from "../agent/durable-agent";
import type { AgentSessionSnapshot } from "../agent/session-types";
import { projectSessionUsage } from "../agent/session";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Session state did not settle."); await new Promise(done => setTimeout(done, 10)); }
}
function session(options: import("../agent/session-types").AgentSessionOptions = {}, databasePath?: string) {
  const faux = ai.fauxProvider({ models: [{ id: "test", contextWindow: 100_000, maxTokens: 100 }, { id: "other", contextWindow: 100_000, maxTokens: 100 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const lease = latch();
  const instance = new DurableAgent({ models, databasePath, session: options, sessionLease: lease.promise, initialState: {
    systemPrompt: "Session test", model: models.getModel("faux", "test")!, thinkingLevel: "off", messages: [], tools: [],
  } });
  let snapshot: AgentSessionSnapshot | undefined;
  instance.subscribe(event => { const value = event as unknown as { type: string; snapshot: AgentSessionSnapshot }; if (value.type === "project_session") snapshot = value.snapshot; });
  return { instance, faux, lease, snapshot: () => snapshot! };
}

function reportScriptedUsage(instance: DurableAgent, messages: ai.AssistantMessage[]): void {
  const streamSimple = instance.models.streamSimple.bind(instance.models);
  let index = 0;
  instance.models.streamSimple = (...args) => {
    const usage = messages[index++]!.usage;
    const source = streamSimple(...args), stream = ai.createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === "done") event.message.usage = usage;
        else if (event.type === "error") event.error.usage = usage;
        stream.push(event);
      }
      stream.end(await source.result());
    })();
    return stream;
  };
}

test("retry records stay between interrupted and resumed text in live and reopened turns", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-session-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite"), first = session({ compaction: { enabled: false } }, database);
  first.faux.setResponses([
    ai.fauxAssistantMessage("Before interruption", { stopReason: "error", errorMessage: "terminated" }),
    ai.fauxAssistantMessage("After first retry", { stopReason: "error", errorMessage: "terminated" }),
    ai.fauxAssistantMessage("Final answer"),
  ]);
  first.instance.requestId = "retry-turn";
  const running = first.instance.prompt("Continue after interruptions");
  t.after(async () => { first.lease.resolve(); await running; await first.instance.close(); });
  await until(() => first.snapshot()?.turns.some(turn => turn.status === "done"));
  const items = first.snapshot().turns.find(turn => turn.requestId === "retry-turn")!.items;
  assert.deepEqual(items.map(item => item.metadata?.partType), ["text", "retry", "text", "retry", "text"]);
  const retries = items.filter(item => item.metadata?.partType === "retry");
  assert.equal(new Set(retries.map(item => item.id)).size, 2);
  assert.ok(retries.every(item => item.collapsed));
  assert.deepEqual(retries.map(item => {
    const content = item.content as { attempt: number; maxAttempts: number; reason: string };
    return [content.attempt, content.maxAttempts, content.reason];
  }), [[1, 10, "terminated"], [2, 10, "terminated"]]);
  first.lease.resolve(); await running; await first.instance.close();
  const reopened = session({ compaction: { enabled: false } }, database);
  reopened.instance.requestId = "retry-turn"; reopened.lease.resolve();
  t.after(() => reopened.instance.close());
  await reopened.instance.prompt("Continue after interruptions");
  assert.equal(reopened.faux.state.callCount, 0);
  assert.deepEqual(reopened.snapshot().turns.find(turn => turn.requestId === "retry-turn")!.items, items);
});

test("session retry counters restart after successful tool requests and preserve both records on replay", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-session-retry-reset-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite"), first = session({ compaction: { enabled: false } }, database);
  first.instance.state.tools = [{ name: "inspect", label: "Inspect", description: "Test", parameters: ai.Type.Object({}),
    execute: async () => ({ content: [ai.fauxText("Inspected")], details: {} }) }];
  first.faux.setResponses([
    ai.fauxAssistantMessage("First partial", { stopReason: "error", errorMessage: "terminated" }),
    ai.fauxAssistantMessage([ai.fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Second partial", { stopReason: "error", errorMessage: "terminated" }),
    ai.fauxAssistantMessage("Finished"),
  ]);
  first.instance.requestId = "retry-reset";
  const running = first.instance.prompt("Inspect");
  t.after(async () => { first.lease.resolve(); await running; await first.instance.close(); });
  await until(() => first.snapshot()?.turns.some(turn => turn.status === "done"));
  const items = first.snapshot().turns.find(turn => turn.requestId === "retry-reset")!.items;
  const retries = items.filter(item => item.metadata?.partType === "retry");
  assert.equal(new Set(retries.map(item => item.id)).size, 2);
  assert.deepEqual(retries.map(item => (item.content as { attempt: number }).attempt), [1, 1]);
  first.lease.resolve(); await running; await first.instance.close();
  const reopened = session({ compaction: { enabled: false } }, database);
  reopened.instance.requestId = "retry-reset"; reopened.lease.resolve();
  t.after(() => reopened.instance.close());
  await reopened.instance.prompt("Inspect");
  assert.equal(reopened.faux.state.callCount, 0);
  assert.deepEqual(reopened.snapshot().turns.find(turn => turn.requestId === "retry-reset")!.items, items);
});

test("turn usage and live context isolate forks, cached tool rounds and SQLite replay", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-session-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite"), first = session({ compaction: { enabled: false } }, database);
  first.instance.state.tools = [{ name: "echo", label: "Echo", description: "Return a result", parameters: ai.Type.Object({}),
    execute: async () => ({ content: [ai.fauxText("Tool result")], details: {} }) }];
  const input = [441, 1395, 3812, 1741, 3105, 775, 1151];
  const output = [140, 181, 226, 170, 298, 863, 206];
  const cached = [3328, 3328, 4352, 7680, 8960, 11776, 12288];
  const answer = ai.fauxAssistantMessage("Hello");
  answer.usage = { ...answer.usage, input: 3642, output: 113, totalTokens: 3755 };
  const rounds = input.map((tokens, index) => {
    const message = ai.fauxAssistantMessage(index < 6 ? [ai.fauxToolCall("echo", {})] : "Fork answer", { stopReason: index < 6 ? "toolUse" : "stop" });
    message.usage = { ...message.usage, input: tokens, output: output[index]!, cacheRead: cached[index]!, totalTokens: tokens + output[index]! + cached[index]! };
    return message;
  });
  reportScriptedUsage(first.instance, [answer, ...rounds]);
  first.faux.setResponses([answer, ...rounds]);
  first.instance.requestId = "hello";
  const running = first.instance.prompt("Hello");
  t.after(async () => { first.lease.resolve(); await running; await first.instance.close(); });
  await until(() => first.snapshot()?.turns.some(turn => turn.status === "done"));
  const initial = first.snapshot().turns[0]!;
  const fork = await first.instance.control({ type: "fork", requestId: "fork", entryId: initial.answerId! });
  assert.deepEqual(first.snapshot().contexts.find(scope => scope.conversationId === fork.forkId)?.contextUsage, { used: 3755, total: 100_000 });
  await first.instance.control({ type: "submit", requestId: "fork-input", targetId: fork.forkId, prompt: "Inspect", mode: "followUp" });
  await until(() => first.snapshot().turns.some(turn => turn.requestId === "fork-input" && turn.status === "done"));
  const root = first.snapshot().turns.find(turn => turn.requestId === "hello")!;
  const child = first.snapshot().turns.find(turn => turn.requestId === "fork-input")!;
  assert.equal(root.usage?.totalTokens, 3755); assert.equal(root.usage?.calls, 1);
  assert.equal(child.usage?.totalTokens, 66216); assert.equal(child.usage?.calls, 7);
  assert.equal(child.usage?.cachedInputTokens, 51712);
  assert.equal(root.usage!.totalTokens + child.usage!.totalTokens, 69971);
  assert.deepEqual(first.snapshot().contexts.find(scope => scope.conversationId === 1)?.contextUsage, { used: 3755, total: 100_000 });
  assert.deepEqual(first.snapshot().contexts.find(scope => scope.conversationId === fork.forkId)?.contextUsage, { used: 13645, total: 100_000 });
  first.lease.resolve(); await running; await first.instance.close();
  const reopened = session({ compaction: { enabled: false } }, database);
  reopened.instance.requestId = "hello"; reopened.lease.resolve();
  t.after(() => reopened.instance.close());
  await reopened.instance.prompt("Hello");
  assert.equal(reopened.faux.state.callCount, 0);
  assert.deepEqual(reopened.snapshot().turns.map(turn => turn.usage), first.snapshot().turns.map(turn => turn.usage));
  assert.deepEqual(reopened.snapshot().contexts.map(scope => scope.contextUsage), first.snapshot().contexts.map(scope => scope.contextUsage));
});

test("session context updates after follow-up, compaction and reset without using summary billing", async t => {
  const { instance, faux, lease, snapshot } = session({ compaction: { enabled: false, keepRecentTokens: 1 } });
  const response = (text: string, tokens: number) => {
    const message = ai.fauxAssistantMessage(text);
    message.usage = { ...message.usage, input: tokens - 100, output: 100, totalTokens: tokens }; return message;
  };
  const responses = [response("First answer", 3755), response("Follow-up answer", 8000), response("Short summary", 6000)];
  reportScriptedUsage(instance, responses); faux.setResponses(responses);
  instance.requestId = "first"; const run = instance.prompt("Hello");
  t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  await instance.control({ type: "submit", requestId: "follow", prompt: "Continue", mode: "followUp" });
  await until(() => snapshot().turns.some(turn => turn.requestId === "follow" && turn.status === "done"));
  assert.deepEqual(snapshot().contexts[0]?.contextUsage, { used: 8000, total: 100_000 });
  assert.equal(snapshot().turns.find(turn => turn.requestId === "first")?.usage?.totalTokens, 3755);
  await instance.control({ type: "compact", requestId: "compact" });
  await until(() => !snapshot().tasks.length && snapshot().records.some(record => record.kind === "pi.compaction"));
  const compacted = snapshot().contexts[0]!.contextUsage!;
  assert.ok(compacted.used > 0 && compacted.used < 3755, "the summary request's 6000 billed tokens do not calibrate the compacted history");
  assert.equal(snapshot().turns.find(turn => turn.requestId === "follow")?.usage?.totalTokens, 8000);
  assert.ok(snapshot().records.some(record => record.kind === "project.compaction-usage"));
  await instance.control({ type: "reset", requestId: "reset" });
  assert.deepEqual(snapshot().contexts[0]?.contextUsage, { used: 0, total: 100_000 });
  assert.equal(snapshot().turns[0]?.usage?.totalTokens, 3755);
});

test("turn billing includes failed model responses and its own compaction but never copied history", () => {
  const message = ai.fauxAssistantMessage("Failed", { stopReason: "error" });
  message.usage = { ...message.usage, input: 100, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 10, totalTokens: 0 };
  const entries = [
    { kind: "project.context", model: [message] },
    { kind: "pi.assistant", model: [message] },
    { kind: "project.compaction-usage", data: { requestId: "this-turn", usage: message.usage } },
    { kind: "project.compaction-usage", data: { requestId: "other-turn", usage: message.usage } },
  ] as unknown as Parameters<typeof projectSessionUsage>[0];
  assert.deepEqual(projectSessionUsage(entries, "this-turn"), { inputTokens: 200, outputTokens: 40, totalTokens: 380,
    cachedInputTokens: 60, cacheCreationTokens: 80, reasoningTokens: 20, calls: 2 });
});

test("an observer failure settles running tools, queued inputs and independent forks before reporting failure", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-session-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite");
  const first = session({}, database);
  let entered = 0, aborted = 0;
  first.instance.state.tools = [{ name: "wait", label: "Wait", description: "Wait for cancellation", replay: "safe", parameters: ai.Type.Object({ fail: ai.Type.Boolean() }),
    execute: async (_id, args, signal, update) => {
      entered++;
      if ((args as { fail: boolean }).fail) update?.({ content: [ai.fauxText("Working")], details: {} });
      await new Promise<void>(resolve => {
        const stop = () => { aborted++; resolve(); };
        if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
      });
      return { content: [ai.fauxText("Stopped")], details: {} };
    } }];
  let failedProjection = false;
  first.instance.subscribe(event => {
    if ((event as { type: string }).type === "project_session" && entered === 2 && !failedProjection) {
      failedProjection = true; throw new Error("projection unavailable");
    }
  });
  first.faux.setResponses([ai.fauxAssistantMessage("First answer"),
    ai.fauxAssistantMessage([ai.fauxToolCall("wait", { fail: false })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxToolCall("wait", { fail: true })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Must not continue"),
  ]);
  first.instance.requestId = "first";
  const run = first.instance.prompt("Hello");
  const failed = assert.rejects(run, error => {
    assert.ok(!(error instanceof AggregateError), error instanceof AggregateError ? String(error.errors) : undefined);
    assert.match(String(error), /projection unavailable/); return true;
  });
  t.after(async () => { first.lease.resolve(); await run.catch(() => undefined); await first.instance.close(); });
  await until(() => first.snapshot()?.turns.some(turn => turn.status === "done"));
  const fork = await first.instance.control({ type: "fork", requestId: "fork", entryId: first.snapshot().turns[0]!.answerId! });
  await first.instance.control({ type: "submit", requestId: "fork-run", targetId: fork.forkId, prompt: "Wait", mode: "followUp" });
  await until(() => entered === 1);
  await first.instance.control({ type: "submit", requestId: "fork-queued", targetId: fork.forkId, prompt: "Must not run", mode: "followUp" });
  await first.instance.control({ type: "submit", requestId: "root-run", prompt: "Fail", mode: "followUp" });
  await failed;
  assert.equal(entered, 2); assert.equal(aborted, 2); assert.equal(first.faux.state.callCount, 3);
  assert.deepEqual(first.snapshot().tasks, []);
  assert.equal(first.snapshot().foreground, false); assert.equal(first.snapshot().backgroundCount, 0);
  assert.ok(first.snapshot().turns.filter(turn => turn.requestId !== "first").every(turn => turn.status === "unanswered"));
  assert.ok(first.snapshot().history.every(task => task.stopping === false));
  await first.instance.close();
  const reopened = session({}, database);
  t.after(() => reopened.instance.close());
  reopened.lease.resolve(); reopened.instance.requestId = "first";
  await reopened.instance.prompt("Hello");
  assert.equal(reopened.faux.state.callCount, 0);
  assert.equal(reopened.instance.state.errorMessage, "projection unavailable");
  assert.deepEqual(reopened.snapshot().tasks, []);
});

test("session commands persist plans, isolate forks and context resets, and reject conflicting request identities", async t => {
  const { instance, faux, lease, snapshot } = session();
  faux.setResponses([ai.fauxAssistantMessage("First"), ai.fauxAssistantMessage("Fork answer"), ai.fauxAssistantMessage("New context")]);
  instance.requestId = "first";
  const run = instance.prompt("Hello");
  t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  const initial = snapshot().turns[0]!;
  const plan = { type: "plan" as const, requestId: "plan", expectedVersion: 0, items: [{ id: "one", text: "Review", status: "in_progress" as const }] };
  await instance.control(plan);
  await instance.control(plan);
  assert.equal(snapshot().plan.version, 1);
  await assert.rejects(() => instance.control({ ...plan, items: [] }), /already used/);
  const command = { type: "fork" as const, requestId: "fork", entryId: initial.answerId! };
  const fork = await instance.control(command);
  assert.equal((await instance.control(command)).forkId, fork.forkId);
  assert.equal(snapshot().conversations.length, 2);
  assert.equal(snapshot().contexts.find(context => context.conversationId === fork.forkId)?.plan.version, 0);
  await instance.control({ type: "submit", requestId: "fork-input", targetId: fork.forkId, prompt: "Fork", mode: "followUp" });
  await until(() => snapshot().turns.some(turn => turn.requestId === "fork-input" && turn.status === "done"));
  await instance.control({ type: "reset", requestId: "reset", handoff: "Start fresh" });
  await instance.control({ type: "submit", requestId: "fresh", prompt: "New", mode: "followUp" });
  await until(() => snapshot().turns.some(turn => turn.requestId === "fresh" && turn.status === "done"));
  assert.equal(snapshot().epoch, 1);
  assert.equal(snapshot().turns.find(turn => turn.requestId === "first")?.items.filter(item => item.contentType === "markdown").map(item => item.content).join(""), "First");
  assert.equal(faux.state.callCount, 3);
});

test("an idle steer is a new answered turn and retains the original answer range", async t => {
  const { instance, faux, lease, snapshot } = session();
  faux.setResponses([ai.fauxAssistantMessage("First"), ai.fauxAssistantMessage("Second")]);
  instance.requestId = "first"; const run = instance.prompt("First input");
  t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  await instance.control({ type: "submit", requestId: "idle-steer", prompt: "Second input", mode: "steer" });
  await until(() => snapshot().turns.some(turn => turn.requestId === "idle-steer" && turn.status === "done"));
  const second = snapshot().turns.find(turn => turn.requestId === "idle-steer")!;
  assert.equal(second.mode, "followUp");
  assert.equal(second.items.map(item => item.content).join(""), "Second");
  assert.equal(snapshot().turns[0]?.items.map(item => item.content).join(""), "First");
});

test("SQLite reopens configuration, plans and command receipts without replaying completed work", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite"), first = session({}, database);
  first.faux.setResponses([ai.fauxAssistantMessage("Persisted")]); first.instance.requestId = "persisted";
  const initial = first.instance.prompt("Hello");
  await until(() => first.snapshot()?.turns.some(turn => turn.status === "done"));
  await first.instance.control({ type: "configure", requestId: "config", expectedVersion: 0, effort: "high" });
  const plan = { type: "plan" as const, requestId: "plan", expectedVersion: 0, items: [{ id: "a", text: "Keep this", status: "completed" as const }] };
  await first.instance.control(plan);
  const forkCommand = { type: "fork" as const, requestId: "fork", entryId: first.snapshot().turns[0]!.answerId! };
  const fork = await first.instance.control(forkCommand);
  const owner = first.snapshot().ownerId;
  first.lease.resolve(); await initial; await first.instance.close();
  const second = session({}, database); second.instance.requestId = "persisted";
  const reopened = second.instance.prompt("Hello");
  t.after(async () => { second.lease.resolve(); await reopened; await second.instance.close(); });
  await until(() => second.snapshot()?.turns.some(turn => turn.status === "done"));
  assert.notEqual(second.snapshot().ownerId, owner);
  assert.equal(second.snapshot().configuration.effort, "high");
  assert.deepEqual(second.snapshot().plan.items, plan.items);
  assert.deepEqual(await second.instance.control(forkCommand), fork);
  assert.equal(second.faux.state.callCount, 0);
  assert.ok(second.snapshot().receipts.some(receipt => receipt.requestId === "config"));
  const remove = { type: "delete" as const, requestId: "delete", targetId: fork.forkId };
  await second.instance.control(remove); await second.instance.control(remove);
  assert.equal(second.snapshot().conversations.length, 1);
  await assert.rejects(() => second.instance.control({ type: "submit", targetId: fork.forkId, requestId: "deleted-input", prompt: "No", mode: "followUp" }), /deleted/);
});

test("foreground cancellation leaves a background subagent alive and cancelling its owner prevents reporting", async t => {
  const { instance, faux, lease, snapshot } = session({ subagents: { tools: ["wait"], maxAgents: 1 } });
  let childEntered = false;
  instance.state.tools = [{ name: "wait", label: "Wait", description: "Wait for cancellation", replay: "safe", parameters: ai.Type.Object({}),
    execute: async (_id, _args, signal) => {
      childEntered = true;
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { content: [{ type: "text", text: "Cancelled" }], details: {} };
    } }];
  const reply = (request: ai.TranscriptContext) => {
    if (request.messages.some(message => message.role === "user" && message.content === "Child wait")) return ai.fauxAssistantMessage([ai.fauxToolCall("wait", {})], { stopReason: "toolUse" });
    if (!request.messages.some(message => message.role === "toolResult")) return ai.fauxAssistantMessage([ai.fauxToolCall("subagent", { task: "Child wait", background: true })], { stopReason: "toolUse" });
    return ai.fauxAssistantMessage("Parent finished");
  };
  faux.setResponses([reply, reply, reply, reply]);
  instance.requestId = "parent"; const run = instance.prompt("Delegate");
  t.after(async () => { lease.resolve(); await instance.control({ type: "cancel", requestId: "cleanup", scope: "all" }); await run; await instance.close(); });
  await until(() => childEntered && snapshot()?.turns.some(turn => turn.requestId === "parent" && turn.status === "done"));
  const child = snapshot().conversations.find(conversation => conversation.parentId === snapshot().conversationId)!;
  await assert.rejects(() => instance.control({ type: "configure", requestId: "escape-model", targetId: child.id, expectedVersion: 0,
    model: { provider: "faux", modelId: "other" } }), /not allowed/);
  await instance.control({ type: "configure", requestId: "child-effort", targetId: child.id, expectedVersion: 0, effort: "low" });
  await instance.control({ type: "cancel", requestId: "foreground", scope: "foreground" });
  assert.ok(snapshot().tasks.some(task => task.toolName === "wait"));
  const delegation = snapshot().tasks.find(task => task.kind === "project.delegation")!;
  await instance.control({ type: "cancel", requestId: "stop-child", scope: "task", taskId: delegation.id });
  assert.equal(snapshot().tasks.length, 0);
  assert.equal(snapshot().turns.filter(turn => turn.requestId.startsWith("report:")).length, 0);
});

for (const sqlite of [false, true]) test(`cancelled tasks stop showing stopping after settling in ${sqlite ? "SQLite" : "memory"}`, async t => {
  const directory = sqlite ? await mkdtemp(path.join(tmpdir(), "agent-cancel-")) : undefined;
  if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
  const database = directory && path.join(directory, "session.sqlite");
  const first = session({}, database), cleanup = latch();
  let entered = false;
  first.instance.state.tools = [{ name: "wait", label: "Wait", description: "Wait for cancellation", replay: "safe", parameters: ai.Type.Object({}),
    execute: async (_id, _args, signal) => {
      entered = true;
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      await cleanup.promise;
      return { content: [{ type: "text", text: "Stopped" }], details: {} };
    } }];
  first.faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
  first.instance.requestId = "cancelled";
  const run = first.instance.prompt("Start");
  t.after(async () => { cleanup.resolve(); first.lease.resolve(); await run; await first.instance.close(); });
  await until(() => entered && first.snapshot()?.tasks.some(task => task.toolName === "wait"));
  const taskId = first.snapshot().tasks.find(task => task.toolName === "wait")!.id;
  const stopped = first.instance.control({ type: "cancel", requestId: "stop", scope: "foreground" });
  await until(() => first.snapshot().tasks.some(task => task.id === taskId && task.stopping));
  cleanup.resolve(); await stopped;
  assert.equal(first.snapshot().tasks.length, 0);
  assert.equal(first.snapshot().history.find(task => task.id === taskId)?.status, "aborted");
  assert.ok(first.snapshot().history.every(task => !task.stopping));
  if (database) {
    first.lease.resolve(); await run; await first.instance.close();
    const second = session({}, database); second.instance.requestId = "cancelled";
    const reopened = second.instance.prompt("Start");
    t.after(async () => { second.lease.resolve(); await reopened; await second.instance.close(); });
    await until(() => second.snapshot()?.history.some(task => task.id === taskId));
    assert.equal(second.snapshot().tasks.length, 0);
    assert.equal(second.snapshot().history.find(task => task.id === taskId)?.status, "aborted");
    assert.ok(second.snapshot().history.every(task => !task.stopping));
    assert.equal(second.faux.state.callCount, 0);
  }
});

test("nested native tools preserve caller restrictions, task ownership and approval checks", async t => {
  let executions = 0;
  const { instance, faux, lease, snapshot } = session({ nativeTools: [
    { name: "hidden", callers: ["tools"], description: "Restricted nested tool", parameters: ai.Type.Object({}), replay: "safe",
      execute: async () => { executions++; return { output: [{ type: "text", text: "Hidden" }] }; } },
    { name: "outer", callers: ["model"], description: "Calls the restricted tool", parameters: ai.Type.Object({}), replay: "safe",
      execute: async (_args, api, context) => {
        const result = await api.executeTool("hidden", {}, context, { key: "read" });
        return { output: [{ type: "text", text: JSON.stringify(result.structuredOutput ?? result.diagnostics) }], isError: result.isError };
      } },
  ] });
  const checked: string[] = [];
  instance.beforeToolCall = async ({ toolCall }) => { checked.push(toolCall.name); return toolCall.name === "hidden" ? { block: true, reason: "Approval denied" } : undefined; };
  faux.setResponses([request => {
    const offered = request.messages.flatMap(message => message.role === "system" ? message.toolsAdded?.map(tool => tool.name) ?? [] : []);
    assert.ok(offered.includes("outer")); assert.ok(!offered.includes("hidden"));
    return ai.fauxAssistantMessage([ai.fauxToolCall("outer", {})], { stopReason: "toolUse" });
  }, ai.fauxAssistantMessage("Done")]);
  instance.requestId = "nested"; const run = instance.prompt("Nested");
  t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  assert.equal(executions, 0);
  assert.deepEqual(checked, ["outer", "hidden"]);
  const nested = snapshot().history.find(task => task.toolName === "hidden")!;
  assert.ok(nested.parentId);
  assert.deepEqual(nested.arguments, {});
  assert.equal(snapshot().history.find(task => task.id === nested.parentId)?.toolName, "outer");
});

test("manual durable compaction is a deduplicated background task and preserves visible answers", async t => {
  const { instance, faux, lease, snapshot } = session({ compaction: { keepRecentTokens: 10, reserveTokens: 100, backgroundTokens: 0 } });
  const longAnswer = "Historical answer. ".repeat(100);
  faux.setResponses([ai.fauxAssistantMessage(longAnswer), ai.fauxAssistantMessage("Recent answer"), ai.fauxAssistantMessage("Historical summary")]);
  instance.requestId = "first"; const run = instance.prompt("First question");
  t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  await instance.control({ type: "submit", requestId: "second", prompt: "Recent question", mode: "followUp" });
  await until(() => snapshot().turns.some(turn => turn.requestId === "second" && turn.status === "done"));
  const command = { type: "compact" as const, requestId: "compact" };
  const receipt = await instance.control(command);
  assert.deepEqual(await instance.control(command), receipt);
  await until(() => snapshot().history.some(task => task.id === receipt.taskId && task.status === "completed"));
  assert.ok(snapshot().records.some(record => record.kind === "pi.compaction"));
  assert.equal(snapshot().turns[0]?.items.map(item => item.content).join(""), longAnswer);
  assert.equal(faux.state.callCount, 3);
  assert.ok(JSON.stringify(instance.state.messages).includes("Historical summary"));
});

test("tool history resolves reused call ids against each task's committed assistant entry", async t => {
  const { instance, faux, lease, snapshot } = session({ nativeTools: ["first_read", "second_read"].map(name => ({
    name, description: name, parameters: ai.Type.Object({ path: ai.Type.String() }), replay: "safe" as const,
    execute: async args => ({ output: [{ type: "text" as const, text: String((args as { path: string }).path) }] }),
  })) });
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("first_read", { path: "first.txt" }, { id: "reused" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxToolCall("second_read", { path: "second.txt" }, { id: "reused" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Done"),
  ]);
  const starts: { id: string; tool: string; args: unknown }[] = [], ends: string[] = [];
  instance.subscribe(event => {
    if (event.type === "tool_execution_start") starts.push({ id: event.toolCallId, tool: event.toolName, args: event.args });
    if (event.type === "tool_execution_end") ends.push(event.toolCallId);
  });
  instance.requestId = "history"; const run = instance.prompt("Inspect both files");
  t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  assert.deepEqual(snapshot().history.filter(task => task.kind === "pi.tool").map(task => ({ name: task.toolName, arguments: task.arguments })), [
    { name: "first_read", arguments: { path: "first.txt" } },
    { name: "second_read", arguments: { path: "second.txt" } },
  ]);
  assert.deepEqual(starts.map(({ tool, args }) => ({ tool, args })), [
    { tool: "first_read", args: { path: "first.txt" } }, { tool: "second_read", args: { path: "second.txt" } },
  ]);
  assert.equal(new Set(starts.map(call => call.id)).size, 2);
  assert.deepEqual(ends, starts.map(call => call.id));
});

test("the durable inbox steers at a tool boundary, withdraws follow ups and never answers a queued input twice", async t => {
  const { instance, faux, lease, snapshot } = session();
  const tool = latch(); let entered = false;
  instance.state.tools = [{ name: "gate", label: "Gate", description: "Barrier", replay: "safe", parameters: ai.Type.Object({}),
    execute: async () => { entered = true; await tool.promise; return { content: [{ type: "text", text: "Ready" }], details: {} }; } }];
  let seen = "";
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("gate", {})], { stopReason: "toolUse" }), request => {
    seen = JSON.stringify(request.messages); return ai.fauxAssistantMessage("Steered");
  }, ai.fauxAssistantMessage("Next")]);
  instance.requestId = "first"; const run = instance.prompt("Start");
  t.after(async () => { tool.resolve(); lease.resolve(); await run; await instance.close(); });
  await until(() => entered);
  await assert.rejects(() => instance.control({ type: "submit", requestId: "rejected", prompt: "Reject", mode: "reject" }), /busy/i);
  await instance.control({ type: "submit", requestId: "steer", prompt: "Use detail", mode: "steer" });
  await instance.control({ type: "submit", requestId: "withdraw-me", prompt: "Skip", mode: "followUp" });
  const withdrawn = await instance.control({ type: "withdraw", requestId: "withdraw", inputId: "withdraw-me" });
  assert.equal(withdrawn.status, "aborted");
  const next = { type: "submit" as const, requestId: "next", prompt: "Next", mode: "followUp" as const };
  await instance.control(next); await instance.control(next);
  tool.resolve();
  await until(() => snapshot().turns.some(turn => turn.requestId === "next" && turn.status === "done"));
  assert.match(seen, /Use detail/); assert.doesNotMatch(seen, /Skip/);
  assert.equal(snapshot().turns.filter(turn => turn.requestId === "next").length, 1);
  assert.equal(faux.state.callCount, 3);
});

for (const sqlite of [false, true]) test(`queued promotion preserves input identity and images in ${sqlite ? "SQLite" : "memory"}`, async t => {
  const directory = sqlite ? await mkdtemp(path.join(tmpdir(), "agent-promote-")) : undefined;
  const database = directory && path.join(directory, "session.sqlite");
  let current = session({}, database);
  const { instance, faux, snapshot } = current;
  const gate = latch(); let entered = false, seen = "";
  instance.state.tools = [{ name: "gate", label: "Gate", description: "Barrier", replay: "safe", parameters: ai.Type.Object({}),
    execute: async () => { entered = true; await gate.promise; return { content: [{ type: "text", text: "Ready" }], details: {} }; } }];
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("gate", {})], { stopReason: "toolUse" }), request => {
    seen = JSON.stringify(request.messages); return ai.fauxAssistantMessage("Steered");
  }, ai.fauxAssistantMessage("Next answer")]);
  instance.requestId = "first"; let run = instance.prompt("Start");
  t.after(async () => {
    gate.resolve(); current.lease.resolve(); await run; await current.instance.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  await until(() => entered);
  await instance.control({ type: "submit", requestId: "next", prompt: "Next queued input", mode: "followUp" });
  await instance.control({ type: "submit", requestId: "urgent", prompt: "Urgent image", mode: "followUp", images: [{ data: "AA==", mimeType: "image/png" }] });
  const command = { type: "promote" as const, requestId: "send-now", inputId: "urgent" };
  const receipt = await instance.control(command);
  assert.equal(receipt.status, "accepted");
  assert.deepEqual(await instance.control(command), receipt);
  assert.equal(snapshot().turns.find(turn => turn.requestId === "urgent")?.mode, "steer");
  assert.equal(snapshot().turns.find(turn => turn.requestId === "next")?.mode, "followUp");
  assert.equal((await instance.control({ type: "promote", requestId: "already-placed", inputId: "first" })).status, "already_placed");
  assert.equal(faux.state.callCount, 1);
  gate.resolve();
  await until(() => snapshot().turns.some(turn => turn.requestId === "next" && turn.status === "done"));
  assert.match(seen, /Urgent image/); assert.match(seen, /AA==/); assert.doesNotMatch(seen, /Next queued input/);
  assert.equal(snapshot().turns.filter(turn => turn.requestId === "urgent").length, 1);
  assert.equal(snapshot().turns.find(turn => turn.requestId === "urgent")?.mode, "steer");
  assert.equal((await instance.control({ type: "promote", requestId: "already-done", inputId: "urgent" })).status, "settled");
  assert.equal(faux.state.callCount, 3);
  if (database) {
    current.lease.resolve(); await run; await instance.close();
    current = session({}, database); current.instance.requestId = "first"; run = current.instance.prompt("Start");
    await until(() => current.snapshot()?.turns.some(turn => turn.requestId === "next" && turn.status === "done"));
    assert.deepEqual(await current.instance.control(command), receipt);
    assert.equal(current.snapshot().turns.find(turn => turn.requestId === "urgent")?.mode, "steer");
    assert.equal(current.faux.state.callCount, 0);
  }
});

test("background subagents have restricted tools and return exactly one durable parent input", async t => {
  const { instance, faux, lease, snapshot } = session({ subagents: { tools: ["read"], maxAgents: 1 } });
  let childTools: string[] = [];
  instance.state.tools = [{ name: "read", label: "Read", description: "Read", replay: "safe", parameters: ai.Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "Read" }], details: {} }) }];
  const response = (request: ai.TranscriptContext): ai.AssistantMessage => {
    const text = JSON.stringify(request.messages);
    if (request.messages.some(message => message.role === "user" && message.content === "Inspect child")) {
      childTools = request.messages.flatMap(message => message.role === "system" ? message.toolsAdded?.map(tool => tool.name) ?? [] : []);
      return ai.fauxAssistantMessage("Child result");
    }
    if (!text.includes('"role":"toolResult"')) return ai.fauxAssistantMessage([ai.fauxToolCall("subagent", { task: "Inspect child", background: true })], { stopReason: "toolUse" });
    return ai.fauxAssistantMessage("Parent answer");
  };
  faux.setResponses([response, response, response, response, response]);
  instance.requestId = "parent"; const run = instance.prompt("Delegate");
  t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.requestId.startsWith("report:") && turn.status === "done"));
  assert.deepEqual(childTools, ["read"]);
  assert.equal(snapshot().turns.filter(turn => turn.requestId.startsWith("report:")).length, 1);
  assert.equal(snapshot().conversations.length, 2);
  assert.equal(snapshot().usage.length, 2);
});
