import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertDirectory,
  loadProductionEnv,
  resolveReleaseStorageRoot,
} from "./release-storage.mjs";

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export function resolveStableDeploymentPaths(releaseRoot) {
  const root = path.resolve(releaseRoot);
  const channelRoot = path.join(root, "deployments", "server", "stable");
  return {
    releaseRoot: root,
    channelRoot,
    releasesRoot: path.join(channelRoot, "releases"),
    currentLink: path.join(channelRoot, "current"),
    dataRoot: path.join(root, "server-data"),
    metadataRoot: path.join(root, "releases"),
  };
}

export function createStableDeploymentId({ serverVersion, serverWebVersion, commitSha }) {
  assertStableVersion(serverVersion, "Server");
  assertStableVersion(serverWebVersion, "Server Web");
  const commit = normalizeCommit(commitSha);
  return `server-${serverVersion}__web-${serverWebVersion}__${commit.slice(0, 12)}`;
}

export function parseRemoteTagTargets(output) {
  const direct = new Map();
  const peeled = new Map();
  for (const line of String(output).trim().split(/\r?\n/u)) {
    if (!line) continue;
    const [sha, ref] = line.trim().split(/\s+/u);
    if (!COMMIT_PATTERN.test(sha ?? "") || !ref?.startsWith("refs/tags/")) continue;
    if (ref.endsWith("^{}")) peeled.set(ref.slice(0, -3), sha);
    else direct.set(ref, sha);
  }
  return new Map([...direct].map(([ref, sha]) => [ref, peeled.get(ref) ?? sha]));
}

export function assertStableTagTargets({ targets, serverVersion, serverWebVersion, commitSha }) {
  const expected = [
    `refs/tags/server/v${serverVersion}`,
    `refs/tags/server-web/v${serverWebVersion}`,
  ];
  for (const ref of expected) {
    const actual = targets.get(ref);
    if (actual !== commitSha) {
      throw new Error(`${ref} must point to ${commitSha}, received ${actual ?? "missing"}.`);
    }
  }
}

export async function createStableReleaseDefinition(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const [serverManifest, serverWebManifest] = await Promise.all([
    readJson(path.join(repoRoot, "package.json")),
    readJson(path.join(repoRoot, "web", "package.json")),
  ]);
  const serverVersion = String(serverManifest.version ?? "").trim();
  const serverWebVersion = String(serverWebManifest.version ?? "").trim();
  assertStableVersion(serverVersion, "Server");
  assertStableVersion(serverWebVersion, "Server Web");
  if (options.version && (serverVersion !== options.version || serverWebVersion !== options.version)) {
    throw new Error(
      `Server and Server Web manifests must both use promoted version ${options.version}; received ${serverVersion} and ${serverWebVersion}.`,
    );
  }

  const coreVersion = readExactStableDependency(serverManifest.dependencies?.["steamharness"], "steamharness");
  const cliVersion = readExactStableDependency(serverManifest.devDependencies?.["@steamharness/cli"], "@steamharness/cli");
  const publishedAt = normalizeTimestamp(options.publishedAt);
  const commitSha = normalizeCommit(options.commitSha);
  const deploymentId = createStableDeploymentId({ serverVersion, serverWebVersion, commitSha });
  const [serverZh, serverEn, serverWebZh, serverWebEn] = await Promise.all([
    readReleaseNotes(path.join(repoRoot, "CHANGELOG.md"), serverVersion),
    readReleaseNotes(path.join(repoRoot, "CHANGELOG.en.md"), serverVersion),
    readReleaseNotes(path.join(repoRoot, "web", "CHANGELOG.md"), serverWebVersion),
    readReleaseNotes(path.join(repoRoot, "web", "CHANGELOG.en.md"), serverWebVersion),
  ]);
  const sharedComponents = { core: coreVersion, cli: cliVersion };

  return {
    serverVersion,
    serverWebVersion,
    commitSha,
    publishedAt,
    deploymentId,
    releases: {
      server: createReleaseMetadata({
        unit: "server",
        version: serverVersion,
        commitSha,
        publishedAt,
        deploymentId,
        components: sharedComponents,
        zh: serverZh,
        en: serverEn,
      }),
      "server-web": createReleaseMetadata({
        unit: "server-web",
        version: serverWebVersion,
        commitSha,
        publishedAt,
        deploymentId,
        components: { ...sharedComponents, server: serverVersion },
        zh: serverWebZh,
        en: serverWebEn,
      }),
    },
  };
}

