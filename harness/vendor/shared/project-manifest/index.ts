import { isProjectKind, type ProjectKind } from "@steamharness/project-types";
import { DATABASE_IDENTIFIER_PATTERN, DATABASE_UUID_PATTERN, normalizeDatabaseRequirement, type DatabaseRequirement } from "@steamharness/database-spaces";
import { normalizeProjectCardMetadata, validateProjectCardMetadata, type ProjectCardMetadata } from "../project-card-metadata/index";
import { normalizeProjectInfo, type ProjectInfoContract } from "../project-info/index";
import { readProjectConfig } from "./config";
export * from "./config";
export const PROJECT_MANIFEST_FILE = "steamharness.json";

export interface ProjectEntry {
  entryId: string;
  type: ProjectKind;
  name: string;
  /** Entry identity only; version and distribution identity belong to the aggregate. */
  projectCard?: ProjectCardMetadata;
  projectInfo?: ProjectInfoContract;
  /** Directory relative to the aggregate root. */
  root: string;
  /** Executable module or static HTML, relative to root. */
  entry: string;
  /** Configuration definition JSON, relative to root. */
  configuration?: string;
  /** Resolved host metadata; steamharness.json entries declare only alias strings. */
  databases: DatabaseRequirement[];
  schedulePresets?: unknown[];
}
export interface ProjectManifest {
  projectId: string;
  name: string;
  version?: string;
  description?: string;
  projectCard?: ProjectCardMetadata;
  projectInfo?: ProjectInfoContract;
  entries: ProjectEntry[];
  defaultEntry: string;
}
export interface ProjectEntryDeclaration extends Omit<ProjectEntry, "databases"> {
  databases: string[];
}
export interface ProjectDeclaration extends Omit<ProjectManifest, "entries"> {
  version: string;
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
  return { projectId: input.projectId.toLowerCase(), name: input.name, entries, defaultEntry: input.defaultEntry,
    ...(typeof input.version === "string" ? {version:input.version} : {}),
    ...(typeof input.description === "string" ? {description:input.description} : {}),
    ...(input.projectCard === undefined ? {} : {projectCard: validateProjectCardMetadata(input.projectCard)}),
    ...(input.projectInfo === undefined ? {} : {projectInfo: normalizeProjectInfo(input.projectInfo)}) };
}

