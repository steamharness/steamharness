import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { create as createTar, list as listTar } from "tar";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolveReleaseMode, resolveVersionReference } from "./release-gate.mjs";
import { resolveSiblingWorkspaceRoot } from "./prepare-local-siblings.mjs";

const INDEX_SCHEMA_VERSION = 2;
const RUNNER_SCHEMA_VERSION = 1;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// 制品按仓库根复制，所以排除规则必须区分"仓库根的 scripts/__tests__"与
// "skill 自己的 scripts/__tests__"：只按 basename 过滤会把
// skills/workflow-generator/scripts/create_workflow.py 一起丢掉，
// 而 SKILL.md 要求运行时能调用它。
const INFRASTRUCTURE_DIRECTORIES = new Set([
  ".git",
  ".agents",
  ".claude",
  ".codex",
  ".ci-artifacts",
  ".release",
  "coverage",
  "node_modules",
  "test-results",
  "__fixtures__",
  "__snapshots__",
  "__tests__",
]);
const INFRASTRUCTURE_ROOT_ENTRIES = new Set([
  ".gitlab-ci.yml",
  "scripts",
  "tsconfig.json",
  "vitest.config.ts",
  "workflow-runtime.d.ts",
]);
const EXCLUDED_ENV_FILE_NAMES = new Set([".env", ".env.production"]);

export function shouldPackEntry(projectRoot, candidate) {
  const name = path.basename(candidate);
  if (EXCLUDED_ENV_FILE_NAMES.has(name) || name === "AGENTS.md") return false;
  const segments = path.relative(projectRoot, candidate).split(path.sep).filter((segment) => segment !== "");
  if (segments.length === 0) return true;
  if (segments.some((segment) => INFRASTRUCTURE_DIRECTORIES.has(segment))) return false;
  return !(segments.length === 1 && INFRASTRUCTURE_ROOT_ENTRIES.has(name));
}

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * Which release channel this build is for. The channel is an explicit input:
 * a tag pipeline has no branch to infer it from, and guessing would publish an
 * Alpha build into the stable index.
 */
export function normalizeChannel(value) {
  const channel = String(value ?? "").trim() || "stable";
  if (channel !== "stable" && channel !== "alpha") {
    throw new Error(`Built-in release channel must be stable or alpha, received ${channel}.`);
  }
  return channel;
}

/**
 * `<projectId>` for the stable channel, `<projectId>/alpha` for Alpha. This one
 * segment decides both the OSS keys and the local publish root, so the two
 * channels cannot collide on a version number and the relative resource URLs
 * inside an index keep resolving.
 */
export function channelProjectPath(definition) {
  return definition.channel === "alpha" ? `${definition.projectId}/alpha` : definition.projectId;
}

