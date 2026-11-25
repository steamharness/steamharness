import assert from "node:assert/strict";
import test from "node:test";
import corePackage from "../../package.json" with { type: "json" };
import { defineBot } from "../agent/bot";
import { AGENT_MODELS_CONFIGURATION_KEY, withProjectConfiguration } from "../configuration";
import { createProjectConversationContext } from "../conversation/index";
import { combineNodeExecutionHooks, createNodeExecutionReporter } from "../executor/report";
import { analyzeProjectScriptSource } from "../executor/rules";
import { withPlatformConnections } from "../platform-connections";
import type { ConfiguredAgentModel } from "@steamharness/project-configuration";
import { createProjectTokenUsageContext } from "../token-usage/index";
import type { LLMBotModelRequestSnapshot, RunContext } from "../types/index";
import { createProjectToolPermissionContext } from "../tool-permissions/index";
import { withUserSettings } from "../user-settings";
import { HarnessError } from "../workflow/errors";
import { createTestResources } from "./entry-test-resources";
import { llmFrames, llmSSE, llmToolSSE } from "./fixtures/llm-sse";
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

test("LLM Bot statically exposes shared tools and project declarations without loading the factory", () => {
  const bot = defineBot({ engine: "llm", llm: { systemPrompt: "Test" } });
  const report = analyzeProjectScriptSource(`export const executor = steamharness.defineBot({ engine: "llm", llm: { systemPrompt: "Test" } });`);
  assert.deepEqual(report.executorConfigurationViolations, []);
  assert.deepEqual(report.executorConversation, bot.conversation);
  assert.deepEqual(report.executorParams?.map(param => param.name), ["provider", "model"]);
  assert.equal(report.executorParamResolver?.enabled, true);
  assert.deepEqual(report.executorTools, bot.tools);
  assert.deepEqual(bot.tools?.filter(tool => tool.enabled).map(tool => tool.name), ["runtime_info"]);
  assert.ok(bot.tools?.some(tool => tool.name === "bash" && !tool.enabled && !tool.autoApprove));
  const custom = { name: "lookup", autoApprove: false };
  const variant = defineBot({ engine: "llm", llm: { createTools() { throw new Error("factory was executed"); } }, tools: [custom] });
  const inspected = analyzeProjectScriptSource(`const tools = [${JSON.stringify(custom)}];
    export const executor = steamharness.defineBot({ engine: "llm", tools, llm: { createTools() { throw new Error("factory was executed"); } } });`);
  assert.deepEqual(inspected.executorConfigurationViolations, []);
  assert.deepEqual(inspected.executorTools, variant.tools);
  assert.equal(bot.conversation?.durable, undefined);
  assert.equal(bot.conversation?.recovery, undefined);
  assert.throws(() => defineBot({} as never), /requires engine/);
  assert.ok(analyzeProjectScriptSource(`export const executor = steamharness.defineBot({});`).executorConfigurationViolations.some(error => error.name === "engine"));
  assert.throws(() => defineBot({ engine: "llm", llm: {}, agent: {} } as never), /requires engine: "agent"/);
});

