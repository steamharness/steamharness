import assert from "node:assert/strict";
import test from "node:test";
import * as ai from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DurableAgent } from "../agent/durable-agent";
import { createAgentRuntime } from "../agent/runtime";
import type { AgentStreamEvent } from "../agent/types";
import { compactAgentMessages, DEFAULT_AGENT_COMPACTION_SETTINGS, estimateAgentTokens,
  serializeAgentMessages, shouldCompactAgent } from "../agent/compaction";

function fixture(options: { session?: boolean; window?: number; enabled?: boolean; contextWindow?: number } = {}) {
  const faux = ai.fauxProvider({ models: [{ id: "compact", contextWindow: options.window ?? 100_000, maxTokens: 1_000 }] });
  const models = ai.createModels(); models.setProvider(faux.provider);
  const summaries: ai.Context[] = [];
  models.completeSimple = async (_model, source) => {
    summaries.push(source);
    return ai.fauxAssistantMessage("Earlier work is complete; continue the current task.");
  };
  const instance = new DurableAgent({ models, retryDelayMs: 0,
    ...(options.session ? { session: { compaction: { enabled: options.enabled ?? true } } } : {}),
    compaction: { ...DEFAULT_AGENT_COMPACTION_SETTINGS, enabled: options.enabled ?? true },
    initialState: { model: models.getModel("faux", "compact")!, systemPrompt: "Continue the user's task.",
      contextWindow: options.contextWindow, thinkingLevel: "off", tools: [],
      messages: [{ role: "user", content: "Earlier instructions: " + "a".repeat(160_000), timestamp: 1 },
        ai.fauxAssistantMessage("Earlier answer")] },
  });
  return { instance, faux, models, summaries };
}

test("automatic compaction includes exactly 90% and leaves lower occupancy alone", () => {
  assert.equal(DEFAULT_AGENT_COMPACTION_SETTINGS.threshold, 0.9);
  for (const used of [0, 89_999]) assert.equal(shouldCompactAgent({ used, total: 100_000 }), false);
  for (const used of [90_000, 90_001, 103_000]) assert.equal(shouldCompactAgent({ used, total: 100_000 }), true);
  assert.equal(shouldCompactAgent({ used: 103_000, total: 100_000 }, { ...DEFAULT_AGENT_COMPACTION_SETTINGS, enabled: false }), false);
});

for (const session of [false, true]) {
  test(`a tool result crossing 90% compacts before the next model request (session=${session})`, async t => {
    const { instance, faux, summaries } = fixture({ session });
    t.after(() => instance.close());
    const result = "tool output " + "x".repeat(40_000);
    let toolCalls = 0;
    instance.state.tools = [{ name: "inspect", label: "Inspect", description: "Inspect data", parameters: ai.Type.Object({}),
      execute: async () => { toolCalls++; return { content: [ai.fauxText(result)], details: {} }; } }];
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
      request => {
        assert.equal(summaries.length, 1);
        assert.match(JSON.stringify(request.messages), /Earlier work is complete/);
        assert.doesNotMatch(JSON.stringify(request.messages), /Earlier instructions/);
        const call = request.messages.find(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall"));
        const output = request.messages.find(message => message.role === "toolResult");
        assert.ok(call && output, "the requesting assistant and tool result survive together");
        assert.equal(serializeAgentMessages([output] as AgentMessage[]).includes(result), true);
        return ai.fauxAssistantMessage("Finished");
      },
    ]);
    await instance.prompt("Inspect and finish");
    assert.equal(instance.state.errorMessage, undefined);
    assert.equal(toolCalls, 1);
    assert.equal(faux.state.callCount, 2);
    assert.equal(summaries.length, 1);
  });
}

test("tool continuations below 90% retain their context without summarizing", async t => {
  const { instance, faux, summaries } = fixture(); t.after(() => instance.close());
  instance.state.tools = [{ name: "inspect", label: "Inspect", description: "Inspect", parameters: ai.Type.Object({}),
    execute: async () => ({ content: [ai.fauxText("small result")], details: {} }) }];
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
    request => { assert.match(JSON.stringify(request.messages), /Earlier instructions/); return ai.fauxAssistantMessage("Finished"); }]);
  await instance.prompt("Inspect");
  assert.equal(instance.state.errorMessage, undefined);
  assert.equal(summaries.length, 0);
});

