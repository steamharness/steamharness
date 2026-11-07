import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import * as ai from "@earendil-works/pi-ai";
import { awaitWithContext } from "@earendil-works/chord/context";
import { DurableAgent } from "../agent/durable-agent";
import { createBuiltinAgentTools } from "../agent/tools";
import { AgentWorkProgressDoc, enqueueAgentWorks } from "../agent/subagents";
import type { AgentSessionSnapshot } from "../agent/session-types";
import { testAgentStorage } from "./runtime-test-storage";

function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (!check()) { if (Date.now() > end) throw new Error("Subagent completion did not wake the parent"); await new Promise(done => setTimeout(done, 5)); }
}

function fixture(options: { database?: string; resume?: boolean; count?: number; immediate?: boolean; beforeSleep?: boolean; seconds?: number; fail?: number; noSleep?: boolean; rootFailure?: boolean } = {}) {
  const count = options.count ?? 4;
  const gates = Array.from({ length: count }, latch), lease = latch(), suspend = latch();
  if (options.immediate) gates.forEach(gate => gate.resolve());
  const faux = ai.fauxProvider({ models: [{ id: "test", contextWindow: 100_000, maxTokens: 200 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  let snapshot: AgentSessionSnapshot | undefined, rootCalls = 0;
  const notifications: string[] = [];
  const agent = new DurableAgent({ models, storage: options.database ? testAgentStorage(options.database) : undefined,
    resumeSession: options.resume, retryDelayMs: 0, sessionLease: lease.promise, sessionSuspend: suspend.promise,
    initialState: { model: models.getModel("faux", "test")!, systemPrompt: "WAKE ROOT", thinkingLevel: "off", messages: [],
      tools: createBuiltinAgentTools({ Type: ai.Type, scope: { workdir: process.cwd(), allowedDirectories: [process.cwd()] } }).filter(tool => tool.name === "sleep") },
    session: { compaction: { enabled: false }, subagents: { tools: ["job"], definitions: [
      { id: "worker", description: "Work", systemPrompt: "WAKE CHILD", tools: ["job"] },
    ] }, nativeTools: [
      { name: "start_work", description: "Start work", replay: "safe", parameters: ai.Type.Object({}), execute: async (_args, api, ctx) => {
        const ids = count ? await api.commit(tx => enqueueAgentWorks(tx, api.registry, Array.from({ length: count }, (_, index) => ({
          agentId: "worker", workId: `work-${index}`, prompt: `work-${index}`, reportToParent: false,
        })), { conversationId: api.conversationId, ownership: { kind: "conversation" }, background: true }), ctx) : [];
        if (options.beforeSleep) await Promise.all(ids.map(id => api.waitForTask(id, ctx)));
        return { output: [ai.fauxText("Work queued")] };
      } },
      { name: "job", description: "Wait for a work receipt", replay: "safe", parameters: ai.Type.Object({ index: ai.Type.Number() }), execute: async (args, api, ctx) => {
        const index = (args as { index: number }).index;
        await awaitWithContext(gates[index].promise, ctx);
        if (index === options.fail) {
          await api.commit(async tx => {
            const owner = (await tx.conversation(api.conversationId))!.owner!;
            const progress = await tx.doc(AgentWorkProgressDoc, owner.conversationId, String(owner.taskId), null);
            progress.error = "Verification failed"; progress.retryable = false;
          }, ctx);
          return { output: [ai.fauxText("Verification failed")], isError: true };
        }
        return { output: [ai.fauxText("Work receipt saved")] };
      } },
    ] } });
  agent.subscribe(event => { const value = event as unknown as { type: string; snapshot: AgentSessionSnapshot }; if (value.type === "project_session") snapshot = value.snapshot; });
  faux.setResponses(Array.from({ length: 100 }, () => (request: ai.TranscriptContext) => {
    if (JSON.stringify(request.messages.filter(message => message.role === "system")).includes("WAKE CHILD")) {
      if (request.messages.some(message => message.role === "toolResult")) return ai.fauxAssistantMessage("Child done");
      const work = request.messages.find(message => message.role === "user" && /^work-\d+$/.test(String(message.content)))!;
      return ai.fauxAssistantMessage([ai.fauxToolCall("job", { index: Number(String(work.content).slice(5)) })], { stopReason: "toolUse" });
    }
    rootCalls++;
    for (const message of request.messages) if (message.role === "user" && String(message.content).startsWith("The subagent queue is idle:")
      && !notifications.includes(String(message.content))) notifications.push(String(message.content));
    const tools = request.messages.filter(message => message.role === "toolResult");
    if (!tools.some(tool => tool.toolName === "start_work")) return ai.fauxAssistantMessage([ai.fauxToolCall("start_work", {})], { stopReason: "toolUse" });
    if (options.rootFailure) return ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: "Parent model failed" });
    if (!options.noSleep && !tools.some(tool => tool.toolName === "sleep")) return ai.fauxAssistantMessage([ai.fauxToolCall("sleep", { seconds: options.seconds ?? 900 })], { stopReason: "toolUse" });
    return ai.fauxAssistantMessage("Parent continued after waiting");
  }));
  const run = agent.prompt("Start");
  return { agent, faux, gates, lease, suspend, run, snapshot: () => snapshot!, rootCalls: () => rootCalls, notifications,
    close: async () => { gates.forEach(gate => gate.resolve()); lease.resolve(); suspend.resolve(); await Promise.allSettled([run]); await agent.close(); } };
}

test("the final child clears a queued batch, wakes a 900-second sleep and submits one hidden notification", async t => {
  const f = fixture(); t.after(f.close);
  await until(() => f.snapshot()?.turns[0]?.items.some(item => item.title === "sleep" && JSON.stringify(item.content).includes("wakeAt")) === true);
  assert.equal(f.snapshot().agents?.filter(work => work.status === "queued").length, 1);
  f.gates.slice(0, 3).forEach(gate => gate.resolve());
  await until(() => f.snapshot().agents?.filter(work => work.status === "completed").length === 3);
  assert.equal(f.rootCalls(), 2, "A remaining running or queued child must keep the sleep active");
  assert.equal(f.snapshot().turns.filter(turn => turn.hiddenInput).length, 0);
  f.gates[3].resolve();
  await until(() => f.snapshot().turns[0]?.status === "done");
  assert.equal(f.rootCalls(), 3); assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0], /4 completed, 0 failed, 0 stopped/);
  const result = f.snapshot().turns[0].items.find(item => item.title === "sleep")!.content as { output: { details: { wakeAt: number; endedAt: number; wakeReason: string } } };
  assert.equal(result.output.details.wakeReason, "subagents-idle");
  assert.ok(result.output.details.endedAt < result.output.details.wakeAt - 890_000);
  assert.equal(f.snapshot().turns.filter(turn => turn.hiddenInput).length, 1);
  await f.agent.control({ type: "snapshot", requestId: "repeat-read" });
  assert.equal(f.notifications.length, 1);
});