test("LLM Bot recovers from a failed system AI catalogue read without replaying the turn", async t => {
  const ai = { serverUrl: "https://bot-ai.example.test", accessToken: "account-token" };
  const selected = { id: "system-model", name: "System model", model: "test-model", source: "system", credentialId: "provider:4" } satisfies ConfiguredAgentModel;
  let catalogReads = 0;
  const modelRequests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === `${ai.serverUrl}/api/ai/catalog`) {
      if (++catalogReads === 1) throw new TypeError("fetch failed");
      return Response.json({ errCode: 0, errMessage: "", data: {
        credentials: [{ id: selected.credentialId, name: "System AI", platform: "openai", providerType: "openai-responses",
          models: [selected.model], proxyPath: "/api/ai/proxy/provider%3A4", credentialToken: "proxy-token",
          expiresAt: new Date(Date.now() + 600_000).toISOString() }],
        fetchedAt: new Date().toISOString(),
      } });
    }
    assert.equal(String(url), `${ai.serverUrl}/api/ai/proxy/provider%3A4/responses`);
    modelRequests.push(JSON.parse(String(init?.body)).model);
    return llmSSE("openai-responses", "Recovered reply");
  });

  const run = context("catalog-recovery");
  const bot = defineBot({ engine: "llm", llm: { modelSource: "project" } });
  await withPlatformConnections({ ai }, () => withProjectConfiguration({ ...snapshot, values: {
    [AGENT_MODELS_CONFIGURATION_KEY]: [selected],
  } }, () => bot.workflow.run({ ...input("catalog-recovery", "Hello"), model: selected.id }, run)));

  assert.equal(catalogReads, 2);
  assert.deepEqual(modelRequests, [selected.model]);
  assert.deepEqual((await run.conversation.getValue()).messages.map(message => [message.role, message.content]), [
    ["user", "Hello"], ["assistant", "Recovered reply"],
  ]);
});

for (const [apiKind, wire] of [["openai-responses", "openai-responses"], ["openai-completions", "openai-completion"], ["anthropic-messages", "anthropic"]] as const) {
  test(`${apiKind} continues with runtime_info using the same model and records both requests`, async t => {
    const bodies: Record<string, any>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? llmToolSSE(wire, "runtime_info") : llmSSE(wire, "Running in Studio");
    });
    const run = context(apiKind);
    const host = { kind: "studio" as const, cliVersion: "4.5.6", secret: "do-not-send-host-secret" };
    const entry = { entryId: "chat", name: "Chat", type: "bot" as const };
    run.runtimeInfo = { host, project: { name: "Example", entry, version: "1.5.0", directory: "/private/test-directory" } };
    const traces: LLMBotModelRequestSnapshot[] = [];
    run.nodeHooks = { onLLMBotModelRequest(snapshot) { traces.push(snapshot); } };
    const bot = defineBot({ engine: "llm", llm: { systemPrompt: "Project instructions" } });
    await withProjectConfiguration({ ...snapshot, values: { [AGENT_MODELS_CONFIGURATION_KEY]: [{ ...endpoint, apiKind }] } }, async () => {
      const output = await bot.workflow.run(input("runtime", "Where are you running?"), run);
      assert.equal(output.items[0]?.content, "Running in Studio");
      assert.equal(output.toolCallCount, 1);
      const replay = await bot.workflow.run(input("runtime"), run);
      assert.equal(replay.items[0]?.content, output.items[0]?.content);
      assert.equal(replay.toolCallCount, 1);
      assert.equal(run.tokenUsage.getRunUsage().calls, 2);
      assert.equal(run.tokenUsage.getRunUsage().totalTokens, 28);
      assert.equal(traces.length, 2);
      assert.deepEqual(traces[0]!.tools?.map(tool => tool.name), ["runtime_info"]);
      assert.deepEqual(bodies[0]!.tools.map((tool: any) => tool.name ?? tool.function.name), ["runtime_info"]);
      assert.equal(bodies[0]!.model, bodies[1]!.model);
      const result = traces[1]!.messages.find(message => message.role === "toolResult");
      assert.ok(result?.content[0]?.type === "text");
      const anthropicResult = wire === "anthropic" && bodies[1]!.messages.at(-1).content.find((item: any) => item.type === "tool_result").content;
      const wireResult = wire === "openai-responses"
        ? bodies[1]!.input.find((item: any) => item.type === "function_call_output").output
        : wire === "anthropic" ? (typeof anthropicResult === "string" ? anthropicResult : anthropicResult[0].text)
          : bodies[1]!.messages.find((item: any) => item.role === "tool").content;
      assert.equal(wireResult, result.content[0].text);
      assert.deepEqual(JSON.parse(wireResult), { engine: "llm", coreVersion: corePackage.version, host: { kind: "studio", cliVersion: "4.5.6" },
        runtime: { name: "node", version: process.versions.node, platform: process.platform, arch: process.arch }, project: { name: "Example", version: "1.5.0", entry } });
      await bot.workflow.run(input("follow-up"), run);
      assert.doesNotMatch(JSON.stringify(bodies[2]), /tool_result|function_call_output|fc_call_1|test-directory|do-not-send-host-secret/u);
    });
  });
}

