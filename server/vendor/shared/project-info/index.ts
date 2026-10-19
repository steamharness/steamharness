export const STEAMHARNESS_PROJECT_DECLARATION_DEFINITIONS = [
  { id: "multilingual", labelKey: "projectDeclarationMultilingual" },
  { id: "multiplatform", labelKey: "projectDeclarationMultiplatform" },
] as const;

export const STEAMHARNESS_PROJECT_PLATFORM_DEFINITIONS = [
  { id: "macos", labelKey: "projectPlatformMacos" },
  { id: "windows", labelKey: "projectPlatformWindows" },
  { id: "web", labelKey: "projectPlatformWeb" },
] as const;

export type KnownProjectDeclaration =
  (typeof STEAMHARNESS_PROJECT_DECLARATION_DEFINITIONS)[number]["id"];
export type KnownProjectPlatform =
  (typeof STEAMHARNESS_PROJECT_PLATFORM_DEFINITIONS)[number]["id"];

export const STEAMHARNESS_PROJECT_DATA_STORAGE_MODES = ["local", "server", "both"] as const;

export type ProjectDataStorageMode =
  (typeof STEAMHARNESS_PROJECT_DATA_STORAGE_MODES)[number];
export type ProjectDataStorageLocation = Exclude<ProjectDataStorageMode, "both">;

export interface ProjectDataStorage {
  mode: ProjectDataStorageMode;
}

export const STEAMHARNESS_RELATED_PROJECT_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const STEAMHARNESS_RELATED_PROJECT_LIMIT = 32;
export const STEAMHARNESS_RELATED_PROJECT_PREFIX_LIMIT = 32;
export const STEAMHARNESS_RELATED_PROJECT_KEY_LIMIT = 1_024;

const STEAMHARNESS_PROJECT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * How far into one of the target project's resources a related project may
 * reach. `prefixes` means the same thing for every resource it rules: what the
 * consumer names has to start with one of them.
 */
export type ProjectAccessRule =
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "prefixes"; prefixes: string[] };

/** @deprecated Renamed to {@link ProjectAccessRule}: entrypoints use it too. */
export type ProjectKVAccessRule = ProjectAccessRule;

/** The target project's knowledge base, read and written separately. */
export interface RelatedProjectKnowledgeGrant {
  read: ProjectAccessRule;
  write: ProjectAccessRule;
}

/**
 * What the *target* project grants the consumer that names it.
 *
 * The direction is the one the manifest already had: this object sits in the
 * project being reached, and says what that project allows.
 *
 * `knowledge` and `entrypoints` are optional so that a manifest written before
 * they existed keeps meaning exactly what it did — a project that already
 * allowed another to read its KV did not thereby agree to hand over its
 * knowledge base or let it run its entrypoints.
 */
export interface RelatedProjectGrant {
  read: ProjectAccessRule;
  write: ProjectAccessRule;
  knowledge?: RelatedProjectKnowledgeGrant;
  /** Which of this project's entrypoints the consumer may call. */
  entrypoints?: ProjectAccessRule;
}

/** @deprecated Renamed to {@link RelatedProjectGrant}. */
export type RelatedProjectKVGrant = RelatedProjectGrant;

export interface RelatedProject {
  alias: string;
  projectId: string;
  grantToRelatedProject: RelatedProjectGrant;
}

export interface ResolvedRelatedProjectAccess {
  consumer: RelatedProject;
  target: RelatedProject;
  grant: RelatedProjectGrant;
}

export type ProjectPlatformSupport =
  | { mode: "agnostic" }
  | { mode: "specific"; platforms: string[] };

export interface ProjectInfoContract {
  localizedNames: Record<string, string>;
  declarations: string[];
  platformSupport: ProjectPlatformSupport;
  dataStorage: ProjectDataStorage | null;
  relatedProjects: RelatedProject[];
}

export type DeclaredProjectInfo = Omit<ProjectInfoContract, "dataStorage"> & {
  dataStorage: ProjectDataStorage;
};

const PROJECT_INFO_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function createDefaultProjectInfo(): DeclaredProjectInfo {
  return {
    localizedNames: {},
    declarations: [],
    platformSupport: { mode: "agnostic" },
    dataStorage: { mode: "both" },
    relatedProjects: [],
  };
}

