export const DATABASE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RESERVED_PROJECT_ARTIFACT_NAMES = ["steamharness", "cache", "reports", "release", "tmp"] as const;

/** Entry IDs also name directories in dist and host runtime storage. */
export function isProjectEntryId(value: unknown): value is string {
  return typeof value === "string" && DATABASE_IDENTIFIER_PATTERN.test(value)
    && !RESERVED_PROJECT_ARTIFACT_NAMES.some(name => name === value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
}
