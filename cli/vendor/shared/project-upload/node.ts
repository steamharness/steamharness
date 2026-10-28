import { projectManifestForDistribution } from "@steamharness/project-manifest";
import { readProjectManifestFromDirectory } from "@steamharness/project-manifest/node";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STEAMHARNESS_IGNORE_FILE,
  createProjectUploadPortablePathKey,
  createProjectUploadMatcher,
  hasProjectIgnoreRules,
  normalizeProjectUploadPath,
  resolveProjectUploadRequiredPaths,
} from "./index";

export interface UploadFileEntry {
  path: string;
  absolutePath: string;
  size: number;
}

export interface UploadPlan {
  projectIgnorePresent: boolean;
  projectIgnoreConfigured: boolean;
  files: UploadFileEntry[];
  ignoredPaths: string[];
  totalBytes: number;
  requiredPaths: string[];
}

export async function createProjectUploadPlan(rootDir: string): Promise<UploadPlan> {
  const projectRoot = path.resolve(rootDir);
  const projectIgnorePath = path.join(projectRoot, STEAMHARNESS_IGNORE_FILE);
  const projectIgnoreStat = await lstat(projectIgnorePath).catch(() => undefined);
  if (projectIgnoreStat?.isSymbolicLink()) {
    throw new Error(`${STEAMHARNESS_IGNORE_FILE} must be a regular file.`);
  }
  const projectIgnorePresent = projectIgnoreStat?.isFile() === true;
  if (projectIgnoreStat !== undefined && !projectIgnorePresent) {
    throw new Error(`${STEAMHARNESS_IGNORE_FILE} must be a regular file.`);
  }
  const projectIgnoreContent = projectIgnorePresent
    ? await readProjectUploadUtf8File(projectIgnorePath, STEAMHARNESS_IGNORE_FILE)
    : undefined;
  const matcher = createProjectUploadMatcher(
    projectIgnoreContent,
  );
  const files: UploadFileEntry[] = [];
  const availableRegularPaths = new Set<string>();
  const portablePaths = new Map<string, string>();
  const ignoredPaths: string[] = [];

  const walk = async (currentDir: string): Promise<void> => {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if ([".git", "node_modules", ".data", ".workflow", ".release", ".steamharness", ".env", ".envrc", ".workflow-kv", ".workflow-persistent-values", ".workflow-schedules", "workflow-auth.json"].includes(entry.name) || entry.name.startsWith(".env.") || /^steamharness\.sqlite(?:-(?:wal|shm))?$/.test(entry.name)) continue;
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = normalizeProjectUploadPath(path.relative(projectRoot, absolutePath));
      const portablePath = createProjectUploadPortablePathKey(relativePath);
      const conflictingPath = portablePaths.get(portablePath);
      if (conflictingPath !== undefined && conflictingPath !== relativePath) {
        throw new Error(
          `Workflow upload paths ${JSON.stringify(conflictingPath)} and ${JSON.stringify(relativePath)} conflict on a case-insensitive filesystem.`,
        );
      }
      portablePaths.set(portablePath, relativePath);
      if (entry.isDirectory()) {
        if (matcher.ignores(relativePath, { directory: true })) {
          ignoredPaths.push(`${relativePath}/`);
          continue;
        }
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Workflow upload path ${JSON.stringify(relativePath)} must be a regular file or directory.`);
      }
      availableRegularPaths.add(relativePath);
      if (matcher.ignores(relativePath)) {
        ignoredPaths.push(relativePath);
        continue;
      }
      const fileStat = await lstat(absolutePath);
      files.push({ path: relativePath, absolutePath, size: fileStat.size });
    }
  };

  await walk(projectRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  ignoredPaths.sort((left, right) => left.localeCompare(right));
  if (!availableRegularPaths.has("package.json")) {
    throw new Error("Workflow package must contain package.json.");
  }
  const packageJson = parsePackageJson(await readProjectUploadUtf8File(
    path.join(projectRoot, "package.json"),
    "package.json",
  ));
  const requiredPaths = resolveProjectUploadRequiredPaths(
    packageJson,
    availableRegularPaths,
  );
  // Validate authored configuration; never export the machine's environment overrides.
  await readProjectManifestFromDirectory(projectRoot, {});
  matcher.assertRequiredPaths(requiredPaths);
  for (const requiredPath of requiredPaths) {
    if (!availableRegularPaths.has(requiredPath)) {
      throw new Error(`Workflow package must contain required upload path ${JSON.stringify(requiredPath)}.`);
    }
  }

  return {
    projectIgnorePresent,
    projectIgnoreConfigured: hasProjectIgnoreRules(projectIgnoreContent),
    files,
    ignoredPaths,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    requiredPaths,
  };
}

export async function copyProjectUploadFiles(
  sourceDir: string,
  targetDir: string,
): Promise<UploadPlan> {
  const plan = await createProjectUploadPlan(sourceDir);
  await mkdir(targetDir, { recursive: true });
  for (const file of plan.files) {
    const targetPath = path.join(targetDir, ...file.path.split("/"));
    await mkdir(path.dirname(targetPath), { recursive: true });
    if (file.path === "package.json") await writeFile(targetPath, JSON.stringify(projectManifestForDistribution(JSON.parse(await readFile(file.absolutePath, "utf8"))), null, 2) + "\n");
    else await copyFile(file.absolutePath, targetPath);
  }
  return plan;
}

function parsePackageJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error("Workflow package.json is invalid JSON.");
  }
}

async function readProjectUploadUtf8File(filePath: string, label: string): Promise<string> {
  const content = await readFile(filePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Workflow ${label} must be a UTF-8 text file.`);
  }
}
