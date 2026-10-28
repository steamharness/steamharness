import { isProjectKind, type ProjectKind } from "@steamharness/project-types";
import { DATABASE_IDENTIFIER_PATTERN, DATABASE_UUID_PATTERN, normalizeDatabaseRequirement, type DatabaseRequirement } from "@steamharness/database-spaces";
import { normalizeProjectCardMetadata, validateProjectCardMetadata, type ProjectCardMetadata } from "../project-card-metadata/index";
import { readProjectConfig } from "./config";
export * from "./config";

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
  /** Resolved host metadata; package.json entries declare only alias strings. */
  databases: DatabaseRequirement[];
  schedulePresets?: unknown[];
}
export interface ProjectManifest {
  projectId: string;
  name: string;
  entries: ProjectEntry[];
  defaultEntry: string;
}
export interface ProjectEntryDeclaration extends Omit<ProjectEntry, "databases"> {
  databases: string[];
}
export interface ProjectDeclaration extends Omit<ProjectManifest, "entries"> {
  entries: ProjectEntryDeclaration[];
}

/** Validate a host's resolved registration, distinct from an authored package declaration. */
export function normalizeProjectManifest(value: unknown): ProjectManifest {
  const input = record(value, "project registration");
  if (typeof input.projectId !== "string" || !DATABASE_UUID_PATTERN.test(input.projectId)) throw new Error("Project registration requires a UUID.");
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("Project registration name is required.");
  if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 64) throw new Error("Project registration requires 1–64 entries.");
  const entries = input.entries.map((entry, index) => normalizeProjectEntry(entry, `entries[${index}]`));
  if (new Set(entries.map(entry => entry.entryId)).size !== entries.length) throw new Error("Project registration contains duplicate entryId values.");
  if (typeof input.defaultEntry !== "string" || !entries.some(entry => entry.entryId === input.defaultEntry)) throw new Error("Project registration defaultEntry must identify a registered entry.");
  return { projectId: input.projectId.toLowerCase(), name: input.name, entries, defaultEntry: input.defaultEntry };
}

/** The sole project declaration. Deliberately rejects pre-aggregate manifests. */
export function readProjectDeclaration(value: unknown): ProjectDeclaration {
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
  const entries = config.entries.map((item, index) => {
    const input = record(item, `steamHarness.entries[${index}]`);
    const aliases = input.databases ?? [];
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== "string" || !DATABASE_IDENTIFIER_PATTERN.test(alias))) throw new Error("Package entry databases must contain only alias strings; configure database IDs in config.json.");
    if (new Set(aliases).size !== aliases.length) throw new Error(`steamHarness.entries[${index}].databases contains duplicate aliases.`);
    return { ...normalizeProjectEntry({ ...input, databases: [] }, `steamHarness.entries[${index}]`), databases: aliases as string[] };
  });
  if (new Set(entries.map((entry) => entry.entryId)).size !== entries.length) throw new Error("steamHarness.entries contains duplicate entryId values.");
  if (typeof config.defaultEntry !== "string" || !entries.some((entry) => entry.entryId === config.defaultEntry)) throw new Error("steamHarness.defaultEntry must identify a registered entry.");
  return { projectId: pkg.id.toLowerCase(), name: pkg.name, entries, defaultEntry: config.defaultEntry };
}

/** Resolve an entry's declared aliases using the independent deployment configuration. */
export function readProjectManifest(value: unknown, configValue?: unknown, env: Record<string, string | undefined> = {}): ProjectManifest {
  const declaration = readProjectDeclaration(value);
  const config = readProjectConfig(configValue, env);
  return { ...declaration, entries: declaration.entries.map(entry => ({ ...entry, databases: entry.databases.map(alias => {
    const databaseId = config.databases[alias];
    if (!databaseId) throw new Error(`Entry "${entry.entryId}" refers to unconfigured database alias "${alias}".`);
    return { alias, databaseId };
  }) })) };
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

export function selectProjectEntry<T extends { entryId: string }>(manifest: { entries: T[]; defaultEntry: string }, entryId = manifest.defaultEntry): T {
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
/** Distribution keeps entry aliases; database IDs remain in config.json. */
export function projectManifestForDistribution<T extends Record<string, unknown>>(pkg: T): T {
  const manifest = readProjectDeclaration(pkg);
  const entries = manifest.entries.map(({ databases, ...entry }) => ({ ...entry, ...(databases.length ? { databases } : {}) }));
  return { ...pkg, steamHarness: { ...record(pkg.steamHarness, "steamHarness"), entries } };
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
