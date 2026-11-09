/** Validate a source-root-relative or aggregate-relative authored entry path. */
export function normalizeEntryPath(value: unknown, field: string, allowRoot = false): string {
  if (allowRoot && value === ".") return ".";
  if (typeof value !== "string" || !value.length || value.includes("\\") || /[\0?#:]/.test(value) || value.startsWith("/") || value.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment === "node_modules" || segment === ".git")) throw new Error(`${field} must be a safe relative path inside the aggregate project.`);
  return value;
}
