export interface AuthUserInfo {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
}

export interface AuthConfig {
  serverUrl: string;
  apiKey: string;
  /** Optional private system-AI service connection; never falls back to the project server. */
  aiServerUrl?: string;
  aiApiKey?: string;
  expiresAt?: string;
  user?: AuthUserInfo;
  source?: "device_flow" | "manual" | "password";
}

export interface AuthEnvLike {
  STEAMHARNESS_CLI_AUTH_DIR?: string;
  STEAMHARNESS_DESKTOP_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  APPDATA?: string;
  HOME?: string;
  platform?: string;
}

export const STEAMHARNESS_AUTH_FILE_NAME = "workflow-auth.json";
export const STEAMHARNESS_DESKTOP_CONFIG_FILE_NAME = "workflow-desktop.json";

const DEFAULT_MAC_PLATFORM = "darwin";
const DEFAULT_WINDOWS_PLATFORM = "win32";
const DEFAULT_OTHER_PLATFORM = "linux";

export function createEmptyWorkflowAuthConfig(): AuthConfig {
  return {
    serverUrl: "",
    apiKey: "",
  };
}

export function normalizeWorkflowAuthConfig(
  value: unknown,
): AuthConfig {
  if (!isRecord(value)) {
    return createEmptyWorkflowAuthConfig();
  }

  const aiServerUrl = readString(value.aiServerUrl);
  const aiApiKey = readString(value.aiApiKey);
  return {
    // Accept legacy field names (remoteUrl, token) from pre-migration
    // config files so existing users don't lose their credentials on upgrade.
    serverUrl: readString(value.serverUrl) ?? readString(value.remoteUrl) ?? "",
    apiKey: readString(value.apiKey) ?? readString(value.token) ?? "",
    ...(aiServerUrl === undefined && aiApiKey === undefined ? {} : {
      aiServerUrl: aiServerUrl ?? "",
      aiApiKey: aiApiKey ?? "",
    }),
    expiresAt: readString(value.expiresAt),
    user: isRecord(value.user)
      ? {
          userId: readString(value.user.userId) ?? "",
          email: readString(value.user.email) ?? "",
          displayName: readString(value.user.displayName) ?? "",
          avatarUrl: readString(value.user.avatarUrl),
        }
      : undefined,
    source: value.source === "device_flow" || value.source === "manual" || value.source === "password"
      ? value.source
      : undefined,
  };
}

export function isWorkflowAuthConfigLoggedIn(config: AuthConfig): boolean {
  return config.serverUrl.trim() !== "" && config.apiKey.trim() !== "";
}

export function isWorkflowAuthConfigAiLoggedIn(config: AuthConfig): boolean {
  return (config.aiServerUrl ?? "").trim() !== "" && (config.aiApiKey ?? "").trim() !== "";
}

export function isWorkflowAuthExpiringSoon(
  expiresAt: string | undefined,
  options: { now?: number; thresholdMs?: number } = {},
): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }
  const now = options.now ?? Date.now();
  const thresholdMs = options.thresholdMs ?? 1000 * 60 * 60 * 24 * 3;
  return expiresAtMs - now <= thresholdMs;
}

export function resolveWorkflowCliAuthDir(
  env: AuthEnvLike = readProcessEnv(),
): string {
  if (readString(env.STEAMHARNESS_CLI_AUTH_DIR)) {
    return normalizePath(env.STEAMHARNESS_CLI_AUTH_DIR!);
  }

  if (readPlatform(env) === DEFAULT_WINDOWS_PLATFORM) {
    return joinPath(
      env.APPDATA ?? joinPath(resolveHomeDir(env), "AppData", "Roaming"),
      "steamharness",
    );
  }

  if (readPlatform(env) === DEFAULT_MAC_PLATFORM) {
    return joinPath(resolveHomeDir(env), "Library", "Application Support", "steamharness");
  }

  return joinPath(
    env.XDG_CONFIG_HOME ?? joinPath(resolveHomeDir(env), ".config"),
    "steamharness",
  );
}

export function resolveWorkflowCliAuthFilePath(
  env: AuthEnvLike = readProcessEnv(),
): string {
  return joinPath(resolveWorkflowCliAuthDir(env), STEAMHARNESS_AUTH_FILE_NAME);
}

export function resolveWorkflowDesktopConfigDir(
  env: AuthEnvLike = readProcessEnv(),
): string {
  if (readString(env.STEAMHARNESS_DESKTOP_CONFIG_DIR)) {
    return normalizePath(env.STEAMHARNESS_DESKTOP_CONFIG_DIR!);
  }

  if (readPlatform(env) === DEFAULT_WINDOWS_PLATFORM) {
    return joinPath(
      env.APPDATA ?? joinPath(resolveHomeDir(env), "AppData", "Roaming"),
      "steamharness",
    );
  }

  if (readPlatform(env) === DEFAULT_MAC_PLATFORM) {
    return joinPath(resolveHomeDir(env), "Library", "Application Support", "steamharness");
  }

  return joinPath(
    env.XDG_CONFIG_HOME ?? joinPath(resolveHomeDir(env), ".config"),
    "steamharness",
  );
}

export function resolveWorkflowDesktopConfigFilePath(
  env: AuthEnvLike = readProcessEnv(),
): string {
  return joinPath(resolveWorkflowDesktopConfigDir(env), STEAMHARNESS_DESKTOP_CONFIG_FILE_NAME);
}

function resolveHomeDir(env: AuthEnvLike): string {
  return env.HOME ?? "";
}

function readPlatform(env: AuthEnvLike): string {
  return env.platform ?? readProcessPlatform();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part !== "").join("/"));
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized.slice(0, 2);
    const rest = normalized.slice(2).replace(/\/+/g, "/");
    return `${drive}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  return normalized.replace(/\/+/g, "/");
}

function readProcessEnv(): AuthEnvLike {
  const processValue = readGlobalProcess();
  return {
    ...(processValue?.env ?? {}),
    platform: processValue?.platform ?? DEFAULT_OTHER_PLATFORM,
  };
}

function readProcessPlatform(): string {
  return readGlobalProcess()?.platform ?? DEFAULT_OTHER_PLATFORM;
}

function readGlobalProcess():
  | { env?: Record<string, string | undefined>; platform?: string }
  | undefined {
  const processValue = Reflect.get(globalThis, "process");
  if (typeof processValue !== "object" || processValue === null) {
    return undefined;
  }
  return processValue as { env?: Record<string, string | undefined>; platform?: string };
}
