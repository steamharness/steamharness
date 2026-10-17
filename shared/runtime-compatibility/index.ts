import semver from "semver";

export const STEAMHARNESS_HARNESS_PACKAGE_NAME = "steamharness";
export const STEAMHARNESS_CLI_PACKAGE_NAME = "@steamharness/cli";

export type WorkflowPackageManifest = Record<string, unknown>;

/** `dev`/功能分支用本地相对路径引用同级仓库；`main`/`alpha` 必须写精确的已发布版本。 */
export type RepositoryMode = "dev" | "main";

export type PackageVersionReference =
  | { kind: "exact"; version: string; specifier: string }
  | { kind: "local"; specifier: string; relative: string };

export interface WorkflowCoreCompatibilityResult {
  compatible: boolean;
  hostCoreVersion: string;
  requiredCoreVersion: string;
  requiredRange: string;
}

/**
 * 发布态引用：只接受精确 SemVer。
 *
 * 这是下载/发布制品的契约，走这条路的清单（内置项目发布产物、Alpha/正式版本）
 * 永远不应该出现相对路径，所以这里的错误信息保持不变，由 `resolveRequiredCoreVersion`
 * 负责开发分支上的本地引用。
 */
export function readRequiredCoreVersion(manifest: unknown): string {
  if (!isRecord(manifest)) {
    throw new Error("Workflow package.json root must be an object.");
  }

  const devDependencies = manifest.devDependencies;
  if (!isRecord(devDependencies)) {
    throw new Error('Workflow package.json must declare devDependencies.steamharness as an exact version.');
  }

  const value = devDependencies[STEAMHARNESS_HARNESS_PACKAGE_NAME];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error('Workflow package.json must declare devDependencies.steamharness as an exact version.');
  }

  return normalizeExactVersion(value, "Workflow Core requirement");
}

/** 读取任意依赖段里的精确版本，供 CLI 与内置项目发布校验复用。 */
export function readExactDevDependency(manifest: unknown, packageName: string): string {
  if (!isRecord(manifest)) throw new Error("Workflow package.json root must be an object.");
  const devDependencies = manifest.devDependencies;
  const value = isRecord(devDependencies) ? devDependencies[packageName] : undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Workflow package.json must declare devDependencies.${packageName} as an exact version.`);
  }
  return normalizeExactVersion(value, `${packageName} requirement`);
}

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const LOCAL_SPECIFIER_PATTERN = /^(?:file|link):(.*)$/u;

/**
 * 纯分类，不碰文件系统：这个模块会被打进 renderer bundle，不能引入 node: 内建模块。
 * 判定规则与 `shared/release-tools/release-gate.mjs` 保持一致。
 */
export function classifyVersionReference(
  manifest: unknown,
  packageName: string,
  { section = "devDependencies" as const } = {},
): PackageVersionReference {
  if (!isRecord(manifest)) throw new Error("Workflow package.json root must be an object.");
  const dependencies = manifest[section];
  const label = `${section}.${packageName}`;
  const value = isRecord(dependencies) ? dependencies[packageName] : undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Workflow package.json must declare ${label} as an exact version.`);
  }

  const specifier = value.trim();
  const local = LOCAL_SPECIFIER_PATTERN.exec(specifier);
  if (local !== null) {
    const relative = local[1]!;
    if (!relative.startsWith("./") && !relative.startsWith("../")) {
      throw new Error(`${label} must use a relative file:/link: specifier, received ${specifier}.`);
    }
    return { kind: "local", specifier, relative };
  }
  if (!EXACT_VERSION_PATTERN.test(specifier)) {
    throw new Error(`${label} "${value}" must be an exact SemVer version.`);
  }
  return { kind: "exact", version: specifier, specifier };
}

/**
 * 当前处于开发模式还是发布模式。
 *
 * 与各仓 `scripts/repository-mode.mjs` 的区别：那里的 `alpha` 算"非 main"，这里
 * `alpha` 是发布通道。只读环境变量，不读 git，因此不引入 node:child_process。
 */
export function resolveReleaseMode(env: Record<string, string | undefined> = process.env): RepositoryMode {
  const override = String(env.STEAMHARNESS_REPOSITORY_MODE ?? "").trim();
  if (override !== "" && override !== "main") {
    throw new Error("STEAMHARNESS_REPOSITORY_MODE only accepts main as a fail-closed override.");
  }
  if (override === "main") return "main";
  if (String(env.CI_COMMIT_TAG ?? "").trim() !== "") return "main";
  const branch = String(env.CI_COMMIT_BRANCH ?? env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? "").trim();
  return branch === "main" || branch === "alpha" ? "main" : "dev";
}

