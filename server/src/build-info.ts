import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ServerBuildInfo {
  productVersion: string;
  coreVersion: string;
  commitSha: string;
  nodeVersion: string;
}

export async function readServerBuildInfo(options: {
  repoRoot: string;
  serverRoot: string;
  strict?: boolean;
}): Promise<ServerBuildInfo> {
  const directServerManifest = await readJson(path.join(options.serverRoot, "package.json"));
  const serverPackageRoot = hasPackageVersion(directServerManifest)
    ? options.serverRoot
    : options.repoRoot;
  const buildInfoPath = path.join(serverPackageRoot, "dist", "build-info.json");
  const [serverManifest, coreManifest] = await Promise.all([
    serverPackageRoot === options.serverRoot
      ? Promise.resolve(directServerManifest)
      : readJson(path.join(serverPackageRoot, "package.json")),
    readJson(path.join(options.repoRoot, "node_modules", "workflow-code", "package.json")),
  ]);
  const expectedProductVersion = readVersion(serverManifest, "server/package.json");
  const expectedCoreVersion = readVersion(coreManifest, "node_modules/workflow-code/package.json");

  if (!options.strict) {
    return {
      productVersion: expectedProductVersion,
      coreVersion: expectedCoreVersion,
      commitSha: "unknown",
      nodeVersion: process.versions.node,
    };
  }

  const buildInfo = await readJsonIfExists(buildInfoPath);
  if (buildInfo === undefined) {
    throw new Error(`Server build info does not exist: ${buildInfoPath}`);
  }

  const parsed = parseServerBuildInfo(buildInfo);
  if (parsed.productVersion !== expectedProductVersion || parsed.coreVersion !== expectedCoreVersion) {
    throw new Error(
      `Server build info versions ${parsed.productVersion}/${parsed.coreVersion} do not match manifests `
      + `${expectedProductVersion}/${expectedCoreVersion}.`,
    );
  }
  return parsed;
}

export function parseServerBuildInfo(value: unknown): ServerBuildInfo {
  if (!isRecord(value)) throw new Error("Server build info root must be an object.");
  return {
    productVersion: readString(value, "productVersion"),
    coreVersion: readString(value, "coreVersion"),
    commitSha: readString(value, "commitSha"),
    nodeVersion: readString(value, "nodeVersion"),
  };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readVersion(value: unknown, label: string): string {
  if (!isRecord(value)) throw new Error(`${label} root must be an object.`);
  return readString(value, "version");
}

function hasPackageVersion(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.version === "string" && value.version.trim() !== "";
}

function readString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.trim() === "") throw new Error(`Build info field ${key} must be a string.`);
  return item.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
