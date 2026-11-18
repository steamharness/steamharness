import assert from "node:assert/strict";
import test from "node:test";
import { createLLMProvider, LLM_PROVIDER_TYPES, type LLMChatInput } from "../provider/llm/index";
import { llmSSE } from "./fixtures/llm-sse";

const input: LLMChatInput = { system: "System instructions", messages: [
  { role: "user", content: "Last question" }, { role: "assistant", content: "Last answer" },
  { role: "user", content: "Next question" },
], maxOutputTokens: 128 };

for (const type of LLM_PROVIDER_TYPES) {
  test(`${type} buffers or streams one request with history and usage`, async () => {
    const requests: string[] = [];
    const provider = createLLMProvider({ type, model: "test-model", apiKey: "fixture-key", baseURL: "https://model.example.test/proxy/v1/",
      async fetch(url, init) {
        assert.equal(new URL(String(url)).pathname, `/proxy/v1/${type === "anthropic" ? "messages" : type === "openai-responses" ? "responses" : "chat/completions"}`);
        assert.equal(new Headers(init?.headers).get(type === "anthropic" ? "x-api-key" : "authorization"), type === "anthropic" ? "fixture-key" : "Bearer fixture-key");
        const body = String(init?.body);
        requests.push(body);
        const data = JSON.parse(body);
        assert.equal(data.model, "test-model"); assert.equal(data.stream, true);
        assert.ok(data.tools === undefined || data.tools.length === 0);
        return llmSSE(type, "返事");
      },
    });
    const result = await provider.chat(input);
    assert.equal(requests.length, 1);
    assert.match(requests[0]!, /Last question.*Last answer.*Next question/);
    assert.match(requests[0]!, /System instructions/);
    assert.equal(result.text, "返事"); assert.equal(result.finishReason, "stop");
    assert.equal(result.usage?.totalTokens, 14);
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.inputTokenDetails.cacheReadTokens, 2);
    const chunks = [];
    for await (const chunk of provider.stream(input)) chunks.push(chunk);
    assert.equal(requests.length, 2);
    assert.equal(chunks.flatMap(chunk => chunk.type === "text-delta" ? [chunk.text] : []).join(""), "返事");
    assert.deepEqual(chunks.at(-1), { type: "finish", finishReason: "stop", usage: result.usage });
  });

  test(`${type} rejects partial EOF and does not retry`, async () => {
    let calls = 0;
    const provider = createLLMProvider({ type, apiKey: "fixture", async fetch() { calls++; return llmSSE(type, "partial", false); } });
    const seen: string[] = [];
    await assert.rejects(async () => {
      for await (const chunk of provider.stream(input)) seen.push(chunk.type);
    }, /stream did not complete/);
    assert.equal(calls, 1);
    assert.ok(seen.includes("text-delta"));
    assert.ok(!seen.includes("finish"));
  });
}

test("native search is explicit and remains server-side", async () => {
  for (const type of ["openai-responses", "anthropic"] as const) {
    const provider = createLLMProvider({ type, apiKey: "fixture", webSearch: true, async fetch(_url, init) {
      const { tools } = JSON.parse(String(init?.body));
      assert.deepEqual(tools, [type === "anthropic" ? { type: "web_search_20250305", name: "web_search", max_uses: 5 }
        : { type: "web_search", search_context_size: "medium" }]);
      return llmSSE(type);
    } });
    assert.equal((await provider.chat(input)).text, "hello");
  }
});

test("JSON-only endpoints fail, and upstream authentication details are not exposed", async () => {
  let calls = 0;
  const provider = createLLMProvider({ type: "openai-responses", apiKey: "fixture", async fetch() {
    return ++calls === 1 ? Response.json({ status: "completed" }) : Response.json({ error: { message: "sensitive upstream details" } }, { status: 401 });
  } });
  await assert.rejects(() => provider.chat(input), /supports streaming/);
  await assert.rejects(() => provider.chat(input), (error: Error) => /authentication failed \(HTTP 401\)/.test(error.message) && !error.message.includes("sensitive"));
  assert.equal(calls, 2);
});
