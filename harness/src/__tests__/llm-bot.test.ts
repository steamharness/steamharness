import assert from "node:assert/strict";
import test from "node:test";
import { defineBot } from "../agent/bot";
import { AGENT_MODELS_CONFIGURATION_KEY, withProjectConfiguration } from "../configuration";
import { createProjectConversationContext } from "../conversation/index";
import { analyzeProjectScriptSource } from "../executor/rules";
import type { ConfiguredAgentModel } from "@steamharness/project-configuration";
import { createProjectTokenUsageContext } from "../token-usage/index";
import type { RunContext } from "../types/index";
import { withUserSettings } from "../user-settings";
import { HarnessError } from "../workflow/errors";
import { createTestResources } from "./entry-test-resources";
import { llmFrames, llmSSE } from "./fixtures/llm-sse";
import { testConversationStorage } from "./runtime-test-storage";

const endpoint: ConfiguredAgentModel = { id: "third", name: "Test", model: "test-model", source: "third-party",
  apiKind: "openai-responses", baseUrl: "https://model.example.test/v1", apiKey: "fixture" };
const snapshot = { id: "default", name: "Default", revision: 1, values: { [AGENT_MODELS_CONFIGURATION_KEY]: [endpoint] } };
const input = (requestId: string, prompt = requestId) => ({ errCode: 0, errMessage: "", prompt, requestId });

function context(id: string, signal?: AbortSignal): RunContext {
  return { ...createTestResources(), config: {}, providers: {}, abortSignal: signal,
    conversation: createProjectConversationContext({ enabled: true, conversationId: id, projectName: "bot", storage: testConversationStorage() }),
    tokenUsage: createProjectTokenUsageContext({ definition: { enabled: true }, store: async () => undefined, projectId: "test", runId: id }),
  };
}

test("LLM Bot has a model selector but no durable, recovery, Plan, or tool controls", () => {
  const bot = defineBot({ engine: "llm", llm: { systemPrompt: "Test" } });
  const report = analyzeProjectScriptSource(`export const executor = steamharness.defineBot({ engine: "llm", llm: { systemPrompt: "Test" } });`);
  assert.deepEqual(report.executorConfigurationViolations, []);
  assert.deepEqual(report.executorConversation, bot.conversation);
  assert.deepEqual(report.executorParams?.map(param => param.name), ["provider", "model"]);
  assert.equal(report.executorParamResolver?.enabled, true);
  assert.deepEqual(bot.tools, []);
  assert.equal(bot.conversation?.durable, undefined);
  assert.equal(bot.conversation?.recovery, undefined);
  assert.throws(() => defineBot({} as never), /requires engine/);
  assert.ok(analyzeProjectScriptSource(`export const executor = steamharness.defineBot({});`).executorConfigurationViolations.some(error => error.name === "engine"));
  assert.throws(() => defineBot({ engine: "llm", llm: {}, agent: {} } as never), /requires engine: "agent"/);
});

test("successful request IDs are persisted before callback, replayed, and isolated by conversation", async t => {
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return llmSSE("openai-responses", `reply-${bodies.length}`);
  });
  const first = context("first"), second = context("second");
  let callbacks = 0;
  const options = { engine: "llm" as const, llm: { systemPrompt: "Project instructions" },
    async onCompleted(result: import("../agent/bot").BotCompletion, run: RunContext) {
      const messages = (await run.conversation.getValue()).messages;
      assert.equal(messages.at(-1)?.content, result.output.items.at(-1)?.content);
      if (++callbacks === 1) throw new Error("notification unavailable");
    } };
  const bot = defineBot(options);
  await withUserSettings({ agent: { permissionPolicy: "auto", models: [endpoint] } }, async () => {
    await assert.rejects(async () => bot.workflow.run(input("r1", "context unique to first"), first), error =>
      error instanceof HarnessError && error.metadata?.phase === "bot_completion" && error.message.includes("notification unavailable"));
    const restarted = defineBot(options);
    await restarted.workflow.run(input("r1"), first);
    await restarted.workflow.run(input("r1"), first);
    assert.equal(callbacks, 2); assert.equal(bodies.length, 1);
    assert.equal(first.tokenUsage.getRunUsage().calls, 1);
    assert.equal(first.tokenUsage.getRunUsage().totalTokens, 14);
    const [a, b] = await Promise.all([restarted.workflow.run(input("r2", "next question"), first), restarted.workflow.run(input("r2"), first)]);
    assert.deepEqual(a, b); assert.equal(bodies.length, 2);
    assert.match(bodies[1]!, /context unique to first.*reply-1.*next question/);
    await bot.workflow.run(input("r1", "fresh conversation"), second);
    assert.doesNotMatch(bodies[2]!, /context unique to first|reply-1|next question/);
  });
});

