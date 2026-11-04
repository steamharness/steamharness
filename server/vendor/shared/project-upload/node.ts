import { DATABASE_DEFINITION_FILE, readDatabaseArtifactFiles } from "./database-artifacts";
import { projectEntryFilePath, projectManifestForDistribution } from "@steamharness/project-manifest";
import { readProjectManifestFromDirectory, readProjectDeclarationFromDirectory } from "@steamharness/project-manifest/node";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STEAMHARNESS_IGNORE_FILE,
  createProjectUploadPortablePathKey,
  createProjectUploadMatcher,
  hasProjectIgnoreRules,
  isProjectUploadExcludedPath,
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
  const databaseRequiredPaths = new Set<string>();

  const declaration = await readProjectDeclarationFromDirectory(projectRoot);
  const sourceRoots = new Set([".", ...declaration.entries.map(entry => entry.root)]);
  for (const sourceRoot of sourceRoots) {
    const definition = await lstat(path.join(projectRoot, sourceRoot, DATABASE_DEFINITION_FILE)).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!definition) continue;
    const artifacts = await readDatabaseArtifactFiles(projectRoot, sourceRoot);
    if (!artifacts) throw new Error(`Missing database artifacts for ${sourceRoot}. Run steamharness database generate ${projectRoot}.`);
    for (const source of Object.keys(artifacts.manifest.sources)) databaseRequiredPaths.add(path.posix.join(sourceRoot, source));
    for (const filename of artifacts.files) {
      const absolutePath = path.join(projectRoot, filename);
      availableRegularPaths.add(filename);
      files.push({ path: filename, absolutePath, size: (await lstat(absolutePath)).size });
      databaseRequiredPaths.add(filename);
    }
  }
  const artifactDirectories = declaration.entries.map(entry => projectEntryFilePath(entry))
    .filter(filename => filename.startsWith("dist/")).map(filename => path.posix.dirname(filename));
  const inArtifacts = (relative: string, directory: boolean): boolean => artifactDirectories.some(artifact =>
    relative === artifact || relative.startsWith(artifact + "/") || directory && artifact.startsWith(relative + "/"));

  const walk = async (currentDir: string): Promise<void> => {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = normalizeProjectUploadPath(path.relative(projectRoot, absolutePath));
      if (isProjectUploadExcludedPath(relativePath)) continue;
      if (relativePath === "dist/steamharness" || relativePath.startsWith("dist/") && !inArtifacts(relativePath, entry.isDirectory())
        || ["dist/cache", "dist/reports", "dist/release", "dist/tmp"].some(prefix => relativePath === prefix || relativePath.startsWith(prefix + "/"))) {
        ignoredPaths.push(relativePath + (entry.isDirectory() ? "/" : "")); continue;
      }
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
  const packageJson = parseProjectDocument(await readProjectUploadUtf8File(
    path.join(projectRoot, "steamharness.json"),
    "steamharness.json",
  ));
  const requiredPaths = resolveProjectUploadRequiredPaths(
    packageJson,
    availableRegularPaths,
    declaration,
  );
  requiredPaths.push(...databaseRequiredPaths);
  for (const file of files) {
    if (file.path.endsWith("steamharness.schema") || file.path.endsWith(DATABASE_DEFINITION_FILE)) requiredPaths.push(file.path);
  }
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
    if (file.path === "steamharness.json") await writeFile(targetPath, JSON.stringify(projectManifestForDistribution(JSON.parse(await readFile(file.absolutePath, "utf8"))), null, 2) + "\n");
    else await copyFile(file.absolutePath, targetPath);
  }
  return plan;
}

function parseProjectDocument(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error("Workflow steamharness.json is invalid JSON.");
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
