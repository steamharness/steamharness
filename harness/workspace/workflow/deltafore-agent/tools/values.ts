export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readRequiredString(value: unknown, name: string): string {
  const text = readOptionalString(value);

  if (text === undefined) {
    throw new Error(`Tool argument "${name}" is required.`);
  }

  return text;
}

export function readSearchQueries(args: Record<string, unknown>): string[] {
  const values: string[] = [];
  // Keep the public tool contract narrow: searchItems accepts only queries.
  collectSearchQueryValues(args.queries, values);

  const unique = [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
  if (unique.length === 0) {
    throw new Error('Tool argument "queries" is required.');
  }

  return unique;
}

export function readAttributeNames(args: Record<string, unknown>): string[] {
  const values: string[] = [];
  collectSearchQueryValues(args.attributes, values);

  const unique = [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
  if (unique.length === 0) {
    throw new Error('Tool argument "attributes" is required.');
  }

  return unique;
}

export function readClassQueries(args: Record<string, unknown>): string[] {
  const values: string[] = [];
  collectSearchQueryValues(args.classes, values);

  const unique = [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
  if (unique.length === 0) {
    throw new Error('Tool argument "classes" is required.');
  }

  return unique;
}

export function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const text = value.trim();
  return text === "" ? undefined : text;
}

export function readObjectID(value: unknown): string | number {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }

  throw new Error('Tool argument "objectID" is required.');
}

export function readLimit(value: unknown, fallback: number): number {
  const limit = typeof value === "number" ? value : Number(value ?? fallback);

  if (!Number.isFinite(limit)) {
    return fallback;
  }

  return Math.min(50, Math.max(1, Math.trunc(limit)));
}

function collectSearchQueryValues(value: unknown, values: string[]): void {
  if (typeof value === "string" || typeof value === "number") {
    values.push(String(value));
    return;
  }

  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    collectSearchQueryValues(item, values);
  }
}
