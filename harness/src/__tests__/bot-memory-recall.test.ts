import assert from "node:assert/strict";
import test from "node:test";
import * as ai from "@earendil-works/pi-ai";
import { DurableAgent } from "../agent/durable-agent";
import { BOT_MEMORY_SYSTEM_PROMPT, createBotMemoryRecall, createBotMemoryTools } from "../agent/memory";
import { BOT_MEMORY_CONFIGURATION_KEY } from "../agent/memory-configuration";
import { defineBot } from "../agent/bot";
import { createMemoryRuntimePersistence } from "../runtime-storage";
import { createProjectToolPermissionContext } from "../tool-permissions";
import { createTestResources } from "./entry-test-resources";
import type { AgentSessionSnapshot } from "../agent/session-types";
import type { RunContext } from "../types";
import { testAgentStorage } from "./runtime-test-storage";
import { testConversationStorage } from "./runtime-test-storage";
import { createProjectConversationContext } from "../conversation";
import { createDisabledProjectTokenUsageContext } from "../token-usage";

function testContext(persistence: ReturnType<typeof createMemoryRuntimePersistence>): RunContext {
  return { ...createTestResources(), config: {}, providers: {}, metadata: { runtimePersistence: persistence },
    conversation: createProjectConversationContext({ enabled: true, conversationId: "memory-recall", projectName: "bot", storage: testConversationStorage() }),
    tokenUsage: createDisabledProjectTokenUsageContext() };
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Memory session did not settle"); await new Promise(done => setTimeout(done, 10)); }
}