export async function readBuiltinDefinition(root = repoRoot, options = {}) {
  const channel = normalizeChannel(options.channel);
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const release = packageJson?.steamHarness?.builtinRelease;
  const projectId = String(release?.projectId ?? "").trim();
  const artifactKind = release?.artifactKind;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId)) {
    throw new Error("steamHarness.builtinRelease.projectId is invalid.");
  }
  if (artifactKind !== "universal" && artifactKind !== "native") {
    throw new Error("steamHarness.builtinRelease.artifactKind must be universal or native.");
  }
  const version = normalizeVersion(packageJson.version);
  if (Object.hasOwn(release, "minAppVersion")) {
    throw new Error("steamHarness.builtinRelease.minAppVersion is not supported; use minDesktopVersion.");
  }
  const minDesktopVersion = normalizeVersion(release.minDesktopVersion);
  if (!Array.isArray(release.dependencies)) {
    throw new Error("steamHarness.builtinRelease.dependencies must be an array.");
  }
  const dependencyIds = new Set();
  const dependencies = release.dependencies.map((dependency) => {
    const id = String(dependency?.id ?? "").trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id === projectId || dependencyIds.has(id)) {
      throw new Error(`Invalid built-in project dependency: ${id || "<empty>"}.`);
    }
    dependencyIds.add(id);
    return { id, minVersion: normalizeVersion(dependency.minVersion) };
  });
  const packageManager = String(packageJson.packageManager ?? "");
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) {
    throw new Error("packageManager must pin an exact pnpm version.");
  }
  // On dev and feature branches the two dependencies point at the sibling
  // checkouts, so the version a release would declare has to come from there.
  // On alpha and main (and any tag pipeline) a relative reference is refused
  // outright: a published artifact must name exact published versions.
  const referenceMode = options.mode ?? resolveReleaseMode({ root });
  const components = {
    harness: await readRuntimeComponentVersion(packageJson, "steamharness", root, referenceMode),
    cli: await readRuntimeComponentVersion(packageJson, "@steamharness/cli", root, referenceMode),
  };
  const dataStorageMode = packageJson?.steamHarness?.projectInfo?.dataStorage?.mode;
  if (dataStorageMode !== "local" && dataStorageMode !== "server" && dataStorageMode !== "both") {
    throw new Error("steamHarness.projectInfo.dataStorage.mode must be local, server, or both.");
  }
  const harnessVersion = semver.parse(components.harness);
  if (harnessVersion?.major === 0 && harnessVersion.minor === 2
      && semver.lt(minDesktopVersion, "0.1.22")) {
    throw new Error("Core 0.2 built-in projects require minDesktopVersion 0.1.22 or newer.");
  }
  return {
    root: path.resolve(root),
    packageJson,
    projectId,
    artifactKind,
    version,
    minDesktopVersion,
    components,
    dataStorageMode,
    dependencies,
    channel,
    // A git tag name cannot be reused across channels, so the Alpha channel
    // publishes the same project version under its own tag namespace.
    unit: `builtin-${projectId}`,
    tag: `builtin-${projectId}/${channel === "alpha" ? "alpha/" : ""}v${version}`,
  };
}

