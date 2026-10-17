const HOST_BRIDGE_URL_ENV = "WORKFLOW_STUDIO_CONTROL_BRIDGE_URL";
const HOST_BRIDGE_TOKEN_ENV = "WORKFLOW_STUDIO_CONTROL_BRIDGE_TOKEN";
const HOST_PERMISSION_POLICY_ENV = "WORKFLOW_STUDIO_CONTROL_PERMISSION_POLICY";
const HOST_BRIDGE_TIMEOUT_MS = 30_000;

export interface StudioControlHostBridgeConfig {
  url: string;
  token: string;
  permissionPolicy?: "read-only" | "workspace" | "auto";
}

export function readStudioControlHostBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): StudioControlHostBridgeConfig | undefined {
  const rawUrl = env[HOST_BRIDGE_URL_ENV]?.trim();
  const token = env[HOST_BRIDGE_TOKEN_ENV]?.trim();
  if (!rawUrl && !token) return undefined;
  if (!rawUrl || !token) throw new Error("Incomplete Studio Control host bridge configuration.");
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/studio-control" || url.search || url.hash || url.username || url.password) {
    throw new Error("Studio Control requires an authenticated loopback host bridge.");
  }
  const permissionPolicy = env[HOST_PERMISSION_POLICY_ENV] ?? "workspace";
  if (permissionPolicy !== "read-only" && permissionPolicy !== "workspace" && permissionPolicy !== "auto") {
    throw new Error("Invalid Studio Control permission policy.");
  }
  return { url: url.toString(), token, permissionPolicy };
}

export async function callStudioControlHost(
  operation: string,
  input: Record<string, unknown>,
  config: StudioControlHostBridgeConfig | undefined = readStudioControlHostBridgeConfig(),
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!config) throw new Error("Studio Control is available only inside Workflow Studio.");
  const timeoutSignal = AbortSignal.timeout(HOST_BRIDGE_TIMEOUT_MS);
  const requestSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal]);
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operation, input, permissionPolicy: config.permissionPolicy ?? "workspace" }),
    signal: requestSignal,
  });
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
    const failure = new Error(
      typeof error.message === "string" ? error.message : "Studio Control operation failed.",
    );
    if (typeof error.code === "string") Object.assign(failure, { code: error.code });
    throw failure;
  }
  return payload.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
