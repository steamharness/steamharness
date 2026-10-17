import { spawn } from "node:child_process";
import { closeSync, lstatSync, openSync } from "node:fs";
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
import {
  assertDirectory,
  loadProductionEnv,
  resolveReleaseStorageRoot,
} from "./release-storage.mjs";

const ALPHA_VERSION_PATTERN = /^\d+\.\d+\.\d+-\d{11}$/u;

export function resolveAlphaDeploymentPaths(releaseRoot) {
  const root = path.resolve(releaseRoot);
  const channelRoot = path.join(root, "deployments", "server", "alpha");
  return {
    releaseRoot: root,
    channelRoot,
    releasesRoot: path.join(channelRoot, "releases"),
    currentLink: path.join(channelRoot, "current"),
    runRoot: path.join(channelRoot, "run"),
    dataRoot: path.join(root, "server-data", "alpha"),
    metadataRoot: path.join(root, "releases"),
  };
}

export async function selectAlphaReleasesToPrune({ releases, retain = 3, currentVersion }) {
  return releases
    .filter((name) => ALPHA_VERSION_PATTERN.test(name))
    .sort(compareAlphaVersions)
    .slice(0, -retain)
    .filter((name) => name !== currentVersion);
}

export function assertAlphaDeploymentCanAdvance(currentVersion, nextVersion) {
  if (currentVersion && compareAlphaVersions(currentVersion, nextVersion) > 0) {
    throw new Error(`Server alpha ${nextVersion} is superseded by the deployed version ${currentVersion}.`);
  }
}