export function requiredTargets(definition) {
  return definition.artifactKind === "universal"
    ? [["all", "all"]]
    : [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"]];
}

export async function verifyBuiltinProject(options = {}) {
  const definition = await readBuiltinDefinition(options.root, { channel: options.channel, mode: options.mode });
  if (definition.artifactKind === "universal") {
    const productionDependencies = [
      ...Object.keys(definition.packageJson.dependencies ?? {}),
      ...Object.keys(definition.packageJson.optionalDependencies ?? {}),
    ];
    if (productionDependencies.length > 0) {
      throw new Error(`Universal built-in project cannot declare production dependencies: ${productionDependencies.join(", ")}.`);
    }
  } else {
    await assertLockfileCurrent(definition.root, definition.packageJson, ["dependencies", "optionalDependencies"]);
  }
  await assertLocalizedProjectPresentation(definition.root, definition.packageJson);
  await assertChangelogParity(definition.root, definition.version);
  return definition;
}

export async function buildReleaseArtifacts(options = {}) {
  const definition = await verifyBuiltinProject({ root: options.root, channel: options.channel, mode: options.mode });
  assertReleaseIdentity(definition, options);
  const targetGroup = normalizeTargetGroup(options.targetGroup);
  if (definition.artifactKind === "universal" && targetGroup !== "mac") {
    throw new Error("Universal built-in projects are built by the mac target group only.");
  }
  const outputDir = path.resolve(options.outputDir);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const targets = requiredTargets(definition).filter(([platform]) => (
    definition.artifactKind === "universal" || (targetGroup === "mac" ? platform === "darwin" : platform === "win32")
  ));
  const resources = [];
  for (const [platform, arch] of targets) {
    resources.push(await buildResource({ definition, platform, arch, outputDir }, options.dependencies));
  }
  const runnerManifest = {
    schemaVersion: RUNNER_SCHEMA_VERSION,
    unit: definition.unit,
    projectId: definition.projectId,
    targetGroup,
    version: definition.version,
    commit: normalizeCommit(options.commit),
    resources: resources.map(({ platform, arch, filename, size, sha256 }) => ({
      platform,
      arch,
      filename,
      size,
      sha256,
    })),
  };
  const runnerManifestPath = path.resolve(options.runnerManifest ?? path.join(outputDir, "runner-manifest.json"));
  await writeJsonAtomic(runnerManifestPath, runnerManifest);
  return { definition, outputDir, runnerManifestPath, runnerManifest };
}

export async function assembleRelease(options = {}) {
  const definition = await verifyBuiltinProject({ root: options.root, channel: options.channel, mode: options.mode });
  assertReleaseIdentity(definition, options);
  const commit = normalizeCommit(options.commit);
  const groups = [{ name: "mac", directory: options.macArtifactsDir }];
  if (definition.artifactKind === "native") groups.push({ name: "windows", directory: options.windowsArtifactsDir });
  const resourcesByTarget = new Map();
  for (const group of groups) {
    if (!group.directory) throw new Error(`${group.name} artifacts are required.`);
    const directory = path.resolve(group.directory);
    const runner = validateRunnerManifest(
      JSON.parse(await readFile(path.join(directory, "runner-manifest.json"), "utf8")),
      definition,
      group.name,
      commit,
    );
    for (const resource of runner.resources) {
      const sourcePath = path.join(directory, definition.projectId, `v${definition.version}`, resource.filename);
      await assertResourceFile(sourcePath, resource);
      resourcesByTarget.set(`${resource.platform}-${resource.arch}`, { ...resource, sourcePath });
    }
  }
  const expectedTargets = requiredTargets(definition);
  if (resourcesByTarget.size !== expectedTargets.length) throw new Error("Built-in release targets are incomplete.");

  const outputDir = path.resolve(options.outputDir);
  const stagingDir = `${outputDir}.stage-${process.pid}-${Date.now()}`;
  await rm(stagingDir, { recursive: true, force: true });
  const projectRoot = path.join(stagingDir, ...channelProjectPath(definition).split("/"));
  const versionRoot = path.join(projectRoot, `v${definition.version}`);
  await mkdir(versionRoot, { recursive: true });
  const resources = [];
  for (const [platform, arch] of expectedTargets) {
    const resource = resourcesByTarget.get(`${platform}-${arch}`);
    if (!resource) throw new Error(`Missing ${platform}-${arch} release resource.`);
    await cp(resource.sourcePath, path.join(versionRoot, resource.filename));
    resources.push({
      platform,
      arch,
      url: `v${definition.version}/${resource.filename}?sha256=${resource.sha256}`,
      size: resource.size,
      sha256: resource.sha256,
    });
  }
  const release = {
    version: definition.version,
    tag: definition.tag,
    commitSha: commit,
    publishedAt: normalizeTimestamp(options.publishedAt ?? process.env.CI_COMMIT_TIMESTAMP ?? new Date().toISOString()),
    minDesktopVersion: definition.minDesktopVersion,
    components: definition.components,
    dependencies: definition.dependencies,
    resources,
  };
  const previous = options.previousIndex
    ? validateReleaseIndex(JSON.parse(await readFile(path.resolve(options.previousIndex), "utf8")), definition)
    : undefined;
  const existing = previous?.releases.find((candidate) => candidate.version === release.version);
  if (existing && JSON.stringify(existing) !== JSON.stringify(release)) {
    throw new Error(`Release ${definition.tag} already exists with different metadata.`);
  }
  const releases = [release, ...(previous?.releases ?? []).filter((candidate) => candidate.version !== release.version)]
    .sort((left, right) => semver.rcompare(left.version, right.version));
  await Promise.all([
    writeJsonAtomic(path.join(projectRoot, "index.json"), {
      schemaVersion: INDEX_SCHEMA_VERSION,
      id: definition.projectId,
      updatedAt: release.publishedAt,
      releases,
    }),
    writeJsonAtomic(path.join(projectRoot, "manifest.json"), {
      id: definition.projectId,
      version: definition.version,
      minDesktopVersion: definition.minDesktopVersion,
      components: definition.components,
      resources,
    }),
  ]);
  await verifyDistribution({ root: definition.root, resourcesRoot: stagingDir, channel: definition.channel, mode: options.mode });
  await replaceDirectory(stagingDir, outputDir);
  return { definition, release, outputDir };
}

export async function verifyDistribution(options = {}) {
  const definition = await readBuiltinDefinition(options.root, { channel: options.channel, mode: options.mode });
  const resourcesRoot = path.resolve(options.resourcesRoot);
  const projectRoot = path.join(resourcesRoot, channelProjectPath(definition));
  const index = validateReleaseIndex(JSON.parse(await readFile(path.join(projectRoot, "index.json"), "utf8")), definition);
  const release = index.releases.find((candidate) => candidate.version === definition.version);
  if (!release) throw new Error(`Distribution does not contain ${definition.tag}.`);
  for (const resource of release.resources) {
    const filePath = resolveResourceUrl(projectRoot, resource.url);
    await assertResourceFile(filePath, resource);
    await assertPortableArchive(filePath);
  }
  return { definition, index, release };
}

export async function publishDistribution(options = {}) {
  const verified = await verifyDistribution({
    root: options.root,
    resourcesRoot: options.resourcesRoot,
    channel: options.channel,
    mode: options.mode,
  });
  const { definition, release } = verified;
  const publishRoot = path.resolve(options.publishRoot);
  await validatePublishedDependencies(publishRoot, release, definition);
  const channelPath = channelProjectPath(definition).split("/");
  const sourceProjectRoot = path.join(path.resolve(options.resourcesRoot), ...channelPath);
  const targetProjectRoot = path.join(publishRoot, ...channelPath);
  const sourceVersion = path.join(sourceProjectRoot, `v${definition.version}`);
  const targetVersion = path.join(targetProjectRoot, `v${definition.version}`);
  await mkdir(targetProjectRoot, { recursive: true });
  const existingIndexPath = path.join(targetProjectRoot, "index.json");
  const existingIndex = await readJsonIfExists(existingIndexPath);
  if (existingIndex) validateReleaseIndex(existingIndex, definition);
  const existingRelease = existingIndex?.releases.find((candidate) => candidate.version === release.version);
  if (existingRelease && JSON.stringify(existingRelease) !== JSON.stringify(release)) {
    throw new Error(`Published ${definition.tag} has different immutable metadata.`);
  }
  if (await exists(targetVersion)) {
    if (JSON.stringify(await collectFiles(targetVersion)) !== JSON.stringify(await collectFiles(sourceVersion))) {
      throw new Error(`Published ${definition.tag} has different immutable resources.`);
    }
  } else {
    const stagedVersion = path.join(targetProjectRoot, `.stage-v${definition.version}-${process.pid}-${Date.now()}`);
    await cp(sourceVersion, stagedVersion, { recursive: true });
    await rename(stagedVersion, targetVersion);
  }
  const releases = [release, ...(existingIndex?.releases ?? []).filter((candidate) => candidate.version !== release.version)]
    .sort((left, right) => semver.rcompare(left.version, right.version));
  await Promise.all([
    writeJsonAtomic(existingIndexPath, {
      schemaVersion: INDEX_SCHEMA_VERSION,
      id: definition.projectId,
      updatedAt: release.publishedAt,
      releases,
    }),
    writeJsonAtomic(path.join(targetProjectRoot, "manifest.json"), {
      id: definition.projectId,
      version: release.version,
      minDesktopVersion: release.minDesktopVersion,
      components: release.components,
      resources: release.resources,
    }),
  ]);
  return { projectRoot: targetProjectRoot, version: release.version, reused: Boolean(existingRelease) };
}

async function buildResource({ definition, platform, arch, outputDir }, dependencies = {}) {
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), `workflow-${definition.projectId}-${platform}-${arch}-`));
  const stagedProject = path.join(stageRoot, "project");
  try {
    await cp(definition.root, stagedProject, {
      recursive: true,
      filter(candidate) {
        return shouldPackEntry(definition.root, candidate);
      },
    });
    if (definition.artifactKind === "native") {
      await writeFile(path.join(stagedProject, "pnpm-workspace.yaml"), stringifyYaml({
        packages: ["."],
        nodeLinker: "hoisted",
        supportedArchitectures: { os: [platform], cpu: [arch] },
      }), "utf8");
      const run = dependencies.runCommand ?? runCommand;
      await run("corepack", [
        "pnpm",
        "install",
        "--prod",
        "--no-frozen-lockfile",
        "--config.node-linker=hoisted",
      ], {
        cwd: stagedProject,
        env: { ...process.env, npm_config_platform: platform, npm_config_arch: arch },
      });
      await assertPortableLinks(stagedProject);
      await assertPlatformRuntime(stagedProject, platform, arch);
      await rm(path.join(stagedProject, "pnpm-workspace.yaml"), { force: true });
    }
    const filename = archiveName(definition, platform, arch);
    const targetDir = path.join(outputDir, definition.projectId, `v${definition.version}`);
    const archivePath = path.join(targetDir, filename);
    await mkdir(targetDir, { recursive: true });
    const tarOptions = { cwd: stagedProject, file: archivePath, gzip: true, portable: true };
    if (process.platform === "win32") createTar({ ...tarOptions, sync: true }, ["."]);
    else await createTar(tarOptions, ["."]);
    await assertPortableArchive(archivePath);
    const info = await stat(archivePath);
    return { platform, arch, filename, size: info.size, sha256: await sha256File(archivePath) };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

export function validateRunnerManifest(value, definition, targetGroup, commit) {
  if (!value || value.schemaVersion !== RUNNER_SCHEMA_VERSION
      || value.unit !== definition.unit
      || value.projectId !== definition.projectId
      || value.targetGroup !== targetGroup
      || value.version !== definition.version
      || value.commit !== commit
      || !Array.isArray(value.resources)) {
    throw new Error(`Invalid ${targetGroup} runner manifest.`);
  }
  const expected = requiredTargets(definition).filter(([platform]) => (
    definition.artifactKind === "universal" || (targetGroup === "mac" ? platform === "darwin" : platform === "win32")
  ));
  if (value.resources.length !== expected.length) throw new Error(`Incomplete ${targetGroup} runner manifest.`);
  const resources = value.resources.map((resource) => {
    if (!expected.some(([platform, arch]) => resource.platform === platform && resource.arch === arch)
        || resource.filename !== archiveName(definition, resource.platform, resource.arch)
        || !Number.isSafeInteger(resource.size)
        || resource.size <= 0
        || !SHA256_PATTERN.test(resource.sha256)) {
      throw new Error(`Invalid ${targetGroup} runner resource.`);
    }
    return resource;
  });
  return { ...value, resources };
}

export function validateReleaseIndex(value, definition) {
  if (!value || value.schemaVersion !== INDEX_SCHEMA_VERSION || value.id !== definition.projectId
      || !Array.isArray(value.releases) || value.releases.length === 0) {
    throw new Error(`Invalid release index for ${definition.projectId}.`);
  }
  let previous;
  const versions = new Set();
  for (const release of value.releases) {
    normalizeVersion(release.version);
    if (Object.hasOwn(release, "minAppVersion")) {
      throw new Error("Release index minAppVersion is not supported; use minDesktopVersion.");
    }
    normalizeVersion(release.minDesktopVersion);
    if (release.components !== undefined) validateRuntimeComponents(release.components);
    normalizeCommit(release.commitSha);
    normalizeTimestamp(release.publishedAt);
    // One index carries one channel, so every entry must be tagged for it.
    if (release.tag !== `builtin-${definition.projectId}/${definition.channel === "alpha" ? "alpha/" : ""}v${release.version}`
        || versions.has(release.version)
        || (previous && semver.gte(release.version, previous))
        || !Array.isArray(release.dependencies)
        || !Array.isArray(release.resources)) {
      throw new Error(`Invalid release entry for ${definition.projectId}.`);
    }
    versions.add(release.version);
    previous = release.version;
    validateDependencies(release.dependencies, definition.projectId);
    validateResources(release.resources, definition, release.version);
  }
  return value;
}

function normalizeRuntimeComponentVersion(value, name) {
  if (typeof value !== "string" || semver.valid(value) !== value) {
    throw new Error(`${name} must use an exact SemVer version.`);
  }
  return value;
}

async function readRuntimeComponentVersion(packageJson, name, root, mode) {
  const { version } = await resolveVersionReference(packageJson, name, {
    mode, repoRoot: root, workspaceRoot: resolveSiblingWorkspaceRoot(root, packageJson),
  });
  return normalizeRuntimeComponentVersion(version, `devDependencies.${name}`);
}

function validateRuntimeComponents(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || normalizeRuntimeComponentVersion(value.harness, "components.harness") !== value.harness
      || normalizeRuntimeComponentVersion(value.cli, "components.cli") !== value.cli) {
    throw new Error("Built-in release components must declare exact harness and CLI versions.");
  }
}

