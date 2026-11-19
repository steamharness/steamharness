import type { ServiceChannel } from "@steamharness/service-urls";

export interface DeviceContext {
  clientKind: "studio" | "cli-web" | "cli";
  channel: ServiceChannel;
  state: string;
  returnUrl?: string;
}

export const studioProtocols: Record<ServiceChannel, string> = {
  dev: "steamharness-studio-dev", main: "steamharness-studio",
};

export function parseDeviceContext(value: unknown): DeviceContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("Invalid sign-in context.");
  const input = value as Record<string, unknown>;
  if (!["studio", "cli-web", "cli"].includes(String(input.clientKind)) ||
      !["dev", "main"].includes(String(input.channel)) ||
      typeof input.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) {
    throw new Error("Invalid sign-in context.");
  }
  const context: DeviceContext = { clientKind: input.clientKind as DeviceContext["clientKind"], channel: input.channel as ServiceChannel, state: input.state };
  if (input.returnUrl !== undefined) {
    if (context.clientKind !== "cli-web" || typeof input.returnUrl !== "string" || input.returnUrl.length > 2048) throw new Error("Invalid sign-in return address.");
    const url = new URL(input.returnUrl);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || /[\\\x00-\x20\x7f]/.test(input.returnUrl)) {
      throw new Error("Invalid sign-in return address.");
    }
    context.returnUrl = url.toString();
  }
  return context;
}

export function deviceReturnUrl(context?: DeviceContext): string | undefined {
  const checked = parseDeviceContext(context);
  if (!checked) return undefined;
  if (checked.clientKind === "studio") {
    return `${studioProtocols[checked.channel]}://studio.studio-workstation/auth/callback?state=${encodeURIComponent(checked.state)}`;
  }
  if (checked.returnUrl) {
    const url = new URL(checked.returnUrl);
    url.searchParams.set("auth_state", checked.state);
    return url.toString();
  }
  return undefined;
}

export interface AuthUser {
  userId: string;
  email: string | null;
  displayName: string;
  avatarUrl?: string;
  username?: string | null;
}
export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  intervalSeconds: number;
}
export interface DeviceToken {
  accessToken: string;
  apiKey: { id: string; prefix?: string; expiresAt?: string };
  user: AuthUser;
  expiresAt?: string;
}
interface Envelope<T> { errCode: number; errMessage?: string; data?: T }

export class ServerAuthError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

export function normalizeAuthServer(value: string): string {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid server address.");
  if (["localhost", "[::1]"].includes(url.hostname)) url.hostname = "127.0.0.1";
  return url.toString().replace(/\/+$/, "");
}

/** The device secret stays in the host; only its public verification URL enters the browser. */
export class ServerAuthClient {
  readonly serverUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly locale?: string;
  constructor(serverUrl: string, fetcher: typeof fetch = fetch, locale?: string) {
    this.serverUrl = normalizeAuthServer(serverUrl); this.fetcher = fetcher; this.locale = locale;
  }
  private async request<T>(path: string, body?: object, signal?: AbortSignal): Promise<Envelope<T>> {
    const response = await this.fetcher(`${this.serverUrl}/api/auth${path}`, {
      method: body ? "POST" : "GET", redirect: "error", credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { Accept: "application/json", ...(this.locale ? {"X-SteamHarness-Locale":this.locale} : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json() as Envelope<T>;
    if (typeof result.errCode !== "number") throw new ServerAuthError("Invalid server response.", response.status);
    return result;
  }
  async start(input: { clientName: string; source: "desktop" | "cli"; context?: DeviceContext }, signal?: AbortSignal): Promise<DeviceStart> {
    const result = await this.request<DeviceStart>("/device/start", input, signal);
    if (result.errCode !== 0 || !result.data) throw new ServerAuthError(result.errMessage || "Sign-in failed.", result.errCode);
    const data = result.data;
    const verification = new URL(data.verificationUriComplete || data.verificationUri);
    const server = new URL(this.serverUrl);
    if (verification.origin !== server.origin || verification.pathname !== `${server.pathname.replace(/\/$/, "")}/login/device` ||
        !data.deviceCode || !Number.isFinite(Date.parse(data.expiresAt)) || !Number.isFinite(data.intervalSeconds) || data.intervalSeconds < 1) {
      throw new ServerAuthError("Invalid server response.");
    }
    return data;
  }
  async poll(started: DeviceStart, signal: AbortSignal): Promise<DeviceToken> {
    let interval = Math.max(1000, started.intervalSeconds * 1000);
    while (Date.now() < Date.parse(started.expiresAt)) {
      signal.throwIfAborted();
      const result = await this.request<DeviceToken & { retryAfterSeconds?: number }>("/device/token", { deviceCode: started.deviceCode }, signal);
      if (result.errCode === 0) {
        const data = result.data;
        if (typeof data?.accessToken !== "string" || !data.accessToken || typeof data.apiKey?.id !== "string" || !data.apiKey.id ||
            typeof data.user?.userId !== "string" || !data.user.userId || typeof data.user.displayName !== "string" ||
            data.user.email !== null && typeof data.user.email !== "string") throw new ServerAuthError("Invalid server response.");
        signal.throwIfAborted();
        return data;
      }
      if (result.errMessage === "slow_down") interval = Math.max(interval, Math.min(60, result.data?.retryAfterSeconds || 10) * 1000);
      else if (result.errMessage !== "authorization_pending") throw new ServerAuthError(result.errMessage || "Sign-in failed.", result.errCode);
      await abortableDelay(Math.min(interval, Math.max(0, Date.parse(started.expiresAt) - Date.now())), signal);
    }
    throw new ServerAuthError("expired_token", 409);
  }
  async cancel(deviceCode: string): Promise<void> { await this.request("/device/cancel", { deviceCode }); }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