test("aborted and incomplete answers never enter history and are not retried automatically", async t => {
  const controller = new AbortController();
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) {
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(new TextEncoder().encode(llmFrames("openai-responses", "cancelled chunk", false).join("")));
        const signal = init!.signal!;
        signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    return llmSSE("openai-responses", bodies.length === 2 ? "partial chunk" : "complete", bodies.length !== 2);
  });
  const run = context("single", controller.signal);
  run.nodeHooks = { onNodeChunk(event) {
    if ((event.chunk as { delta?: string }).delta === "cancelled chunk") controller.abort();
  } };
  const bot = defineBot({ engine: "llm", llm: {} });
  await withProjectConfiguration(snapshot, async () => {
    await assert.rejects(async () => bot.workflow.run(input("cancel", "discard cancelled question"), run), error =>
      error instanceof HarnessError && (error.type === "execution_aborted" || error.safeCause?.name === "AbortError"));
    assert.equal(bodies.length, 1);
    assert.deepEqual((await run.conversation.getValue()).messages, []);
    const retry = { ...run, abortSignal: undefined, nodeHooks: undefined };
    await assert.rejects(async () => bot.workflow.run(input("repeat", "discard incomplete question"), retry), /stream did not complete/);
    assert.equal(bodies.length, 2);
    assert.deepEqual((await run.conversation.getValue()).messages, []);
    await bot.workflow.run(input("repeat", "manual retry"), retry);
    assert.equal(bodies.length, 3);
    assert.doesNotMatch(bodies[2]!, /discard|cancelled chunk|partial chunk/);
    assert.equal((await run.conversation.getValue()).messages.length, 2);
  });
});

test("a system-only project rejects third-party model IDs and a failed credential does not select another model", async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    urls.push(String(url));
    return Response.json({ error: { message: "provider secret" } }, { status: 403 });
  });
  const run = context("policy");
  const bot = defineBot({ engine: "llm", llm: { modelSource: "project" } });
  await withProjectConfiguration({ ...snapshot, agentModelPolicy: { allowThirdParty: false } }, async () => {
    const choices = await bot.resolveParams!({ projectName: "bot", projectDir: ".", args: [], paramValues: {}, config: snapshot.values,
      draftText: "", inputMode: "form", trigger: { kind: "init" }, abortSignal: new AbortController().signal });
    assert.deepEqual(choices.params?.model?.resolvedOptions, []);
    await assert.rejects(async () => bot.workflow.run({ ...input("policy"), model: "third" }, run), /only allows system AI/);
  });
  assert.deepEqual(urls, []);
  await withProjectConfiguration({ ...snapshot, values: { [AGENT_MODELS_CONFIGURATION_KEY]: [endpoint, { ...endpoint, id: "backup", baseUrl: "https://backup.example.test/v1" }] } }, async () => {
    await assert.rejects(async () => bot.workflow.run(input("failure"), run), (error: Error) => /authentication failed/.test(error.message) && !error.message.includes("secret"));
  });
  assert.deepEqual(urls, ["https://model.example.test/v1/responses"]);
});