test("a sleep started after children have already finished still ends immediately without duplicate notices", async t => {
  const f = fixture({ count: 2, immediate: true, beforeSleep: true }); t.after(f.close);
  await until(() => f.snapshot()?.turns[0]?.status === "done");
  assert.equal(f.notifications.length, 1);
  assert.match(JSON.stringify(f.snapshot().turns[0].items), /subagents-idle/);
  assert.equal(f.rootCalls(), 3);
});

test("an ordinary sleep with no child work retains its duration", async t => {
  const f = fixture({ count: 0, seconds: 0.04 }); t.after(f.close);
  await until(() => f.snapshot()?.turns[0]?.status === "done");
  assert.equal(f.notifications.length, 0);
  const result = f.snapshot().turns[0].items.find(item => item.title === "sleep")!;
  assert.match(JSON.stringify(result.content), /Waited 0.04 seconds/);
  assert.doesNotMatch(JSON.stringify(result.content), /wakeReason/);
});

test("completion also resumes an idle parent without a visible user input", async t => {
  const f = fixture({ count: 1, noSleep: true }); t.after(f.close);
  await until(() => f.snapshot()?.turns[0]?.status === "done");
  assert.equal(f.rootCalls(), 2);
  f.gates[0].resolve();
  await until(() => f.snapshot().turns.some(turn => turn.hiddenInput && turn.status === "done"));
  assert.equal(f.rootCalls(), 3); assert.equal(f.notifications.length, 1);
  const notice = f.snapshot().turns.find(turn => turn.hiddenInput)!;
  assert.equal(notice.mode, "followUp");
  assert.ok(notice.items.some(item => item.content === "Parent continued after waiting"));
});

test("the idle notice reports existing failures accurately when the final child succeeds", async t => {
  const f = fixture({ count: 2, fail: 0 }); t.after(f.close);
  await until(() => f.snapshot()?.turns[0]?.items.some(item => item.title === "sleep") === true);
  f.gates[0].resolve();
  await until(() => f.snapshot().agents?.some(work => work.status === "failed") === true);
  assert.equal(f.rootCalls(), 2);
  f.gates[1].resolve();
  await until(() => f.snapshot().turns[0]?.status === "done");
  assert.match(f.notifications[0], /1 completed, 1 failed, 0 stopped/);
});

test("stopping the parent cancels its sleep and children without a completion-triggered restart", async t => {
  const f = fixture({ count: 2 }); t.after(f.close);
  await until(() => f.snapshot()?.turns[0]?.items.some(item => item.title === "sleep") === true);
  await f.agent.control({ type: "cancel", scope: "all", requestId: "stop-all" });
  f.gates.forEach(gate => gate.resolve());
  await f.agent.control({ type: "snapshot", requestId: "stopped-snapshot" });
  assert.equal(f.notifications.length, 0); assert.equal(f.rootCalls(), 2);
  assert.ok(f.snapshot().agents?.every(work => work.status === "aborted"));
});

test("child completion cannot restart a failed parent's exhausted model budget", async t => {
  const f = fixture({ count: 1, rootFailure: true }); t.after(f.close);
  await until(() => f.snapshot()?.turns[0]?.status === "unanswered");
  const calls = f.rootCalls();
  f.gates[0].resolve();
  await until(() => f.snapshot().agents?.[0]?.status === "completed"
    && f.snapshot().history.some(task => task.kind === "project.subagents-idle" && task.status === "completed"));
  assert.equal(f.rootCalls(), calls); assert.equal(f.notifications.length, 0);
  assert.equal(f.snapshot().turns.filter(turn => turn.hiddenInput).length, 0);
});

test("recovery preserves the sleep deadline and delivers the queue completion only once", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-idle-wake-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite");
  const first = fixture({ database, count: 2 }); t.after(first.close);
  await until(() => first.snapshot()?.turns[0]?.items.some(item => item.title === "sleep" && JSON.stringify(item.content).includes("wakeAt")) === true);
  const deadline = /"wakeAt":(\d+)/.exec(JSON.stringify(first.snapshot().turns[0].items))![1];
  first.suspend.resolve(); await first.run; await first.agent.close();
  const second = fixture({ database, count: 2, resume: true, immediate: true }); t.after(second.close);
  await until(() => second.snapshot()?.turns[0]?.status === "done");
  assert.equal(second.notifications.length, 1);
  assert.match(JSON.stringify(second.snapshot().turns[0].items), new RegExp(`"wakeAt":${deadline}`));
  assert.equal(second.snapshot().turns.filter(turn => turn.hiddenInput).length, 1);
});
