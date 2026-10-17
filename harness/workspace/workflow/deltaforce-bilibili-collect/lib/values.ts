export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clampPositiveInteger(
  value: unknown,
  fallback: number,
  options: { min?: number; max?: number; name: string },
): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

export function normalizeOptionalPositiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return numeric;
}

export function normalizeOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  const numeric = normalizeOptionalPositiveNumber(value, name);
  return numeric === undefined ? undefined : Math.floor(numeric);
}

export function sanitizeFileSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized === "" ? "file" : normalized;
}
