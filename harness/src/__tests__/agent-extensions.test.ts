import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as ai from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTask, GenerationTask, Harness, hook, MemoryStorage, ToolTask } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableAgent } from "../agent/durable-agent";
import { agentConversationDirectory, cancelAgentConversation, exportAgentDatabase, importAgentDatabase, openAgentStorage } from "../agent/storage";
import type { AgentSessionOptions, AgentSessionSnapshot } from "../agent/session-types";
import type { AgentTool } from "../agent/types";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createMcpToolCatalog } from "../agent/mcp/catalog";
import { AgentExtensionResources, mergeAgentRegistries } from "../agent/extensions";
import type { AgentStorageFactory } from "../agent/storage";

const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (!check()) { if (Date.now() > end) throw new Error("Extension state did not settle."); await pause(10); }
}
function agent(session: AgentSessionOptions, databasePath?: string, storage?: AgentStorageFactory) {
  const provider = ai.fauxProvider({ models: [{ id: "test", contextWindow: 100_000, maxTokens: 1000 }] });
  const models = ai.createModels(); models.setProvider(provider.provider);
  const lease = latch();
  const instance = new DurableAgent({ models, databasePath, storage, session, sessionLease: lease.promise, initialState: {
    systemPrompt: "Extension test", model: models.getModel("faux", "test")!, thinkingLevel: "off", messages: [], tools: [],
  } });
  let snapshot: AgentSessionSnapshot | undefined;
  instance.subscribe(event => { const value = event as unknown as { type: string; snapshot: AgentSessionSnapshot }; if (value.type === "project_session") snapshot = value.snapshot; });
  instance.requestId = "initial";
  return { instance, provider, lease, snapshot: () => snapshot! };
}
const tool = (name: string, execute: AgentTool["execute"]): AgentTool => ({ name, description: name, label: name, replay: "safe", parameters: ai.Type.Object({}), execute });

test("custom tasks checkpoint timers, join dependencies, deduplicate commands and run abort cleanup", async t => {
  const registry = createRegistry(); let cleaned = 0;
  const timer = defineTask<{ wakeAt: number }, { phase: "sleep"; wakeAt: number }, string>({ name: "test.timer", version: 1,
    initial: input => ({ phase: "sleep", wakeAt: input.wakeAt }), phases: { sleep: async (task, runtime, ctx) => {
      await runtime.sleep(task.state.checkpoint.wakeAt, ctx);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "awake" } }), ctx);
    } }, abort: async (_task, runtime, ctx) => { cleaned++; await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
  const joined = defineTask<{ wakeAt: number }, { phase: "start" } | { phase: "joined"; child: number }, string>({ name: "test.join", version: 1,
    initial: () => ({ phase: "start" }), phases: {
      start: async (task, runtime, ctx) => { await runtime.commit(async tx => {
        const child = await tx.createTask(timer, task.input, { ownership: { kind: "task", taskId: task.id } });
        return { status: "waiting", on: [child], policy: "allSettled", checkpoint: { phase: "joined", child } };
      }, ctx); },
      joined: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "joined" } }), ctx); },
    }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
  registry.install(defineExtension({ name: "custom", tasks: [timer, joined] }));
  const { instance, provider, lease, snapshot } = agent({ registry }); provider.setResponses([ai.fauxAssistantMessage("Ready")]);
  const run = instance.prompt("Start"); t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  const command = { type: "task" as const, requestId: "timer", name: "test.join", input: { wakeAt: Date.now() + 500 }, background: true };
  for (const input of [undefined, { value: NaN }, { value: () => {} }, { value: "x".repeat(256 * 1024) }]) {
    await assert.rejects(() => instance.control({ ...command, requestId: "invalid", input: input as never }), /JSON values|too large/);
  }
  const receipt = await instance.control(command); assert.deepEqual(await instance.control(command), receipt);
  await until(() => snapshot().tasks.some(task => task.wakeAt === command.input.wakeAt));
  assert.ok(snapshot().tasks.some(task => task.blockedOn.length));
  assert.ok(snapshot().tasks.some(task => task.checkpoint && task.definitionVersion === 1));
  await until(() => snapshot().history.some(task => task.id === receipt.taskId && task.status === "completed"));
  const cancel = await instance.control({ type: "task", requestId: "cancel-timer", name: "test.timer", input: { wakeAt: Date.now() + 60_000 }, background: true });
  await instance.control({ type: "cancel", requestId: "stop-timer", scope: "task", taskId: cancel.taskId });
  assert.equal(cleaned, 1);
});