export async function deployAlphaRelease(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const version = options.version;
  if (!ALPHA_VERSION_PATTERN.test(version)) throw new Error(`Invalid Server alpha version: ${version}`);
  const [serverManifest, webManifest] = await Promise.all([
    readJson(path.join(repoRoot, "package.json")),
    readJson(path.join(repoRoot, "web", "package.json")),
  ]);
  if (serverManifest.version !== version || webManifest.version !== version) {
    throw new Error(`Server and Server Web manifests must both use ${version}.`);
  }

  const releaseRoot = options.releaseRoot ?? resolveReleaseStorageRoot({ required: true });
  await assertDirectory(releaseRoot, { label: "WORKFLOW_RELEASE_STORAGE_ROOT", writable: true });
  const paths = resolveAlphaDeploymentPaths(releaseRoot);
  await Promise.all([
    mkdir(paths.releasesRoot, { recursive: true }),
    mkdir(paths.runRoot, { recursive: true }),
    mkdir(paths.dataRoot, { recursive: true }),
  ]);
  const releaseDir = path.join(paths.releasesRoot, version);
  const previousTarget = await readCurrentTarget(paths.currentLink);
  assertAlphaDeploymentCanAdvance(readVersionFromTarget(previousTarget), version);
  const stagingDir = path.join(paths.releasesRoot, `.staging-${version}-${process.pid}`);
  await rm(stagingDir, { recursive: true, force: true });

  const executeCommand = options.runCommand ?? runCommand;
  const commitSha = options.commitSha ?? process.env.CI_COMMIT_SHA ?? "unknown";
  const reused = await exists(releaseDir);
  if (reused) {
    const existing = await readJson(path.join(releaseDir, "alpha-release.json"));
    if (existing.channel !== "alpha" || existing.version !== version || existing.commitSha !== commitSha) {
      throw new Error(`Server alpha ${version} already exists with a different release identity.`);
    }
  } else {
    try {
      await executeCommand("corepack", [
        "pnpm",
        "--filter",
        "@workflow-code/server",
        "deploy",
        "--prod",
        "--legacy",
        stagingDir,
      ], { cwd: repoRoot });
      await writeFile(path.join(stagingDir, "alpha-release.json"), `${JSON.stringify({
        channel: "alpha",
        version,
        commitSha,
        publishedAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      await rename(stagingDir, releaseDir);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  const previousMetadata = await readAlphaReleaseMetadata(paths);
  await stopAlphaProcess(paths, { quiet: true });
  await replaceSymlink(paths.currentLink, releaseDir);
  try {
    await startAlphaProcess(paths, { expectedVersion: version, port: options.port ?? 7140 });
    await writeAlphaReleaseMetadata(paths, { version, commitSha: options.commitSha });
  } catch (error) {
    await stopAlphaProcess(paths, { quiet: true });
    if (previousTarget) {
      await replaceSymlink(paths.currentLink, path.resolve(path.dirname(paths.currentLink), previousTarget));
    } else {
      await rm(paths.currentLink, { force: true });
    }
    await restoreAlphaReleaseMetadata(paths, previousMetadata);
    if (previousTarget) {
      await startAlphaProcess(paths, { port: options.port ?? 7140 }).catch((rollbackError) => {
        throw new AggregateError([error, rollbackError], "Alpha deployment and rollback restart both failed.");
      });
    }
    throw error;
  }

  await pruneAlphaReleases(paths, version, options.retain ?? 3);
  return { version, releaseDir, currentLink: paths.currentLink, port: options.port ?? 7140, reused };
}

export async function recoverAlphaRelease(options = {}) {
  const releaseRoot = options.releaseRoot ?? resolveReleaseStorageRoot({ required: true });
  await assertDirectory(releaseRoot, { label: "WORKFLOW_RELEASE_STORAGE_ROOT", writable: true });
  const paths = resolveAlphaDeploymentPaths(releaseRoot);
  const target = await readCurrentTarget(paths.currentLink);
  if (!target) throw new Error(`No deployed Server alpha release: ${paths.currentLink}`);
  const releaseDir = path.resolve(path.dirname(paths.currentLink), target);
  if (path.dirname(releaseDir) !== paths.releasesRoot) {
    throw new Error(`Current Server alpha release is outside its release directory: ${releaseDir}`);
  }
  const release = await readJson(path.join(releaseDir, "alpha-release.json"));
  if (release.channel !== "alpha" || !ALPHA_VERSION_PATTERN.test(release.version ?? "")) {
    throw new Error(`Current Server alpha release metadata is invalid: ${releaseDir}`);
  }
  const stop = options.stopProcess ?? stopAlphaProcess;
  const start = options.startProcess ?? startAlphaProcess;
  await stop(paths, { quiet: true });
  await start(paths, { expectedVersion: release.version, port: options.port ?? 7140 });
  return { version: release.version, releaseDir, currentLink: paths.currentLink, port: options.port ?? 7140 };
}

export async function startAlphaProcess(paths, options = {}) {
  const port = options.port ?? 7140;
  const entry = path.join(paths.currentLink, "dist", "index.js");
  if (!(await exists(entry))) throw new Error(`Server alpha entry does not exist: ${entry}`);
  await mkdir(paths.runRoot, { recursive: true });
  const logFile = path.join(paths.runRoot, "server.log");
  const pidFile = path.join(paths.runRoot, "server.pid");
  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [entry], {
    cwd: paths.currentLink,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      WORKFLOW_RELEASE_CHANNEL: "alpha",
      WORKFLOW_REPO_ROOT: paths.currentLink,
      WORKFLOW_RELEASE_METADATA_DIR: paths.metadataRoot,
      WORKFLOW_SERVER_DATA_DIR: paths.dataRoot,
      WORKFLOW_SERVER_PORT: String(port),
      PORT: String(port),
    },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  await writeFile(pidFile, `${child.pid}\n`, "utf8");
  const healthy = await waitForHealth({ pid: child.pid, port, expectedVersion: options.expectedVersion, timeoutMs: 30_000 });
  if (!healthy) throw new Error(`Server alpha ${options.expectedVersion ?? "rollback"} did not become healthy on port ${port}. Log: ${logFile}`);
}

export async function stopAlphaProcess(paths, options = {}) {
  const pidFile = path.join(paths.runRoot, "server.pid");
  const pid = await readPid(pidFile);
  if (pid === undefined) return;
  if (isProcessAlive(pid)) {
    process.kill(pid, "SIGTERM");
    if (!(await waitForExit(pid, 15_000)) && isProcessAlive(pid)) {
      process.kill(pid, "SIGKILL");
      await waitForExit(pid, 5_000);
    }
  }
  await rm(pidFile, { force: true });
  if (!options.quiet) process.stdout.write(`Stopped Server alpha pid ${pid}.\n`);
}

export async function pruneAlphaReleases(paths, currentVersion, retain = 3) {
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(paths.releasesRoot, { withFileTypes: true }));
  const releases = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const stale = await selectAlphaReleasesToPrune({ releases, retain, currentVersion });
  for (const version of stale) {
    const target = path.join(paths.releasesRoot, version);
    if (path.dirname(target) !== paths.releasesRoot) throw new Error(`Unsafe alpha release path: ${target}`);
    await rm(target, { recursive: true, force: true });
  }
  return stale;
}

async function writeAlphaReleaseMetadata(paths, options) {
  const publishedAt = new Date().toISOString();
  for (const unit of ["server", "server-web"]) {
    const directory = path.join(paths.metadataRoot, unit, "alpha");
    await mkdir(directory, { recursive: true });
    await writeAtomicFile(path.join(directory, "release.json"), `${JSON.stringify({
      unit,
      channel: "alpha",
      tag: `alpha/v${options.version}`,
      version: options.version,
      publishedAt,
      commitSha: options.commitSha ?? process.env.CI_COMMIT_SHA ?? null,
    }, null, 2)}\n`, "utf8");
  }
}

async function readAlphaReleaseMetadata(paths) {
  return Promise.all(["server", "server-web"].map(async (unit) => {
    const filePath = path.join(paths.metadataRoot, unit, "alpha", "release.json");
    try {
      return [filePath, await readFile(filePath, "utf8")];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [filePath, undefined];
      throw error;
    }
  }));
}

async function restoreAlphaReleaseMetadata(_paths, metadata) {
  for (const [filePath, content] of metadata) {
    if (content === undefined) await rm(filePath, { force: true });
    else await writeAtomicFile(filePath, content);
  }
}

async function writeAtomicFile(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.next-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

async function replaceSymlink(linkPath, targetPath) {
  const existing = await lstat(linkPath).catch(() => undefined);
  if (existing && !existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink path: ${linkPath}`);
  const temporary = `${linkPath}.next-${process.pid}`;
  await rm(temporary, { force: true });
  await symlink(path.relative(path.dirname(linkPath), targetPath), temporary, "dir");
  await rename(temporary, linkPath);
}

async function readCurrentTarget(linkPath) {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) throw new Error(`Current alpha path is not a symlink: ${linkPath}`);
    return await readlink(linkPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForHealth({ pid, port, expectedVersion, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const payload = await response.json();
        const version = payload?.data?.versions?.serverVersion;
        if (!expectedVersion || version === expectedVersion) return true;
      }
    } catch {
      // The process is still starting.
    }
    await delay(500);
  }
  return false;
}

async function readPid(filePath) {
  try {
    const value = Number((await readFile(filePath, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(250);
  }
  return !isProcessAlive(pid);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compareAlphaVersions(left, right) {
  const toParts = (value) => value.split(/[.-]/u).map(Number);
  const leftParts = toParts(left);
  const rightParts = toParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if ((leftParts[index] ?? 0) !== (rightParts[index] ?? 0)) return (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
  }
  return 0;
}

function readVersionFromTarget(target) {
  if (!target) return undefined;
  const version = path.basename(target);
  return ALPHA_VERSION_PATTERN.test(version) ? version : undefined;
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadProductionEnv();
  const command = process.argv[2] ?? "deploy";
  const releaseRoot = resolveReleaseStorageRoot({ required: true });
  const paths = resolveAlphaDeploymentPaths(releaseRoot);
  if (command === "stop") {
    await stopAlphaProcess(paths);
  } else if (command === "status") {
    const pid = await readPid(path.join(paths.runRoot, "server.pid"));
    process.stdout.write(`${JSON.stringify({ running: pid !== undefined && isProcessAlive(pid), pid, port: 7140, current: await readCurrentTarget(paths.currentLink) })}\n`);
  } else if (command === "deploy") {
    const version = process.env.ALPHA_VERSION || process.argv[3];
    if (!version) throw new Error("ALPHA_VERSION or a version argument is required.");
    const result = await deployAlphaRelease({ repoRoot: path.resolve(import.meta.dirname, ".."), releaseRoot, version });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "recover") {
    const result = await recoverAlphaRelease({ releaseRoot });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new Error("Usage: deploy-alpha.mjs <deploy|recover|stop|status> [version]");
  }
}
