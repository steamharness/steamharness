import { cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRepositoryMode } from "./repository-mode.mjs";

export async function prepareSharedPackages({
  root = path.resolve(import.meta.dirname, ".."),
  env = process.env,
  branch,
} = {}) {
  const destination = path.join(root, ".shared");
  const vendor = path.join(root, "vendor", "shared");
  const mode = resolveRepositoryMode({ root, env, branch });
  const source = vendor;
  if (!await valid(source)) {
    throw new Error("Shared source is missing in vendor/shared. Sync Shared before installing or building.");
  }

  await ensureDirectory(destination);
  const packages = await listSharedPackages(source);
  await removeStalePackages(destination, new Set(packages));
  await Promise.all(packages.map(async (packageDirectory) => {
    const packageRoot = path.join(source, packageDirectory);
    const packageDestination = path.join(destination, packageDirectory);
    await resetPackageSources(packageDestination);
    await cp(packageRoot, packageDestination, {
      recursive: true,
      filter: (sourcePath) => {
        const relativePath = path.relative(packageRoot, sourcePath);
        return !relativePath.split(path.sep).some((segment) => segment === "__tests__" || segment === "node_modules");
      },
    });
  }));
  return { mode, packages, source, strategy: "copied" };
}

async function ensureDirectory(directory) {
  try {
    if (!(await lstat(directory)).isDirectory()) {
      await rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  await mkdir(directory, { recursive: true });
}

async function removeStalePackages(destination, packages) {
  const entries = await readdir(destination);
  await Promise.all(entries
    .filter((entry) => !packages.has(entry))
    .map((entry) => rm(path.join(destination, entry), { recursive: true, force: true })));
}

async function resetPackageSources(destination) {
  try {
    if (!(await lstat(destination)).isDirectory()) {
      await rm(destination, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  await mkdir(destination, { recursive: true });
  const entries = await readdir(destination);
  await Promise.all(entries
    .filter((entry) => entry !== "node_modules")
    .map((entry) => rm(path.join(destination, entry), { recursive: true, force: true })));
}

function isMissingPathError(error) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function valid(directory) {
  try {
    return JSON.parse(await readFile(path.join(directory, "i18n", "package.json"), "utf8")).name
      === "@workflow-code/i18n";
  } catch {
    return false;
  }
}

async function listSharedPackages(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, entry.name, "package.json"), "utf8"));
      if (typeof manifest.name === "string" && manifest.name.startsWith("@workflow-code/")) {
        packages.push(entry.name);
      }
    } catch {
      // Build output and other non-package directories stay outside .shared.
    }
  }
  return packages.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { mode, packages, source, strategy } = await prepareSharedPackages();
  process.stdout.write(`[repository:${mode}] ${strategy} ${packages.length} shared packages from ${source}\n`);
}