test("task commands capture their JSON input before waiting and reject non-JSON values before reserving request ids", async t => {
  const registry = createRegistry(); const inputs: unknown[] = [];
  registry.install(defineExtension({ name: "capture", tasks: [defineTask<{ value: string[] }, { phase: "capture" }, null>({
    name: "test.capture", version: 1, initial: () => ({ phase: "capture" }), phases: { capture: async (task, api, ctx) => {
      inputs.push(task.input);
      await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
    } },
    abort: async (_task, api, ctx) => { await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
  })] }));
  const { instance, provider, lease, snapshot } = agent({ registry }); provider.setResponses([ai.fauxAssistantMessage("Ready")]);
  const run = instance.prompt("Start"); t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  const command = { type: "task" as const, requestId: "captured", name: "test.capture", input: { value: ["original"] }, background: true };
  const pending = instance.control(command);
  command.requestId = "mutated"; command.input.value[0] = "mutated";
  const receipt = await pending;
  assert.equal(receipt.requestId, "captured");
  await until(() => snapshot().history.some(task => task.id === receipt.taskId));
  assert.deepEqual(inputs, [{ value: ["original"] }]);
  assert.deepEqual(await instance.control({ ...command, requestId: "captured", input: { value: ["original"] } }), receipt);
  for (const [index, input] of [new Date(), new Map(), { value: [undefined] }, { toJSON: () => ({ value: ["converted"] }) }].entries()) {
    const requestId = `strict-${index}`;
    await assert.rejects(() => instance.control({ ...command, requestId, input: input as never }), /JSON/);
    await instance.control({ ...command, requestId, input: { value: ["valid"] } });
  }
});

test("registry phases pin in-flight code and missing or incompatible task definitions block until reinstalled", async t => {
  const registry = createRegistry(), gate = latch(), entered = latch(); const versions: string[] = [];
  const definition = (version: number) => defineTask<null, { phase: "first" | "next" }, string>({ name: "test.hot", version,
    initial: () => ({ phase: "first" }), phases: {
      first: async (_task, runtime, ctx) => { entered.resolve(); await gate.promise; versions.push(`first:${version}`); await runtime.commit(() => ({ status: "waiting", on: [], policy: "allSettled", checkpoint: { phase: "next" } }), ctx); },
      next: async (_task, runtime, ctx) => { versions.push(`next:${version}`); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "updated" } }), ctx); },
    }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
  const first = defineExtension({ name: "hot", tasks: [definition(2)] }); registry.install(first);
  const { instance, provider, lease, snapshot } = agent({ registry }); provider.setResponses([ai.fauxAssistantMessage("Ready")]);
  const run = instance.prompt("Start"); t.after(async () => { gate.resolve(); lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  const receipt = await instance.control({ type: "task", requestId: "hot", name: "test.hot", input: null, background: true });
  await entered.promise;
  registry.uninstall(first); gate.resolve();
  await until(() => snapshot().tasks.some(task => task.id === receipt.taskId && task.blockedReason === "missing_task"));
  registry.install(defineExtension({ name: "hot", tasks: [definition(1)] }));
  await until(() => snapshot().tasks.some(task => task.blockedReason === "task_too_old"));
  registry.install(defineExtension({ name: "hot", tasks: [definition(2)] }));
  await until(() => snapshot().history.some(task => task.id === receipt.taskId));
  assert.deepEqual(versions, ["first:2", "next:2"]);
});

test("registry hook publications apply to later generations and reserved or duplicate definitions are rejected", async t => {
  const registry = createRegistry(); const observed: string[] = [];
  const extension = (label: string) => defineExtension({ name: "observed", hooks: [hook(GenerationTask, { beforeRequest: () => { observed.push(label); } })] });
  registry.install(extension("first"));
  const { instance, provider, lease, snapshot } = agent({ registry }); provider.setResponses([ai.fauxAssistantMessage("One"), ai.fauxAssistantMessage("Two")]);
  const run = instance.prompt("Start"); t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  registry.install(extension("next"));
  await instance.control({ type: "submit", requestId: "second", prompt: "Next", mode: "followUp" });
  await until(() => snapshot().turns.some(turn => turn.requestId === "second" && turn.status === "done"));
  assert.deepEqual(observed, ["first", "next"]);
  const internal = createRegistry(), application = createRegistry();
  application.install(defineExtension({ name: "steamharness.forged" }));
  assert.throws(() => mergeAgentRegistries(internal, application).snapshot(), /Reserved/);
  internal.install(defineExtension({ name: "one", tools: [{ name: "same", description: "one", parameters: {}, execute: async () => ({ output: [] }) }] }));
  internal.install(defineExtension({ name: "two", tools: [{ name: "same", description: "two", parameters: {}, execute: async () => ({ output: [] }) }] }));
  assert.throws(() => mergeAgentRegistries(internal).snapshot(), /Duplicate/);
});

test("Code Mode runs in QuickJS and every nested call passes the ordinary approval hooks", async t => {
  let executed = 0;
  const { instance, provider, lease, snapshot } = agent({ codeMode: {}, nativeTools: [{ name: "secret", description: "Needs permission", parameters: ai.Type.Object({}), replay: "safe",
    execute: async () => { executed++; return { output: [{ type: "text", text: "secret" }] }; } }] });
  const checked: string[] = [];
  instance.beforeToolCall = async ({ toolCall }) => { checked.push(toolCall.name); return toolCall.name === "secret" ? { block: true, reason: "Permission denied" } : undefined; };
  provider.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("codemode", { code: "text(typeof process); text(typeof models); try { await tools.secret({}); } catch (e) { text(e.message); }" })], { stopReason: "toolUse" }),
    request => { assert.match(JSON.stringify(request.messages), /undefined/); assert.match(JSON.stringify(request.messages), /Permission denied/); return ai.fauxAssistantMessage("Done"); }]);
  const run = instance.prompt("Run script"); t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  assert.equal(executed, 0); assert.deepEqual(checked, ["codemode", "secret"]);
  assert.ok(snapshot().history.some(task => task.toolName === "secret" && task.parentId));
  assert.match(snapshot().history.find(task => task.toolName === "codemode")!.script!, /typeof process/);
});

