import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  STEAMHARNESS_IGNORE_FILE,
  createWorkflowUploadPortablePathKey,
  createWorkflowUploadMatcher,
  hasWorkflowIgnoreRules,
  normalizeWorkflowUploadPath,
  resolveWorkflowUploadRequiredPaths,
} from "./index";

export interface UploadFileEntry {
  path: string;
  absolutePath: string;
  size: number;
}

export interface UploadPlan {
  workflowIgnorePresent: boolean;
  workflowIgnoreConfigured: boolean;
  files: UploadFileEntry[];
  ignoredPaths: string[];
  totalBytes: number;
  requiredPaths: string[];
}

export async function createWorkflowUploadPlan(rootDir: string): Promise<UploadPlan> {
  const projectRoot = path.resolve(rootDir);
  const workflowIgnorePath = path.join(projectRoot, STEAMHARNESS_IGNORE_FILE);
  const workflowIgnoreStat = await lstat(workflowIgnorePath).catch(() => undefined);
  if (workflowIgnoreStat?.isSymbolicLink()) {
    throw new Error(`${STEAMHARNESS_IGNORE_FILE} must be a regular file.`);
  }
  const workflowIgnorePresent = workflowIgnoreStat?.isFile() === true;
  if (workflowIgnoreStat !== undefined && !workflowIgnorePresent) {
    throw new Error(`${STEAMHARNESS_IGNORE_FILE} must be a regular file.`);
  }
  const workflowIgnoreContent = workflowIgnorePresent
    ? await readWorkflowUploadUtf8File(workflowIgnorePath, STEAMHARNESS_IGNORE_FILE)
    : undefined;
  const matcher = createWorkflowUploadMatcher(
    workflowIgnoreContent,
  );
  const files: UploadFileEntry[] = [];
  const availableRegularPaths = new Set<string>();
  const portablePaths = new Map<string, string>();
  const ignoredPaths: string[] = [];

  const walk = async (currentDir: string): Promise<void> => {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = normalizeWorkflowUploadPath(path.relative(projectRoot, absolutePath));
      const portablePath = createWorkflowUploadPortablePathKey(relativePath);
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
  const packageJson = parsePackageJson(await readWorkflowUploadUtf8File(
    path.join(projectRoot, "package.json"),
    "package.json",
  ));
  const requiredPaths = resolveWorkflowUploadRequiredPaths(
    packageJson,
    availableRegularPaths,
  );
  matcher.assertRequiredPaths(requiredPaths);
  for (const requiredPath of requiredPaths) {
    if (!availableRegularPaths.has(requiredPath)) {
      throw new Error(`Workflow package must contain required upload path ${JSON.stringify(requiredPath)}.`);
    }
  }

  return {
    workflowIgnorePresent,
    workflowIgnoreConfigured: hasWorkflowIgnoreRules(workflowIgnoreContent),
    files,
    ignoredPaths,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    requiredPaths,
  };
}

export async function copyWorkflowUploadFiles(
  sourceDir: string,
  targetDir: string,
): Promise<UploadPlan> {
  const plan = await createWorkflowUploadPlan(sourceDir);
  await mkdir(targetDir, { recursive: true });
  for (const file of plan.files) {
    const targetPath = path.join(targetDir, ...file.path.split("/"));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(file.absolutePath, targetPath);
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

async function readWorkflowUploadUtf8File(filePath: string, label: string): Promise<string> {
  const content = await readFile(filePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Workflow ${label} must be a UTF-8 text file.`);
  }
}
