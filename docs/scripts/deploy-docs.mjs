import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export async function deployDocs(options = {}) {
  const sourceDir = path.resolve(options.sourceDir ?? path.resolve(import.meta.dirname, "..", "dist", "site"));
  const deployRoot = resolveDeployRoot(options.deployRoot ?? process.env.STEAMHARNESS_DOCS_DEPLOY_ROOT);
  const commitSha = String(options.commitSha ?? process.env.CI_COMMIT_SHA ?? "").trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commitSha)) throw new Error("Docs deployment requires an exact 40-character commit SHA.");
  await assertBuildSource(sourceDir, commitSha);

  const releasesRoot = path.join(deployRoot, "releases");
  const releaseRoot = path.join(releasesRoot, commitSha);
  const stagedRoot = path.join(deployRoot, `.staged-${commitSha}-${process.pid}`);
  const currentLink = path.join(deployRoot, "current");
  const previousTarget = await readCurrentTarget(currentLink);
  await mkdir(releasesRoot, { recursive: true });
  await rm(stagedRoot, { recursive: true, force: true });
  await cp(sourceDir, stagedRoot, { recursive: true });

  try {
    if (await exists(releaseRoot)) {
      if (await directoryDigest(releaseRoot) !== await directoryDigest(stagedRoot)) {
        throw new Error(`Commit ${commitSha} already has different deployed contents.`);
      }
      await rm(stagedRoot, { recursive: true, force: true });
    } else {
      await rename(stagedRoot, releaseRoot);
    }
    await replaceCurrentLink(currentLink, path.join("releases", commitSha));
    try {
      await runDeployHook(options, { deployRoot, releaseRoot, currentLink, commitSha });
    } catch (activationError) {
      await restoreCurrentLink(currentLink, previousTarget);
      try {
        if (previousTarget !== undefined) {
          const previousReleaseRoot = path.resolve(deployRoot, previousTarget);
          await runDeployHook(options, {
            deployRoot,
            releaseRoot: previousReleaseRoot,
            currentLink,
            commitSha: await readReleaseCommit(previousReleaseRoot),
          });
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [activationError, rollbackError],
          "Docs activation failed and the previous release could not be reactivated.",
        );
      }
      throw activationError;
    }
    await writeJsonAtomic(path.join(deployRoot, "deployment.json"), {
      schemaVersion: 1,
      framework: "docusaurus",
      commitSha,
      releaseRoot,
      currentLink,
      deployedAt: options.deployedAt ?? new Date().toISOString(),
    });
  } catch (error) {
    await restoreCurrentLink(currentLink, previousTarget);
    await rm(stagedRoot, { recursive: true, force: true });
    throw error;
  }
  return { commitSha, releaseRoot, currentLink };
}

function resolveDeployRoot(value) {
  const raw = String(value ?? "").trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error("STEAMHARNESS_DOCS_DEPLOY_ROOT must be an absolute path.");
  const resolved = path.resolve(raw);
  const filesystemRoot = path.parse(resolved).root;
  if (resolved === filesystemRoot || resolved === os.homedir()) {
    throw new Error(`Refusing unsafe Docs deployment root: ${resolved}`);
  }
  return resolved;
}

async function assertBuildSource(sourceDir, commitSha) {
  const deployment = JSON.parse(await readFile(path.join(sourceDir, "deployment.json"), "utf8"));
  if (deployment.schemaVersion !== 1) throw new Error("Docs build source has an unsupported deployment schema.");
  if (deployment.framework !== "docusaurus") throw new Error("Docs build source is not a Docusaurus site.");
  if (deployment.commitSha !== null && deployment.commitSha !== commitSha) {
    throw new Error(`Docs build commit ${deployment.commitSha} does not match deployment commit ${commitSha}.`);
  }
  await readFile(path.join(sourceDir, "index.html"), "utf8");
  await readFile(path.join(sourceDir, "en", "index.html"), "utf8");
  await readFile(path.join(sourceDir, ".steamharness", "activate-docs.mjs"), "utf8");
  await readFile(path.join(sourceDir, ".steamharness", "serve-docs.mjs"), "utf8");
}

async function readReleaseCommit(releaseRoot) {
  const deployment = JSON.parse(await readFile(path.join(releaseRoot, "deployment.json"), "utf8"));
  if (!COMMIT_PATTERN.test(deployment.commitSha)) {
    throw new Error(`Previous Docs release has an invalid commit identity: ${releaseRoot}`);
  }
  return deployment.commitSha;
}

async function runDeployHook(options, context) {
  const executable = String(options.hook ?? process.env.STEAMHARNESS_DOCS_DEPLOY_HOOK ?? "").trim();
  if (!executable) return;
  if (!path.isAbsolute(executable)) throw new Error("STEAMHARNESS_DOCS_DEPLOY_HOOK must be an absolute executable path.");
  const rawArgs = options.hookArgs ?? process.env.STEAMHARNESS_DOCS_DEPLOY_HOOK_ARGS ?? "[]";
  const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new Error("STEAMHARNESS_DOCS_DEPLOY_HOOK_ARGS must be a JSON string array.");
  }
  await (options.execFile ?? execFileAsync)(executable, args, {
    env: {
      ...process.env,
      STEAMHARNESS_DOCS_CURRENT_ROOT: context.currentLink,
      STEAMHARNESS_DOCS_RELEASE_ROOT: context.releaseRoot,
      STEAMHARNESS_DOCS_DEPLOY_COMMIT: context.commitSha,
      STEAMHARNESS_DOCS_FRAMEWORK: "docusaurus",
    },
  });
}

async function readCurrentTarget(currentLink) {
  try {
    const info = await lstat(currentLink);
    if (!info.isSymbolicLink()) throw new Error(`Docs current path must be a symbolic link: ${currentLink}`);
    return await readlink(currentLink);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function replaceCurrentLink(currentLink, target) {
  const temporary = `${currentLink}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  await symlink(target, temporary, process.platform === "win32" ? "junction" : "dir");
  if (process.platform === "win32") await rm(currentLink, { force: true });
  await rename(temporary, currentLink);
}

async function restoreCurrentLink(currentLink, previousTarget) {
  if (previousTarget === undefined) {
    await rm(currentLink, { force: true });
    return;
  }
  await replaceCurrentLink(currentLink, previousTarget);
}

async function directoryDigest(root) {
  const hash = createHash("sha256");
  const files = await collectFiles(root, root);
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    for await (const chunk of createReadStream(path.join(root, relative))) hash.update(chunk);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function collectFiles(root, current) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files;
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await deployDocs();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