test("Core approval checks the final arguments after project hooks", async t => {
  const registry = createRegistry(); let executed = 0;
  registry.install(defineExtension({ name: "rewrite", hooks: [hook(ToolTask, { beforeTool: call => ({ arguments: { ...call.arguments, path: "requires-approval" } }) })] }));
  const { instance, provider, lease, snapshot } = agent({ registry });
  instance.state.tools = [{ ...tool("read", async () => { executed++; return { content: [], details: {} }; }), parameters: ai.Type.Object({ path: ai.Type.String() }) }];
  instance.beforeToolCall = async ({ args }) => {
    assert.deepEqual(args, { path: "requires-approval" }); return { block: true, reason: "Final arguments denied" };
  };
  provider.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("read", { path: "original" })], { stopReason: "toolUse" }), request => {
    assert.match(JSON.stringify(request.messages), /Final arguments denied/); return ai.fauxAssistantMessage("Blocked");
  }]);
  const run = instance.prompt("Read"); t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done")); assert.equal(executed, 0);
});

test("tool search only discovers authorized catalogs, persists schemas and refuses drift after reopening", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-catalog-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.sqlite"); let opened = 0, closed = 0, called = 0, changed = false;
  const catalog = { id: "permitted", allowedTools: ["catalog_read"], open: async () => { opened++; return {
    tools: [tool("catalog_read", async () => { called++; return { content: [{ type: "text", text: "Found" }], details: {} }; })].map(item => ({ ...item, description: changed ? "Different" : item.description })),
    close: async () => { closed++; },
  }; } };
  const first = agent({ toolSearch: { catalogs: [catalog] } }, file);
  first.provider.setResponses([request => {
    assert.equal(opened, 0); assert.doesNotMatch(JSON.stringify(request.messages), /"name":"catalog_read"/);
    return ai.fauxAssistantMessage([ai.fauxToolCall("tool_search", { query: "catalog read" })], { stopReason: "toolUse" });
  }, ai.fauxAssistantMessage([ai.fauxToolCall("catalog_read", {})], { stopReason: "toolUse" }), ai.fauxAssistantMessage("Done")]);
  const run = first.instance.prompt("Find tools");
  await until(() => first.snapshot()?.turns.some(turn => turn.status === "done"));
  assert.equal(opened, 1); assert.equal(called, 1); assert.deepEqual(first.snapshot().resources?.catalogs[0]?.loaded, ["catalog_read"]);
  first.lease.resolve(); await run; await first.instance.close(); assert.equal(closed, 1);
  changed = true;
  const next = agent({ toolSearch: { catalogs: [catalog] } }, file); next.instance.requestId = "next";
  next.provider.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("catalog_read", {})], { stopReason: "toolUse" }), request => {
    assert.match(JSON.stringify(request.messages), /Tool catalog definition changed/); return ai.fauxAssistantMessage("Blocked");
  }]);
  const reopened = next.instance.prompt("Read again"); t.after(async () => { next.lease.resolve(); await reopened; await next.instance.close(); });
  await until(() => next.snapshot()?.turns.some(turn => turn.requestId === "next" && turn.status === "done"));
  assert.equal(opened, 2); assert.equal(called, 1); assert.equal(closed, 2);
  assert.equal(next.snapshot().resources?.catalogs[0]?.state, "failed");
});

