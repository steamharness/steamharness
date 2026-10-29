import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { normalizeAssistantError } from "../agent/stream-error";

test("temporary provider wording and bare transport codes reach Pi's retry classifier without losing diagnostics", () => {
  for (const errorMessage of [
    "upstream_error: Upstream service temporarily unavailable",
    "Upstream service temporarily unavailable",
    "The provider is temporarily unavailable",
    "temporarily_unavailable: Please try later",
    "upstream_error: Failed to reach upstream",
    "read ECONNRESET", "write EPIPE", "UND_ERR_SOCKET: other side disconnected", "ERR_STREAM_PREMATURE_CLOSE",
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
