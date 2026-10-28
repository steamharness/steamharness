import { isProjectKind, type ProjectKind } from "@steamharness/project-types";
import { DATABASE_IDENTIFIER_PATTERN, DATABASE_UUID_PATTERN, normalizeDatabaseRequirement, type DatabaseRequirement } from "@steamharness/database-spaces";
import { normalizeProjectCardMetadata, validateProjectCardMetadata, type ProjectCardMetadata } from "../project-card-metadata/index";

export interface ProjectEntry {
  entryId: string;
  type: ProjectKind;
  name: string;
  /** Entry identity only; version and distribution identity belong to the aggregate. */
  projectCard?: ProjectCardMetadata;
  /** Directory relative to the aggregate root. */
  root: string;
  /** Executable module or static HTML, relative to root. */
  entry: string;
  /** Configuration definition JSON, relative to root. */
  configuration?: string;
  databases: DatabaseRequirement[];
  schedulePresets?: unknown[];
}
export interface ProjectManifest {
  projectId: string;
  name: string;
  entries: ProjectEntry[];
  defaultEntry: string;
}

/** The sole project declaration. Deliberately rejects pre-aggregate manifests. */
export function readProjectManifest(value: unknown): ProjectManifest {
  const pkg = record(value, "package.json");
  if (typeof pkg.id !== "string" || !DATABASE_UUID_PATTERN.test(pkg.id)) throw new Error("package.json.id must be the aggregate project's UUID.");
  if (typeof pkg.name !== "string" || !pkg.name.trim()) throw new Error("package.json.name is required.");
  const config = record(pkg.steamHarness, "steamHarness");
  for (const field of ["projectType", "kanban", "dataStorage", "relatedProjects", "dependencies", "projectGroup"]) {
    if (field in config) throw new Error(`steamHarness.${field} was removed. Register entries and database requirements instead.`);
  }
  if (config.projectInfo && typeof config.projectInfo === "object") {
    for (const field of ["dataStorage", "relatedProjects"]) if (field in (config.projectInfo as object)) throw new Error(`steamHarness.projectInfo.${field} was removed.`);
  }
  if (!Array.isArray(config.entries) || !config.entries.length || config.entries.length > 64) throw new Error("steamHarness.entries must contain 1–64 registered entries.");
  const entries = config.entries.map((item, index) => normalizeProjectEntry(item, `steamHarness.entries[${index}]`));
  if (new Set(entries.map((entry) => entry.entryId)).size !== entries.length) throw new Error("steamHarness.entries contains duplicate entryId values.");
  if (typeof config.defaultEntry !== "string" || !entries.some((entry) => entry.entryId === config.defaultEntry)) throw new Error("steamHarness.defaultEntry must identify a registered entry.");
  return { projectId: pkg.id.toLowerCase(), name: pkg.name, entries, defaultEntry: config.defaultEntry };
}

export function normalizeProjectEntry(value: unknown, field = "entry"): ProjectEntry {
  const item = record(value, field);
  if (Object.keys(item).some((key) => !["entryId", "type", "name", "projectCard", "root", "entry", "configuration", "databases", "schedulePresets"].includes(key))) throw new Error(`${field} contains unsupported fields.`);
  if (typeof item.entryId !== "string" || !DATABASE_IDENTIFIER_PATTERN.test(item.entryId)) throw new Error(`${field}.entryId must be an identifier.`);
  if (!isProjectKind(item.type)) throw new Error(`${field}.type must be workflow, conversation, or kanban.`);
  if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 256) throw new Error(`${field}.name is required.`);
  const projectCard = item.projectCard === undefined ? undefined : validateProjectCardMetadata({
    ...normalizeProjectCardMetadata(undefined, item.type),
    ...record(item.projectCard, `${field}.projectCard`),
  });
  const root = normalizeEntryPath(item.root, `${field}.root`, true);
  const entry = normalizeEntryPath(item.entry, `${field}.entry`);
  if (item.type === "kanban" ? !/\.html$/i.test(entry) : !/\.[cm]?[jt]sx?$/i.test(entry)) throw new Error(`${field}.entry must be ${item.type === "kanban" ? "an HTML artifact" : "an executable module"}.`);
  const configuration = item.configuration === undefined ? undefined : normalizeEntryPath(item.configuration, `${field}.configuration`);
  if (!Array.isArray(item.databases)) throw new Error(`${field}.databases must be an array (use [] for no database access).`);
  const databases = item.databases.map((database, index) => normalizeDatabaseRequirement(database, `${field}.databases[${index}]`));
  if (new Set(databases.map((database) => database.alias)).size !== databases.length) throw new Error(`${field}.databases contains duplicate aliases.`);
  if (item.schedulePresets !== undefined && !Array.isArray(item.schedulePresets)) throw new Error(`${field}.schedulePresets must be an array.`);
  return { entryId: item.entryId, type: item.type, name: item.name.trim(), root, entry, databases, ...(projectCard === undefined ? {} : { projectCard }), ...(configuration === undefined ? {} : { configuration }), ...(item.schedulePresets === undefined ? {} : { schedulePresets: item.schedulePresets as unknown[] }) };
}

export function selectProjectEntry(manifest: Pick<ProjectManifest, "entries" | "defaultEntry">, entryId = manifest.defaultEntry): ProjectEntry {
  const entry = manifest.entries.find((item) => item.entryId === entryId);
  if (!entry) throw new Error(`Unknown project entry "${entryId}".`);
  return entry;
}
export function projectEntryKey(projectId: string, entryId: string): string {
  if (!DATABASE_UUID_PATTERN.test(projectId) || !DATABASE_IDENTIFIER_PATTERN.test(entryId)) throw new Error("Invalid project or entry identity.");
  return `${projectId.toLowerCase()}:${entryId}`;
}
export function projectManifestTypes(manifest: Pick<ProjectManifest, "entries">): ProjectKind[] {
  return [...new Set(manifest.entries.map((entry) => entry.type))];
}
/** Database IDs are portable references; all authorization stays on the host. */
export function projectManifestForDistribution<T extends Record<string, unknown>>(pkg: T): T {
  const manifest = readProjectManifest(pkg);
  return { ...pkg, steamHarness: { ...record(pkg.steamHarness, "steamHarness"), entries: manifest.entries } };
}
export function normalizeEntryPath(value: unknown, field: string, allowRoot = false): string {
  if (allowRoot && value === ".") return ".";
  if (typeof value !== "string" || !value.length || value.includes("\\") || /[\0?#:]/.test(value) || value.startsWith("/") || value.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment === "node_modules" || segment === ".git")) throw new Error(`${field} must be a safe relative path inside the aggregate project.`);
  return value;
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