function validateDependencies(dependencies, projectId) {
  const ids = new Set();
  for (const dependency of dependencies) {
    const id = String(dependency?.id ?? "").trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
        || id === projectId
        || ids.has(id)
        || !semver.valid(dependency?.minVersion)
        || semver.prerelease(dependency.minVersion)) {
      throw new Error(`Invalid release dependency for ${projectId}: ${id || "<empty>"}.`);
    }
    ids.add(id);
  }
}

function validateResources(resources, definition, version) {
  const targets = requiredTargets(definition);
  if (resources.length !== targets.length) throw new Error("Built-in release targets are incomplete.");
  for (const [platform, arch] of targets) {
    const resource = resources.find((candidate) => candidate.platform === platform && candidate.arch === arch);
    const filename = archiveName(definition, platform, arch);
    if (!resource || !Number.isSafeInteger(resource.size) || resource.size <= 0
        || !SHA256_PATTERN.test(resource.sha256)
        || resource.url !== `v${version}/${filename}?sha256=${resource.sha256}`) {
      throw new Error(`Invalid ${platform}-${arch} release resource.`);
    }
  }
}

async function validatePublishedDependencies(publishRoot, release, definition) {
  // The dependency may be published to this channel, or to the stable channel
  // this one falls back to at runtime, so both are checked in that order.
  for (const dependency of release.dependencies) {
    const indexPaths = definition.channel === "alpha"
      ? [path.join(publishRoot, dependency.id, "alpha", "index.json"), path.join(publishRoot, dependency.id, "index.json")]
      : [path.join(publishRoot, dependency.id, "index.json")];
    let compatible;
    for (const indexPath of indexPaths) {
      const index = await readJsonIfExists(indexPath);
      compatible = index?.releases?.find((candidate) => (
        semver.valid(candidate.version)
        && semver.gte(candidate.version, dependency.minVersion)
        && semver.lte(candidate.minDesktopVersion, release.minDesktopVersion)
      ));
      if (compatible) break;
    }
    if (!compatible) {
      throw new Error(`${release.tag} requires published ${dependency.id} ${dependency.minVersion} or later.`);
    }
  }
}