test("predeclared catalogs retain their durable definition when both host and server descriptors change", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-declared-catalog-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.sqlite"); let called = 0, closed = 0;
  const catalog = (description: string) => {
    const entry = { ...tool("declared_read", async () => { called++; return { content: [], details: {} }; }), description };
    return { id: "declared", tools: [entry], open: async () => ({ tools: [entry], close: async () => { closed++; } }) };
  };
  const first = agent({ toolSearch: { catalogs: [catalog("Original definition")] } }, file);
  first.provider.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("tool_search", { query: "declared read" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxToolCall("declared_read", {})], { stopReason: "toolUse" }), ai.fauxAssistantMessage("Done")]);
  const run = first.instance.prompt("Read");
  try { await until(() => first.snapshot()?.turns.some(turn => turn.status === "done")); }
  finally { first.lease.resolve(); await run; await first.instance.close(); }
  assert.equal(called, 1); assert.equal(closed, 1);
  const same = agent({ toolSearch: { catalogs: [catalog("Original definition")] } }, file); same.instance.requestId = "same";
  same.provider.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("declared_read", {})], { stopReason: "toolUse" }), ai.fauxAssistantMessage("Unchanged")]);
  const compatible = same.instance.prompt("Read with the original definition");
  try { await until(() => same.snapshot()?.turns.some(turn => turn.requestId === "same" && turn.status === "done")); }
  finally { same.lease.resolve(); await compatible; await same.instance.close(); }
  assert.equal(called, 2); assert.equal(closed, 2);
  const next = agent({ toolSearch: { catalogs: [catalog("Changed definition")] } }, file); next.instance.requestId = "next";
  let resumedMessages = "";
  next.provider.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("declared_read", {})], { stopReason: "toolUse" }), request => {
    resumedMessages = JSON.stringify(request.messages); return ai.fauxAssistantMessage("Blocked");
  }]);
  const reopened = next.instance.prompt("Read again"); t.after(async () => { next.lease.resolve(); await reopened; await next.instance.close(); });
  await until(() => next.snapshot()?.turns.some(turn => turn.requestId === "next" && turn.status === "done"));
  assert.equal(called, 2); assert.equal(closed, 3);
  assert.equal(next.snapshot().resources?.catalogs[0]?.state, "failed");
  assert.match(resumedMessages, /Tool catalog definition changed/);
});

test("catalog ids that match object prototype keys open without inherited manifests", async () => {
  const entry = tool("catalog_read", async () => ({ content: [], details: {} }));
  for (const predeclared of [false, true]) {
    const { instance } = agent({ toolSearch: { catalogs: [{ id: "constructor", ...(predeclared ? { tools: [entry] } : { allowedTools: [entry.name] }),
      open: async () => ({ tools: [entry] }) }] } });
    try { await instance.open(); }
    finally { await instance.close(); }
  }
});

test("MCP catalog defers a real stdio handshake and restricts its tool list", async () => {
  const catalog = await createMcpToolCatalog({ definition: { id: "echo", command: [process.execPath, path.join(import.meta.dirname, "fixtures/mcp-echo-server.mjs")] }, allowedTools: ["echo"] });
  assert.equal(catalog.tools, undefined); assert.deepEqual(catalog.allowedTools, ["echo_echo"]);
  const connection = await catalog.open();
  try {
    assert.deepEqual(connection.tools.map(tool => tool.name), ["echo_echo"]);
    const result = await connection.tools[0]!.execute("test", { text: "hello" });
    assert.deepEqual(result.content, [{ type: "text", text: "echo:hello" }]);
  } finally { await connection.close?.(); }
});

