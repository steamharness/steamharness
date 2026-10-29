import type { AssistantMessage } from "@earendil-works/pi-ai";

const TEMPORARY_PROVIDER_ERROR = /\b(?:upstream_error|temporarily_unavailable)\b|\b(?:service|server|provider|upstream)(?:\s+is)?\s+temporarily\s+unavailable\b/i;
const CONNECTION_ERROR = /\b(?:ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE)\b/i;
// Do not promote deterministic errors merely because a gateway wraps them in
// upstream_error. Pi still applies its quota/billing exclusions to the full text.
const PERMANENT_PROVIDER_ERROR = /\b(?:400|401|402|403|404|413|422|bad_request|invalid[ _-]?(?:api[ _-]?(?:key|token)|credentials?|token|request|model|input|parameters?|arguments?)(?:[ _-]error)?|authentication[ _-]?(?:error|failed)|unauthori[sz]ed|(?:permission|access)[ _-]?(?:denied|error)|forbidden|quota(?:[ _-](?:exceeded|exhausted))?|insufficient_quota|context[ _-](?:length|window)[ _-]exceeded|maximum context length|(?:model|deployment)[ _-]not[ _-]found|input_too_long)\b/i;

/** Normalize provider failures before either Pi retry policy classifies them. */
export function normalizeAssistantError(message: AssistantMessage, signal?: AbortSignal): AssistantMessage {
  if (signal?.aborted) return message;
  // A provider's abort is cancellation only when the caller cancelled this request.
  if (message.stopReason === "aborted") return { ...message, stopReason: "error",
    errorMessage: `Model connection lost without a cancellation request (provider reported aborted).${message.errorMessage ? ` ${message.errorMessage}` : ""}` };
  const text = message.errorMessage;
  if (message.stopReason !== "error" || !text || PERMANENT_PROVIDER_ERROR.test(text)) return message;
  const prefix = TEMPORARY_PROVIDER_ERROR.test(text) ? "Service unavailable"
    : CONNECTION_ERROR.test(text) ? "Connection error" : undefined;
  if (prefix === undefined || text.startsWith(`${prefix}: `)) return message;
  // Pi classifies text, including SSE failures that have no HTTP status. Supply
  // its canonical wording while retaining the complete provider error for users,
  // durable history and retry diagnostics. Keep normalization idempotent.
  return { ...message, errorMessage: `${prefix}: ${text}` };
}
