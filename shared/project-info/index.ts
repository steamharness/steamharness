export const STEAMHARNESS_PROJECT_DECLARATION_DEFINITIONS = [
  { id: "multilingual", labelKey: "projectDeclarationMultilingual" },
  { id: "multiplatform", labelKey: "projectDeclarationMultiplatform" },
] as const;

export const STEAMHARNESS_PROJECT_PLATFORM_DEFINITIONS = [
  { id: "macos", labelKey: "projectPlatformMacos" },
  { id: "windows", labelKey: "projectPlatformWindows" },
  { id: "web", labelKey: "projectPlatformWeb" },
] as const;

export type KnownWorkflowProjectDeclaration =
  (typeof STEAMHARNESS_PROJECT_DECLARATION_DEFINITIONS)[number]["id"];
export type KnownWorkflowProjectPlatform =
  (typeof STEAMHARNESS_PROJECT_PLATFORM_DEFINITIONS)[number]["id"];

export const STEAMHARNESS_PROJECT_DATA_STORAGE_MODES = ["local", "server", "both"] as const;

export type WorkflowProjectDataStorageMode =
  (typeof STEAMHARNESS_PROJECT_DATA_STORAGE_MODES)[number];
export type WorkflowProjectDataStorageLocation = Exclude<WorkflowProjectDataStorageMode, "both">;

export interface WorkflowProjectDataStorage {
  mode: WorkflowProjectDataStorageMode;
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
export type WorkflowProjectAccessRule =
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "prefixes"; prefixes: string[] };

/** @deprecated Renamed to {@link WorkflowProjectAccessRule}: entrypoints use it too. */
export type WorkflowProjectKVAccessRule = WorkflowProjectAccessRule;

