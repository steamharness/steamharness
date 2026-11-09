import { DATABASE_UUID_PATTERN, isProjectEntryId } from "./identity";
import { PROJECT_RELEASE_BASE_DIRECTORY, isProjectToolArtifactPath } from "./artifact-paths";

export const PROJECT_RELEASE_FILE = "steamharness.release.json";
export const PROJECT_RELEASE_DIRECTORY = `${PROJECT_RELEASE_BASE_DIRECTORY}/project`;
export type ProjectDistributionMode = "auto" | "source" | "release";

export interface ProjectReleaseEntryOverride {
  entry?: string;
  configuration?: string;
  profiles?: string[];
  assets?: string[];
}
export interface ProjectReleaseConfiguration {
  entries?: string[];
  defaultEntry?: string;
  entryOverrides?: Record<string, ProjectReleaseEntryOverride>;
  build?: string[];
  files?: string[];
  /** Packages that cannot be bundled must be explicitly declared here. */
  externals?: string[];
}
export interface ProjectReleaseFile { path: string; size: number; sha256: string }
export interface ProjectReleaseEntry {
  entryId: string;
  root: string;
  entry: string;
  structure: string;
  configuration?: string;
  profiles?: string[];
}
export interface ProjectReleaseManifest {
  kind: "steamharness.project.release";
  version: 1;
  projectId: string;
  projectVersion: string;
  buildId: string;
  inputHash: string;
  entries: ProjectReleaseEntry[];
  files: ProjectReleaseFile[];
}

export function releasePath(value: unknown, glob = false): string {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f:<>"|]/.test(value)
    || value.split("/").some(part => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || !glob && /[*?\[\]{}!]/.test(value)) throw new Error(`Invalid release path: ${String(value)}`);
  return value;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields.`);
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item || item.includes("\0")) || new Set(value).size !== value.length) throw new Error(`${label} must contain unique nonempty strings.`);
  return [...value];
}
export function parseProjectReleaseConfiguration(value: unknown, registeredEntries: string[]): ProjectReleaseConfiguration | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) throw new Error("release must be an object.");
  keys(value, ["entries", "defaultEntry", "entryOverrides", "build", "files", "externals"], "release");
  const selected = value.entries === undefined ? registeredEntries : strings(value.entries, "release.entries");
  if (!selected.length || selected.some(id => !registeredEntries.includes(id))) throw new Error("release.entries must select registered entries.");
  if (value.defaultEntry !== undefined && (typeof value.defaultEntry !== "string" || !selected.includes(value.defaultEntry))) throw new Error("release.defaultEntry must select an included entry.");
  const result: ProjectReleaseConfiguration = { ...(value.entries === undefined ? {} : { entries: selected }), ...(value.defaultEntry === undefined ? {} : { defaultEntry: value.defaultEntry as string }) };
  if (value.entryOverrides !== undefined) {
    if (!object(value.entryOverrides)) throw new Error("release.entryOverrides must be an object.");
    result.entryOverrides = {};
    for (const [id, raw] of Object.entries(value.entryOverrides)) {
      if (!selected.includes(id) || !object(raw)) throw new Error(`Invalid release override for ${id}.`);
      keys(raw, ["entry", "configuration", "profiles", "assets"], `release.entryOverrides.${id}`);
      result.entryOverrides[id] = {
        ...(raw.entry === undefined ? {} : { entry: releasePath(raw.entry) }),
        ...(raw.configuration === undefined ? {} : { configuration: releasePath(raw.configuration) }),
        ...(raw.profiles === undefined ? {} : { profiles: strings(raw.profiles, "release profiles") }),
        ...(raw.assets === undefined ? {} : { assets: strings(raw.assets, "release assets").map(file => releasePath(file, true)) }),
      };
      if (result.entryOverrides[id].profiles?.length === 0) throw new Error("Release profiles cannot be empty.");
    }
  }
  if (value.build !== undefined) {
    if (!Array.isArray(value.build) || !value.build.length || value.build.some(arg => typeof arg !== "string" || arg.includes("\0")) || !value.build[0]) throw new Error("release.build must be a nonempty command argument array.");
    result.build = [...value.build];
  }
  if (value.files !== undefined) result.files = strings(value.files, "release.files").map(file => releasePath(file, true));
  if (value.externals !== undefined) {
    result.externals = strings(value.externals, "release.externals");
    if (result.externals.some(name => !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name))) throw new Error("Release externals must be npm package names.");
  }
  return result;
}

export function isForbiddenReleasePath(filename: string): boolean {
  const parts = releasePath(filename).split("/");
  return parts.some(part => ["node_modules", ".git", ".DS_Store", ".data", ".local", ".workflow", ".release", ".steamharness", ".env", ".envrc", "workflow-auth.json", "tests", "__tests__", "e2e"].includes(part)
    || part.startsWith(".env.") || part.startsWith("._"))
    || isProjectToolArtifactPath(filename) || /\.(?:tsx?|jsx|map|tsbuildinfo)$/i.test(filename) || /\.(?:test|spec)\.[cm]?js$/i.test(filename);
}
export function parseProjectReleaseManifest(value: unknown): ProjectReleaseManifest {
  if (!object(value) || value.kind !== "steamharness.project.release" || value.version !== 1) throw new Error("Unsupported SteamHarness release format. Upgrade the host.");
  keys(value, ["kind", "version", "projectId", "projectVersion", "buildId", "inputHash", "entries", "files"], "release manifest");
  const hash = /^[a-f0-9]{64}$/;
  if (typeof value.projectId !== "string" || !DATABASE_UUID_PATTERN.test(value.projectId) || typeof value.projectVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.projectVersion)
    || typeof value.buildId !== "string" || !hash.test(value.buildId) || typeof value.inputHash !== "string" || !hash.test(value.inputHash)
    || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 64 || !Array.isArray(value.files) || !value.files.length) throw new Error("Invalid release manifest.");
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry) || !isProjectEntryId(entry.entryId) || ids.has(entry.entryId)) throw new Error("Invalid release entry.");
    ids.add(entry.entryId);
    keys(entry, ["entryId", "root", "entry", "structure", "configuration", "profiles"], "release entry");
    if (entry.root !== `entries/${entry.entryId}` || releasePath(entry.structure) !== `${entry.root}/structure.json`) throw new Error("Invalid release entry directory.");
    releasePath(entry.entry);
    if (entry.configuration !== undefined) releasePath(entry.configuration);
    if (entry.profiles !== undefined && !strings(entry.profiles, "release profiles").length) throw new Error("Invalid release profiles.");
  }
  const files = new Set<string>();
  for (const file of value.files) {
    if (!object(file)) throw new Error("Invalid release file.");
    keys(file, ["path", "size", "sha256"], "release file");
    const filename = releasePath(file.path), portable = filename.normalize("NFC").toLowerCase();
    if (filename === PROJECT_RELEASE_FILE || isForbiddenReleasePath(filename) || files.has(portable) || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || typeof file.sha256 !== "string" || !hash.test(file.sha256)) throw new Error(`Invalid release inventory: ${filename}`);
    files.add(portable);
  }
  for (const required of ["steamharness.json", "package.json", ...value.entries.flatMap(entry => [entry.structure, `${entry.root}/steamharness.json`, ...(entry.configuration ? [`${entry.root}/${entry.configuration}`] : [])])]) {
    if (!files.has(required.toLowerCase())) throw new Error(`Release inventory is missing ${required}.`);
  }
  return value as unknown as ProjectReleaseManifest;
}
