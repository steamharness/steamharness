import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { declareConfigurationFixture } from "./configuration-fixture";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as ai from "@earendil-works/pi-ai";
import { DurableAgent } from "../agent/durable-agent";
import { agentConversationDirectory, cancelAgentConversation } from "../agent/storage";
import { HarnessError } from "../workflow/errors";
import {createLocalProjectConfigurationStore,withProjectConfiguration} from '../configuration';

function worker(directory: string, scenario: string, phase: string) {
  return spawn(process.execPath, ["--import", "tsx", "--conditions=development",
    path.join(import.meta.dirname, "fixtures", "agent-durable-worker.ts"), directory, scenario, phase],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] });
}
async function message(child: ChildProcess, type: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker did not publish ${type}`)); }, 10_000);
    const receive = (value: any) => { if (value?.type === type) { cleanup(); resolve(value); } };
    const end = (code: number | null) => { cleanup(); reject(new Error(`Worker exited early: ${code}`)); };
    const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", end); };
    child.on("message", receive); child.on("exit", end);
  });
}
function agent(databasePath?: string, retryDelayMs?: number) {
  const faux = ai.fauxProvider({ models: [{ id: "test", contextWindow: 100_000, maxTokens: 100 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const instance = new DurableAgent({ databasePath, models, retryDelayMs, initialState: {
    systemPrompt: "Test", model: models.getModel("faux", "test")!, thinkingLevel: "off", messages: [], tools: [],
  } });
  return { instance, faux };
}

test('durable model steps retain the verified configuration scope and stop after a role downgrade', async t => {
  const directory=await mkdtemp(path.join(tmpdir(),'durable-profile-'));
  const originalFetch=globalThis.fetch,originalUrl=process.env.STEAMHARNESS_SERVER_URL,originalKey=process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  let role='developer';
  let instance:DurableAgent|undefined;
  t.after(async()=>{
    await instance?.close();globalThis.fetch=originalFetch;
    if(originalUrl===undefined)delete process.env.STEAMHARNESS_SERVER_URL;else process.env.STEAMHARNESS_SERVER_URL=originalUrl;
    if(originalKey===undefined)delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;else process.env.STEAMHARNESS_SERVER_ADMIN_KEY=originalKey;
    await rm(directory,{recursive:true,force:true});
  });
  await writeProjectFixture(path.join(directory,'package.json'),JSON.stringify({name:"aggregate-fixture",version: "0.1.0", defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",databases:[],configuration:"configuration.json"}],id:crypto.randomUUID()}));
  await writeFile(path.join(directory,'configuration.json'),JSON.stringify({version:2,fields:[{name:'mode',type:'string'}],profilePolicy:{version:1,defaultProfileKey:'ask',manageMinimumRole:'developer',profiles:[{key:'ask',name:'Ask',minimumRole:'guest',fixedValues:{mode:'ask'}},{key:'build',name:'Build',minimumRole:'developer',fixedValues:{mode:'build'}}]}}));
  process.env.STEAMHARNESS_SERVER_URL='https://durable-access.test';process.env.STEAMHARNESS_SERVER_ADMIN_KEY=directory;
  globalThis.fetch=async input=>new Response(JSON.stringify({errCode:0,data:String(input).endsWith('/api/auth/me')?{profile:{userId:'alice'}}:{access:{effectiveRole:role}}}));
  await declareConfigurationFixture(directory);
  const store=await createLocalProjectConfigurationStore(directory);
  const snapshot=await store.snapshot({id:'profile-build'});
  const created=withProjectConfiguration(snapshot,()=>agent(undefined,0),directory);instance=created.instance;
  instance.state.tools=[{name:'revoke',label:'Revoke',description:'Test',parameters:ai.Type.Object({}),execute:async()=>{role='guest';return {content:[ai.fauxText('Role changed')],details:{}};}}];
  created.faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall('revoke',{})],{stopReason:'toolUse'}),ai.fauxAssistantMessage('Must not run')]);
  await instance.prompt('Revoke and continue').catch(()=>undefined);
  assert.equal(created.faux.state.callCount,1);
  assert.match(instance.state.errorMessage??'',/not available/);
});

for (const partial of [false, true]) test(`unexpected provider aborts retry without replaying completed tools (partial=${partial})`, async t => {
  const { instance, faux } = agent(undefined, 0);
  t.after(() => instance.close());
  let calls = 0;
  instance.state.tools = [{ name: "inspect", label: "Inspect", description: "Test", parameters: ai.Type.Object({}),
    execute: async () => { calls++; return { content: [ai.fauxText("Inspected")], details: {} }; } }];
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage(partial ? [ai.fauxText("Kept partial"), ai.fauxToolCall("inspect", {})] : [], { stopReason: "aborted", errorMessage: "aborted" }),
    ai.fauxAssistantMessage("Finished")]);
  const retries: unknown[] = [];
  instance.subscribe(event => { if ((event as { type: string }).type === "project_retry") retries.push(event); });
  await instance.prompt("Inspect and finish");
  assert.equal(instance.state.errorMessage, undefined);
  assert.equal(calls, 1); assert.equal(faux.state.callCount, 3); assert.equal(retries.length, 1);
  if (partial) assert.ok(instance.state.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Kept partial")));
});

for (const failure of ["eof", "throw"] as const) test(`durable ${failure} stream failures keep partial text and retry instead of hanging or cancelling`, { timeout: 3000 }, async t => {
  const { instance, faux } = agent(undefined, 0);
  t.after(() => instance.close());
  const base = instance.models.streamSimple.bind(instance.models);
  let requests = 0;
  instance.models.streamSimple = (...args) => {
    if (requests++ > 0) return base(...args);
    const stream = ai.createAssistantMessageEventStream();
    const partial = ai.fauxAssistantMessage("Kept partial", { stopReason: "pending" });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Kept partial", partial }); stream.end();
    if (failure === "throw") {
      const iterator = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        const source = iterator();
        for (let next = await source.next(); !next.done; next = await source.next()) yield next.value;
        throw new Error("connection lost");
      };
    }
    return stream;
  };
  faux.setResponses([ai.fauxAssistantMessage("Finished")]);
  await instance.prompt("Continue");
  assert.equal(instance.state.errorMessage, undefined); assert.equal(requests, 2);
  assert.ok(instance.state.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Kept partial")));
});

for (const kind of ["dropped", "empty", "lost-call", "length"] as const) {
  test(`successful tool responses reset the ${kind} retry sequence and budget`, async t => {
    const { instance, faux } = agent(undefined, 0);
    t.after(() => instance.close());
    let calls = 0;
    instance.state.tools = [{ name: "inspect", label: "Inspect", description: "Test", parameters: ai.Type.Object({}),
      execute: async () => { calls++; return { content: [ai.fauxText("Inspected")], details: {} }; } }];
    const limit = kind === "length" ? 2 : 10;
    const failures = () => Array.from({ length: limit }, () => ai.fauxAssistantMessage(kind === "empty" ? [] : "Partial answer", {
      stopReason: kind === "length" ? "length" : kind === "lost-call" ? "toolUse" : "error", errorMessage: "terminated",
    }));
    faux.setResponses([...failures(), ai.fauxAssistantMessage([ai.fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
      ...failures(), ai.fauxAssistantMessage("Finished")]);
    const attempts: number[] = [];
    instance.subscribe(event => {
      const retry = event as unknown as { type: string; attempt: number; maxAttempts: number };
      if (retry.type === "project_retry") { attempts.push(retry.attempt); assert.equal(retry.maxAttempts, limit); }
    });
    await instance.prompt("Inspect and continue");
    assert.equal(instance.state.errorMessage, undefined);
    assert.equal(calls, 1);
    assert.equal(faux.state.callCount, 2 * limit + 2);
    const sequence = Array.from({ length: limit }, (_, index) => index + 1);
    assert.deepEqual(attempts, [...sequence, ...sequence]);
  });
}

for (const first of ["empty", "partial"] as const) {
  test(`switching between empty failures and partial streams retains the retry budget when starting ${first}`, async t => {
    const { instance, faux } = agent(undefined, 0);
    t.after(() => instance.close());
    faux.setResponses(Array.from({ length: 12 }, (_, index) => ai.fauxAssistantMessage((index % 2 === 0) === (first === "empty") ? [] : "Partial", {
      stopReason: "error", errorMessage: "terminated",
    })));
    const attempts: number[] = [];
    instance.subscribe(event => {
      const retry = event as unknown as { type: string; attempt: number };
      if (retry.type === "project_retry") attempts.push(retry.attempt);
    });
    await instance.prompt("Continue").catch(error => assert.match(error.message, /11 times in a row/));
    assert.match(instance.state.errorMessage ?? "", /11 times in a row/);
    assert.equal(faux.state.callCount, 11);
    assert.deepEqual(attempts, Array.from({ length: 10 }, (_, index) => index + 1));
  });
}

test("a committed successful response resets the retry budget after reopening a paused SQLite run", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-retry-reset-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "session.sqlite");
  const tool = { name: "inspect", label: "Inspect", description: "Test", parameters: ai.Type.Object({}),
    execute: async () => ({ content: [ai.fauxText("Inspected")], details: {} }) };
  const first = agent(database, 0);
  first.instance.state.tools = [tool]; first.instance.requestId = "same-run";
  first.instance.beforeToolCall = async () => ({ block: true, reason: "Waiting", pause: new HarnessError({ type: "user_input_required", message: "Approve?" }) });
  first.faux.setResponses([ai.fauxAssistantMessage("Partial", { stopReason: "error", errorMessage: "terminated" }),
    ai.fauxAssistantMessage([ai.fauxToolCall("inspect", {})], { stopReason: "toolUse" })]);
  try { await first.instance.prompt("Inspect"); } finally { await first.instance.close(); }
  const reopened = agent(database, 0);
  t.after(() => reopened.instance.close());
  reopened.instance.state.tools = [tool]; reopened.instance.requestId = "same-run";
  reopened.faux.setResponses([...Array.from({ length: 10 }, () => ai.fauxAssistantMessage("Resumed partial", { stopReason: "error", errorMessage: "terminated" })),
    ai.fauxAssistantMessage("Finished")]);
  const attempts: number[] = [];
  reopened.instance.subscribe(event => {
    const retry = event as unknown as { type: string; attempt: number };
    if (retry.type === "project_retry") attempts.push(retry.attempt);
  });
  await reopened.instance.prompt("Inspect");
  assert.equal(reopened.instance.state.errorMessage, undefined);
  assert.equal(reopened.faux.state.callCount, 11);
  assert.deepEqual(attempts, [1, ...Array.from({ length: 10 }, (_, index) => index + 1)]);
});
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("streamed thinking, text and tool blocks retain their indices before the message commits", { timeout: 10_000 }, async t => {
  const { instance, faux } = agent();
  t.after(() => instance.close());
  const ready = latch<ai.AssistantMessageEventStream>();
  const thinking = latch(), text = latch();
  const tool = ai.fauxToolCall("inspect", { path: "fixture" }, { id: "inspect-call" });
  let partial = ai.fauxAssistantMessage([], { stopReason: "pending" });
  const original = instance.models.streamSimple.bind(instance.models);
  let calls = 0;
  instance.models.streamSimple = (...args) => {
    if (calls++ > 0) return original(...args);
    const stream = ai.createAssistantMessageEventStream();
    const abort = () => {
      const message = { ...partial, stopReason: "aborted" as const };
      stream.push({ type: "error", reason: "aborted", error: message }); stream.end(message);
    };
    args[2]?.signal?.addEventListener("abort", abort, { once: true });
    stream.push({ type: "start", partial }); ready.resolve(stream);
    return stream;
  };
  const deltas: { type: string; index: number; delta: string }[] = [];
  let executed = 0;
  instance.state.tools = [{ name: "inspect", label: "Inspect", description: "Test", parameters: ai.Type.Object({ path: ai.Type.String() }),
    execute: async (_id, args) => { assert.deepEqual(args, tool.arguments); executed++; return { content: [ai.fauxText("Inspected")], details: {} }; } }];
  instance.subscribe(event => {
    if (event.type !== "message_update") return;
    const update = event.assistantMessageEvent;
    if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
    deltas.push({ type: update.type, index: update.contentIndex, delta: update.delta });
    if (update.delta === "Inspect first.") thinking.resolve();
    if (update.delta === "I will inspect. ") text.resolve();
  });
  faux.setResponses([ai.fauxAssistantMessage("Finished.")]);
  const run = instance.prompt("Inspect");
  void run.catch(() => undefined);
  const stream = await ready.promise;
  partial = { ...partial, content: [{ type: "thinking", thinking: "Inspect first." }] };
  stream.push({ type: "thinking_start", contentIndex: 0, partial });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: "Inspect first.", partial });
  await Promise.race([thinking.promise, run]);
  partial = { ...partial, content: [...partial.content, ai.fauxText("I will inspect. ")] };
  stream.push({ type: "text_start", contentIndex: 1, partial });
  stream.push({ type: "text_delta", contentIndex: 1, delta: "I will inspect. ", partial });
  await Promise.race([text.promise, run]);
  assert.deepEqual(instance.state.streamingMessage?.content, partial.content);
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Streamed blocks were not projected.");
      await Promise.race([new Promise(done => setTimeout(done, 5)), run]);
    }
  };
  partial = { ...partial, content: [...partial.content, { ...tool, arguments: { path: "fi" } }] };
  stream.push({ type: "toolcall_start", contentIndex: 2, partial });
  const streamedPath = () => {
    const block = instance.state.streamingMessage?.content[2];
    return block?.type === "toolCall" ? block.arguments.path : undefined;
  };
  await until(() => streamedPath() === "fi");
  partial = { ...partial, content: [{ type: "thinking", thinking: "Inspect first.", thinkingSignature: "signature" }, partial.content[1]!, tool] };
  stream.push({ type: "thinking_end", contentIndex: 0, content: "Inspect first.", partial });
  stream.push({ type: "toolcall_delta", contentIndex: 2, delta: "xture", partial });
  await until(() => streamedPath() === "fixture");
  assert.deepEqual(instance.state.streamingMessage?.content, partial.content);
  stream.push({ type: "toolcall_end", contentIndex: 2, toolCall: tool, partial });
  const message = { ...partial, stopReason: "toolUse" as const };
  stream.push({ type: "done", reason: "toolUse", message }); stream.end(message);
  await run;
  assert.equal(executed, 1);
  assert.deepEqual(deltas, [
    { type: "thinking_delta", index: 0, delta: "Inspect first." },
    { type: "text_delta", index: 1, delta: "I will inspect. " },
    { type: "text_delta", index: 0, delta: "Finished." },
  ]);
});

for (const scenario of ["safe", "unsafe"]) {
  test(`SIGKILL recovery observes ${scenario} replay and releases ownership`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-"));
    const children: ChildProcess[] = [];
    t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); });
    const first = worker(directory, scenario, "initial"); children.push(first);
    await message(first, "checkpoint");
    const concurrent = agent(path.join(directory, "session.sqlite")).instance;
    await assert.rejects(() => concurrent.open(), /already has an execution owner/);
    const exited = once(first, "exit"); first.kill("SIGKILL"); await exited;
    const resumed = worker(directory, scenario, "resume"); children.push(resumed);
    const result = message(resumed, "recovered-result");
    const done = await message(resumed, "done");
    assert.equal(done.text, "Recovered answer");
    assert.equal((await result).result?.isError, scenario === "unsafe");
    await once(resumed, "exit");
    if (scenario === "safe") assert.equal(await readFile(path.join(directory, "writes.txt"), "utf8"), "write\n");
    assert.equal(await readFile(path.join(directory, "barriers.txt"), "utf8"), scenario === "safe" ? "attempt\nattempt\n" : "attempt\n");
  });
}

for (const phase of ["resume", "attach"]) {
  test(`busy admission preserves pending work and a ${phase} can complete it without poisoning retries`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-busy-admission-"));
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    });
    const first = worker(directory, "safe", "initial"); children.push(first);
    await message(first, "checkpoint");
    const killed = once(first, "exit"); first.kill("SIGKILL"); await killed;
    const rejected = worker(directory, "safe", "reject"); children.push(rejected);
    assert.deepEqual(await message(rejected, "rejected"), { type: "rejected", message: "Conversation 1 is busy", calls: 0 });
    await once(rejected, "exit");
    const resumed = worker(directory, "safe", phase); children.push(resumed);
    const done = await message(resumed, "done");
    assert.equal(done.text, "Recovered answer"); assert.equal(done.calls, 1);
    await once(resumed, "exit");
    assert.equal(await readFile(path.join(directory, "writes.txt"), "utf8"), "write\n");
    assert.equal(await readFile(path.join(directory, "barriers.txt"), "utf8"), "attempt\nattempt\n");
    const retried = worker(directory, "safe", "retry-rejected"); children.push(retried);
    const retry = await message(retried, "done");
    assert.equal(retry.errorMessage, undefined); assert.equal(retry.calls, 1);
    await once(retried, "exit");
  });
}

test("a completed request replays its answer and billing identity without another model call", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-dedupe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.sqlite");
  const billing: string[][] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { instance, faux } = agent(file);
    faux.setResponses([ai.fauxAssistantMessage("Only once")]);
    instance.requestId = "same-input";
    const ids: string[] = [], text: string[] = [];
    instance.subscribe(event => {
      const record = event as unknown as { type: string; recordId: string };
      if (record.type === "project_usage") ids.push(record.recordId);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") text.push(event.assistantMessageEvent.delta);
    });
    try { await instance.prompt("Hello"); } finally { await instance.close(); }
    assert.equal(text.join(""), "Only once"); billing.push(ids);
    assert.equal(faux.state.callCount, attempt === 0 ? 1 : 0);
  }
  assert.equal(billing[0]!.length, 1); assert.deepEqual(billing[1], billing[0]);
});

test("a completed request replays only its own answer after later turns", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-range-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { instance, faux } = agent(path.join(directory, "session.sqlite"));
  t.after(() => instance.close());
  faux.setResponses([ai.fauxAssistantMessage("First"), ai.fauxAssistantMessage("Second")]);
  instance.requestId = "first"; await instance.prompt("One");
  instance.requestId = "second"; await instance.prompt("Two");
  const text: string[] = [];
  instance.subscribe(event => { if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") text.push(event.assistantMessageEvent.delta); });
  instance.requestId = "first"; await instance.prompt("One");
  assert.equal(text.join(""), "First"); assert.equal(faux.state.callCount, 2);
});

test("initial transcript seeding cannot overwrite an existing durable history", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-seed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.sqlite");
  const first = agent(file);
  first.instance.requestId = "original";
  first.faux.setResponses([ai.fauxAssistantMessage("Original answer")]);
  try { await first.instance.prompt("Original input"); } finally { await first.instance.close(); }
  const { instance, faux } = agent(file);
  t.after(() => instance.close());
  instance.state.messages = [{ role: "user", content: "Stale host history", timestamp: 1 }];
  instance.requestId = "next";
  let messages: readonly ai.Message[] = [];
  faux.setResponses([request => {
    messages = request.messages;
    return ai.fauxAssistantMessage("Next answer");
  }]);
  await instance.prompt("Next input");
  assert.ok(messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Original answer")));
  assert.equal(messages.some(message => message.content === "Stale host history"), false);
});

for (const storage of ["memory", "sqlite"]) test(`a parked unsafe tool resumes its original intent with ${storage} storage`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { instance, faux } = agent(storage === "sqlite" ? path.join(directory, "session.sqlite") : undefined);
  let calls = 0;
  instance.state.tools = [{ name: "write", label: "Write", description: "Test", parameters: ai.Type.Object({}),
    execute: async () => { calls++; return { content: [{ type: "text", text: "Written" }], details: {} }; } }];
  instance.beforeToolCall = async () => ({ block: true, reason: "Waiting", pause: new HarnessError({ type: "user_input_required", message: "Approve?" }) });
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("write", {}, { id: "original-call" })], { stopReason: "toolUse" })]);
  instance.requestId = "approval-run";
  await instance.prompt("Write"); assert.equal(calls, 0);
  await instance.open();
  assert.equal(await instance.canCompact(), false);
  const previous = instance.state.messages;
  instance.reset();
  await assert.rejects(() => instance.checkpoint(), /Cannot replace agent context/);
  instance.state.messages = previous;
  instance.beforeToolCall = undefined;
  faux.setResponses([ai.fauxAssistantMessage("Done")]);
  try { await instance.prompt("Write"); assert.equal(calls, 1); }
  finally { await instance.close(); }
});

for (const storage of ["memory", "sqlite"]) test(`reused call ids require separate approvals and retain their original approval on ${storage} recovery`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-reused-approval-"));
  const { instance, faux } = agent(storage === "sqlite" ? path.join(directory, "session.sqlite") : undefined);
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  let calls = 0;
  instance.state.tools = [{ name: "write", label: "Write", description: "Test", parameters: ai.Type.Object({}),
    execute: async () => { calls++; return { content: [{ type: "text", text: "Written" }], details: {} }; } }];
  const approved = new Set<string>(), pending: string[] = [];
  instance.beforeToolCall = async ({ toolCall }) => {
    if (approved.has(toolCall.id)) return;
    pending.push(toolCall.id);
    return { block: true, reason: "Waiting", pause: new HarnessError({ type: "user_input_required", message: "Approve?" }) };
  };
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall("write", {}, { id: "reused" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxToolCall("write", {}, { id: "reused" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("Done"),
  ]);
  instance.requestId = "approval-run";
  await instance.prompt("Write twice");
  assert.equal(calls, 0); assert.equal(pending.length, 1);
  approved.add(pending[0]!);
  await instance.prompt("Write twice");
  assert.equal(calls, 1); assert.equal(pending.length, 2);
  assert.notEqual(pending[0], pending[1]);
  approved.add(pending[1]!);
  await instance.prompt("Write twice");
  assert.equal(calls, 2); assert.equal(pending.length, 2);
  assert.equal(faux.state.callCount, 3);
});

test("SIGKILL during a partial answer continues committed text without repeating it or executing partial calls", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-stream-"));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const first = worker(directory, "stream", "initial"); children.push(first);
  await message(first, "checkpoint");
  const exited = once(first, "exit"); first.kill("SIGKILL"); await exited;
  const interrupted = worker(directory, "stream", "reinterrupt"); children.push(interrupted);
  const firstRequest = message(interrupted, "recovered-request");
  await message(interrupted, "checkpoint");
  await firstRequest;
  const interruptedExit = once(interrupted, "exit"); interrupted.kill("SIGKILL"); await interruptedExit;
  const resumed = worker(directory, "stream", "resume"); children.push(resumed);
  const request = message(resumed, "recovered-request");
  const done = await message(resumed, "done");
  const messages = (await request).messages as ai.Message[];
  assert.ok(messages.some(value => value.role === "assistant" && value.content.some(block => block.type === "text" && block.text === "Committed prefix. ")));
  assert.ok(messages.some(value => value.role === "assistant" && value.content.some(block => block.type === "text" && block.text === "Continued ")));
  assert.match(String(messages.at(-1)?.content), /agent host restarted/);
  assert.equal(messages.some(value => value.role === "assistant" && value.content.some(block => block.type === "toolCall")), false);
  assert.equal(done.text, "Committed prefix. Continued answer.");
  assert.deepEqual(done.tools, []);
  await once(resumed, "exit");
  const replay = worker(directory, "stream", "replay"); children.push(replay);
  const replayed = await message(replay, "done");
  assert.equal(replayed.text, done.text); assert.equal(replayed.calls, 0);
  await once(replay, "exit");
});

test("process recovery and transport continuations share the persisted continuation budget", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-budget-"));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const first = worker(directory, "stream", "initial"); children.push(first);
  await message(first, "checkpoint");
  const exited = once(first, "exit"); first.kill("SIGKILL"); await exited;
  const resumed = worker(directory, "stream", "budget"); children.push(resumed);
  const done = await message(resumed, "done");
  assert.equal(done.calls, 10);
  assert.match(String(done.errorMessage), /cut off mid-answer 11 times/);
  await once(resumed, "exit");
});

test("cancelling a parked conversation settles its tasks without replaying tools", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(agentConversationDirectory(directory, "conversation"), "session.sqlite");
  const { instance, faux } = agent(file);
  let calls = 0;
  instance.state.tools = [{ name: "write", label: "Write", description: "Test", parameters: ai.Type.Object({}),
    execute: async () => { calls++; return { content: [], details: {} }; } }];
  instance.beforeToolCall = async () => ({ block: true, reason: "Waiting", pause: new HarnessError({ type: "user_input_required", message: "Approve?" }) });
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("write", {})], { stopReason: "toolUse" })]);
  instance.requestId = "parked"; await instance.prompt("Write"); await instance.close();
  await cancelAgentConversation({ agentStoreDir: directory, conversationId: "conversation" });
  const reopened = agent(file);
  reopened.faux.setResponses([ai.fauxAssistantMessage("New answer")]); reopened.instance.requestId = "new-input";
  try { await reopened.instance.prompt("Hello"); assert.equal(reopened.instance.state.errorMessage, undefined); }
  finally { await reopened.instance.close(); }
  assert.equal(calls, 0); assert.equal(reopened.faux.state.callCount, 1);
});

test("a failing observer terminates the prompt and releases ownership", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-durable-observer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.sqlite");
  const { instance, faux } = agent(file);
  instance.requestId = "failed-observer";
  faux.setResponses([ai.fauxAssistantMessage("Answer")]);
  instance.subscribe(() => { throw new Error("projection unavailable"); });
  await assert.rejects(() => instance.prompt("Hello"), /projection unavailable/);
  await instance.close().catch(() => undefined);
  const reopened = agent(file);
  try {
    await reopened.instance.open();
    assert.equal(await reopened.instance.canCompact(), true);
    reopened.instance.requestId = "failed-observer";
    await reopened.instance.prompt("Hello");
    assert.equal(reopened.instance.state.errorMessage, "projection unavailable");
    assert.equal(reopened.faux.state.callCount, 0);
    reopened.faux.setResponses([ai.fauxAssistantMessage("New answer")]);
    reopened.instance.requestId = "new-input";
    await reopened.instance.prompt("Try again");
    assert.equal(reopened.instance.state.errorMessage, undefined);
    assert.equal(reopened.faux.state.callCount, 1);
  } finally { await reopened.instance.close(); }
});

test("tools retain argument repair, error results, structured schemas, usage and termination", async t => {
  const { instance, faux } = agent();
  t.after(() => instance.close());
  let executed = 0;
  const usage = ai.fauxAssistantMessage("").usage;
  instance.state.tools = [{
    name: "structured", label: "Structured", description: "Test", replay: "never",
    parameters: ai.Type.Object({ value: ai.Type.Number() }),
    outputSchema: ai.Type.Object({ accepted: ai.Type.Boolean() }),
    prepareArguments: () => ({ value: 42 }),
    execute: async (_id, args) => {
      assert.deepEqual(args, { value: 42 }); executed++;
      return { content: [ai.fauxText("rejected")], details: { code: "rejected" },
        structuredContent: { accepted: false }, usage, isError: true, terminate: true };
    },
  }];
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("structured", { value: "42" })], { stopReason: "toolUse" })]);
  await instance.prompt("Use the tool");
  const result = instance.state.messages.find(message => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  if (result?.role !== "toolResult") return;
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, { code: "rejected" });
  assert.deepEqual(result.usage, usage);
  assert.equal(executed, 1);
  assert.equal(faux.state.callCount, 1, "terminate prevents a follow-up model request");
});

test("tool progress preserves both content and details before completion", { timeout: 10_000 }, async t => {
  const { instance, faux } = agent();
  t.after(() => instance.close());
  const partial = { content: [ai.fauxText("Working")], details: { step: 1 } };
  let progressSeen!: () => void;
  const observed = new Promise<void>(resolve => { progressSeen = resolve; });
  instance.subscribe(event => {
    if (event.type === "tool_execution_update") {
      assert.deepEqual(event.partialResult, partial);
      progressSeen();
    }
  });
  instance.state.tools = [{ name: "progress", label: "Progress", description: "Test", parameters: ai.Type.Object({}),
    execute: async (_id, _args, _signal, update) => {
      update?.(partial);
      await observed;
      return { content: [ai.fauxText("Done")], details: { step: 2 }, terminate: true };
    } }];
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("progress", {})], { stopReason: "toolUse" })]);
  await instance.prompt("Show progress");
  const result = instance.state.messages.find(message => message.role === "toolResult");
  assert.deepEqual(result?.role === "toolResult" && result.details, { step: 2 });
});
