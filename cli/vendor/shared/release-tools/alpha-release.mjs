import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const ALPHA_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-(\d{8})(\d{3})$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const ZERO_SHA = /^0{40}$/u;
const MANIFEST_PATH_PATTERN = /(^|\/)package\.json$/u;
const RELEASE_METADATA_PATH_PATTERNS = Object.freeze([
  /^\.ci-artifacts(?:\/|$)/u,
  /^\.release(?:\/|$)/u,
  /^\.workflow-local(?:\/|$)/u,
  /^\.gitlab-ci\.yml$/u,
  /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/u,
  /^(?:\.agents|\.claude|\.codex)(?:\/|$)/u,
  /(?:^|\/)__tests__(?:\/|$)/u,
  /^(?:docs?|documentation|guides)(?:\/|$)/u,
  /(?:^|\/)(?:CHANGELOG|README|DESIGN|DESIGN-CODE-CONTRACT)(?:\.next)?(?:\.en)?\.md$/u,
  /^(?:vendor\/shared\/)?(?:\.workflow-shared-release\.json|release-tools(?:\/|$))/u,
  /^dist(?:\/|$)/u,
]);

export function formatAlphaDate(date = new Date(), timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

export function nextStablePatch(version) {
  const match = STABLE_VERSION_PATTERN.exec(String(version).trim());
  if (!match) throw new Error(`Stable manifest version is invalid: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * Return true only when a commit range contains product, dependency, or
 * effective vendored-source changes. Release bookkeeping is intentionally
 * ignored so a baseline-only commit cannot publish an empty Alpha.
 */
export async function hasReleaseChanges({
  root,
  beforeSha,
  currentSha,
  runCommand = run,
} = {}) {
  const resolvedRoot = path.resolve(root ?? process.cwd());
  const current = normalizeCommitSha(
    currentSha
      || process.env.CI_COMMIT_SHA
      || await runCommand("git", ["rev-parse", "HEAD"], { cwd: resolvedRoot, capture: true }),
    "Release commit SHA",
  );

  let before = String(beforeSha ?? process.env.CI_COMMIT_BEFORE_SHA ?? "").trim();
  if (!before || ZERO_SHA.test(before)) {
    try {
      before = String(await runCommand("git", ["rev-parse", `${current}^`], {
        cwd: resolvedRoot,
        capture: true,
      })).trim();
    } catch {
      // A first pipeline or a shallow checkout has no comparable parent. It
      // is safer to build once than to silently suppress a real release.
      return true;
    }
  }
  if (!before || ZERO_SHA.test(before) || before === current) return false;

  let output;
  try {
    output = await runCommand("git", ["diff", "--name-status", before, current], {
      cwd: resolvedRoot,
      capture: true,
    });
  } catch {
    // Missing history in a shallow runner must fail open for publication.
    return true;
  }
  const changes = parseChangedPaths(output);
  for (const change of changes) {
    if (isReleaseMetadataPath(change.path)) continue;
    if (MANIFEST_PATH_PATTERN.test(change.path)) {
      if (await manifestHasReleaseChanges({ resolvedRoot, before, current, filePath: change.path, runCommand })) return true;
      continue;
    }
    return true;
  }
  return false;
}

export function parseChangedPaths(output) {
  return String(output ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\t+/u))
    .filter((parts) => parts.length >= 2 && parts[0])
    .map(([status, ...paths]) => ({
      status,
      // Rename/copy records contain old and new paths. The new path is the
      // one whose contents are present in the release candidate.
      path: String(paths.at(-1) ?? "").replaceAll("\\", "/"),
    }))
    .filter(({ path: filePath }) => filePath !== "");
}

function isReleaseMetadataPath(filePath) {
  return RELEASE_METADATA_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

async function manifestHasReleaseChanges({ resolvedRoot, before, current, filePath, runCommand }) {
  const [beforeContents, currentContents] = await Promise.all([
    readGitFile({ resolvedRoot, sha: before, filePath, runCommand }),
    readGitFile({ resolvedRoot, sha: current, filePath, runCommand }),
  ]);
  if (beforeContents === undefined || currentContents === undefined) return true;
  try {
    const beforeManifest = JSON.parse(beforeContents);
    const currentManifest = JSON.parse(currentContents);
    delete beforeManifest.version;
    delete currentManifest.version;
    return stableJson(beforeManifest) !== stableJson(currentManifest);
  } catch {
    // Invalid JSON is a product/build failure, not a reason to suppress a
    // candidate. Let the normal validation job report the precise error.
    return beforeContents !== currentContents;
  }
}

async function readGitFile({ resolvedRoot, sha, filePath, runCommand }) {
  try {
    return String(await runCommand("git", ["show", `${sha}:${filePath}`], {
      cwd: resolvedRoot,
      capture: true,
    }));
  } catch {
    return undefined;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function formatReleaseChangeDotenv(changed, variable = "WORKFLOW_ALPHA_CHANGED") {
  const normalizedVariable = String(variable).trim();
  if (!/^[A-Z][A-Z0-9_]*$/u.test(normalizedVariable)) {
    throw new Error(`Release environment variable is invalid: ${variable}`);
  }
  return `${normalizedVariable}=${changed === true ? "true" : "false"}\n`;
}

function normalizeCommitSha(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA_PATTERN.test(normalized) || ZERO_SHA.test(normalized)) {
    throw new Error(`${label} is invalid: ${value}`);
  }
  return normalized;
}

export async function bumpStableManifestVersions({ root, manifestPaths, incrementPatch = false }) {
  if (incrementPatch !== true) {
    throw new Error("A stable version bump requires an explicit --increment-patch instruction.");
  }
  const resolvedRoot = path.resolve(root);
  const paths = [...new Set(manifestPaths?.length ? manifestPaths : ["package.json"])]
    .map((manifestPath) => path.resolve(resolvedRoot, manifestPath));
  const manifests = await Promise.all(paths.map(async (filePath) => ({
    filePath,
    manifest: JSON.parse(await readFile(filePath, "utf8")),
  })));
  const baseVersion = String(manifests[0]?.manifest.version ?? "").trim();
  if (!STABLE_VERSION_PATTERN.test(baseVersion)) throw new Error(`Stable manifest version is invalid: ${baseVersion}`);
  for (const { filePath, manifest } of manifests) {
    const version = String(manifest.version ?? "").trim();
    if (!STABLE_VERSION_PATTERN.test(version)) throw new Error(`Stable manifest version is invalid: ${version}`);
    if (version !== baseVersion) {
      throw new Error(`Manifest versions must match before an explicit bump: ${version} != ${baseVersion} (${path.relative(resolvedRoot, filePath)}).`);
    }
  }
  const version = nextStablePatch(baseVersion);
  await Promise.all(manifests.map(({ filePath, manifest }) => {
    manifest.version = version;
    return writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }));
  return { version, manifests: manifests.map(({ filePath }) => path.relative(resolvedRoot, filePath)) };
}

export function formatReleaseDotenv(result, prefix = "ALPHA") {
  const normalizedPrefix = String(prefix).trim();
  if (!/^[A-Z][A-Z0-9_]*$/u.test(normalizedPrefix)) {
    throw new Error(`Release environment prefix is invalid: ${prefix}`);
  }
  return `${normalizedPrefix}_VERSION=${result.version}\n${normalizedPrefix}_TAG=${result.tag}\n`;
}

export function nextAlphaVersion({ baseVersion, existingVersions = [], date = formatAlphaDate() }) {
  if (!/^\d{8}$/u.test(date)) throw new Error(`Alpha date must use YYYYMMDD: ${date}`);
  if (!STABLE_VERSION_PATTERN.test(String(baseVersion).trim())) {
    throw new Error(`Alpha branch version is invalid: ${baseVersion}`);
  }
  const normalizedBaseVersion = String(baseVersion).trim();
  let highestSequence = 0;
  for (const value of existingVersions) {
    const match = ALPHA_VERSION_PATTERN.exec(String(value).trim());
    if (!match || `${match[1]}.${match[2]}.${match[3]}` !== normalizedBaseVersion || match[4] !== date) continue;
    highestSequence = Math.max(highestSequence, Number(match[5]));
  }
  if (highestSequence >= 999) throw new Error(`Alpha sequence exhausted for ${normalizedBaseVersion} on ${date}.`);
  return `${normalizedBaseVersion}-${date}${String(highestSequence + 1).padStart(3, "0")}`;
}

export function readAlphaVersionFromTag(ref, tagPrefix = "alpha/v") {
  const marker = `refs/tags/${tagPrefix}`;
  if (!ref.startsWith(marker) || ref.endsWith("^{}")) return undefined;
  const version = ref.slice(marker.length);
  return ALPHA_VERSION_PATTERN.test(version) ? version : undefined;
}

export function parseRemoteAlphaTags(output, tagPrefix = "alpha/v") {
  const tags = new Map();
  for (const line of String(output).split(/\r?\n/u)) {
    const [sha, ref] = line.trim().split(/\s+/u);
    if (!/^[0-9a-f]{40}$/iu.test(sha ?? "") || !ref) continue;
    const directRef = ref.endsWith("^{}") ? ref.slice(0, -3) : ref;
    const version = readAlphaVersionFromTag(directRef, tagPrefix);
    if (!version) continue;
    const existing = tags.get(directRef);
    tags.set(directRef, {
      tag: `${tagPrefix}${version}`,
      version,
      commitSha: ref.endsWith("^{}") || !existing ? sha.toLowerCase() : existing.commitSha,
    });
  }
  return [...tags.values()];
}

export async function writeAlphaManifestVersions({ root, manifestPaths, version }) {
  const alphaMatch = ALPHA_VERSION_PATTERN.exec(String(version));
  if (!alphaMatch) throw new Error(`Alpha version is invalid: ${version}`);
  const alphaBaseVersion = `${alphaMatch[1]}.${alphaMatch[2]}.${alphaMatch[3]}`;
  const resolvedRoot = path.resolve(root);
  const manifests = [];
  for (const manifestPath of manifestPaths) {
    const filePath = path.resolve(resolvedRoot, manifestPath);
    const manifest = JSON.parse(await readFile(filePath, "utf8"));
    if (manifest.version === version) {
      manifests.push({ filePath, manifest });
      continue;
    }
    if (ALPHA_VERSION_PATTERN.test(String(manifest.version))) {
      throw new Error(`${manifestPath} already uses alpha version ${manifest.version}; refusing to replace it with ${version}.`);
    }
    if (String(manifest.version) !== alphaBaseVersion) {
      throw new Error(`${version} must use declared alpha base ${manifest.version} for ${manifestPath}.`);
    }
    manifest.version = version;
    manifests.push({ filePath, manifest });
  }
  await Promise.all(manifests.map(({ filePath, manifest }) =>
    writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")));
}

export async function listRemoteAlphaVersions({ root, tagPrefix = "alpha/v", runCommand = run }) {
  return (await listRemoteAlphaTags({ root, tagPrefix, runCommand })).map((entry) => entry.version);
}

export async function listRemoteAlphaTags({ root, tagPrefix = "alpha/v", runCommand = run }) {
  const output = await runCommand("git", ["ls-remote", "--tags", "origin", `refs/tags/${tagPrefix}*`], {
    cwd: path.resolve(root),
    capture: true,
  });
  return parseRemoteAlphaTags(output, tagPrefix);
}

export function parseRemoteBranchHead(output, branch) {
  const expectedRef = `refs/heads/${branch}`;
  const matches = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([sha, ref]) => /^[0-9a-f]{40}$/iu.test(sha ?? "") && ref === expectedRef);
  if (matches.length !== 1) throw new Error(`Remote branch ${branch} does not resolve to exactly one commit.`);
  return matches[0][0].toLowerCase();
}

export async function assertRemoteBranchHead({ root, branch, commitSha, runCommand = run }) {
  if (!/^[a-z0-9][a-z0-9._/-]*$/iu.test(String(branch))) {
    throw new Error(`Alpha branch name is invalid: ${branch}`);
  }
  const output = await runCommand("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], {
    cwd: path.resolve(root),
    capture: true,
  });
  const remoteHead = parseRemoteBranchHead(output, branch);
  if (remoteHead !== commitSha) {
    throw new Error(`Alpha commit ${commitSha} is superseded by origin/${branch} at ${remoteHead}.`);
  }
  return remoteHead;
}

export async function reserveAlphaVersion(options) {
  const root = path.resolve(options.root);
  const manifestPath = options.manifestPaths[0];
  const manifest = JSON.parse(await readFile(path.resolve(root, manifestPath), "utf8"));
  const runCommand = options.runCommand ?? run;
  const tagPrefix = options.tagPrefix ?? "alpha/v";
  const commitSha = String(
    options.commitSha
      || process.env.CI_COMMIT_SHA
      || await runCommand("git", ["rev-parse", "HEAD"], { cwd: root, capture: true }),
  ).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error(`Alpha commit SHA is invalid: ${commitSha}`);
  if (options.branch) {
    await assertRemoteBranchHead({ root, branch: options.branch, commitSha, runCommand });
  }
  if (options.ifChanged === true) {
    const changed = await hasReleaseChanges({
      root,
      beforeSha: options.beforeSha,
      currentSha: commitSha,
      runCommand,
    });
    if (!changed) return { changed: false, commitSha };
  }
  const existingTags = await listRemoteAlphaTags({
    root,
    tagPrefix,
    runCommand,
  });
  const reserved = existingTags
    .filter((entry) => entry.commitSha === commitSha)
    .sort((left, right) => compareAlphaVersions(left.version, right.version))
    .at(-1);
  if (reserved) return { version: reserved.version, tag: reserved.tag, reused: true };

  const siblingTagPrefix = tagPrefix === "alpha/v"
    ? "dev/v"
    : tagPrefix === "dev/v"
      ? "alpha/v"
      : undefined;
  const siblingTags = siblingTagPrefix
    ? await listRemoteAlphaTags({ root, tagPrefix: siblingTagPrefix, runCommand })
    : [];

  const version = nextAlphaVersion({
    baseVersion: manifest.version,
    existingVersions: [...existingTags, ...siblingTags].map((entry) => entry.version),
    date: options.date,
  });
  const tag = `${tagPrefix}${version}`;
  if (options.dryRun !== true) {
    await runCommand("git", ["tag", tag, commitSha], { cwd: root });
    try {
      await runCommand("git", ["push", "origin", `refs/tags/${tag}`], {
        cwd: root,
        env: createGitAuthenticationEnv(options.token, options.tokenUsername),
      });
    } catch (error) {
      await runCommand("git", ["tag", "-d", tag], { cwd: root }).catch(() => undefined);
      throw error;
    }
  }
  return { version, tag };
}

function compareAlphaVersions(left, right) {
  const leftParts = String(left).split(/[.-]/u).map(Number);
  const rightParts = String(right).split(/[.-]/u).map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function createGitAuthenticationEnv(
  token = process.env.WORKFLOW_ALPHA_SYNC_TOKEN || process.env.CI_JOB_TOKEN,
  username = process.env.WORKFLOW_ALPHA_SYNC_USERNAME || (process.env.WORKFLOW_ALPHA_SYNC_TOKEN ? "oauth2" : "gitlab-ci-token"),
) {
  if (!token) return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const authorization = Buffer.from(`${username}:${token}`, "utf8").toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(`${command} ${args.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function parseArgs(argv) {
  const [command = ""] = argv;
  const options = { manifestPaths: [], tagPrefix: "alpha/v", dryRun: false };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--if-changed" || token === "--increment-patch") {
      options[token === "--if-changed" ? "ifChanged" : "incrementPatch"] = true;
      continue;
    }
    if (["--manifest", "--tag-prefix", "--output", "--version", "--date", "--branch", "--env-prefix", "--before", "--current"].includes(token)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${token} requires a value.`);
      if (token === "--manifest") options.manifestPaths.push(value);
      else {
        const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
        options[key === "before" ? "beforeSha" : key === "current" ? "currentSha" : key] = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (options.manifestPaths.length === 0) options.manifestPaths.push("package.json");
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (options.incrementPatch && command !== "bump") {
    throw new Error("--increment-patch is only valid with the bump command.");
  }
  if (options.ifChanged && command !== "reserve") {
    throw new Error("--if-changed is only valid with the reserve command.");
  }
  const root = process.cwd();
  if (command === "reserve") {
    const result = await reserveAlphaVersion({ root, ...options });
    const dotenv = result.changed === false
      ? formatReleaseChangeDotenv(false)
      : `${formatReleaseChangeDotenv(true)}${formatReleaseDotenv(result, options.envPrefix)}`;
    if (options.output) await writeFile(path.resolve(root, options.output), dotenv, "utf8");
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "changed") {
    const changed = await hasReleaseChanges({
      root,
      beforeSha: options.beforeSha,
      currentSha: options.currentSha,
    });
    const dotenv = formatReleaseChangeDotenv(changed);
    if (options.output) await writeFile(path.resolve(root, options.output), dotenv, "utf8");
    process.stdout.write(`${JSON.stringify({ changed })}\n`);
    return;
  }
  if (command === "bump") {
    const result = await bumpStableManifestVersions({
      root,
      manifestPaths: options.manifestPaths,
      incrementPatch: options.incrementPatch,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "write") {
    if (!options.version) throw new Error("write requires --version.");
    await writeAlphaManifestVersions({ root, manifestPaths: options.manifestPaths, version: options.version });
    process.stdout.write(`${JSON.stringify({ version: options.version, manifests: options.manifestPaths })}\n`);
    return;
  }
  throw new Error("Usage: alpha-release.mjs <reserve|changed|bump|write> [--manifest package.json] [--if-changed] [--increment-patch] [--tag-prefix alpha/v] [--branch alpha] [--env-prefix ALPHA]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