test("the configured window overrides catalogue metadata for automatic compaction", async t => {
  const { instance, faux, summaries } = fixture({ window: 1_000_000, contextWindow: 100_000 });
  t.after(() => instance.close());
  instance.state.messages[0] = { role: "user", content: "x".repeat(360_000), timestamp: 1 };
  faux.setResponses([() => { assert.equal(summaries.length, 1); return ai.fauxAssistantMessage("Finished"); }]);
  await instance.prompt("Continue");
  assert.equal(instance.state.errorMessage, undefined);
  assert.equal(summaries.length, 1);
});

test("CJK occupancy triggers compaction even when Pi's latin estimate is below 90%", async t => {
  const { instance, faux, summaries } = fixture(); t.after(() => instance.close());
  instance.state.messages[0] = { role: "user", content: "压".repeat(90_000), timestamp: 1 };
  faux.setResponses([() => { assert.equal(summaries.length, 1); return ai.fauxAssistantMessage("Finished"); }]);
  await instance.prompt("Continue");
  assert.equal(instance.state.errorMessage, undefined);
  assert.equal(summaries.length, 1);
});

for (const reportedWindow of [100_000, 1_000_000]) {
  test(`external occupancy uses the configured window and resets after compaction (reported=${reportedWindow})`, async t => {
    const { models, faux, summaries } = fixture();
    const runtime = await createAgentRuntime({ models, resolvedModel: models.getModel("faux", "compact")!,
      provider: "faux", model: "compact" });
    t.after(() => runtime.close());
    runtime.restoreTranscript?.([{ role: "user", content: "x".repeat(40_000), timestamp: 1 }, ai.fauxAssistantMessage("Earlier answer")]);
    runtime.updateContextUsage({ used: 90_000, total: reportedWindow });
    faux.setResponses([() => { assert.equal(summaries.length, 1); return ai.fauxAssistantMessage("Finished"); }]);
    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.run({ prompt: "Continue", errCode: 0, errMessage: "" })) events.push(event);
    assert.deepEqual(events.filter(event => event.type === "compaction").map(event => event.phase), ["start", "end"]);
    assert.ok(events.findIndex(event => event.type === "compaction") < events.findIndex(event => event.type === "text_delta"));
    assert.ok(runtime.getContextUsage()!.used < 90_000);
  });
}

test("automatic compaction can resume a history already larger than the window", async t => {
  const { instance, faux, models } = fixture(); t.after(() => instance.close());
  instance.state.messages[0] = { role: "user", content: "旧".repeat(103_000), timestamp: 1 };
  let summaries = 0, billed = 0;
  models.completeSimple = async (model, source, options) => {
    summaries++;
    assert.ok(estimateAgentTokens(source.systemPrompt ?? "") + estimateAgentTokens(serializeAgentMessages(source.messages as AgentMessage[])) + options!.maxTokens! < model.contextWindow);
    return ai.fauxAssistantMessage("A concise checkpoint preserving prior work.");
  };
  instance.subscribe(event => {
    const usage = event as unknown as { type: string; recordId?: string };
    if (usage.type === "project_usage" && usage.recordId?.startsWith("compaction:")) billed++;
  });
  faux.setResponses([() => { assert.ok(summaries > 1); return ai.fauxAssistantMessage("Recovered"); }]);
  await instance.prompt("Continue");
  assert.equal(instance.state.errorMessage, undefined);
  assert.equal(billed, summaries);
  assert.ok(serializeAgentMessages(instance.state.messages).length < 10_000);
});