export function createUndeclaredProjectInfo(): ProjectInfoContract {
  return {
    localizedNames: {},
    declarations: [],
    platformSupport: { mode: "agnostic" },
    dataStorage: null,
    relatedProjects: [],
  };
}

export function normalizeProjectInfo(value: unknown): ProjectInfoContract {
  if (!isRecord(value)) {
    throw new Error("steamHarness.projectInfo must be an object.");
  }

  const localizedNames = normalizeLocalizedNames(value["localizedNames"]);
  const declarations = normalizeIds(value["declarations"], "steamHarness.projectInfo.declarations");
  const platformSupport = normalizePlatformSupport(value["platformSupport"]);
  const dataStorage = normalizeDataStorage(value["dataStorage"]);
  const relatedProjects = normalizeRelatedProjects(value["relatedProjects"]);

  return { localizedNames, declarations, platformSupport, dataStorage, relatedProjects };
}

export function normalizeDeclaredProjectInfoInput(value: unknown): DeclaredProjectInfo {
  const normalized = normalizeProjectInfo(value);
  if (normalized.dataStorage === null) {
    throw new Error(
      "steamHarness.projectInfo.dataStorage.mode must be declared as local, server, or both.",
    );
  }
  return normalized as DeclaredProjectInfo;
}

export function readProjectInfo(packageJson: unknown): ProjectInfoContract {
  if (!isRecord(packageJson)) return createUndeclaredProjectInfo();
  const steamHarness = packageJson["steamHarness"];
  if (!isRecord(steamHarness) || steamHarness["projectInfo"] === undefined) {
    return createUndeclaredProjectInfo();
  }
  const projectInfo = normalizeProjectInfo(steamHarness["projectInfo"]);
  const projectId = typeof packageJson["id"] === "string" ? packageJson["id"].trim() : undefined;
  if (projectId !== undefined && projectId !== "") {
    assertProjectRelatedProjects(projectInfo, projectId);
  }
  return projectInfo;
}

export function writeProjectInfo(
  packageJson: Record<string, unknown>,
  projectInfo: DeclaredProjectInfo,
): Record<string, unknown> {
  const normalized = normalizeDeclaredProjectInfoInput(projectInfo);
  const projectId = typeof packageJson["id"] === "string" ? packageJson["id"].trim() : undefined;
  if (projectId !== undefined && projectId !== "") {
    assertProjectRelatedProjects(normalized, projectId);
  }
  const steamHarness = isRecord(packageJson["steamHarness"])
    ? packageJson["steamHarness"]
    : {};

  return {
    ...packageJson,
    steamHarness: {
      ...steamHarness,
      projectInfo: serializeProjectInfo(normalized),
    },
  };
}

export function serializeProjectInfo(projectInfo: ProjectInfoContract): Record<string, unknown> {
  const normalized = normalizeProjectInfo(projectInfo);
  return {
    localizedNames: { ...normalized.localizedNames },
    declarations: [...normalized.declarations],
    platformSupport: normalized.platformSupport.mode === "agnostic"
      ? { mode: "agnostic" }
      : { mode: "specific", platforms: [...normalized.platformSupport.platforms] },
    dataStorage: normalized.dataStorage === null
      ? null
      : { mode: normalized.dataStorage.mode },
    relatedProjects: normalized.relatedProjects.map(serializeProjectRelatedProject),
  };
}

export function createDefaultProjectRelatedProjectGrant(): RelatedProjectKVGrant {
  return {
    read: { mode: "all" },
    write: { mode: "none" },
  };
}

export function assertProjectRelatedProjects(
  projectInfo: ProjectInfoContract,
  currentProjectId: string,
): void {
  if (projectInfo.relatedProjects.length === 0) return;
  const normalizedProjectId = currentProjectId.trim();
  if (!STEAMHARNESS_PROJECT_UUID_PATTERN.test(normalizedProjectId)) {
    throw new Error("package.json.id must be a UUID before related projects can be declared.");
  }
  if (projectInfo.relatedProjects.some(
    (relation) => relation.projectId.toLowerCase() === normalizedProjectId.toLowerCase(),
  )) {
    throw new Error("steamHarness.projectInfo.relatedProjects cannot reference the current project.");
  }
}

