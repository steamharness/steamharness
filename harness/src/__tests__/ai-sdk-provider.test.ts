import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { AiSdkLLMProvider, createLLMProvider, HarnessError } from "../index";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

test("AI SDK provider consumes fullStream and preserves finish data", async () => {
  const model = new MockLanguageModelV3({
    doStream: {
      stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "hello" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          usage,
          finishReason: { unified: "stop", raw: "stop" },
          providerMetadata: { mock: { requestId: "provider-request" } },
        },
      ] }),
    },
  });
  const provider = new AiSdkLLMProvider({ model });
  const chunks = [];
  for await (const chunk of provider.stream({ prompt: "hi" })) chunks.push(chunk);

  assert.deepEqual(chunks[0], { type: "text-delta", text: "hello" });
  assert.deepEqual(chunks[1] && {
    ...chunks[1],
    usage: chunks[1].type === "finish" ? {
      inputTokens: chunks[1].usage?.inputTokens,
      outputTokens: chunks[1].usage?.outputTokens,
      totalTokens: chunks[1].usage?.totalTokens,
      reasoningTokens: chunks[1].usage?.reasoningTokens,
      cachedInputTokens: chunks[1].usage?.cachedInputTokens,
    } : undefined,
  }, {
    type: "finish",
    finishReason: "stop",
    usage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
    providerMetadata: { mock: { requestId: "provider-request" } },
  });
});

test("AI SDK provider surfaces fullStream error parts", async () => {
  const providerError = new Error("provider stream failed");
  const model = new MockLanguageModelV3({
    doStream: {
      stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "error", error: providerError },
      ] }),
    },
  });
  const provider = new AiSdkLLMProvider({ model });

  await assert.rejects(
    async () => {
      for await (const _chunk of provider.stream({ prompt: "hi" })) {
        // Consume the stream.
      }
    },
    (error: unknown) => error instanceof HarnessError
      && error.type === "stream_interrupted"
      && error.safeCause?.message === providerError.message,
  );
});

test("AI SDK provider keeps non-streaming results when optional settings are unsupported", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text: "completed" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      providerMetadata: { mock: { requestId: "provider-request" } },
      warnings: [{
        type: "unsupported",
        feature: "temperature",
        details: "temperature is not supported for reasoning models",
      }],
    },
  });
  const provider = new AiSdkLLMProvider({ model });

  const output = await provider.chat({ prompt: "hi", temperature: 0.4 });

  assert.equal(output.text, "completed");
  assert.deepEqual(output.providerMetadata, {
    mock: { requestId: "provider-request" },
    "steamharness": {
      warnings: ["temperature (temperature is not supported for reasoning models)"],
    },
  });
});

test("AI SDK provider streams output when optional settings are unsupported", async () => {
  const model = new MockLanguageModelV3({
    doStream: {
      stream: simulateReadableStream({ chunks: [
        {
          type: "stream-start",
          warnings: [{ type: "unsupported", feature: "topP", details: "not available" }],
        },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "completed" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          usage,
          finishReason: { unified: "stop", raw: "stop" },
          providerMetadata: { mock: { requestId: "provider-request" } },
        },
      ] }),
    },
  });
  const provider = new AiSdkLLMProvider({ model });
  const chunks = [];

  for await (const chunk of provider.stream({ prompt: "hi", topP: 0.8 })) {
    chunks.push(chunk);
  }

  assert.equal(chunks[0]?.type, "text-delta");
  assert.deepEqual(chunks[1] && {
    type: chunks[1].type,
    providerMetadata: chunks[1].type === "finish" ? chunks[1].providerMetadata : undefined,
  }, {
    type: "finish",
    providerMetadata: {
      mock: { requestId: "provider-request" },
      "steamharness": { warnings: ["topP (not available)"] },
    },
  });
});

test("OpenAI Responses drops unsupported reasoning-model temperature and completes", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createLLMProvider({
    type: "openai-responses",
    apiKey: "test-key",
    model: "gpt-5.6-luna",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "resp_test",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5.6-luna",
        output: [{
          id: "msg_test",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "completed", annotations: [] }],
        }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      });
    },
  });

  const output = await provider.chat({ prompt: "hi", temperature: 0.2 });

  assert.equal(output.text, "completed");
  assert.equal(requestBody?.temperature, undefined);
  assert.deepEqual(output.providerMetadata?.["steamharness"], {
    warnings: ["temperature (temperature is not supported for reasoning models)"],
  });
});

test("AI SDK provider still fails on real generation errors", async () => {
  const providerError = new Error("upstream request failed");
  const model = new MockLanguageModelV3({
    doGenerate: () => {
      throw providerError;
    },
  });
  const provider = new AiSdkLLMProvider({ model });

  await assert.rejects(
    provider.chat({ prompt: "hi", temperature: 0.4 }),
    (error: unknown) => error instanceof HarnessError
      && error.type === "provider_call"
      && error.safeCause?.message === providerError.message,
  );
});