for (const outcome of ["failure", "cancelled"] as const) {
  test(`automatic compaction retains history on ${outcome}`, async t => {
    const { instance, models, faux } = fixture(); t.after(() => instance.close());
    instance.state.messages[0] = { role: "user", content: "x".repeat(360_000), timestamp: 1 };
    models.completeSimple = async (_model, _source, options) => {
      if (outcome === "cancelled") {
        instance.abort();
        if (!options?.signal?.aborted) await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      }
      return ai.fauxAssistantMessage("Late summary", { stopReason: outcome === "failure" ? "error" : "stop", errorMessage: "invalid api key" });
    };
    await instance.prompt("Continue");
    assert.equal(faux.state.callCount, 0, "no normal request is sent after a failed or cancelled summary");
    assert.ok(serializeAgentMessages(instance.state.messages).includes("x".repeat(360_000)));
    assert.doesNotMatch(serializeAgentMessages(instance.state.messages), /Late summary/);
  });
}

for (const repeats of [false, true]) {
  test(`a provider context overflow compacts and retries once (repeated=${repeats})`, async t => {
    const { instance, faux, summaries } = fixture(); t.after(() => instance.close());
    const overflow = () => ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: "context_length_exceeded: maximum context length exceeded" });
    faux.setResponses([overflow, repeats ? overflow : () => ai.fauxAssistantMessage("Recovered")]);
    await instance.prompt("Continue");
    assert.equal(summaries.length, 1);
    assert.equal(faux.state.callCount, 2);
    if (repeats) assert.match(instance.state.errorMessage ?? "", /context_length_exceeded/);
    else assert.equal(instance.state.errorMessage, undefined);
  });
}

test("explicitly disabling automatic compaction also disables overflow retries", async t => {
  const { instance, faux, summaries } = fixture({ enabled: false }); t.after(() => instance.close());
  faux.setResponses([ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: "context_length_exceeded" })]);
  await instance.prompt("Continue");
  assert.equal(summaries.length, 0);
  assert.equal(faux.state.callCount, 1);
  assert.match(instance.state.errorMessage ?? "", /context_length_exceeded/);
});

test("over-limit history is summarized in bounded chunks, preserving the entire source and billing every call", async () => {
  const { models } = fixture({ window: 2_000 });
  const model = models.getModel("faux", "compact")!;
  const messages = [{ role: "user", content: "START " + "历史".repeat(3_000) + " END", timestamp: 1 }] as AgentMessage[];
  const original = structuredClone(messages);
  const requests: string[] = [], usages: ai.Usage[] = [];
  models.completeSimple = async (_model, source, options) => {
    const text = serializeAgentMessages(source.messages as AgentMessage[]);
    requests.push(text);
    assert.ok(estimateAgentTokens(source.systemPrompt ?? "") + estimateAgentTokens(text) + options!.maxTokens! < model.contextWindow);
    return ai.fauxAssistantMessage(`Checkpoint ${requests.length}: preserve START and END`);
  };
  const result = await compactAgentMessages({ models, model, messages, force: true, onUsage: usage => { usages.push(usage); } });
  assert.ok(requests.length > 3);
  assert.match(requests[0]!, /START/);
  assert.ok(requests.some(request => request.includes("END")));
  assert.equal(usages.length, requests.length);
  assert.deepEqual(messages, original);
  assert.equal(result.removed, 1);
  assert.equal(result.messages.length, 1);
});

for (const outcome of ["failure", "cancelled"] as const) {
  test(`a chunked summary preserves original history on ${outcome}`, async () => {
    const { models } = fixture({ window: 2_000 });
    const model = models.getModel("faux", "compact")!;
    const messages = [{ role: "user", content: "历史".repeat(3_000), timestamp: 1 }] as AgentMessage[];
    const original = structuredClone(messages), controller = new AbortController();
    let calls = 0, billed = 0;
    models.completeSimple = async () => {
      calls++;
      if (calls === 2 && outcome === "cancelled") controller.abort(new Error("Summary cancelled"));
      return ai.fauxAssistantMessage("Checkpoint", { stopReason: calls === 2 && outcome === "failure" ? "error" : "stop",
        errorMessage: calls === 2 ? "Summary failed" : undefined });
    };
    await assert.rejects(compactAgentMessages({ models, model, messages, force: true, signal: controller.signal,
      onUsage: () => { billed++; } }), outcome === "failure" ? /Summary failed/ : /Summary cancelled/);
    assert.equal(billed, 2);
    assert.deepEqual(messages, original);
  });
}