async function assertChangelogParity(root, currentVersion) {
  const [zh, en] = await Promise.all([
    readFile(path.join(root, "CHANGELOG.md"), "utf8"),
    readFile(path.join(root, "CHANGELOG.en.md"), "utf8"),
  ]);
  const read = (contents) => [...contents.replace(/\r\n?/g, "\n").matchAll(/^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$/gm)]
    .map((match) => ({ version: match[1], date: match[2] }));
  const zhReleases = read(zh);
  if (JSON.stringify(zhReleases) !== JSON.stringify(read(en))) throw new Error("Changelog histories differ by locale.");
  if (!zhReleases.some((release) => release.version === currentVersion)) {
    throw new Error(`CHANGELOG.md does not contain current version ${currentVersion}.`);
  }
}

async function assertLocalizedProjectPresentation(root, packageJson) {
  const defaultName = typeof packageJson.name === "string" ? packageJson.name.trim() : "";
  const projectInfo = packageJson?.steamHarness?.projectInfo;
  const localizedNames = projectInfo?.localizedNames;
  const chineseName = typeof localizedNames?.["zh-CN"] === "string"
    ? localizedNames["zh-CN"].trim()
    : "";
  const englishName = typeof localizedNames?.en === "string"
    ? localizedNames.en.trim()
    : "";
  if (defaultName === "" || englishName !== defaultName || chineseName === "") {
    throw new Error("Built-in project names must define an English default plus zh-CN and en localized names.");
  }
  if (!Array.isArray(projectInfo?.declarations) || !projectInfo.declarations.includes("multilingual")) {
    throw new Error('Built-in project declarations must include "multilingual".');
  }

  const readmes = await Promise.all([
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "README.en.md"), "utf8"),
  ]).catch(() => {
    throw new Error("Built-in project must include README.md and README.en.md.");
  });
  if (readmes.some((content) => content.trim() === "")) {
    throw new Error("Built-in project README.md and README.en.md must not be empty.");
  }
}

