/** A receipt timeout leaves execution unknown. Every attempt keeps the same command ID. */
export const AGENT_COMMAND_TIMEOUT_MS = 30_000;
export const AGENT_COMMAND_MAX_RETRIES = 3;
// Includes all receipt windows and backoff, with time for the host to persist the result.
export const AGENT_COMMAND_REQUEST_TIMEOUT_MS = 135_000;

export function retryableAgentCommandError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth >= 5) return false;
  const value = error as { name?: string; code?: string; status?: number; statusCode?: number; cause?: unknown };
  if (value.name === 'TimeoutError') return true;
  if (['AGENT_NOT_READY', 'AGENT_COMMAND_TIMEOUT', 'STEAMHARNESS_WORKER_INTERRUPTED',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(value.code ?? '')) return true;
  const status = value.status ?? value.statusCode;
  return status === 408 || status === 429 || typeof status === 'number' && status >= 500 && status < 600
    || value.cause !== error && value.cause !== undefined && retryableAgentCommandError(value.cause, depth + 1);
}

export async function confirmAgentCommand<T>(options: {
  apply(): Promise<T>;
  confirmed: Promise<T>;
  terminated(): boolean;
  timeoutError(): Error;
  retry(attempt: number): void;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.terminated()) return await options.confirmed;
      return await Promise.race([options.confirmed, options.apply(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(options.timeoutError()), AGENT_COMMAND_TIMEOUT_MS);
      })]);
    } catch (error) {
      if (options.terminated() || attempt >= AGENT_COMMAND_MAX_RETRIES || !retryableAgentCommandError(error)) throw error;
      options.retry(attempt + 1);
    } finally { clearTimeout(timeout); }
    let delay: ReturnType<typeof setTimeout> | undefined;
    try {
      // A late receipt also ends backoff; a stopped/closed owner rejects confirmed.
      const result = await Promise.race([
        options.confirmed.then(value => ({ value })),
        new Promise<undefined>(resolve => { delay = setTimeout(() => resolve(undefined), 500 * 2 ** attempt); }),
      ]);
      if (result) return result.value;
    } finally { clearTimeout(delay); }
  }
}
