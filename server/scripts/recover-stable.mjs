import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertDirectory,
  assertReleaseStorageRootWritable,
  loadProductionEnv,
  resolveReleasePaths,
  resolveReleaseStorageRoot,
} from "./release-storage.mjs";
import { validateRecoveryEnvironment } from "./recover-services.mjs";

const STABLE_TAG_PATTERN = /^server\/v(\d+\.\d+\.\d+)$/u;

export function resolveStableRecoveryPaths(releaseRoot) {
  const root = path.resolve(releaseRoot);
  const channelRoot = path.join(root, "deployments", "server", "stable");
  return {
    releaseRoot: root,
    channelRoot,
    releasesRoot: path.join(channelRoot, "releases"),
    currentLink: path.join(channelRoot, "current"),
    metadataFile: path.join(root, "releases", "server", "stable", "release.json"),
  };
}

export function parseStableReleaseMetadata(value) {
  if (!value || value.unit !== "server" || value.channel !== "stable") {
    throw new Error("Stable Server release metadata is invalid.");
  }
  const match = STABLE_TAG_PATTERN.exec(String(value.tag ?? ""));
  if (!match || value.version !== match[1]) {
    throw new Error("Stable Server release metadata does not contain a matching server tag and version.");
  }
  const deploymentId = value.deploymentId === undefined ? undefined : String(value.deploymentId);
  if (deploymentId !== undefined && (!deploymentId || path.basename(deploymentId) !== deploymentId || deploymentId === "." || deploymentId === "..")) {
    throw new Error("Stable Server release metadata contains an invalid deployment id.");
  }
  return {
    tag: value.tag,
    version: value.version,
    ...(deploymentId === undefined ? {} : { deploymentId }),
  };
}

export async function recoverStableServer(options = {}) {
  loadProductionEnv();
  const env = validateRecoveryEnvironment(options.env ?? process.env);
  const { serverRoot } = resolveReleasePaths();
  const sourceRoot = path.resolve(options.sourceRoot ?? serverRoot);
  const releaseRoot = resolveReleaseStorageRoot({ required: true });
  await assertReleaseStorageRootWritable();
  const paths = resolveStableRecoveryPaths(releaseRoot);
  const release = parseStableReleaseMetadata(JSON.parse(await readFile(paths.metadataFile, "utf8")));
  await assertSourceVersion(sourceRoot, release.version);

  await mkdir(paths.releasesRoot, { recursive: true });
  const releaseDir = path.join(paths.releasesRoot, release.deploymentId ?? release.version);
  if (!(await exists(path.join(releaseDir, "dist", "index.js")))) {
    const stagingDir = path.join(paths.releasesRoot, `.staging-${release.version}-${process.pid}`);
    await rm(stagingDir, { recursive: true, force: true });
    try {
      const execute = options.runCommand ?? runCommand;
      await execute("corepack", ["pnpm", "build:all"], { cwd: sourceRoot, env });
      await execute("corepack", ["pnpm", "--filter", "@steamharness/server", "deploy", "--prod", "--legacy", stagingDir], {
        cwd: sourceRoot,
        env,
      });
      await writeFile(path.join(stagingDir, "stable-recovery.json"), `${JSON.stringify({
        channel: "stable",
        tag: release.tag,
        version: release.version,
        recoveredAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      await rename(stagingDir, releaseDir);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  const previousTarget = await readCurrentTarget(paths.currentLink);
  await replaceSymlink(paths.currentLink, releaseDir);
  try {
    const execute = options.runCommand ?? runCommand;
    await execute(process.execPath, [path.join(releaseDir, "scripts", "deploy.mjs"), "start"], {
      cwd: releaseDir,
      env: {
        ...env,
        STEAMHARNESS_REPO_ROOT: releaseDir,
        STEAMHARNESS_SERVER_DATA_DIR: path.join(paths.releaseRoot, "server-data"),
      },
    });
  } catch (error) {
    if (previousTarget) await replaceSymlink(paths.currentLink, previousTarget);
    else await rm(paths.currentLink, { force: true });
    throw error;
  }
  return { ...release, releaseDir, currentLink: paths.currentLink };
}

async function assertSourceVersion(sourceRoot, expectedVersion) {
  await assertDirectory(sourceRoot, { label: "Server recovery source" });
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  if (manifest.version !== expectedVersion) {
    throw new Error(`Server main version ${manifest.version ?? "unknown"} does not match stable release ${expectedVersion}.`);
  }
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
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(filePath) {
  return lstat(filePath).then(() => true, () => false);
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await recoverStableServer();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
