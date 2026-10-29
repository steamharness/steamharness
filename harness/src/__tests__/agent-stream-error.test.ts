import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, isRetryableAssistantError, type Api, type Model } from "@earendil-works/pi-ai";
import { createAssistantErrorMessage, normalizeAssistantError } from "../agent/stream-error";

const model = { api: "faux", provider: "faux", id: "test" } as Model<Api>;

test("temporary provider wording and bare transport codes reach Pi's retry classifier without losing diagnostics", () => {
  for (const errorMessage of [
    "upstream_error: Upstream service temporarily unavailable",
    "Upstream service temporarily unavailable",
    "The provider is temporarily unavailable",
    "temporarily_unavailable: Please try later",
    "upstream_error: Failed to reach upstream",
    "upstream_error: Request id 400 failed",
    "read ECONNRESET", "write EPIPE", "UND_ERR_SOCKET: other side disconnected", "ERR_STREAM_PREMATURE_CLOSE",
    "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ECONNABORTED",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
    "408 Request failed", "409 Request failed", "501 Request failed", "HTTP 507", 'statusCode: 599',
  ]) {
    const source = fauxAssistantMessage("Partial", { stopReason: "error", errorMessage });
    const normalized = normalizeAssistantError(source);
    assert.equal(isRetryableAssistantError(normalized), true, errorMessage);
    assert.ok(normalized.errorMessage?.includes(errorMessage));
    assert.equal(normalized.content, source.content);
    assert.equal(normalized.usage, source.usage);
    assert.equal(source.errorMessage, errorMessage);
    assert.equal(normalizeAssistantError(normalized), normalized, "normalizing twice must not add another prefix");
  }
});

test("upstream wrappers do not turn auth, validation, quota or context errors into transient failures", () => {
  for (const detail of [
    "401 invalid API key", "invalid_api_token", "invalid_credentials", "authentication_error", "unauthorized", "403 permission denied",
    "bad_request", "invalid_request_error", "invalid_model", "model_not_found", "invalid_input", "invalid parameter", "invalid arguments", "422 invalid argument",
    "insufficient_quota", "quota_exceeded", "quota_exhausted", "quota exceeded", "quota exhausted", "billing error", "out of budget",
    "context_length_exceeded", "context_window_exceeded", "input_too_long", "maximum context length exceeded",
  ]) {
    const source = fauxAssistantMessage([], { stopReason: "error", errorMessage: `upstream_error: ${detail}` });
    assert.equal(isRetryableAssistantError(normalizeAssistantError(source)), false, detail);
  }
});

test("only failed provider responses are normalized and caller cancellation stays terminal", () => {
  const errorMessage = "upstream_error: Upstream service temporarily unavailable";
  const source = fauxAssistantMessage([], { stopReason: "error", errorMessage });
  const controller = new AbortController(); controller.abort();
  assert.equal(normalizeAssistantError(source, controller.signal), source);
  const aborted = { ...source, stopReason: "aborted" as const };
  assert.equal(normalizeAssistantError(aborted, controller.signal), aborted);
  assert.equal(isRetryableAssistantError(normalizeAssistantError(aborted)), true);
  const success = { ...source, stopReason: "stop" as const };
  assert.equal(normalizeAssistantError(success), success);
});

test("structured provider failures retain only safe classification fields, with bounded cyclic causes", () => {
  const cause = { code: "ECONNREFUSED", statusCode: 501, cause: undefined as unknown,
    headers: { authorization: "secret-header" }, request: { apiKey: "secret-key" }, response: { body: "secret-body" } };
  cause.cause = cause;
  const partial = fauxAssistantMessage("Retained");
  const message = createAssistantErrorMessage(model, new Error("Transport failed", { cause }), undefined, partial);
  assert.equal(isRetryableAssistantError(message), true);
  assert.match(message.errorMessage ?? "", /Transport failed.*ECONNREFUSED.*501/);
  assert.doesNotMatch(message.errorMessage ?? "", /secret|authorization|apiKey|\[object Object\]/);
  assert.equal(message.content, partial.content); assert.equal(message.usage, partial.usage);
});

test("structured rejection statuses and unrelated numbers are not promoted to transient failures", () => {
  for (const status of [400, 401, 402, 403, 404, 405, 410, 413, 422]) {
    assert.equal(isRetryableAssistantError(createAssistantErrorMessage(model, { message: "Request rejected", status })), false);
  }
  for (const errorMessage of ["Request 408 failed", "tokens=408; request_id=501", "request_id=1408; output=1501"]) {
    const message = fauxAssistantMessage([], { stopReason: "error", errorMessage });
    assert.equal(normalizeAssistantError(message), message);
    assert.equal(isRetryableAssistantError(message), false);
  }
});

test("thrown AbortError is retryable only when the caller has not cancelled", () => {
  const cause = new DOMException("The operation was aborted", "AbortError");
  assert.equal(isRetryableAssistantError(createAssistantErrorMessage(model, cause)), true);
  const controller = new AbortController(); controller.abort();
  const cancelled = createAssistantErrorMessage(model, cause, controller.signal);
  assert.equal(cancelled.stopReason, "aborted"); assert.equal(isRetryableAssistantError(cancelled), false);
});