test("project tools obey permission, validated arguments and live approval without restarting the turn", async t => {
  const bodies: string[] = [];
  let nextCall = "lookup", approved = true, closeCount = 0, callCount = 0, approvalCount = 0;
  let complete = true, args: Record<string, unknown> = { query: "example" };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    return JSON.parse(body).input.some((item: any) => item.type === "function_call_output")
      ? llmSSE("openai-responses", "Done") : llmToolSSE("openai-responses", nextCall, args, "call_1", complete);
  });
  const bot = defineBot({ engine: "llm", tools: [{ name: "lookup" }, { name: "read", enabled: true }], llm: { createTools() {
    const tool = { name: "lookup", label: "Lookup", description: "Look up data.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      async execute(_id: string, args: unknown) {
        callCount++;
        return { content: [{ type: "text" as const, text: `Tool: ${(args as { query: string }).query}` }], details: {} };
      } };
    return { tools: [tool, { ...tool, name: "undeclared" }], async close() { closeCount++; } };
  } } });
  const run = context("permissions");
  run.toolPermissions = createProjectToolPermissionContext({ definitions: bot.tools, policies: { read: { enabled: false } }, projectName: "test", runId: "run" });
  run.userInput = { requestInput() { assert.fail("must not suspend and restart the run"); }, getResolvedInput() { return undefined; },
    async waitForInput(request) {
      approvalCount++;
      assert.equal(request.metadata?.live, true);
      assert.deepEqual(request.metadata?.toolArguments, { query: "example" });
      return { requestId: request.requestId, nodeName: request.nodeName, values: { approved }, submittedAt: new Date() };
    } };
  await withProjectConfiguration(snapshot, async () => {
    await bot.workflow.run(input("approved"), run);
    assert.equal(bodies.length, 2);
    assert.equal(callCount, 1);
    assert.equal(approvalCount, 1);
    assert.match(bodies[1]!, /Tool: example/);
    assert.deepEqual(JSON.parse(bodies[0]!).tools.map((tool: any) => tool.name), ["runtime_info", "lookup"]);
    approved = false;
    await assert.rejects(async () => bot.workflow.run(input("rejected"), run), /rejected by the approval/);
    assert.equal(bodies.length, 3);
    args = {};
    await bot.workflow.run(input("invalid"), run);
    assert.match(bodies.at(-1)!, /arguments do not match/);
    nextCall = "read";
    await bot.workflow.run(input("disabled"), run);
    assert.match(bodies.at(-1)!, /tool is not available or is disabled/);
    nextCall = "lookup"; args = { query: "example" }; complete = false;
    await assert.rejects(async () => bot.workflow.run(input("truncated"), run), /stream did not complete/);
    assert.equal(callCount, 1);
    assert.equal(approvalCount, 2);
    assert.equal(closeCount, 5);
    const state = await run.conversation.getValue();
    assert.deepEqual(state.messages.filter(message => message.role === "user").map(message => message.content), ["approved", "invalid", "disabled"]);
  });
});

