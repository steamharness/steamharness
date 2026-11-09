import assert from "node:assert/strict";
import test from "node:test";
import * as ai from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { DurableAgent } from "../agent/durable-agent";
import { DEFAULT_AGENT_COMPACTION_SETTINGS } from "../agent/compaction";
import { createAgentRuntime, type AgentRuntimeInternalOptions } from "../agent/runtime";
import type { AgentContextUsage, AgentTool } from "../agent/types";
import type { AgentToolCatalog } from "../agent/extensions";
import { testAgentStorage } from "./runtime-test-storage";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("The lifecycle checkpoint did not settle.");
    await new Promise(done => setTimeout(done, 10));
  }
}
function provider() {
  const faux = ai.fauxProvider({ models: [{ id: "lifecycle", contextWindow: 100_000, maxTokens: 1000 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  return { faux, models };
}
const tool = (name: string, execute: AgentTool["execute"]): AgentTool => ({
  name, label: name, description: `Use ${name}`, parameters: ai.Type.Object({}), execute,
});
const output = (text: string) => ({ content: [ai.fauxText(text)], details: {} });
const call = (name: string, args = {}) => ai.fauxAssistantMessage([ai.fauxToolCall(name, args)], { stopReason: "toolUse" });
const run = async (runtime: Awaited<ReturnType<typeof createAgentRuntime>>, prompt: string) => {
  for await (const event of runtime.run({ prompt, errCode: 0, errMessage: "" })) void event;
};
async function runtime(options: Partial<AgentRuntimeInternalOptions> = {}) {
  const { faux, models } = provider();
  const instance = await createAgentRuntime({ models, provider: "faux", model: "lifecycle", retryDelayMs: 0, ...options });
  return { instance, faux };
}

for (const partial of [false, true]) for (const revoked of [false, true]) test(`reopening after request-time compaction reuses its summary and authorized loadout (partial=${partial}, revoked=${revoked})`, { timeout: 8000 }, async t => {
  const key = `context-lifecycle:${crypto.randomUUID()}`;
  let occupancy: AgentContextUsage | undefined, summaries = 0, effects = 0;
  const inspect = tool("inspect", async () => {
    effects++; occupancy = { used: 90_000, total: 100_000 }; return output("Saved file inspection");
  });
  const make = (options: Partial<ConstructorParameters<typeof DurableAgent>[0]> = {}) => {
    const { faux, models } = provider();
    models.completeSimple = async () => {
      summaries++; occupancy = undefined; return ai.fauxAssistantMessage("Compacted checkpoint: keep the file inspection and finish.");
    };
    const instance = new DurableAgent({ models, storage: testAgentStorage(key), session: {}, retryDelayMs: 0,
      compaction: DEFAULT_AGENT_COMPACTION_SETTINGS, initialState: { model: models.getModel("faux", "lifecycle")!,
        systemPrompt: "Continue the authorized workspace task.", thinkingLevel: "off", tools: [inspect], messages: [] }, ...options });
    instance.requestId = "original-request";
    return { instance, faux, models };
  };
  const suspended = latch(), reached = latch();
  const first = make({ sessionSuspend: suspended.promise, contextUsage: () => occupancy });
  first.instance.state.messages = [{ role: "user", content: "Old uncompressed history " + "x".repeat(40_000), timestamp: 1 },
    ai.fauxAssistantMessage("Earlier answer")];
  first.faux.setResponses([call(inspect.name)]);
  const originalStream = first.models.streamSimple.bind(first.models);
  let attempts = 0;
  first.models.streamSimple = (...args) => {
    if (++attempts !== 2) return originalStream(...args);
    const pending = ai.createAssistantMessageEventStream();
    if (partial) pending.push({ type: "text_delta", contentIndex: 0, delta: "Retained before restart",
      partial: ai.fauxAssistantMessage("Retained before restart", { stopReason: "pending" }) });
    args[2]?.signal?.addEventListener("abort", () => pending.end(), { once: true });
    reached.resolve();
    return pending;
  };
  const running = first.instance.prompt("Inspect and finish");
  t.after(async () => { suspended.resolve(); await running; await first.instance.close(); });
  await reached.promise;
  if (partial) await until(() => first.instance.state.streamingMessage?.content.some(block =>
    block.type === "text" && block.text.includes("Retained before restart")) === true);
  suspended.resolve(); await running; await first.instance.close();
  const second = make({ resumeSession: true, isToolEnabled: name => !revoked || name !== inspect.name });
  t.after(() => second.instance.close());
  const requests: ai.TranscriptContext[] = [];
  second.faux.setResponses([context => { requests.push(context); return ai.fauxAssistantMessage("Finished"); }]);
  await second.instance.prompt("Unused bootstrap input");
  assert.equal(second.instance.state.errorMessage, undefined);
  assert.equal(summaries, 1); assert.equal(effects, 1); assert.equal(requests.length, 1);
  const resumed = requests[0]!;
  assert.ok(JSON.stringify(resumed.messages).includes("Compacted checkpoint"));
  assert.ok(!JSON.stringify(resumed.messages).includes("Old uncompressed history"));
  assert.equal(ai.getCurrentTools(resumed.messages).some(item => item.name === inspect.name), !revoked);
  assert.equal(resumed.messages[0]?.role, "system");
  if (partial) assert.match(JSON.stringify(resumed.messages), /Retained before restart/);
});

test("host-disabled session and native tools are neither offered nor executed", async t => {
  let effects = 0;
  const disabled = new Set(["bash", "tool_search", "codemode", "update_plan", "subagent", "blocked_native"]);
  const f = await runtime({ isToolEnabled: name => !disabled.has(name), session: {
    toolSearch: {}, codeMode: {}, subagents: { tools: ["read"] },
    nativeTools: [{ name: "blocked_native", description: "Blocked native tool", parameters: ai.Type.Object({}),
      execute: async () => { effects++; return { output: [ai.fauxText("Should not execute")] }; } }],
  } });
  t.after(() => f.instance.close());
  const requests: ai.TranscriptContext[] = [];
  f.faux.setResponses([context => { requests.push(context); return call("blocked_native"); }, ai.fauxAssistantMessage("Finished")]);
  await run(f.instance, "Inspect the current tool loadout");
  assert.equal(effects, 0);
  assert.deepEqual(ai.getCurrentTools(requests[0]!.messages).filter(item => disabled.has(item.name)).map(item => item.name), []);
});

test("host-disabled tools discovered by a catalog stay unavailable", async t => {
  let effects = 0;
  const blocked = tool("blocked_catalog_tool", async () => { effects++; return output("Should not execute"); });
  const permitted = tool("permitted_catalog_tool", async () => output("Permitted"));
  const f = await runtime({ isToolEnabled: name => name !== blocked.name, session: { toolSearch: {} } });
  t.after(() => f.instance.close());
  f.instance.setExternalTools([], [{ id: "dynamic", allowedTools: [blocked.name, permitted.name],
    open: async () => ({ tools: [blocked, permitted] }) }]);
  const requests: ai.TranscriptContext[] = [];
  f.faux.setResponses([call("tool_search", { query: blocked.name }),
    context => { requests.push(context); return call(blocked.name); }, ai.fauxAssistantMessage("Finished")]);
  await run(f.instance, "Discover a catalog tool");
  assert.equal(effects, 0);
  assert.ok(!ai.getCurrentTools(requests[0]!.messages).some(item => item.name === blocked.name));
});

test("Code Mode cannot invoke a host-disabled native tool indirectly", async t => {
  let effects = 0;
  const f = await runtime({ isToolEnabled: name => name !== "blocked_nested", session: { codeMode: {}, nativeTools: [{
    name: "blocked_nested", description: "Blocked nested call", parameters: ai.Type.Object({}), callers: ["tools"],
    execute: async () => { effects++; return { output: [ai.fauxText("Should not execute")] }; },
  }] } });
  t.after(() => f.instance.close());
  f.faux.setResponses([call("codemode", { code: "try { await tools.blocked_nested({}); } catch (e) { text(String(e)); }" }), ai.fauxAssistantMessage("Finished")]);
  await run(f.instance, "Check nested tool authorization");
  assert.equal(effects, 0);
});

test("replacing external catalogs between turns refreshes closures, additions and removals without losing history", async t => {
  const effects: string[] = []; let closed = 0;
  const original = tool("catalog_read", async () => { effects.push("old"); return output("Old context"); });
  const rebound = { ...original, execute: async () => { effects.push("new"); return output("Current context"); } };
  const added = tool("catalog_added", async () => { effects.push("added"); return output("New tool"); });
  const catalog = (tools: AgentTool[]): AgentToolCatalog => ({ id: "workspace", tools,
    open: async () => ({ tools, close: async () => { closed++; } }) });
  const f = await runtime({ session: { toolSearch: {} } }); t.after(() => f.instance.close());
  f.instance.setExternalTools([], [catalog([original])]);
  f.faux.setResponses([call("tool_search", { query: original.name, limit: 1 }), call(original.name), ai.fauxAssistantMessage("First result retained")]);
  await run(f.instance, "First turn");
  f.instance.setExternalTools([], [catalog([rebound, added])]);
  const requests: ai.TranscriptContext[] = [];
  f.faux.setResponses([call("tool_search", { query: added.name, limit: 1 }),
    context => { requests.push(context); return ai.fauxAssistantMessage([ai.fauxToolCall(original.name, {}), ai.fauxToolCall(added.name, {})], { stopReason: "toolUse" }); },
    ai.fauxAssistantMessage("Second result retained")]);
  await run(f.instance, "Second turn");
  assert.deepEqual(effects, ["old", "new", "added"]);
  assert.equal(closed, 1);
  assert.match(JSON.stringify(requests[0]!.messages), /First result retained/);
  assert.ok(ai.getCurrentTools(requests[0]!.messages).some(item => item.name === added.name));
  f.instance.setExternalTools([], []);
  f.faux.setResponses([context => { requests.push(context); return call(original.name); }, ai.fauxAssistantMessage("Finished")]);
  await run(f.instance, "Third turn");
  assert.equal(closed, 2);
  assert.deepEqual(effects, ["old", "new", "added"]);
  assert.ok(!ai.getCurrentTools(requests[1]!.messages).some(item => [original.name, added.name].includes(item.name)));
});

test("catalog replacement retains pinned definitions when a tool schema changes", async t => {
  let originalCalls = 0, changedCalls = 0;
  const original = tool("pinned_tool", async () => { originalCalls++; return output("Original"); });
  const changed = { ...original, description: "Changed schema contract", execute: async () => { changedCalls++; return output("Changed"); } };
  const catalog = (entry: AgentTool): AgentToolCatalog => ({ id: "pinned", tools: [entry], open: async () => ({ tools: [entry] }) });
  const f = await runtime({ session: { toolSearch: {} } }); t.after(() => f.instance.close());
  f.instance.setExternalTools([], [catalog(original)]);
  f.faux.setResponses([call("tool_search", { query: original.name }), call(original.name), ai.fauxAssistantMessage("Saved")]);
  await run(f.instance, "Use the original tool");
  f.instance.setExternalTools([], [catalog(changed)]);
  const requests: ai.TranscriptContext[] = [];
  f.faux.setResponses([call(changed.name), context => { requests.push(context); return ai.fauxAssistantMessage("Blocked"); }]);
  await run(f.instance, "Use a changed tool");
  assert.equal(originalCalls, 1); assert.equal(changedCalls, 0);
  assert.match(JSON.stringify(requests[0]!.messages), /Tool catalog definition changed/);
});

for (const replaceCatalogs of [false, true]) test(`a concurrent run cannot overwrite active resources (replaceCatalogs=${replaceCatalogs})`, { timeout: 8000 }, async t => {
  const entered = latch(), release = latch(); let closed = 0;
  const entry = tool("waiting_tool", async () => { entered.resolve(); await release.promise; return output("Completed once"); });
  const f = await runtime({ session: { toolSearch: {} } });
  f.instance.setExternalTools([], [{ id: "active", tools: [entry], open: async () => ({ tools: [entry], close: async () => { closed++; } }) }]);
  f.faux.setResponses([call("tool_search", { query: entry.name }), call(entry.name), ai.fauxAssistantMessage("Finished")]);
  const running = run(f.instance, "Wait for a tool");
  t.after(async () => { release.resolve(); await running; await f.instance.close(); });
  await entered.promise;
  if (replaceCatalogs) f.instance.setExternalTools([], []);
  await assert.rejects(run(f.instance, "Do not replace active resources"), /active|busy/i);
  assert.equal(closed, 0);
  release.resolve(); await running;
});

test("direct concurrent prompts preserve the running agent's observer and tool result", { timeout: 8000 }, async t => {
  const entered = latch(), release = latch(); let effects = 0;
  const { faux, models } = provider();
  const inspect = tool("inspect", async () => { effects++; entered.resolve(); await release.promise; return output("Completed once"); });
  const instance = new DurableAgent({ models, initialState: { model: models.getModel("faux", "lifecycle")!,
    systemPrompt: "Inspect and finish", thinkingLevel: "off", tools: [inspect], messages: [] } });
  faux.setResponses([call(inspect.name), ai.fauxAssistantMessage("Finished")]);
  const running = instance.prompt("First prompt");
  t.after(async () => { release.resolve(); await running; await instance.close(); });
  await entered.promise;
  await assert.rejects(instance.prompt("Overlapping prompt"), /busy/i);
  release.resolve(); await running;
  assert.equal(effects, 1); assert.equal(instance.state.errorMessage, undefined);
  assert.match(JSON.stringify(instance.state.messages), /Completed once/);
});

test("request reconciliation preserves a narrower tool list supplied by an earlier hook", async t => {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "request-restriction", hooks: [hook(GenerationTask, {
    beforeRequest: request => ({ messages: [...request.messages, { role: "system", content: "", timestamp: 1,
      toolsRemoved: [{ name: "restricted_tool" }] }] }),
  })] }));
  const f = await runtime({ session: { registry }, extraTools: [tool("restricted_tool", async () => output("Restricted"))] });
  t.after(() => f.instance.close());
  const requests: ai.TranscriptContext[] = [];
  f.faux.setResponses([context => { requests.push(context); return ai.fauxAssistantMessage("Finished"); }]);
  await run(f.instance, "Keep the request restriction");
  assert.ok(!ai.getCurrentTools(requests[0]!.messages).some(item => item.name === "restricted_tool"));
});
