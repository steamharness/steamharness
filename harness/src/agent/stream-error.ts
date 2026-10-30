import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

/** Preserve provider diagnostics and distinguish caller cancellation from provider aborts. */
export function normalizeAssistantError(message: AssistantMessage, signal?: AbortSignal): AssistantMessage {
  if (signal?.aborted) return message.stopReason === "aborted" ? message : { ...message, stopReason: "aborted" };
  // A provider's abort is cancellation only when the caller cancelled this request.
  if (message.stopReason === "aborted") return { ...message, stopReason: "error",
    errorMessage: `Model connection lost without a cancellation request (provider reported aborted).${message.errorMessage ? ` ${message.errorMessage}` : ""}` };
  return message;
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
