import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

const TEMPORARY_PROVIDER_ERROR = /\b(?:upstream_error|temporarily_unavailable)\b|\b(?:service|server|provider|upstream)(?:\s+is)?\s+temporarily\s+unavailable\b/i;
const CONNECTION_ERROR = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|ERR_STREAM_PREMATURE_CLOSE|ERR_HTTP2_STREAM_CANCEL)\b/i;
// Status must be identified as such (or be an SDK's leading HTTP status), not
// merely appear somewhere in an ID, token count or free-form provider message.
const HTTP_STATUS = /(?:^|\n)\s*(?:Error:\s*)?([45]\d{2})(?=\s|:|$)|\b(?:HTTP(?:\/\d(?:\.\d)?)?|API\s+error|status(?:Code)?)\s*["':=(\s]*(\b[45]\d{2}\b)/gi;
// Do not promote deterministic errors merely because a gateway wraps them in
// upstream_error. Pi still applies its quota/billing exclusions to the full text.
const PERMANENT_PROVIDER_ERROR = /\b(?:bad_request|invalid[ _-]?(?:api[ _-]?(?:key|token)|credentials?|token|request|model|input|parameters?|arguments?)(?:[ _-]error)?|authentication[ _-]?(?:error|failed)|unauthori[sz]ed|(?:permission|access)[ _-]?(?:denied|error)|forbidden|quota(?:[ _-](?:exceeded|exhausted))?|insufficient_quota|context[ _-](?:length|window)[ _-]exceeded|maximum context length|(?:model|deployment)[ _-]not[ _-]found|input_too_long)\b/i;

/** Normalize provider failures before either Pi retry policy classifies them. */
export function normalizeAssistantError(message: AssistantMessage, signal?: AbortSignal): AssistantMessage {
  if (signal?.aborted) return message;
  // A provider's abort is cancellation only when the caller cancelled this request.
  if (message.stopReason === "aborted") return { ...message, stopReason: "error",
    errorMessage: `Model connection lost without a cancellation request (provider reported aborted).${message.errorMessage ? ` ${message.errorMessage}` : ""}` };
  const text = message.errorMessage;
  if (message.stopReason !== "error" || !text) return message;
  const statuses = [...text.matchAll(HTTP_STATUS)].map(match => Number(match[1] ?? match[2]));
  if (PERMANENT_PROVIDER_ERROR.test(text) || statuses.some(status => status < 500 && ![408, 409, 429].includes(status))) return message;
  const transientStatus = statuses.some(status => status === 408 || status === 409 || status === 429 || status >= 500);
  const prefix = TEMPORARY_PROVIDER_ERROR.test(text) || transientStatus ? "Service unavailable"
    : CONNECTION_ERROR.test(text) ? "Connection error" : undefined;
  if (prefix === undefined || text.startsWith(`${prefix}: `)) return message;
  // Pi classifies text, including SSE failures that have no HTTP status. Supply
  // its canonical wording while retaining the complete provider error for users,
  // durable history and retry diagnostics. Keep normalization idempotent.
  return { ...message, errorMessage: `${prefix}: ${text}` };
}

/** Convert only errors caught at a provider boundary, retaining billed partials. */
export function createAssistantErrorMessage(
  model: Model<Api>, cause: unknown, signal?: AbortSignal, partial?: AssistantMessage,
): AssistantMessage {
  return normalizeAssistantError({
    ...(partial ?? { role: "assistant", content: [], api: model.api, provider: model.provider,
      model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
    stopReason: signal?.aborted || cause instanceof Error && cause.name === "AbortError" ? "aborted" : "error",
    errorMessage: describeProviderError(cause),
  }, signal);
}

/** Never serialize request/response objects, headers, credentials or stacks. */
function describeProviderError(cause: unknown, seen = new Set<unknown>()): string {
  if (cause === null || typeof cause !== "object") return String(cause);
  if (seen.has(cause) || seen.size >= 5) return "";
  seen.add(cause);
  const value = cause as Record<string, unknown>;
  const parts: string[] = [];
  const name = typeof value.name === "string" && value.name !== "Error" ? value.name : undefined;
  if (typeof value.message === "string") parts.push(name ? `${name}: ${value.message}` : value.message);
  else if (name) parts.push(name);
  if (typeof value.code === "string" || typeof value.code === "number") parts.push(`code: ${value.code}`);
  for (const key of ["status", "statusCode"] as const) {
    if (typeof value[key] === "number" || typeof value[key] === "string" && /^[45]\d{2}$/.test(value[key])) {
      parts.push(`HTTP ${value[key]}`);
    }
  }
  if (value.cause !== undefined) {
    const nested = describeProviderError(value.cause, seen);
    if (nested) parts.push(`cause: ${nested}`);
  }
  return parts.join("; ") || "Model request failed";
}