test("remote environment tools target the supplied filesystem and always clean up", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-environment-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let cleaned = 0, opened = 0;
  const env = new NodeExecutionEnv({ cwd: directory }); const cleanup = env.cleanup.bind(env);
  env.cleanup = async ctx => { cleaned++; await cleanup(ctx); };
  const { instance, provider, lease, snapshot } = agent({ environment: { id: env.id, label: "Remote fixture", open: async () => { opened++; return env; } } });
  instance.state.tools = [tool("write", async () => { throw new Error("Local fallback is forbidden"); })];
  provider.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "remote.txt", content: "remote" })], { stopReason: "toolUse" }), ai.fauxAssistantMessage("Done")]);
  const run = instance.prompt("Write remotely"); await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  assert.equal(opened, 1); assert.equal(snapshot().resources?.environment.label, "Remote fixture");
  lease.resolve(); await run; await instance.close(); assert.equal(cleaned, 1);
  assert.equal(await readFile(path.join(directory, "remote.txt"), "utf8"), "remote");
});

test("environment identity mismatches close the resource and reopening cannot change the durable target", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-environment-id-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let cleaned = 0;
  const environment = new NodeExecutionEnv({ cwd: directory });
  environment.cleanup = async () => { cleaned++; };
  const resources = new AgentExtensionResources({ environment: { id: "another-host", label: "Other", open: () => environment } });
  await assert.rejects(() => resources.environment({ conversationId: 1 }, BACKGROUND_CONTEXT), /identity/);
  assert.equal(cleaned, 1); await resources.close(BACKGROUND_CONTEXT); assert.equal(cleaned, 1);
  const file = path.join(directory, "session.sqlite"), first = agent({}, file);
  first.provider.setResponses([ai.fauxAssistantMessage("Saved")]); const run = first.instance.prompt("Save");
  await until(() => first.snapshot()?.turns.some(turn => turn.status === "done"));
  first.lease.resolve(); await run; await first.instance.close();
  const next = agent({ environment: { id: "another-host", label: "Other", open: () => environment } }, file);
  await assert.rejects(() => next.instance.prompt("Reopen"), /environment identity changed/);
  await next.instance.close();
  const owner = await openAgentStorage(file); await owner.storage.close(BACKGROUND_CONTEXT); owner.release();
});

test("predeclared catalogs connect only on use, retry connection failures and close a late connection once", async t => {
  let attempts = 0, closed = 0;
  const entry = tool("lazy_read", async () => ({ content: [{ type: "text", text: "Read" }], details: {} }));
  const { instance, provider, lease, snapshot } = agent({ toolSearch: { catalogs: [{ id: "lazy", tools: [entry], open: async () => {
    if (++attempts === 1) throw new Error("Temporary connection failure");
    return { tools: [entry], close: async () => { closed++; } };
  } }] } });
  provider.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("tool_search", { query: "lazy read" })], { stopReason: "toolUse" }),
    () => { assert.equal(attempts, 0); return ai.fauxAssistantMessage([ai.fauxToolCall("lazy_read", {})], { stopReason: "toolUse" }); },
    request => { assert.match(JSON.stringify(request.messages), /Temporary connection failure/); return ai.fauxAssistantMessage([ai.fauxToolCall("lazy_read", {})], { stopReason: "toolUse" }); },
    ai.fauxAssistantMessage("Done")]);
  const run = instance.prompt("Discover then retry");
  t.after(async () => { lease.resolve(); await run; await instance.close(); });
  await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  assert.equal(attempts, 2); lease.resolve(); await run; await instance.close(); assert.equal(closed, 1);
  const gate = latch(), opened = latch();
  const registry = createRegistry(), late = new AgentExtensionResources({ toolSearch: { catalogs: [{ id: "late", tools: [entry], open: async () => {
    opened.resolve(); await gate.promise; return { tools: [entry], close: async () => { closed++; } };
  } }] } });
  await late.install(registry, value => ({ name: value.name, description: value.description, parameters: {}, execute: async () => {
    const result = await value.execute("late", {}); return { output: result.content };
  } }));
  const invocation = registry.snapshot().tools().find(item => item.tool.name === entry.name)!.tool.execute({}, {} as never, BACKGROUND_CONTEXT);
  await opened.promise; const closing = late.close(BACKGROUND_CONTEXT); gate.resolve();
  await Promise.all([invocation, closing]); assert.equal(closed, 2);
});

