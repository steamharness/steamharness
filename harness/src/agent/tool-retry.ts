import { waitBeforeRetry } from "./provider-retry";

const MAX_RETRIES = 3;
function terminal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as { type?: string; name?: string; status?: number; statusCode?: number; retryable?: boolean; metadata?: { retryable?: boolean } };
  return error.retryable === false || error.metadata?.retryable === false || error.name === "AbortError"
    || ["execution_aborted", "user_input_required", "tool_permission_denied", "input_validation"].includes(error.type ?? "")
    || [401, 403].includes(error.status ?? error.statusCode ?? 0);
}

/** Only explicitly replayable tools repeat. Approval/configuration and storage failures stay outside this boundary. */
export async function retryAgentTool<T extends { isError?: boolean; details?: unknown; diagnostics?: unknown; control?: unknown }>(options: {
  replay?: string;
  signal?: AbortSignal;
  delayMs?: number;
  before(): Promise<T | void>;
  execute(): Promise<T>;
  canRetry?(): boolean | Promise<boolean>;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const blocked = await options.before();
    if (blocked) return blocked;
    let result: T;
    try { result = await options.execute(); }
    catch (error) {
      if (options.replay !== "safe" || attempt >= MAX_RETRIES || terminal(error) || await options.canRetry?.() === false) throw error;
      if (!await waitBeforeRetry(attempt + 1, options.signal, options.delayMs)) options.signal?.throwIfAborted();
      continue;
    }
    if (!result.isError || options.replay !== "safe" || attempt >= MAX_RETRIES || result.control
      || terminal(result.details) || terminal(result.diagnostics) || await options.canRetry?.() === false) return result;
    if (!await waitBeforeRetry(attempt + 1, options.signal, options.delayMs)) options.signal?.throwIfAborted();
  }
}