export function findProjectRelatedProject(
  projectInfo: ProjectInfoContract,
  alias: string,
): RelatedProject | undefined {
  const normalizedAlias = alias.trim();
  return projectInfo.relatedProjects.find((relation) => relation.alias === normalizedAlias);
}

export function resolveProjectRelatedProjectAccess(input: {
  consumerProjectId: string;
  consumerProjectInfo: ProjectInfoContract;
  targetProjectId: string;
  targetProjectInfo: ProjectInfoContract;
  alias: string;
}): ResolvedRelatedProjectAccess | undefined {
  const consumer = findProjectRelatedProject(input.consumerProjectInfo, input.alias);
  if (consumer?.projectId.toLowerCase() !== input.targetProjectId.trim().toLowerCase()) {
    return undefined;
  }
  const target = input.targetProjectInfo.relatedProjects.find(
    (relation) => relation.projectId.toLowerCase() === input.consumerProjectId.trim().toLowerCase(),
  );
  if (target === undefined) return undefined;
  return { consumer, target, grant: target.grantToRelatedProject };
}

/**
 * Whether a rule admits one value — a KV key, an entrypoint id.
 *
 * `undefined` is a rule that was never written, and answers the same as
 * `{ mode: "none" }`: a capability nobody granted is not granted by default.
 */
export function isProjectAccessAllowed(
  rule: ProjectAccessRule | undefined,
  value: string,
): boolean {
  if (rule === undefined || rule.mode === "none") return false;
  if (rule.mode === "all") return true;
  return rule.prefixes.some((prefix) => value.startsWith(prefix));
}

/** @deprecated Renamed to {@link isProjectAccessAllowed}: entrypoint ids use it too. */
export function isProjectKVAccessAllowed(
  rule: ProjectAccessRule,
  key: string,
): boolean {
  return isProjectAccessAllowed(rule, key);
}

export function isProjectDataStorageLocationAllowed(
  projectInfo: ProjectInfoContract,
  location: ProjectDataStorageLocation,
): boolean {
  const mode = projectInfo.dataStorage?.mode;
  return mode === "both" || mode === location;
}

export function assertProjectDataStorageLocationAllowed(
  projectInfo: ProjectInfoContract,
  location: ProjectDataStorageLocation,
): void {
  const mode = projectInfo.dataStorage?.mode;
  if (mode === undefined) {
    throw new Error(
      "steamHarness.projectInfo.dataStorage.mode must be declared before this project can run or access data.",
    );
  }
  if (mode !== "both" && mode !== location) {
    throw new Error(
      `Project data storage mode "${mode}" does not allow ${location} storage access.`,
    );
  }
}

export function resolveProjectName(
  defaultName: string,
  projectInfo: ProjectInfoContract,
  locale?: string,
): string {
  const fallback = defaultName.trim();
  const localizedNames = projectInfo.localizedNames;
  const normalizedLocale = locale?.trim().toLowerCase() ?? "";
  const exact = Object.entries(localizedNames)
    .find(([key]) => key.toLowerCase() === normalizedLocale)?.[1];
  if (exact) return exact;
  if (normalizedLocale.startsWith("zh")) {
    const chinese = Object.entries(localizedNames)
      .find(([key]) => key.toLowerCase() === "zh-cn")?.[1];
    if (chinese) return chinese;
  }
  if (normalizedLocale.startsWith("en")) {
    const english = Object.entries(localizedNames)
      .find(([key]) => key.toLowerCase() === "en")?.[1];
    if (english) return english;
  }
  return fallback;
}

export function listProjectSearchNames(
  defaultName: string,
  projectInfo: ProjectInfoContract,
): string[] {
  return uniqueStrings([defaultName, ...Object.values(projectInfo.localizedNames)], false);
}

export function matchesProjectSearch(
  defaultName: string,
  projectInfo: ProjectInfoContract,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery === "") return true;
  return listProjectSearchNames(defaultName, projectInfo)
    .some((name) => name.toLocaleLowerCase().includes(normalizedQuery));
}

