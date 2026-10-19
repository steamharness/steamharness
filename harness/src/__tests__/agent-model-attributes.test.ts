import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentModelAttributes } from "../agent/model-attributes";
import {
  createPiRuntime,
  DEFAULT_AGENT_CONTEXT_WINDOW,
  DEFAULT_AGENT_MAX_TOKENS,
} from "../agent/pi";
import { toAgentModelAttributes } from "../agent/system-llm";
import { HarnessError } from "../workflow/errors";
import type { ServerLLMModelDetails } from "../provider/llm/server";

test("model attributes round-trip through the string and object forms", () => {
  const expected = {
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    thinkingLevelMap: { off: "none", low: "low", high: "high", max: "max" },
  };

  assert.deepEqual(parseAgentModelAttributes(JSON.stringify(expected)), expected);
  assert.deepEqual(parseAgentModelAttributes(expected), expected);
});

test("a partial record keeps only the fields it declares", () => {
  assert.deepEqual(parseAgentModelAttributes('{"contextWindow": 64000}'), { contextWindow: 64_000 });
  assert.deepEqual(parseAgentModelAttributes(""), {});
});

test("a field this build does not know is refused rather than dropped", () => {
  // Silently ignoring it would look like the model ignored the setting.
  assert.throws(
    () => parseAgentModelAttributes('{"contextWindows": 1000}'),
    (error: unknown) => error instanceof HarnessError && error.message.includes("contextWindows"),
  );
});

test("unusable values are rejected with the offending field named", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["not json at all", "JSON"],
    ["[]", "JSON"],
    ['{"input": []}', "input"],
    ['{"input": ["text", "audio"]}', "input"],
    ['{"cost": {"input": 1, "output": 2}}', "cost"],
    ['{"cost": {"input": -1, "output": 2, "cacheRead": 0, "cacheWrite": 0}}', "cost"],
    ['{"contextWindow": 0}', "contextWindow"],
    ['{"maxTokens": 1.5}', "maxTokens"],
    ['{"thinkingLevelMap": {"ultra": "max"}}', "thinkingLevelMap"],
    ['{"thinkingLevelMap": {"high": ""}}', "thinkingLevelMap"],
    ['{"reasoning": "yes"}', "reasoning"],
  ];

  for (const [value, field] of rejected) {
    assert.throws(
      () => parseAgentModelAttributes(value),
      (error: unknown) => error instanceof HarnessError && error.message.includes(field),
      `${value} must be rejected`,
    );
  }
});

test("duplicate modalities collapse instead of repeating", () => {
  assert.deepEqual(parseAgentModelAttributes('{"input": ["image", "text", "image"]}'), {
    input: ["image", "text"],
  });
});

/** A runtime pointed at a caller-supplied endpoint; nothing is called on it. */
async function createEndpointRuntime(options: {
  modelAttributes?: Parameters<typeof createPiRuntime>[0]["modelAttributes"];
  contextWindow?: number;
}) {
  return createPiRuntime({
    provider: "self-hosted",
    model: "MiniMax-M3",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKind: "openai-completions",
    ...options,
  });
}

test("the catalogue's record is what the runtime tells the provider", async () => {
  const runtime = await createEndpointRuntime({
    modelAttributes: {
      name: "MiniMax M3",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 512_000,
      thinkingLevelMap: { off: "none", max: "max" },
    },
  });

  // The bug this whole path exists to fix: a 1M-window model used to be
  // advertised to the composer with the 272k fallback.
  assert.equal(runtime.model.contextWindow, 1_048_576);
  assert.equal(runtime.model.maxTokens, 512_000);
  assert.equal(runtime.model.name, "MiniMax M3");
  assert.deepEqual(runtime.model.input, ["text", "image"]);
  assert.deepEqual(runtime.model.thinkingLevelMap, { off: "none", max: "max" });
});

test("an explicit window still outranks the catalogue's", async () => {
  const runtime = await createEndpointRuntime({
    contextWindow: 4_096,
    modelAttributes: { contextWindow: 1_048_576 },
  });

  assert.equal(runtime.model.contextWindow, 4_096);
});

test("a model nobody described keeps the previous defaults", async () => {
  const runtime = await createEndpointRuntime({});

  assert.equal(runtime.model.contextWindow, DEFAULT_AGENT_CONTEXT_WINDOW);
  assert.equal(runtime.model.maxTokens, DEFAULT_AGENT_MAX_TOKENS);
  assert.deepEqual(runtime.model.input, ["text", "image"]);
  assert.equal(runtime.model.reasoning, true);
});

test("a model that takes no images says so", async () => {
  const runtime = await createEndpointRuntime({ modelAttributes: { input: ["text"] } });

  // pi drops image parts for a model whose input excludes them, which beats
  // the provider failing the whole request.
  assert.deepEqual(runtime.model.input, ["text"]);
});

function createDetails(overrides: Partial<ServerLLMModelDetails>): ServerLLMModelDetails {
  return {
    id: "MiniMax-M3",
    name: "MiniMax-M3",
    capabilities: { vision: true, webSearch: false, reasoning: true, toolCalling: true },
    ...overrides,
  };
}

test("the catalogue record becomes agent attributes, window and all", () => {
  assert.deepEqual(
    toAgentModelAttributes(createDetails({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 512_000,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
      thinkingLevelMap: { off: "none", max: "max" },
    })),
    {
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 512_000,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
      thinkingLevelMap: { off: "none", max: "max" },
    },
  );
});

test("a Server that knows nothing leaves the runtime on its own defaults", () => {
  // All-false capabilities are what an unrecognized model reports; turning
  // those into attributes would pin the model to values nobody chose.
  assert.equal(toAgentModelAttributes(undefined), undefined);
  assert.equal(toAgentModelAttributes(createDetails({})), undefined);
});

test("the capability summary alone does not decide the model's reasoning", () => {
  // `capabilities.reasoning` is the picker's summary and reads false for an
  // unknown model, so it must not become an attribute — the model would lose
  // its effort options for no better reason than nobody having heard of it.
  assert.deepEqual(
    toAgentModelAttributes(createDetails({
      capabilities: { vision: false, webSearch: false, reasoning: false, toolCalling: false },
      contextWindow: 1_048_576,
    })),
    { contextWindow: 1_048_576 },
  );
});
