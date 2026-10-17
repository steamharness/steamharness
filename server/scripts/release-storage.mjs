import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";

const defaultRepoRoot = path.resolve(import.meta.dirname, "..");

export function resolveReleasePaths() {
  const repoRoot = process.env.STEAMHARNESS_REPO_ROOT?.trim()
    ? path.resolve(process.env.STEAMHARNESS_REPO_ROOT.trim())
    : defaultRepoRoot;
  return { repoRoot, serverRoot: repoRoot };
}

export function loadProductionEnv() {
  const { repoRoot, serverRoot } = resolveReleasePaths();
  for (const filePath of [path.join(serverRoot, ".env.production"), path.join(serverRoot, ".env")]) {
    config({ path: filePath, override: false, quiet: true });
  }
  return { repoRoot, serverRoot };
}

export function resolveReleaseStorageRoot(options = {}) {
  const raw = process.env.STEAMHARNESS_RELEASE_STORAGE_ROOT?.trim();
  if (!raw) {
    if (options.required === true) {
      throw new Error("STEAMHARNESS_RELEASE_STORAGE_ROOT is required for release services.");
    }
    return undefined;
  }
  return path.resolve(raw);
}

export function resolveServerDataRoot(options = {}) {
  const { serverRoot } = resolveReleasePaths();
  const explicit = firstNonEmpty(process.env.STEAMHARNESS_SERVER_DATA_DIR, process.env.STEAMHARNESS_SERVER_DEPLOY_DIR);
  if (explicit) return path.resolve(explicit);
  const releaseRoot = options.requiredForRelease === true
    ? resolveReleaseStorageRoot({ required: true })
    : resolveReleaseStorageRoot();
  return releaseRoot ? path.join(releaseRoot, "server-data") : path.join(options.serverRoot ?? serverRoot, ".data");
}

export function resolveDocsRoot() {
  const explicit = firstNonEmpty(process.env.STEAMHARNESS_DOCS_ROOT);
  return explicit
    ? path.resolve(explicit)
    : path.join(resolveReleaseStorageRoot({ required: true }), "published", "docs", "stable");
}

export async function assertReleaseStorageRootWritable() {
  const releaseRoot = resolveReleaseStorageRoot({ required: true });
  return assertDirectory(releaseRoot, { label: "STEAMHARNESS_RELEASE_STORAGE_ROOT", writable: true });
}

export async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

export async function assertDirectory(directoryPath, options = {}) {
  const info = await stat(directoryPath).catch((error) => {
    throw new Error(`${options.label ?? directoryPath} does not exist: ${directoryPath}`, { cause: error });
  });
  if (!info.isDirectory()) throw new Error(`${options.label ?? directoryPath} is not a directory: ${directoryPath}`);
  if (options.writable === true) await access(directoryPath, constants.W_OK);
  return directoryPath;
}

export function readPositiveIntegerEnv(name, fallback) {
  const parsed = Number(process.env[name]?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readHostEnv(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

function firstNonEmpty(...values) {
  return values.find((value) => value?.trim())?.trim();
}