function normalizeLocalizedNames(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error("steamHarness.projectInfo.localizedNames must be an object.");
  }
  const entries: Array<[string, string]> = [];
  for (const [rawLocale, rawName] of Object.entries(value)) {
    const locale = rawLocale.trim();
    if (locale === "") {
      throw new Error("steamHarness.projectInfo.localizedNames contains an empty locale.");
    }
    if (typeof rawName !== "string") {
      throw new Error(`steamHarness.projectInfo.localizedNames.${locale} must be a string.`);
    }
    const name = rawName.trim();
    if (name !== "") entries.push([locale, name]);
  }
  return Object.fromEntries(entries);
}

function normalizePlatformSupport(value: unknown): ProjectPlatformSupport {
  if (value === undefined) return { mode: "agnostic" };
  if (!isRecord(value)) {
    throw new Error("steamHarness.projectInfo.platformSupport must be an object.");
  }
  if (value["mode"] === "agnostic") {
    if (value["platforms"] !== undefined) {
      throw new Error("steamHarness.projectInfo.platformSupport.platforms is not allowed in agnostic mode.");
    }
    return { mode: "agnostic" };
  }
  if (value["mode"] !== "specific") {
    throw new Error('steamHarness.projectInfo.platformSupport.mode must be "agnostic" or "specific".');
  }
  const platforms = normalizeIds(
    value["platforms"],
    "steamHarness.projectInfo.platformSupport.platforms",
  );
  if (platforms.length === 0) {
    throw new Error("steamHarness.projectInfo.platformSupport.platforms must contain at least one platform.");
  }
  return { mode: "specific", platforms };
}

function normalizeDataStorage(value: unknown): ProjectDataStorage | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Error("steamHarness.projectInfo.dataStorage must be an object.");
  }
  const mode = value["mode"];
  if (typeof mode !== "string" || !STEAMHARNESS_PROJECT_DATA_STORAGE_MODES.includes(
    mode as ProjectDataStorageMode,
  )) {
    throw new Error(
      'steamHarness.projectInfo.dataStorage.mode must be "local", "server", or "both".',
    );
  }
  return { mode: mode as ProjectDataStorageMode };
}

function normalizeRelatedProjects(value: unknown): RelatedProject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("steamHarness.projectInfo.relatedProjects must be an array.");
  }
  if (value.length > STEAMHARNESS_RELATED_PROJECT_LIMIT) {
    throw new Error(
      `steamHarness.projectInfo.relatedProjects supports at most ${STEAMHARNESS_RELATED_PROJECT_LIMIT} items.`,
    );
  }
  const aliases = new Set<string>();
  const projectIds = new Set<string>();
  return value.map((item, index) => {
    const field = `steamHarness.projectInfo.relatedProjects[${index}]`;
    if (!isRecord(item)) throw new Error(`${field} must be an object.`);
    const supportedFields = new Set(["alias", "projectId", "grantToRelatedProject"]);
    if (Object.keys(item).some((key) => !supportedFields.has(key))) {
      throw new Error(`${field} contains unsupported fields.`);
    }
    const alias = readRelatedProjectString(item["alias"], `${field}.alias`);
    if (!STEAMHARNESS_RELATED_PROJECT_ALIAS_PATTERN.test(alias)) {
      throw new Error(`${field}.alias is invalid.`);
    }
    if (aliases.has(alias)) {
      throw new Error(`steamHarness.projectInfo.relatedProjects contains duplicate alias "${alias}".`);
    }
    aliases.add(alias);
    const projectId = readRelatedProjectString(item["projectId"], `${field}.projectId`);
    if (!STEAMHARNESS_PROJECT_UUID_PATTERN.test(projectId)) {
      throw new Error(`${field}.projectId must be a UUID.`);
    }
    const normalizedProjectId = projectId.toLowerCase();
    if (projectIds.has(normalizedProjectId)) {
      throw new Error(`steamHarness.projectInfo.relatedProjects contains duplicate projectId "${projectId}".`);
    }
    projectIds.add(normalizedProjectId);
    return {
      alias,
      projectId,
      grantToRelatedProject: normalizeRelatedProjectGrant(
        item["grantToRelatedProject"],
        `${field}.grantToRelatedProject`,
      ),
    };
  });
}

