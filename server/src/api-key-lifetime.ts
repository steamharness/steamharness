const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_API_KEY_TTL_MS = 30 * DAY_MS;
export const DESKTOP_API_KEY_TTL_MS = 90 * DAY_MS;

export function resolveApiKeyTtlMs(source: string): number {
  return source.trim().toLowerCase() === "desktop" ? DESKTOP_API_KEY_TTL_MS : DEFAULT_API_KEY_TTL_MS;
}

export function createApiKeyExpiresAt(source: string, now = Date.now()): string {
  return new Date(now + resolveApiKeyTtlMs(source)).toISOString();
}

export function createSlidingApiKeyExpiresAt(source: string, now = Date.now()): string | undefined {
  return source.trim().toLowerCase() === "desktop"
    ? new Date(now + DESKTOP_API_KEY_TTL_MS).toISOString()
    : undefined;
}
