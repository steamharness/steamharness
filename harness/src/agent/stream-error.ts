import type { AssistantMessage } from "@earendil-works/pi-ai";

/** A provider's abort is cancellation only when the caller cancelled this request. */
export function normalizeAssistantCancellation(message: AssistantMessage, signal?: AbortSignal): AssistantMessage {
  if (message.stopReason !== "aborted" || signal?.aborted) return message;
  return { ...message, stopReason: "error",
    errorMessage: `Model connection lost without a cancellation request (provider reported aborted).${message.errorMessage ? ` ${message.errorMessage}` : ""}` };
}