function normalizeRelatedProjectGrant(
  value: unknown,
  field: string,
): RelatedProjectGrant {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  const supported = new Set(["read", "write", "knowledge", "entrypoints"]);
  if (Object.keys(value).some((key) => !supported.has(key))) {
    throw new Error(`${field} contains unsupported fields.`);
  }

  const grant: RelatedProjectGrant = {
    read: normalizeProjectAccessRule(value["read"], `${field}.read`),
    write: normalizeProjectAccessRule(value["write"], `${field}.write`),
  };

  const knowledge = value["knowledge"];
  if (knowledge !== undefined) {
    if (!isRecord(knowledge)) throw new Error(`${field}.knowledge must be an object.`);
    if (Object.keys(knowledge).some((key) => key !== "read" && key !== "write")) {
      throw new Error(`${field}.knowledge contains unsupported fields.`);
    }
    grant.knowledge = {
      read: normalizeProjectAccessRule(knowledge["read"], `${field}.knowledge.read`),
      write: normalizeProjectAccessRule(knowledge["write"], `${field}.knowledge.write`),
    };
  }

  const entrypoints = value["entrypoints"];
  if (entrypoints !== undefined) {
    grant.entrypoints = normalizeProjectAccessRule(entrypoints, `${field}.entrypoints`);
  }

  return grant;
}

function normalizeProjectAccessRule(value: unknown, field: string): ProjectAccessRule {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  const mode = value["mode"];
  if (mode === "none" || mode === "all") {
    if (Object.keys(value).some((key) => key !== "mode")) {
      throw new Error(`${field} contains unsupported fields.`);
    }
    return { mode };
  }
  if (mode !== "prefixes") {
    throw new Error(`${field}.mode must be "none", "all", or "prefixes".`);
  }
  if (Object.keys(value).some((key) => key !== "mode" && key !== "prefixes")) {
    throw new Error(`${field} contains unsupported fields.`);
  }
  const rawPrefixes = value["prefixes"];
  if (
    !Array.isArray(rawPrefixes) ||
    rawPrefixes.length === 0 ||
    rawPrefixes.length > STEAMHARNESS_RELATED_PROJECT_PREFIX_LIMIT
  ) {
    throw new Error(
      `${field}.prefixes must contain 1 to ${STEAMHARNESS_RELATED_PROJECT_PREFIX_LIMIT} items.`,
    );
  }
  const prefixes = rawPrefixes.map((prefix, index) => {
    const normalized = readRelatedProjectString(prefix, `${field}.prefixes[${index}]`);
    if (normalized.length > STEAMHARNESS_RELATED_PROJECT_KEY_LIMIT || normalized.includes("\0")) {
      throw new Error(`${field}.prefixes[${index}] is invalid.`);
    }
    return normalized;
  });
  if (new Set(prefixes).size !== prefixes.length) {
    throw new Error(`${field}.prefixes contains duplicates.`);
  }
  return { mode: "prefixes", prefixes };
}

function serializeProjectRelatedProject(relation: RelatedProject): Record<string, unknown> {
  const grant = relation.grantToRelatedProject;
  const knowledge = grant.knowledge;
  return {
    alias: relation.alias,
    projectId: relation.projectId,
    grantToRelatedProject: {
      read: serializeProjectAccessRule(grant.read),
      write: serializeProjectAccessRule(grant.write),
      // A grant nobody widened is left out rather than written back as an
      // explicit refusal: rewriting every existing manifest on save would put
      // this pair in front of every project that ever opened the dialog.
      ...(knowledge === undefined
        ? {}
        : { knowledge: { read: serializeProjectAccessRule(knowledge.read), write: serializeProjectAccessRule(knowledge.write) } }),
      ...(grant.entrypoints === undefined ? {} : { entrypoints: serializeProjectAccessRule(grant.entrypoints) }),
    },
  };
}

function serializeProjectAccessRule(rule: ProjectAccessRule): Record<string, unknown> {
  return rule.mode === "prefixes"
    ? { mode: rule.mode, prefixes: [...rule.prefixes] }
    : { mode: rule.mode };
}

function readRelatedProjectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeIds(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const values = value.map((item, index) => {
    if (typeof item !== "string" || !PROJECT_INFO_ID_PATTERN.test(item.trim())) {
      throw new Error(`${field}[${index}] must be a lowercase identifier.`);
    }
    return item.trim();
  });
  return uniqueStrings(values, true);
}

function uniqueStrings(values: string[], caseSensitive: boolean): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (value === "") continue;
    const key = caseSensitive ? value : value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
