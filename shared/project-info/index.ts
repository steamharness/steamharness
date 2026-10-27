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

export type ProjectPlatformSupport = { mode: "agnostic" } | { mode: "specific"; platforms: string[] };
export interface ProjectInfoContract {
  localizedNames: Record<string, string>;
  declarations: string[];
  platformSupport: ProjectPlatformSupport;
}
export type DeclaredProjectInfo = ProjectInfoContract;
const PROJECT_INFO_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export function createDefaultProjectInfo(): ProjectInfoContract { return { localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" } }; }
export function createUndeclaredProjectInfo(): ProjectInfoContract { return createDefaultProjectInfo(); }
export function normalizeProjectInfo(value: unknown): ProjectInfoContract {
  if (!isRecord(value)) throw new Error("steamHarness.projectInfo must be an object.");
  if ("relatedProjects" in value || "dataStorage" in value) throw new Error("Project database and related-project declarations were removed. Register entry database requirements instead.");
  if (Object.keys(value).some(key => !["localizedNames", "declarations", "platformSupport"].includes(key))) throw new Error("steamHarness.projectInfo contains unsupported fields.");
  return { localizedNames: normalizeLocalizedNames(value.localizedNames), declarations: normalizeIds(value.declarations, "steamHarness.projectInfo.declarations"), platformSupport: normalizePlatformSupport(value.platformSupport) };
}
export function normalizeDeclaredProjectInfoInput(value: unknown): DeclaredProjectInfo { return normalizeProjectInfo(value); }
export function readProjectInfo(packageJson: unknown): ProjectInfoContract {
  if (!isRecord(packageJson) || !isRecord(packageJson.steamHarness) || packageJson.steamHarness.projectInfo === undefined) return createDefaultProjectInfo();
  return normalizeProjectInfo(packageJson.steamHarness.projectInfo);
}
export function writeProjectInfo(packageJson: Record<string, unknown>, projectInfo: DeclaredProjectInfo): Record<string, unknown> {
  return { ...packageJson, steamHarness: { ...(isRecord(packageJson.steamHarness) ? packageJson.steamHarness : {}), projectInfo: serializeProjectInfo(projectInfo) } };
}
export function serializeProjectInfo(projectInfo: ProjectInfoContract): Record<string, unknown> { return structuredClone(normalizeProjectInfo(projectInfo)) as unknown as Record<string, unknown>; }

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