test("automatic recall follows follow-up and busy steering inputs without persisting memory snippets", { timeout: 15_000 }, async t => {
  const faux = ai.fauxProvider({ models: [{ id: "recall", contextWindow: 100_000, maxTokens: 500 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const run = testContext(persistence);
  run.toolPermissions = createProjectToolPermissionContext({ definitions: defineBot({ engine: "agent" }).tools, projectName: "bot", runId: "recall" });
  const store = persistence.botMemory!({ projectId: run.projectId, entryId: run.entryId });
  for (const [key, content] of [["database", "数据库使用 PostgreSQL。"], ["images", "图片格式固定 PNG。"], ["timeout", "HTTP 超时为 30 秒。"]]) {
    await store.execute({ action: "save", category: "facts", key: key!, content: content! });
  }
  const held = latch(), started = latch(), lease = latch();
  const tools = createBotMemoryTools({ context: run, defaultEnabled: true, readOnly: false, input: { errCode: 0, errMessage: "", prompt: "" } });
  const instance = new DurableAgent({ models, session: {}, sessionLease: lease.promise, botGuidance: BOT_MEMORY_SYSTEM_PROMPT,
    botMemoryRecall: createBotMemoryRecall(run, true), retryDelayMs: 0, initialState: {
      systemPrompt: BOT_MEMORY_SYSTEM_PROMPT, model: models.getModel("faux", "recall")!, thinkingLevel: "off", messages: [],
      tools: [...tools, { name: "hold", label: "Hold", description: "Hold the round", parameters: ai.Type.Object({}),
        async execute() { started.resolve(); await held.promise; return { content: [ai.fauxText("Finished")], details: {} }; } }],
    } });
  let snapshot: AgentSessionSnapshot | undefined;
  instance.subscribe(event => { const value = event as unknown as { type: string; snapshot: AgentSessionSnapshot }; if (value.type === "project_session") snapshot = value.snapshot; });
  const topics: string[] = [];
  const recall = (request: { messages: readonly ai.Message[] }) => {
    const reference = request.messages.find(message => message.role === "system" && typeof message.content === "string" && message.content.includes("Automatically retrieved Bot project memory"));
    const content = typeof reference?.content === "string" ? reference.content : "";
    assert.match(content, /Automatically retrieved Bot project memory/);
    topics.push(content);
  };
  faux.setResponses([
    request => { recall(request); return ai.fauxAssistantMessage("Ready"); },
    request => { recall(request); return ai.fauxAssistantMessage([ai.fauxToolCall("hold", {})], { stopReason: "toolUse" }); },
    request => { recall(request); return ai.fauxAssistantMessage("Complete"); },
  ]);
  instance.requestId = "database-turn";
  const running = instance.prompt("数据库如何配置？");
  t.after(async () => { held.resolve(); lease.resolve(); await running; await instance.close(); });
  await until(() => snapshot?.turns.some(turn => turn.requestId === "database-turn" && turn.status === "done") === true);
  await instance.control({ type: "submit", requestId: "image-turn", prompt: "图片格式是什么？", mode: "followUp" });
  await started.promise;
  await instance.control({ type: "submit", requestId: "timeout-steer", prompt: "HTTP 超时怎么配置？", mode: "steer" });
  held.resolve();
  await until(() => faux.state.callCount === 3 && !instance.state.streamingMessage);
  assert.match(topics[0]!, /PostgreSQL/); assert.doesNotMatch(topics[0]!, /固定 PNG|超时为 30/);
  assert.match(topics[1]!, /固定 PNG/); assert.doesNotMatch(topics[1]!, /PostgreSQL|超时为 30/);
  assert.match(topics[2]!, /超时为 30/); assert.doesNotMatch(topics[2]!, /PostgreSQL|固定 PNG/);
  assert.doesNotMatch(JSON.stringify(instance.state.messages), /Automatically retrieved Bot project memory|数据库使用 PostgreSQL|图片格式固定 PNG/);
});

for (const mode of ["plan", "read-only", "disabled", "host-disabled", "manual-approval"] as const) {
  test(`automatic recall honors ${mode} without approval prompts`, async t => {
    const faux = ai.fauxProvider({ models: [{ id: "recall-policy", contextWindow: 100_000, maxTokens: 500 }] });
    const models = ai.createModels(); models.setProvider(faux.provider);
    const persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
    const run = testContext(persistence); run.config[BOT_MEMORY_CONFIGURATION_KEY] = mode !== "disabled";
    const bot = defineBot({ engine: "agent", agent: { models, resolvedModel: models.getModel("faux", "recall-policy")!, tools: [], permissionPolicy: mode === "read-only" ? "read-only" : "workspace" } });
    run.toolPermissions = createProjectToolPermissionContext({ definitions: bot.tools,
      policies: { memory_search: { enabled: mode !== "host-disabled", autoApprove: mode !== "manual-approval" } }, projectName: "bot", runId: "recall-policy" });
    let approvalPrompts = 0;
    if (mode !== "plan") run.userInput = { getResolvedInput: async () => undefined,
      requestInput: async () => { approvalPrompts++; throw new Error("Unexpected approval prompt"); } } as never;
    await persistence.botMemory!({ projectId: run.projectId, entryId: run.entryId }).execute({ action: "save", category: "facts", key: "database", content: "数据库选择 PostgreSQL。" });
    let observed = "";
    faux.setResponses([request => { observed = JSON.stringify(request); return ai.fauxAssistantMessage("Ready"); }]);
    assert.equal((await bot.workflow.run({ errCode: 0, errMessage: "", prompt: "数据库怎样配置？", agent: mode === "plan" ? "plan" : "build" }, run)).errCode, 0);
    if (mode === "plan" || mode === "read-only") assert.match(observed, /数据库选择 PostgreSQL/);
    else assert.doesNotMatch(observed, /数据库选择 PostgreSQL/);
    assert.equal(approvalPrompts, 0);
  });
}

test("reopened sessions search the resumed input before model recovery", { timeout: 15_000 }, async t => {
  const database = `memory-recall:${crypto.randomUUID()}`, persistence = createMemoryRuntimePersistence(); t.after(() => persistence.close());
  const run = testContext(persistence);
  run.toolPermissions = createProjectToolPermissionContext({ definitions: defineBot({ engine: "agent" }).tools, projectName: "bot", runId: "resume-recall" });
  await persistence.botMemory!({ projectId: run.projectId, entryId: run.entryId }).execute({ action: "save", category: "facts", key: "database", content: "数据库选择 PostgreSQL。" });
  const create = (resumeSession = false) => {
    const faux = ai.fauxProvider({ models: [{ id: "recovered-recall", contextWindow: 100_000, maxTokens: 500 }] });
    const models = ai.createModels(); models.setProvider(faux.provider);
    const suspend = latch();
    const instance = new DurableAgent({ models, storage: testAgentStorage(database), session: {}, sessionSuspend: suspend.promise, resumeSession,
      botGuidance: BOT_MEMORY_SYSTEM_PROMPT, botMemoryRecall: createBotMemoryRecall(run, true), retryDelayMs: 0,
      initialState: { systemPrompt: BOT_MEMORY_SYSTEM_PROMPT, model: models.getModel("faux", "recovered-recall")!, thinkingLevel: "off", messages: [],
        tools: createBotMemoryTools({ context: run, defaultEnabled: true, readOnly: true, input: { errCode: 0, errMessage: "", prompt: "" } }) } });
    return { instance, faux, suspend };
  };
  const first = create(), active = latch();
  first.instance.models.streamSimple = (...args) => {
    const stream = ai.createAssistantMessageEventStream();
    const partial = ai.fauxAssistantMessage("Interrupted", { stopReason: "pending" });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Interrupted", partial });
    args[2]!.signal!.addEventListener("abort", () => {
      stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } }); stream.end();
    }, { once: true });
    active.resolve(); return stream;
  };
  first.instance.requestId = "resume-input";
  const running = first.instance.prompt("数据库怎样配置？");
  await active.promise; first.suspend.resolve(); await running; await first.instance.close();
  const second = create(true);
  t.after(() => second.instance.close());
  second.faux.setResponses([request => { assert.match(JSON.stringify(request.messages.filter(message => message.role === "system")), /数据库选择 PostgreSQL/); return ai.fauxAssistantMessage("Recovered"); }]);
  await second.instance.prompt("Bootstrap must not become the search topic");
  assert.equal(second.faux.state.callCount, 1);
});