/** Parse the authored root document. Child configurations are loaded only for explicit registrations. */
function rootDocument(value: unknown): Record<string, unknown> {
  const input = record(value, PROJECT_MANIFEST_FILE);
  if (Object.keys(input).some(key => !["id", "name", "version", "description", "defaultEntry", "entries", "projectCard", "projectInfo", "builtinRelease"].includes(key))) throw new Error(`${PROJECT_MANIFEST_FILE} contains unsupported fields.`);
  if (typeof input.id !== "string" || !DATABASE_UUID_PATTERN.test(input.id)) throw new Error(`${PROJECT_MANIFEST_FILE}.id must be the aggregate project's UUID.`);
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error(`${PROJECT_MANIFEST_FILE}.name is required.`);
  if (typeof input.version !== "string" || !/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error(`${PROJECT_MANIFEST_FILE}.version must use x.y.z format.`);
  if (input.description !== undefined && typeof input.description !== "string") throw new Error(`${PROJECT_MANIFEST_FILE}.description must be a string.`);
  if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 64) throw new Error(`${PROJECT_MANIFEST_FILE}.entries must contain 1–64 registered entries.`);
  const ids = new Set<string>();
  for (const raw of input.entries) {
    const entry = record(raw, "entries");
    if (typeof entry.entryId !== "string" || !DATABASE_IDENTIFIER_PATTERN.test(entry.entryId)) throw new Error("entries.entryId must be an identifier.");
    if (ids.has(entry.entryId)) throw new Error("entries contains duplicate entryId values.");
    ids.add(entry.entryId);
    const root = normalizeEntryPath(entry.root, "entries.root", true);
    if (root !== "." && Object.keys(entry).some(key => !["entryId", "root"].includes(key))) throw new Error("Child entry registrations contain only entryId and root; declare entry settings in the child's steamharness.json.");
    if (root === "." && entry.entry === undefined) throw new Error("Root entries must declare their executable entry inline.");
  }
  if (typeof input.defaultEntry !== "string" || !ids.has(input.defaultEntry)) throw new Error(`${PROJECT_MANIFEST_FILE}.defaultEntry must identify a registered entry.`);
  return input;
}
export function projectEntryConfigRoots(value: unknown): string[] {
  const input = rootDocument(value);
  return [...new Set((input.entries as Array<{root:string}>).filter(entry => entry.root !== ".").map(entry => entry.root))];
}
/** The declaration path is also the write destination for entry-specific settings. */
export function projectEntryDeclarationPath(value: unknown, entryId: string): string {
  const input = rootDocument(value);
  const entry = selectProjectEntry(input as unknown as {entries:Array<{entryId:string;root:string}>;defaultEntry:string}, entryId);
  return entry.root === "." ? PROJECT_MANIFEST_FILE : `${entry.root}/${PROJECT_MANIFEST_FILE}`;
}
export async function readProjectDeclarationWithReader(value: unknown, load: (root: string) => Promise<unknown>): Promise<ProjectDeclaration> {
  const roots = projectEntryConfigRoots(value);
  const children = Object.fromEntries(await Promise.all(roots.map(async root => [root, await load(root)])));
  return readProjectDeclaration(value, children);
}
export function readProjectDeclaration(value: unknown, children: Record<string, unknown> = {}): ProjectDeclaration {
  const input = rootDocument(value);
  const entries = (input.entries as unknown[]).map((raw, index) => {
    const registration = record(raw, `entries[${index}]`);
    let entry = registration;
    if (registration.root !== ".") {
      const child = record(children[registration.root as string], `${registration.root}/${PROJECT_MANIFEST_FILE}`);
      if (Object.keys(child).some(key => !["type", "name", "entry", "configuration", "projectCard", "projectInfo", "databases", "schedulePresets"].includes(key))) throw new Error(`${registration.root}/${PROJECT_MANIFEST_FILE} contains unsupported fields; child entries cannot declare project identity or more entries.`);
      entry = { ...child, entryId: registration.entryId, root: registration.root };
    }
    const aliases = entry.databases ?? [];
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== "string" || !DATABASE_IDENTIFIER_PATTERN.test(alias))) throw new Error("Entry databases must contain only alias strings; configure database IDs in config.json.");
    if (new Set(aliases).size !== aliases.length) throw new Error(`entries[${index}].databases contains duplicate aliases.`);
    return { ...normalizeProjectEntry({ ...entry, databases: [] }, `entries[${index}]`), databases: aliases as string[] };
  });
  const defaultType = selectProjectEntry({entries, defaultEntry: input.defaultEntry as string}).type;
  return { projectId: (input.id as string).toLowerCase(), name: input.name as string, version: input.version as string, entries, defaultEntry: input.defaultEntry as string,
    ...(input.description === undefined ? {} : {description: input.description as string}),
    ...(input.projectCard === undefined ? {} : {projectCard: validateProjectCardMetadata({...normalizeProjectCardMetadata(undefined, defaultType), ...record(input.projectCard, "projectCard")})}),
    ...(input.projectInfo === undefined ? {} : {projectInfo: normalizeProjectInfo(input.projectInfo)}) };
}

/** Resolve an entry's declared aliases using the independent deployment configuration. */
export function readProjectManifest(value: unknown, configValue?: unknown, env: Record<string, string | undefined> = {}, children: Record<string, unknown> = {}): ProjectManifest {
  return resolveProjectDatabases(readProjectDeclaration(value, children), configValue, env);
}
export function resolveProjectDatabases(declaration: ProjectDeclaration, configValue?: unknown, env: Record<string, string | undefined> = {}): ProjectManifest {
  const config = readProjectConfig(configValue, env);
  return { ...declaration, entries: declaration.entries.map(entry => ({ ...entry, databases: entry.databases.map(alias => {
    const databaseId = config.databases[alias];
    if (!databaseId) throw new Error(`Entry "${entry.entryId}" refers to unconfigured database alias "${alias}".`);
    return { alias, databaseId };
  }) })) };
}

export function normalizeProjectEntry(value: unknown, field = "entry"): ProjectEntry {
  const item = record(value, field);
  if (Object.keys(item).some((key) => !["entryId", "type", "name", "projectCard", "projectInfo", "root", "entry", "configuration", "databases", "schedulePresets"].includes(key))) throw new Error(`${field} contains unsupported fields.`);
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
  return { entryId: item.entryId, type: item.type, name: item.name.trim(), root, entry, databases, ...(projectCard === undefined ? {} : { projectCard }), ...(item.projectInfo === undefined ? {} : { projectInfo: normalizeProjectInfo(item.projectInfo) }), ...(configuration === undefined ? {} : { configuration }), ...(item.schedulePresets === undefined ? {} : { schedulePresets: item.schedulePresets as unknown[] }) };
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
export function projectManifestForDistribution<T extends Record<string, unknown>>(document: T): T {
  rootDocument(document);
  return structuredClone(document);
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