async function assertLockfileCurrent(root, packageJson, dependencyTypes) {
  const lock = parseYaml(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const importer = lock?.importers?.["."];
  if (!importer) throw new Error("pnpm-lock.yaml has no root importer.");
  for (const type of dependencyTypes) {
    const declared = packageJson[type] ?? {};
    const locked = importer[type] ?? {};
    for (const [name, specifier] of Object.entries(declared)) {
      const value = locked[name];
      if ((typeof value === "string" ? value : value?.specifier) !== specifier) {
        throw new Error(`pnpm-lock.yaml does not match ${type}.${name}.`);
      }
    }
    for (const name of Object.keys(locked)) {
      if (!(name in declared)) throw new Error(`pnpm-lock.yaml contains stale ${type}.${name}.`);
    }
  }
}

async function assertPlatformRuntime(projectDir, platform, arch) {
  const packages = await collectPlatformPackages(path.join(projectDir, "node_modules"));
  const incompatible = packages.filter((entry) => !matchesConstraint(entry.os, platform) || !matchesConstraint(entry.cpu, arch));
  if (incompatible.length > 0) throw new Error(`Resource contains incompatible platform packages: ${incompatible.map((item) => item.name).join(", ")}.`);
  const targetSpecific = packages.filter((entry) => isTargetConstraint(entry.os, platform) && isTargetConstraint(entry.cpu, arch));
  if (targetSpecific.length === 0) throw new Error(`Resource contains no ${platform}-${arch} runtime package.`);
}

async function collectPlatformPackages(root) {
  const packages = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === "package.json") {
        const manifest = JSON.parse(await readFile(fullPath, "utf8"));
        if (manifest.os !== undefined || manifest.cpu !== undefined) packages.push(manifest);
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(fullPath);
    }
  };
  await visit(root);
  return packages;
}