/**
 * 把 `../harness` 这样的相对引用换算成相对 **workspace 根** 的目录名。
 *
 * 纯字符串运算，不依赖 `node:path`，同时保证引用不会走出 workspace 根：
 * `../..`、`../../etc`、`file:/abs` 都会在这里被拒绝。
 */
export function resolveSiblingDirectory(relative: string, repositoryDirectory: string): string {
  const segments = String(repositoryDirectory).split("/").filter((segment) => segment !== "");
  if (segments.length === 0) throw new Error("The declaring repository directory is required.");
  for (const segment of String(relative).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(`${relative} must stay inside the workspace root.`);
      }
      segments.pop();
      continue;
    }
    if (segment.includes("\\")) throw new Error(`${relative} must use forward slashes.`);
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new Error(`${relative} must point at a sibling repository, not the workspace root.`);
  }
  return segments.join("/");
}

/**
 * 解析清单声明的 Core 版本：发布通道要求精确版本，开发分支允许 `link:../harness`
 * 并读取同级仓库 `package.json` 的版本。
 *
 * 同级清单的读取由调用方注入 —— 这个模块不能碰文件系统。`resolveSiblingDirectory`
 * 已经保证 `siblingDirectory` 落在 workspace 根之内。
 */
export function resolveRequiredCoreVersion(
  manifest: unknown,
  options: {
    mode: RepositoryMode;
    repositoryDirectory: string;
    readSiblingManifest: (siblingDirectory: string) => unknown;
    section?: "devDependencies";
  },
): string {
  const reference = classifyVersionReference(manifest, STEAMHARNESS_HARNESS_PACKAGE_NAME, {
    section: options.section ?? "devDependencies",
  });
  if (reference.kind === "exact") return normalizeExactVersion(reference.version, "Workflow Core requirement");
  if (options.mode === "main") {
    throw new Error(
      `devDependencies.${STEAMHARNESS_HARNESS_PACKAGE_NAME} must declare an exact published version on main and alpha; `
      + `${reference.specifier} is only allowed on dev and feature branches.`,
    );
  }

  const siblingDirectory = resolveSiblingDirectory(reference.relative, options.repositoryDirectory);
  const sibling = options.readSiblingManifest(siblingDirectory);
  if (!isRecord(sibling) || sibling.name !== STEAMHARNESS_HARNESS_PACKAGE_NAME) {
    throw new Error(`${reference.specifier} must point at the sibling Core repository (${siblingDirectory}).`);
  }
  return normalizeExactVersion(String(sibling.version ?? ""), "Sibling Core version");
}

export function normalizeExactVersion(value: string, label = "version"): string {
  const normalized = value.trim();
  const validVersion = semver.valid(normalized);
  if (validVersion === null || validVersion !== normalized) {
    throw new Error(`${label} "${value}" must be an exact SemVer version.`);
  }
  return validVersion;
}

export function evaluateCoreCompatibility(
  hostCoreVersion: string,
  requiredCoreVersion: string,
): WorkflowCoreCompatibilityResult {
  const host = normalizeExactVersion(hostCoreVersion, "Host Core version");
  const required = normalizeExactVersion(requiredCoreVersion, "Required Core version");
  const hostParsed = semver.parse(host);
  const requiredParsed = semver.parse(required);
  if (hostParsed === null || requiredParsed === null) {
    throw new Error("Core compatibility requires valid exact SemVer versions.");
  }
  const requiredRange = `${requiredParsed.major}.${requiredParsed.minor}.x`;

  return {
    compatible: hostParsed.major === requiredParsed.major
      && hostParsed.minor === requiredParsed.minor,
    hostCoreVersion: host,
    requiredCoreVersion: required,
    requiredRange,
  };
}

export function assertCoreCompatibility(
  hostCoreVersion: string,
  requiredCoreVersion: string,
): WorkflowCoreCompatibilityResult {
  const result = evaluateCoreCompatibility(hostCoreVersion, requiredCoreVersion);
  if (!result.compatible) {
    throw new Error(
      `Workflow requires exact Core ${result.requiredCoreVersion} (${result.requiredRange} compatibility line), `
      + `but this host provides Core ${result.hostCoreVersion}. Install a host that bundles Core `
      + `${result.requiredRange}, or update the project's exact Core declaration after migration.`,
    );
  }
  return result;
}

export function formatSupportedProjectCoreRange(hostCoreVersion: string): string {
  const host = normalizeExactVersion(hostCoreVersion, "Host Core version");
  const parsed = semver.parse(host);
  if (parsed === null) throw new Error(`Host Core version "${host}" must be an exact SemVer version.`);
  return `${parsed.major}.${parsed.minor}.x`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