export async function deployStableRelease(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const definition = await createStableReleaseDefinition({
    repoRoot,
    version: options.version,
    commitSha: options.commitSha,
    publishedAt: options.publishedAt,
  });
  if (options.verifyTags !== false) {
    const listTags = options.listRemoteTags ?? listRemoteTags;
    const targets = parseRemoteTagTargets(await listTags({
      repoRoot,
      remote: options.remote ?? "origin",
      refs: [
        `refs/tags/server/v${definition.serverVersion}`,
        `refs/tags/server-web/v${definition.serverWebVersion}`,
      ],
    }));
    assertStableTagTargets({ targets, ...definition });
  }

  const releaseRoot = options.releaseRoot ?? resolveReleaseStorageRoot({ required: true });
  await assertDirectory(releaseRoot, { label: "STEAMHARNESS_RELEASE_STORAGE_ROOT", writable: true });
  const paths = resolveStableDeploymentPaths(releaseRoot);
  await Promise.all([
    mkdir(paths.releasesRoot, { recursive: true }),
    mkdir(paths.dataRoot, { recursive: true }),
  ]);
  const releaseDir = path.join(paths.releasesRoot, definition.deploymentId);
  const stagingDir = path.join(paths.releasesRoot, `.staging-${definition.deploymentId}-${process.pid}`);
  const previousTarget = await readCurrentTarget(paths.currentLink);
  if (previousTarget && path.dirname(previousTarget) !== paths.releasesRoot) {
    throw new Error(`Current stable release is outside its release directory: ${previousTarget}`);
  }
  const previousMetadata = await readStableReleaseMetadata(paths);
  const execute = options.runCommand ?? runCommand;
  const reused = await exists(releaseDir);

  if (reused) {
    const existing = await readJson(path.join(releaseDir, "stable-deployment.json"));
    if (
      existing.channel !== "stable"
      || existing.deploymentId !== definition.deploymentId
      || existing.commitSha !== definition.commitSha
      || existing.serverVersion !== definition.serverVersion
      || existing.serverWebVersion !== definition.serverWebVersion
    ) {
      throw new Error(`Stable deployment ${definition.deploymentId} already exists with another identity.`);
    }
  } else {
    await rm(stagingDir, { recursive: true, force: true });
    try {
      await execute("corepack", [
        "pnpm",
        "--filter",
        "@steamharness/server",
        "deploy",
        "--prod",
        "--legacy",
        stagingDir,
      ], { cwd: repoRoot, env: options.env });
      await assertPackagedStableRelease(stagingDir);
      await writeFile(path.join(stagingDir, "stable-deployment.json"), `${JSON.stringify({
        schemaVersion: 1,
        channel: "stable",
        deploymentId: definition.deploymentId,
        serverVersion: definition.serverVersion,
        serverWebVersion: definition.serverWebVersion,
        commitSha: definition.commitSha,
        publishedAt: definition.publishedAt,
      }, null, 2)}\n`, "utf8");
      await rename(stagingDir, releaseDir);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  await replaceSymlink(paths.currentLink, releaseDir);
  const runtimeEnv = createRuntimeEnv(options.env ?? process.env, paths, releaseDir, options.port);
  try {
    await execute(process.execPath, [path.join(releaseDir, "scripts", "deploy.mjs"), "start"], {
      cwd: releaseDir,
      env: runtimeEnv,
    });
    await writeStableReleaseMetadata(paths, definition.releases);
    await verifyStableHealth({
      url: `http://127.0.0.1:${readPort(options.port)}/health`,
      definition,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.healthTimeoutMs,
    });
    if (options.publicUrl) {
      await verifyStableHealth({
        url: `${String(options.publicUrl).replace(/\/$/u, "")}/health`,
        definition,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.healthTimeoutMs,
      });
    }
  } catch (error) {
    const rollbackErrors = await rollbackStableDeployment({
      error,
      execute,
      paths,
      releaseDir,
      previousTarget,
      previousMetadata,
      env: options.env ?? process.env,
      port: options.port,
    });
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Stable deployment failed and rollback was incomplete.");
    }
    throw error;
  }

  const result = {
    channel: "stable",
    deploymentId: definition.deploymentId,
    serverVersion: definition.serverVersion,
    serverWebVersion: definition.serverWebVersion,
    commitSha: definition.commitSha,
    releaseDir,
    currentLink: paths.currentLink,
    reused,
  };
  if (options.output) await writeAtomicFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function rollbackStableDeployment(options) {
  const errors = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  await attempt(() => options.execute(process.execPath, [path.join(options.releaseDir, "scripts", "deploy.mjs"), "stop"], {
    cwd: options.releaseDir,
    env: createRuntimeEnv(options.env, options.paths, options.releaseDir, options.port),
  }));
  await attempt(async () => {
    if (options.previousTarget) await replaceSymlink(options.paths.currentLink, options.previousTarget);
    else await rm(options.paths.currentLink, { force: true });
  });
  await attempt(() => restoreStableReleaseMetadata(options.previousMetadata));
  if (options.previousTarget) {
    await attempt(() => options.execute(process.execPath, [path.join(options.previousTarget, "scripts", "deploy.mjs"), "start"], {
      cwd: options.previousTarget,
      env: createRuntimeEnv(options.env, options.paths, options.previousTarget, options.port),
    }));
  }
  return errors;
}

async function verifyStableHealth(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let lastError;
  do {
    try {
      const response = await fetchImpl(options.url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status ?? "error"}`);
      const payload = await response.json();
      const data = payload?.data;
      if (data?.versions?.serverVersion !== options.definition.serverVersion) {
        throw new Error(`Server health reports ${data?.versions?.serverVersion ?? "unknown"}.`);
      }
      for (const [key, unit] of [["server", "server"], ["serverWeb", "server-web"]]) {
        const release = data?.deployment?.[key];
        const expected = options.definition.releases[unit];
        if (release?.version !== expected.version || release?.commitSha !== expected.commitSha) {
          throw new Error(`${unit} health release identity is stale.`);
        }
      }
      return payload;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } while (Date.now() < deadline);
  throw new Error(`Stable Server health verification failed at ${options.url}: ${lastError?.message ?? "unknown error"}`, {
    cause: lastError,
  });
}

function createReleaseMetadata(options) {
  return {
    schemaVersion: 1,
    unit: options.unit,
    channel: "stable",
    tag: `${options.unit}/v${options.version}`,
    version: options.version,
    commitSha: options.commitSha,
    publishedAt: options.publishedAt,
    deploymentId: options.deploymentId,
    components: options.components,
    releaseNotes: {
      format: "markdown",
      body: options.zh,
      localizations: {
        "zh-CN": { format: "markdown", body: options.zh },
        en: { format: "markdown", body: options.en },
      },
    },
  };
}

async function readReleaseNotes(filePath, version) {
  const contents = (await readFile(filePath, "utf8")).replace(/\r\n?/gu, "\n");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = contents.match(new RegExp(`^## ${escaped} - [^\\n]+\\n+([\\s\\S]*?)(?=^## |$)`, "mu"));
  const body = match?.[1]?.trim();
  if (!body) throw new Error(`${path.basename(filePath)} has no ${version} release notes.`);
  return body;
}

async function assertPackagedStableRelease(root) {
  for (const relativePath of ["dist/index.js", "public/index.html", "scripts/deploy.mjs", "package.json", "web/package.json"]) {
    const filePath = path.join(root, relativePath);
    const info = await lstat(filePath).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`Stable Server package is missing ${relativePath}.`);
  }
}

async function writeStableReleaseMetadata(paths, releases) {
  for (const [unit, release] of Object.entries(releases)) {
    await writeAtomicFile(
      path.join(paths.metadataRoot, unit, "stable", "release.json"),
      `${JSON.stringify(release, null, 2)}\n`,
    );
  }
}

async function readStableReleaseMetadata(paths) {
  return Promise.all(["server", "server-web"].map(async (unit) => {
    const filePath = path.join(paths.metadataRoot, unit, "stable", "release.json");
    try {
      return [filePath, await readFile(filePath, "utf8")];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [filePath, undefined];
      throw error;
    }
  }));
}

async function restoreStableReleaseMetadata(metadata) {
  for (const [filePath, contents] of metadata) {
    if (contents === undefined) await rm(filePath, { force: true });
    else await writeAtomicFile(filePath, contents);
  }
}

function createRuntimeEnv(env, paths, releaseDir, port) {
  return {
    ...env,
    NODE_ENV: "production",
    STEAMHARNESS_RELEASE_CHANNEL: "stable",
    STEAMHARNESS_REPO_ROOT: releaseDir,
    STEAMHARNESS_RELEASE_STORAGE_ROOT: paths.releaseRoot,
    STEAMHARNESS_RELEASE_METADATA_DIR: paths.metadataRoot,
    STEAMHARNESS_SERVER_DATA_DIR: paths.dataRoot,
    STEAMHARNESS_SERVER_PORT: String(readPort(port)),
    PORT: String(readPort(port)),
  };
}

async function replaceSymlink(linkPath, targetPath) {
  const existing = await lstat(linkPath).catch(() => undefined);
  if (existing && !existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink path: ${linkPath}`);
  await mkdir(path.dirname(linkPath), { recursive: true });
  const temporary = `${linkPath}.next-${process.pid}`;
  await rm(temporary, { force: true });
  await symlink(path.relative(path.dirname(linkPath), targetPath), temporary, "dir");
  await rename(temporary, linkPath);
}

async function readCurrentTarget(linkPath) {
  try {
    const info = await lstat(linkPath);
    if (!info.isSymbolicLink()) throw new Error(`Current stable path is not a symlink: ${linkPath}`);
    return path.resolve(path.dirname(linkPath), await readlink(linkPath));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomicFile(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.next-${process.pid}`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, filePath);
}

async function listRemoteTags({ repoRoot, remote, refs }) {
  const patterns = refs.flatMap((ref) => [ref, `${ref}^{}`]);
  const { stdout } = await promisify(execFile)("git", ["ls-remote", "--tags", remote, ...patterns], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout;
}

function assertStableVersion(version, label) {
  if (!STABLE_VERSION_PATTERN.test(String(version))) throw new Error(`${label} version is not stable SemVer: ${version}`);
}

function readExactStableDependency(value, name) {
  const version = String(value ?? "").trim();
  assertStableVersion(version, name);
  return version;
}

function normalizeCommit(value) {
  const commit = String(value ?? "").trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) throw new Error("Stable deployment commit must be a full Git SHA.");
  return commit;
}

function normalizeTimestamp(value) {
  const timestamp = String(value ?? "").trim();
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) throw new Error(`Stable deployment timestamp is invalid: ${value}`);
  return timestamp;
}

function readPort(value) {
  const port = Number(value ?? process.env.STEAMHARNESS_SERVER_PORT ?? 7130);
  return Number.isInteger(port) && port > 0 ? port : 7130;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function exists(filePath) {
  return lstat(filePath).then(() => true, () => false);
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!["--version", "--commit-sha", "--published-at", "--public-url", "--output"].includes(token)) {
      throw new Error(`Unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}.`);
    options[token.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadProductionEnv();
  const args = parseArgs(process.argv.slice(2));
  const version = args.version ?? String(process.env.CI_COMMIT_TAG ?? "").replace(/^server-web\/v/u, "");
  const commitSha = args.commitSha ?? process.env.CI_COMMIT_SHA;
  const publishedAt = args.publishedAt ?? process.env.CI_COMMIT_TIMESTAMP ?? new Date().toISOString();
  const publicUrl = args.publicUrl ?? process.env.STEAMHARNESS_API_PUBLIC_BASE_URL;
  if (!STABLE_VERSION_PATTERN.test(version)) throw new Error("Usage: pnpm deploy:stable -- --version X.Y.Z");
  if (!publicUrl) throw new Error("STEAMHARNESS_API_PUBLIC_BASE_URL or --public-url is required for stable deployment verification.");
  const result = await deployStableRelease({
    repoRoot: path.resolve(import.meta.dirname, ".."),
    releaseRoot: resolveReleaseStorageRoot({ required: true }),
    version,
    commitSha,
    publishedAt,
    publicUrl,
    output: args.output,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