/** The target project's knowledge base, read and written separately. */
export interface WorkflowRelatedProjectKnowledgeGrant {
  read: WorkflowProjectAccessRule;
  write: WorkflowProjectAccessRule;
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
export interface WorkflowRelatedProjectGrant {
  read: WorkflowProjectAccessRule;
  write: WorkflowProjectAccessRule;
  knowledge?: WorkflowRelatedProjectKnowledgeGrant;
  /** Which of this project's entrypoints the consumer may call. */
  entrypoints?: WorkflowProjectAccessRule;
}

/** @deprecated Renamed to {@link WorkflowRelatedProjectGrant}. */
export type WorkflowRelatedProjectKVGrant = WorkflowRelatedProjectGrant;

export interface WorkflowRelatedProject {
  alias: string;
  projectId: string;
  grantToRelatedProject: WorkflowRelatedProjectGrant;
}

export interface WorkflowResolvedRelatedProjectAccess {
  consumer: WorkflowRelatedProject;
  target: WorkflowRelatedProject;
  grant: WorkflowRelatedProjectGrant;
}

export type WorkflowProjectPlatformSupport =
  | { mode: "agnostic" }
  | { mode: "specific"; platforms: string[] };

export interface WorkflowProjectInfo {
  localizedNames: Record<string, string>;
  declarations: string[];
  platformSupport: WorkflowProjectPlatformSupport;
  dataStorage: WorkflowProjectDataStorage | null;
  relatedProjects: WorkflowRelatedProject[];
}

export type DeclaredWorkflowProjectInfo = Omit<WorkflowProjectInfo, "dataStorage"> & {
  dataStorage: WorkflowProjectDataStorage;
};

const PROJECT_INFO_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function createDefaultWorkflowProjectInfo(): DeclaredWorkflowProjectInfo {
  return {
    localizedNames: {},
    declarations: [],
    platformSupport: { mode: "agnostic" },
    dataStorage: { mode: "both" },
    relatedProjects: [],
  };
}

export function createUndeclaredWorkflowProjectInfo(): WorkflowProjectInfo {
  return {
    localizedNames: {},
    declarations: [],
    platformSupport: { mode: "agnostic" },
    dataStorage: null,
    relatedProjects: [],
  };
}

export function normalizeWorkflowProjectInfo(value: unknown): WorkflowProjectInfo {
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

export function normalizeDeclaredWorkflowProjectInfo(value: unknown): DeclaredWorkflowProjectInfo {
  const normalized = normalizeWorkflowProjectInfo(value);
  if (normalized.dataStorage === null) {
    throw new Error(
      "steamHarness.projectInfo.dataStorage.mode must be declared as local, server, or both.",
    );
  }
  return normalized as DeclaredWorkflowProjectInfo;
}

export function readWorkflowProjectInfo(packageJson: unknown): WorkflowProjectInfo {
  if (!isRecord(packageJson)) return createUndeclaredWorkflowProjectInfo();
  const steamHarness = packageJson["steamHarness"];
  if (!isRecord(steamHarness) || steamHarness["projectInfo"] === undefined) {
    return createUndeclaredWorkflowProjectInfo();
  }
  const projectInfo = normalizeWorkflowProjectInfo(steamHarness["projectInfo"]);
  const projectId = typeof packageJson["id"] === "string" ? packageJson["id"].trim() : undefined;
  if (projectId !== undefined && projectId !== "") {
    assertWorkflowRelatedProjects(projectInfo, projectId);
  }
  return projectInfo;
}

export function writeWorkflowProjectInfo(
  packageJson: Record<string, unknown>,
  projectInfo: DeclaredWorkflowProjectInfo,
): Record<string, unknown> {
  const normalized = normalizeDeclaredWorkflowProjectInfo(projectInfo);
  const projectId = typeof packageJson["id"] === "string" ? packageJson["id"].trim() : undefined;
  if (projectId !== undefined && projectId !== "") {
    assertWorkflowRelatedProjects(normalized, projectId);
  }
  const steamHarness = isRecord(packageJson["steamHarness"])
    ? packageJson["steamHarness"]
    : {};

  return {
    ...packageJson,
    steamHarness: {
      ...steamHarness,
      projectInfo: serializeWorkflowProjectInfo(normalized),
    },
  };
}

export function serializeWorkflowProjectInfo(projectInfo: WorkflowProjectInfo): Record<string, unknown> {
  const normalized = normalizeWorkflowProjectInfo(projectInfo);
  return {
    localizedNames: { ...normalized.localizedNames },
    declarations: [...normalized.declarations],
    platformSupport: normalized.platformSupport.mode === "agnostic"
      ? { mode: "agnostic" }
      : { mode: "specific", platforms: [...normalized.platformSupport.platforms] },
    dataStorage: normalized.dataStorage === null
      ? null
      : { mode: normalized.dataStorage.mode },
    relatedProjects: normalized.relatedProjects.map(serializeWorkflowRelatedProject),
  };
}

export function createDefaultWorkflowRelatedProjectGrant(): WorkflowRelatedProjectKVGrant {
  return {
    read: { mode: "all" },
    write: { mode: "none" },
  };
}

export function assertWorkflowRelatedProjects(
  projectInfo: WorkflowProjectInfo,
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

export function findWorkflowRelatedProject(
  projectInfo: WorkflowProjectInfo,
  alias: string,
): WorkflowRelatedProject | undefined {
  const normalizedAlias = alias.trim();
  return projectInfo.relatedProjects.find((relation) => relation.alias === normalizedAlias);
}

export function resolveWorkflowRelatedProjectAccess(input: {
  consumerProjectId: string;
  consumerProjectInfo: WorkflowProjectInfo;
  targetProjectId: string;
  targetProjectInfo: WorkflowProjectInfo;
  alias: string;
}): WorkflowResolvedRelatedProjectAccess | undefined {
  const consumer = findWorkflowRelatedProject(input.consumerProjectInfo, input.alias);
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
export function isWorkflowProjectAccessAllowed(
  rule: WorkflowProjectAccessRule | undefined,
  value: string,
): boolean {
  if (rule === undefined || rule.mode === "none") return false;
  if (rule.mode === "all") return true;
  return rule.prefixes.some((prefix) => value.startsWith(prefix));
}

/** @deprecated Renamed to {@link isWorkflowProjectAccessAllowed}: entrypoint ids use it too. */
export function isWorkflowProjectKVAccessAllowed(
  rule: WorkflowProjectAccessRule,
  key: string,
): boolean {
  return isWorkflowProjectAccessAllowed(rule, key);
}

export function isWorkflowProjectDataStorageLocationAllowed(
  projectInfo: WorkflowProjectInfo,
  location: WorkflowProjectDataStorageLocation,
): boolean {
  const mode = projectInfo.dataStorage?.mode;
  return mode === "both" || mode === location;
}

export function assertWorkflowProjectDataStorageLocationAllowed(
  projectInfo: WorkflowProjectInfo,
  location: WorkflowProjectDataStorageLocation,
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

export function resolveWorkflowProjectName(
  defaultName: string,
  projectInfo: WorkflowProjectInfo,
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

export function listWorkflowProjectSearchNames(
  defaultName: string,
  projectInfo: WorkflowProjectInfo,
): string[] {
  return uniqueStrings([defaultName, ...Object.values(projectInfo.localizedNames)], false);
}

export function matchesWorkflowProjectSearch(
  defaultName: string,
  projectInfo: WorkflowProjectInfo,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery === "") return true;
  return listWorkflowProjectSearchNames(defaultName, projectInfo)
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

function normalizePlatformSupport(value: unknown): WorkflowProjectPlatformSupport {
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

function normalizeDataStorage(value: unknown): WorkflowProjectDataStorage | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Error("steamHarness.projectInfo.dataStorage must be an object.");
  }
  const mode = value["mode"];
  if (typeof mode !== "string" || !STEAMHARNESS_PROJECT_DATA_STORAGE_MODES.includes(
    mode as WorkflowProjectDataStorageMode,
  )) {
    throw new Error(
      'steamHarness.projectInfo.dataStorage.mode must be "local", "server", or "both".',
    );
  }
  return { mode: mode as WorkflowProjectDataStorageMode };
}

function normalizeRelatedProjects(value: unknown): WorkflowRelatedProject[] {
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
): WorkflowRelatedProjectGrant {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  const supported = new Set(["read", "write", "knowledge", "entrypoints"]);
  if (Object.keys(value).some((key) => !supported.has(key))) {
    throw new Error(`${field} contains unsupported fields.`);
  }

  const grant: WorkflowRelatedProjectGrant = {
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

function normalizeProjectAccessRule(value: unknown, field: string): WorkflowProjectAccessRule {
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

function serializeWorkflowRelatedProject(relation: WorkflowRelatedProject): Record<string, unknown> {
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

function serializeProjectAccessRule(rule: WorkflowProjectAccessRule): Record<string, unknown> {
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