test("custom storage closes before releasing its owner even when initialization fails", async () => {
  for (const fail of [false, true]) {
    const order: string[] = [], storage = new MemoryStorage();
    const close = storage.close.bind(storage); storage.close = async context => { order.push("close"); await close(context); };
    const factory: AgentStorageFactory = { label: "Custom", open: async () => ({ storage, release: async () => { order.push("release"); } }) };
    const registry = createRegistry(); if (fail) registry.install(defineExtension({ name: "steamharness.invalid" }));
    const { instance, provider, lease, snapshot } = agent({ registry }, undefined, factory);
    if (fail) await assert.rejects(() => instance.open(), /Reserved/);
    else {
      provider.setResponses([ai.fauxAssistantMessage("Ready")]); const run = instance.prompt("Open");
      await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
      assert.equal(snapshot().resources?.storage, "Custom"); lease.resolve(); await run;
    }
    await instance.close(); assert.deepEqual(order, ["close", "release"]);
  }
});

test("offline cancellation uses the supplied custom task definition for abort cleanup", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-offline-abort-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let cleaned = 0; const entered = latch();
  const definition = defineTask<null, { phase: "sleep" }, null>({
    name: "cleanup.timer", version: 1, initial: () => ({ phase: "sleep" }),
    phases: { sleep: async (_task, api, ctx) => { entered.resolve(); await api.sleep(Date.now() + 60_000, ctx); } },
    abort: async (_task, api, ctx) => { cleaned++; await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
  });
  const registry = createRegistry(); registry.install(defineExtension({ name: "cleanup", tasks: [definition] }));
  const file = path.join(agentConversationDirectory(directory, "custom"), "session.sqlite");
  const { storage, release } = await openAgentStorage(file);
  const harness = await Harness.open(storage, { registry, models: ai.createModels() }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    await root.commit(tx => tx.createTask(definition, null, { conversationId: root.id, ownership: { kind: "conversation" }, background: true }), BACKGROUND_CONTEXT);
    harness.resume(); await entered.promise;
  } finally { await harness.close(BACKGROUND_CONTEXT); release(); }
  assert.equal(cleaned, 0);
  await cancelAgentConversation({ agentStoreDir: directory, conversationId: "custom", registry });
  assert.equal(cleaned, 1);
});

for (const layout of ["shallow", "deep"] as const) test(`SQLite backup includes committed state, refuses a live owner and imports only into new paths (${layout})`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-backup-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = layout === "deep" ? path.join(root, ...Array.from({ length: 8 }, () => "nested directory with spaces and 中文")) : root;
  const file = path.join(directory, "source.sqlite"), copy = path.join(directory, "backup.sqlite"), restored = path.join(directory, "restored.sqlite");
  const { instance, provider, lease, snapshot } = agent({}, file); provider.setResponses([ai.fauxAssistantMessage("Persisted")]);
  const run = instance.prompt("Hello"); await until(() => snapshot()?.turns.some(turn => turn.status === "done"));
  await assert.rejects(() => openAgentStorage(file), /owner/);
  await assert.rejects(() => openAgentStorage(path.toNamespacedPath(file)), /owner/);
  await assert.rejects(() => exportAgentDatabase({ databasePath: file, destination: copy }), /owner/);
  lease.resolve(); await run; await instance.close();
  const reserved = path.join(directory, "reserved.sqlite"), destinationOwner = new DatabaseSync(path.toNamespacedPath(`${reserved}.owner`));
  destinationOwner.exec("BEGIN EXCLUSIVE");
  try {
    await assert.rejects(() => exportAgentDatabase({ databasePath: file, destination: reserved }), /owner/);
    await assert.rejects(() => readFile(reserved), { code: "ENOENT" });
  } finally { destinationOwner.close(); }
  await exportAgentDatabase({ databasePath: file, destination: copy });
  await assert.rejects(() => exportAgentDatabase({ databasePath: file, destination: copy }), /EEXIST/);
  await importAgentDatabase({ source: copy, databasePath: restored });
  await assert.rejects(() => importAgentDatabase({ source: copy, databasePath: restored }), /EEXIST/);
  const invalid = path.join(directory, "invalid.sqlite"); await writeFile(invalid, "not sqlite");
  await assert.rejects(() => exportAgentDatabase({ databasePath: invalid, destination: path.join(directory, "invalid-copy.sqlite") }));
  assert.ok(!(await readdir(directory)).some(file => file.endsWith(".tmp")));
  const reopened = agent({}, restored), replay = reopened.instance.prompt("Hello");
  try {
    await until(() => reopened.snapshot()?.turns.some(turn => turn.status === "done")); assert.equal(reopened.provider.state.callCount, 0);
    const opened = await openAgentStorage(copy); await opened.storage.close(BACKGROUND_CONTEXT); opened.release();
  } finally { reopened.lease.resolve(); await replay; await reopened.instance.close(); }
});