async function assertPortableLinks(projectDir) {
  const root = path.resolve(projectDir);
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) {
        const target = await readlink(fullPath);
        const resolved = path.resolve(directory, target);
        const relative = path.relative(root, resolved);
        if (path.isAbsolute(target) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Resource contains non-portable link: ${fullPath} -> ${target}`);
        }
      } else if (info.isDirectory()) await visit(fullPath);
    }
  };
  await visit(root);
}

async function assertPortableArchive(archivePath) {
  let unsafe;
  await listTar({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      const entryPath = normalizeArchivePath(entry.path);
      const link = entry.linkpath === undefined ? undefined : String(entry.linkpath).replaceAll("\\", "/");
      if (!unsafe && (!entryPath || (link !== undefined && !portableLink(entryPath, link, entry.type)))) {
        unsafe = `${entry.path}${link ? ` -> ${link}` : ""}`;
      }
      entry.resume();
    },
  });
  if (unsafe) throw new Error(`Resource archive contains unsafe path: ${unsafe}`);
}

function portableLink(entryPath, link, type) {
  if (path.posix.isAbsolute(link) || /^[A-Za-z]:\//.test(link)) return false;
  return normalizeArchivePath(type === "SymbolicLink" ? path.posix.join(path.posix.dirname(entryPath), link) : link) !== undefined;
}

export function normalizeArchivePath(value) {
  const input = String(value ?? "").replaceAll("\\", "/");
  if (!input || path.posix.isAbsolute(input) || /^[A-Za-z]:\//.test(input)) return undefined;
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized === "./") return ".";
  return normalized === ".." || normalized.startsWith("../") ? undefined : normalized.replace(/^\.\//, "");
}

function matchesConstraint(value, target) {
  const constraints = Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];
  if (constraints.includes(`!${target}`)) return false;
  const positive = constraints.filter((item) => !item.startsWith("!"));
  return positive.length === 0 || positive.includes(target);
}

function isTargetConstraint(value, target) {
  const positive = (Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [])
    .filter((item) => !item.startsWith("!"));
  return positive.length === 1 && positive[0] === target;
}

async function assertResourceFile(filePath, resource) {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile() || info.size !== resource.size || await sha256File(filePath) !== resource.sha256) {
    throw new Error(`Resource integrity check failed: ${filePath}`);
  }
}

async function collectFiles(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push({ path: path.relative(root, fullPath).split(path.sep).join("/"), sha256: await sha256File(fullPath) });
    }
  };
  await visit(root);
  return files;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function resolveResourceUrl(projectRoot, url) {
  const pathname = String(url).split("?", 1)[0];
  const target = path.resolve(projectRoot, ...pathname.split("/"));
  if (!target.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) throw new Error(`Unsafe resource URL: ${url}`);
  return target;
}

function archiveName(definition, platform, arch) {
  return definition.artifactKind === "universal"
    ? `${definition.projectId}-universal.tgz`
    : `${definition.projectId}-${platform}-${arch}.tgz`;
}

function assertReleaseIdentity(definition, options) {
  if (options.tag !== definition.tag) throw new Error(`Release tag must be ${definition.tag}.`);
  normalizeCommit(options.commit);
}

function normalizeTargetGroup(value) {
  if (value !== "mac" && value !== "windows") throw new Error("target-group must be mac or windows.");
  return value;
}

function normalizeVersion(value) {
  const normalized = String(value ?? "").trim().replace(/^v/, "");
  if (!semver.valid(normalized) || semver.prerelease(normalized)) throw new Error(`Invalid stable version: ${value}.`);
  return normalized;
}

function normalizeCommit(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!COMMIT_PATTERN.test(normalized)) throw new Error(`Invalid 40-character commit SHA: ${value}.`);
  return normalized;
}

function normalizeTimestamp(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(`Invalid release timestamp: ${value}.`);
  return normalized;
}

function runCommand(command, args, options) {
  const invocation = resolveSpawnInvocation(command, args, {
    platform: process.platform,
    execPath: process.execPath,
    comSpec: options.env?.ComSpec ?? process.env.ComSpec,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}.`)));
  });
}

