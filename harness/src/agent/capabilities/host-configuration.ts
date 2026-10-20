const HOST_BRIDGE_URL_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL";
const HOST_BRIDGE_TOKEN_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN";
const HOST_BRIDGE_TIMEOUT_MS = 15_000;

export interface HostBridgeConfig {
  url: string;
  token: string;
}

/**
 * Reads the loopback bridge a host injects for this run.
 *
 * Only the host may activate this tool. A project with no bridge environment
 * simply does not expose it, and a bridge that is not an authenticated
 * loopback endpoint is refused rather than dialled — the token would
 * otherwise be sent somewhere it does not belong.
 */
export function readHostConfigurationBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): HostBridgeConfig | undefined {
  const rawUrl = env[HOST_BRIDGE_URL_ENV]?.trim();
  const token = env[HOST_BRIDGE_TOKEN_ENV]?.trim();
  if (!rawUrl || !token) return undefined;
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("The developer-assistant host bridge must use an authenticated loopback URL.");
  }
  return { url: url.toString(), token };
}

export async function requestHostBridge(
  operation: string,
  input: Record<string, unknown>,
  config: HostBridgeConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HOST_BRIDGE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operation,
      input,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json() as unknown;
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
    const message = typeof error.message === "string"
      ? error.message
      : "Host project configuration operation failed.";
    const failure = new Error(message);
    if (typeof error.code === "string") Object.assign(failure, { code: error.code });
    throw failure;
  }
  return payload.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
