import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, type Api, type Model } from "@earendil-works/pi-ai";
import { createAssistantErrorMessage, normalizeAssistantError } from "../agent/stream-error";
import { retryAssistantResponse, waitBeforeRetry } from "../agent/provider-retry";

const model = { api: "faux", provider: "faux", id: "test" } as Model<Api>;

for (const errorMessage of ["Upstream response stream was interrupted", "未知供应商错误", "", undefined,
  "401 invalid API key", "422 invalid argument", "insufficient_quota", "context_length_exceeded", "read ECONNRESET"]) {
  test(`fallback retries model errors independently of their diagnostics: ${String(errorMessage)}`, async () => {
    const source = fauxAssistantMessage("Partial", { stopReason: "error", errorMessage });
    assert.equal(normalizeAssistantError(source), source);
    let calls = 0;
    const result = await retryAssistantResponse(async () => ++calls === 1 ? source : fauxAssistantMessage("Recovered"), undefined, 0);
    assert.equal(calls, 2); assert.equal(result.stopReason, "stop");
    assert.equal(source.errorMessage, errorMessage);
    assert.equal(source.content[0]?.type, "text");
  });
}

test("unknown errors exhaust ten retries and preserve the final diagnostic", async () => {
  let calls = 0;
  const result = await retryAssistantResponse(async () => fauxAssistantMessage([], {
    stopReason: "error", errorMessage: `未知错误 ${++calls}`,
  }), undefined, 0);
  assert.equal(calls, 11); assert.equal(result.stopReason, "error"); assert.equal(result.errorMessage, "未知错误 11");
});

test("caller cancellation stays terminal, including a late success and aborting during backoff", async () => {
  const controller = new AbortController(); controller.abort();
  const source = fauxAssistantMessage([], { stopReason: "aborted" });
  assert.equal(normalizeAssistantError(source, controller.signal), source);
  assert.equal(normalizeAssistantError(fauxAssistantMessage("Late success"), controller.signal).stopReason, "aborted");
  const waiting = new AbortController();
  const wait = waitBeforeRetry(10, waiting.signal); waiting.abort();
  assert.equal(await wait, false);
  let calls = 0;
  await assert.rejects(retryAssistantResponse(async () => { calls++; return source; }, controller.signal, 0), { name: "AbortError" });
  assert.equal(calls, 0);
  const active = new AbortController();
  const result = await retryAssistantResponse(async () => { calls++; active.abort(); return source; }, active.signal, 0);
  assert.equal(calls, 1); assert.equal(result.stopReason, "aborted");
});

test("structured provider failures retain safe diagnostics and billed partials with bounded cyclic causes", () => {
  const cause = { code: "ECONNREFUSED", statusCode: 501, cause: undefined as unknown,
    headers: { authorization: "secret-header" }, request: { apiKey: "secret-key" }, response: { body: "secret-body" } };
  cause.cause = cause;
  const partial = fauxAssistantMessage("Retained");
  const message = createAssistantErrorMessage(model, new Error("Transport failed", { cause }), undefined, partial);
  assert.match(message.errorMessage ?? "", /Transport failed.*ECONNREFUSED.*501/);
  assert.doesNotMatch(message.errorMessage ?? "", /secret|authorization|apiKey|\[object Object\]/);
  assert.equal(message.content, partial.content); assert.equal(message.usage, partial.usage);
});

test("a provider AbortError is an error unless the caller cancelled", () => {
  const cause = new DOMException("The operation was aborted", "AbortError");
  assert.equal(createAssistantErrorMessage(model, cause).stopReason, "error");
  assert.equal(normalizeAssistantError(fauxAssistantMessage([], { stopReason: "aborted" })).stopReason, "error");
  const controller = new AbortController(); controller.abort();
  assert.equal(createAssistantErrorMessage(model, cause, controller.signal).stopReason, "aborted");
});