export function resolveSpawnInvocation(command, args, options = {}) {
  if ((options.platform ?? process.platform) === "win32" && command === "corepack") {
    const corepackCommand = path.win32.join(
      path.win32.dirname(options.execPath ?? process.execPath),
      "corepack.cmd",
    );
    return {
      command: options.comSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "call", corepackCommand, ...args],
    };
  }
  return { command, args };
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rm(filePath, { force: true });
  await rename(temporary, filePath);
}

async function replaceDirectory(staged, target) {
  const backup = `${target}.previous-${process.pid}-${Date.now()}`;
  let moved = false;
  await rm(backup, { recursive: true, force: true });
  try {
    await rename(target, backup);
    moved = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(staged, target);
  } catch (error) {
    if (moved) await rename(backup, target);
    throw error;
  }
  if (moved) await rm(backup, { recursive: true, force: true });
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(filePath) {
  return Boolean(await stat(filePath).catch(() => undefined));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token?.startsWith("--")) throw new Error(`Unknown argument: ${token}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}.`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function main(argv) {
  const [command, ...tokens] = argv;
  const args = parseArgs(tokens);
  const channel = normalizeChannel(args.channel);
  if (command === "verify") return verifyBuiltinProject({ root: args.root, channel });
  if (command === "build") return buildReleaseArtifacts({
    root: args.root,
    channel,
    tag: args.tag,
    commit: args.commit,
    targetGroup: args["target-group"],
    outputDir: args["output-dir"],
    runnerManifest: args["runner-manifest"],
  });
  if (command === "assemble") return assembleRelease({
    root: args.root,
    channel,
    tag: args.tag,
    commit: args.commit,
    publishedAt: args["published-at"],
    macArtifactsDir: args["mac-artifacts-dir"],
    windowsArtifactsDir: args["windows-artifacts-dir"],
    previousIndex: args["previous-index"],
    outputDir: args["output-dir"],
  });
  if (command === "verify-distribution") return verifyDistribution({
    root: args.root,
    channel,
    resourcesRoot: args["resources-root"],
  });
  if (command === "publish") return publishDistribution({
    root: args.root,
    channel,
    resourcesRoot: args["resources-root"],
    publishRoot: args["publish-root"],
  });
  throw new Error("Usage: builtin-release.mjs <verify|build|assemble|verify-distribution|publish> [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`[builtin-release] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