for (const [apiKind, wire] of [["openai-responses", "openai-responses"], ["openai-completions", "openai-completion"], ["anthropic-messages", "anthropic"]] as const) {
  test(`private ${apiKind} trace matches the dispatched request without secrets or image bytes`, async t => {
    const bodies: Record<string, any>[] = [];
    const traces: LLMBotModelRequestSnapshot[] = [];
    const reporter = createNodeExecutionReporter();
    const image = { mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" };
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return llmSSE(wire, "Earlier reply");
    });
    const run = context(apiKind);
    run.nodeHooks = combineNodeExecutionHooks(reporter.hooks, { onLLMBotModelRequest: request => {
      assert.equal(bodies.length, traces.length + 1, "the trace is emitted at dispatch");
      traces.push(request);
    } });
    const bot = defineBot({ engine: "llm", llm: { systemPrompt: "Project instructions", temperature: 0.3, maxOutputTokens: 42 } });
    await withProjectConfiguration({ ...snapshot, values: { [AGENT_MODELS_CONFIGURATION_KEY]: [{ ...endpoint, apiKind }] } }, async () => {
      await bot.workflow.run({ ...input("first", "Inspect image"), images: [image], apiKey: "unused-node-credential" }, run);
      await bot.workflow.run({ ...input("next", "Follow up"), systemPrompt: `Turn instructions ${endpoint.apiKey}` }, run);
      await bot.workflow.run(input("next", "Duplicate request"), run);
    });
    assert.equal(traces.length, 2);
    const second = traces[1]!;
    const body = bodies[1]!;
    assert.equal(second.model, body.model);
    assert.equal(second.provider, "third");
    assert.equal(second.systemPrompt, "Project instructions\n\nTurn instructions [redacted]");
    assert.deepEqual(second.messages, [
      { role: "user", content: [{ type: "text", text: "Inspect image" }, { type: "image", mimeType: "image/png" }] },
      { role: "assistant", content: "Earlier reply" },
      { role: "user", content: "Follow up" },
    ]);
    assert.equal(second.generation.temperature, body.temperature);
    assert.equal(second.generation.maxOutputTokens, body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens);
    assert.ok(JSON.stringify(body).includes(image.data));
    assert.doesNotMatch(JSON.stringify(traces), /fixture|aW1hZ2UtYnl0ZXM=|apiKey|authorization|model\.example/i);
    assert.doesNotMatch(JSON.stringify(reporter.getReports()), /Project instructions|Turn instructions|aW1hZ2UtYnl0ZXM=|unused-node-credential/);
    assert.equal(bodies.length, 2);
  });
}

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
  const traces: LLMBotModelRequestSnapshot[] = [];
  run.nodeHooks = { onLLMBotModelRequest: request => { traces.push(request); }, onNodeChunk(event) {
    if ((event.chunk as { delta?: string }).delta === "cancelled chunk") controller.abort();
  } };
  const bot = defineBot({ engine: "llm", llm: {} });
  await withProjectConfiguration(snapshot, async () => {
    await assert.rejects(async () => bot.workflow.run(input("cancel", "discard cancelled question"), run), error =>
      error instanceof HarnessError && (error.type === "execution_aborted" || error.safeCause?.name === "AbortError"));
    assert.equal(bodies.length, 1);
    assert.deepEqual(traces[0]?.messages, [{ role: "user", content: "discard cancelled question" }]);
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
  const traces: LLMBotModelRequestSnapshot[] = [];
  run.nodeHooks = { onLLMBotModelRequest: request => { traces.push(request); } };
  const bot = defineBot({ engine: "llm", llm: { modelSource: "project" } });
  await withProjectConfiguration({ ...snapshot, agentModelPolicy: { allowThirdParty: false } }, async () => {
    const choices = await bot.resolveParams!({ projectName: "bot", projectDir: ".", args: [], paramValues: {}, config: snapshot.values,
      draftText: "", inputMode: "form", trigger: { kind: "init" }, abortSignal: new AbortController().signal });
    assert.deepEqual(choices.params?.model?.resolvedOptions, []);
    await assert.rejects(async () => bot.workflow.run({ ...input("policy"), model: "third" }, run), /only allows system AI/);
  });
  assert.deepEqual(urls, []);
  assert.deepEqual(traces, []);
  await withProjectConfiguration({ ...snapshot, values: { [AGENT_MODELS_CONFIGURATION_KEY]: [endpoint, { ...endpoint, id: "backup", baseUrl: "https://backup.example.test/v1" }] } }, async () => {
    await assert.rejects(async () => bot.workflow.run(input("failure"), run), (error: Error) => /authentication failed/.test(error.message) && !error.message.includes("secret"));
  });
  assert.deepEqual(urls, ["https://model.example.test/v1/responses"]);
  assert.equal(traces.length, 1);
});
