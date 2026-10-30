import type { AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeAssistantError } from "./stream-error";

/** One initial model request plus at most ten fallback requests. */
export const AGENT_PROVIDER_MAX_RETRIES = 10;

/** Retry decisions use the response state, never provider-specific error text. */
export async function retryAssistantResponse(
  produce: () => Promise<AssistantMessage>, signal?: AbortSignal, baseDelayMs = 500,
): Promise<AssistantMessage> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    // The caller catches only provider errors inside produce. Host callbacks
    // (usage accounting, storage and observers) must still reject immediately.
    const message = normalizeAssistantError(await produce(), signal);
    if (message.stopReason !== "error" || attempt >= AGENT_PROVIDER_MAX_RETRIES) return message;
    if (!await waitBeforeRetry(attempt + 1, signal, baseDelayMs)) return { ...message, stopReason: "aborted" };
  }
}

/** An abort interrupts the bounded exponential backoff immediately. */
export function waitBeforeRetry(attempt: number, signal?: AbortSignal, baseDelayMs = 500): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  const delayMs = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), 8_000) * (1 - Math.random() * 0.25);
  return new Promise(resolve => {
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
