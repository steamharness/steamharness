import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWorkflowUuid(value) {
  return UUID_PATTERN.test(String(value ?? "").trim());
}

export function collectLegacyWorkflowIds(workflows) {
  return [...new Set(
    workflows
      .map((workflow) => String(workflow.id ?? "").trim())
      .filter((workflowId) => workflowId !== "" && !isWorkflowUuid(workflowId)),
  )].sort((left, right) => left.localeCompare(right));
}

export function collectArtifactObjectPaths(versionRows) {
  const paths = new Set();
  for (const row of versionRows) {
    const sourceObjectPath = typeof row.sourceObjectPath === "string" ? row.sourceObjectPath.trim() : "";
    const runtimeObjectPath = typeof row.runtimeObjectPath === "string" ? row.runtimeObjectPath.trim() : "";
    if (sourceObjectPath !== "") {
      paths.add(sourceObjectPath);
    }
    if (runtimeObjectPath !== "") {
      paths.add(runtimeObjectPath);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export async function listWorkspaceWorkflowProjects(workspaceRoot) {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workflowDir = path.join(workspaceRoot, entry.name);
    const packageJsonPath = path.join(workflowDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
      throw new Error(`Workflow "${entry.name}" package.json must contain a JSON object.`);
    }

    const workflowId = typeof packageJson.id === "string" ? packageJson.id.trim() : "";
    if (!isWorkflowUuid(workflowId)) {
      throw new Error(`Workflow "${entry.name}" package.json must include a UUID id.`);
    }

    const workflowName = typeof packageJson.name === "string" ? packageJson.name.trim() : "";
    if (workflowName === "") {
      throw new Error(`Workflow "${entry.name}" package.json must include string "name".`);
    }

    projects.push({
      dirName: entry.name,
      workflowDir,
      workflowId,
      workflowName,
    });
  }

  return projects.sort((left, right) => left.dirName.localeCompare(right.dirName));
}

export async function listLegacyLocalWorkflowIds(dataRoot) {
  const workflowsRoot = path.join(dataRoot, "workflows");
  let entries = [];
  try {
    entries = await readdir(workflowsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && !isWorkflowUuid(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function findManagedFileDirectoriesForWorkflowIds(filesRoot, workflowIds) {
  if (workflowIds.length === 0) {
    return [];
  }

  let entries = [];
  try {
    entries = await readdir(filesRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const workflowIdSet = new Set(workflowIds);
  const matches = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fileDir = path.join(filesRoot, entry.name);
    const metadataPath = path.join(fileDir, "metadata.json");
    if (!existsSync(metadataPath)) {
      continue;
    }

    let metadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch {
      continue;
    }

    if (metadata && typeof metadata === "object" && workflowIdSet.has(metadata.workflowId)) {
      matches.push(fileDir);
    }
  }

  return matches.sort((left, right) => left.localeCompare(right));
}

export async function syncWorkspaceProjects(options) {
  const workspaceProjects = await listWorkspaceWorkflowProjects(options.workspaceRoot);
  const workspaceWorkflowIds = workspaceProjects.map((project) => project.workflowId);

  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
  });

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-workspace-sync-"));

  try {
    const existingRows = (await pool.query(
      "select id, name from workflows order by name asc, id asc",
    )).rows;
    const existingWorkflowIdSet = new Set(
      existingRows
        .map((row) => String(row.id ?? "").trim())
        .filter((workflowId) => workflowId !== ""),
    );
    const legacyDbIds = collectLegacyWorkflowIds(existingRows);
    const legacyLocalIds = await listLegacyLocalWorkflowIds(options.dataRoot);
    const legacyWorkflowIds = [...new Set([...legacyDbIds, ...legacyLocalIds])]
      .sort((left, right) => left.localeCompare(right));

    let deletedArtifactPaths = [];
    if (legacyWorkflowIds.length > 0) {
      const versionRows = (await pool.query(
        `select workflow_id as "workflowId",
                source_object_path as "sourceObjectPath",
                runtime_object_path as "runtimeObjectPath"
           from workflow_versions
          where workflow_id = any($1::text[])`,
        [legacyWorkflowIds],
      )).rows;
      deletedArtifactPaths = collectArtifactObjectPaths(versionRows);

      const client = await pool.connect();
      try {
        await client.query("begin");
        // 旧版 non-UUID 项目不再兼容保留，连同 KV/知识库引用一起清掉，
        // 避免 workspace UUID 项目上传后界面和统计继续混入历史脏数据。
        await client.query(
          `delete from workflow_kv_entries
            where workflow_name_key = any($1::text[])
               or last_workflow_name = any($1::text[])`,
          [legacyWorkflowIds],
        );
        await client.query(
          "delete from workflows where id = any($1::text[])",
          [legacyWorkflowIds],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      await cleanupLegacyFilesystem({
        dataRoot: options.dataRoot,
        legacyWorkflowIds,
      });
      await cleanupLegacyManagedFiles({
        dataRoot: options.dataRoot,
        legacyWorkflowIds,
      });
    }

    const uploadedWorkflowIds = [];
    for (const project of workspaceProjects) {
      if (!existingWorkflowIdSet.has(project.workflowId)) {
        await ensureRemoteProjectExists({
          serverUrl: options.serverUrl,
          adminToken: options.adminToken,
          project,
        });
        existingWorkflowIdSet.add(project.workflowId);
      }

      const archivePath = await packWorkflowProject(project, tempRoot, options.workspaceRoot);
      await uploadWorkflowArchive({
        serverUrl: options.serverUrl,
        adminToken: options.adminToken,
        workflowId: project.workflowId,
        archivePath,
      });
      await publishWorkflowProject({
        serverUrl: options.serverUrl,
        adminToken: options.adminToken,
        workflowId: project.workflowId,
        releaseLog: `Sync workspace workflow ${project.dirName}`,
      });
      uploadedWorkflowIds.push(project.workflowId);
    }

    const workflowsResponse = await fetchApiJson(
      `${trimTrailingSlash(options.serverUrl)}/api/workflows`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.adminToken}`,
        },
      },
    );
    assertApiOk(workflowsResponse, "Failed to list workflows after migration.");

    const remoteWorkflows = Array.isArray(workflowsResponse.data) ? workflowsResponse.data : [];
    const remoteWorkflowIds = remoteWorkflows
      .map((workflow) => String(workflow?.id ?? "").trim())
      .filter((workflowId) => workflowId !== "")
      .sort((left, right) => left.localeCompare(right));
    const remainingLegacyIds = remoteWorkflowIds.filter((workflowId) => !isWorkflowUuid(workflowId));
    const missingWorkflowIds = workspaceWorkflowIds.filter(
      (workflowId) => !remoteWorkflowIds.includes(workflowId),
    );

    return {
      workspaceProjectCount: workspaceProjects.length,
      workspaceWorkflowIds,
      deletedLegacyWorkflowIds: legacyWorkflowIds,
      deletedArtifactPaths,
      uploadedWorkflowIds,
      remainingLegacyIds,
      missingWorkflowIds,
      remoteWorkflowIds,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await pool.end();
  }
}

function parseArgs(argv) {
  const options = {
    serverUrl: process.env.STEAMHARNESS_SERVER_URL ?? "",
    adminToken: process.env.STEAMHARNESS_SERVER_ADMIN_KEY ?? "",
    databaseUrl: process.env.STEAMHARNESS_DATABASE_URL ?? "",
    dataRoot: process.env.STEAMHARNESS_SERVER_DATA_DIR ?? "",
    workspaceRoot: resolveDefaultWorkspaceRoot(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--server-url":
        options.serverUrl = requireValue(argv, ++index, "--server-url");
        break;
      case "--admin-token":
        options.adminToken = requireValue(argv, ++index, "--admin-token");
        break;
      case "--database-url":
        options.databaseUrl = requireValue(argv, ++index, "--database-url");
        break;
      case "--data-root":
        options.dataRoot = requireValue(argv, ++index, "--data-root");
        break;
      case "--workspace-root":
        options.workspaceRoot = path.resolve(requireValue(argv, ++index, "--workspace-root"));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.serverUrl.trim() === "") {
    throw new Error("Missing --server-url or STEAMHARNESS_SERVER_URL.");
  }
  if (options.adminToken.trim() === "") {
    throw new Error("Missing --admin-token or STEAMHARNESS_SERVER_ADMIN_KEY.");
  }
  if (options.databaseUrl.trim() === "") {
    throw new Error("Missing --database-url or STEAMHARNESS_DATABASE_URL.");
  }
  if (options.dataRoot.trim() === "") {
    throw new Error("Missing --data-root or STEAMHARNESS_SERVER_DATA_DIR.");
  }

  return options;
}

async function main() {
  const summary = await syncWorkspaceProjects(parseArgs(process.argv.slice(2)));
  if (summary.remainingLegacyIds.length > 0) {
    throw new Error(
      `Legacy non-UUID workflows still visible after migration: ${summary.remainingLegacyIds.join(", ")}`,
    );
  }
  if (summary.missingWorkflowIds.length > 0) {
    throw new Error(
      `Workspace workflows missing after migration: ${summary.missingWorkflowIds.join(", ")}`,
    );
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

export function resolveDefaultWorkspaceRoot(env = process.env) {
  const explicit = env.STEAMHARNESS_WORKSPACE_ROOT?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve(resolveServerRoot(), "..", "harness", "workspace", "workflow");
}

function resolveServerRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function requireValue(argv, index, label) {
  const value = argv[index];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing value for ${label}.`);
  }
  return value;
}

async function packWorkflowProject(project, tempRoot, workspaceRoot) {
  const archivePath = path.join(tempRoot, "packs", `${project.dirName}.tgz`);
  await rm(archivePath, { force: true });
  await mkdir(path.dirname(archivePath), { recursive: true });
  const stagingDir = path.join(tempRoot, "stage", project.dirName);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(path.join(stagingDir, "workspace", "workflow"), { recursive: true });

  await stageWorkflowWithLocalDependencies({
    workspaceRoot,
    workflowDir: project.workflowDir,
    workflowName: project.dirName,
    stagingRoot: path.join(stagingDir, "workspace", "workflow"),
  });

  await runCommand("tar", ["-czf", archivePath, "-C", stagingDir, "."], {
    cwd: resolveServerRoot(),
  });
  return archivePath;
}

async function stageWorkflowWithLocalDependencies(options) {
  const queue = [options.workflowName];
  const visited = new Set();

  while (queue.length > 0) {
    const currentWorkflowName = queue.shift();
    if (!currentWorkflowName || visited.has(currentWorkflowName)) {
      continue;
    }
    visited.add(currentWorkflowName);

    const sourceDir = currentWorkflowName === options.workflowName
      ? options.workflowDir
      : path.join(options.workspaceRoot, currentWorkflowName);
    if (!existsSync(path.join(sourceDir, "package.json"))) {
      throw new Error(
        `Workflow "${options.workflowName}" references local workflow "${currentWorkflowName}", but ${sourceDir} is missing package.json.`,
      );
    }

    await copyWorkflowSource(sourceDir, path.join(options.stagingRoot, currentWorkflowName));
    for (const dependency of await findLocalWorkflowDependencies(sourceDir)) {
      if (!visited.has(dependency)) {
        queue.push(dependency);
      }
    }
  }
}

async function copyWorkflowSource(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  await cpDirectory(sourceDir, targetDir);
}

async function cpDirectory(sourceDir, targetDir) {
  const { cp } = await import("node:fs/promises");
  await cp(sourceDir, targetDir, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceDir, source);
      return relative === "" || !shouldExcludePackagePath(relative);
    },
  });
}

function shouldExcludePackagePath(relativePath) {
  const parts = relativePath.split(path.sep);
  const name = parts.at(-1) ?? "";

  if (
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes(".git") ||
    parts.includes(".cache")
  ) {
    return true;
  }

  if (name === ".env" || name.startsWith(".env.")) {
    return name !== ".env.example";
  }

  return name.endsWith(".tmp");
}

async function findLocalWorkflowDependencies(sourceDir) {
  const discovered = new Set();

  for (const fileName of ["index.ts", "interface.ts", "globals.d.ts"]) {
    const filePath = path.join(sourceDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    const source = await readFile(filePath, "utf8");
    for (const match of source.matchAll(/(?:from\s+|reference path=)\"(\.\.\/([^/\"']+)(?:\/[^\"']*)?)\"/g)) {
      const workflowName = match[2]?.trim();
      if (workflowName) {
        discovered.add(workflowName);
      }
    }
    for (const match of source.matchAll(/(?:from\s+|reference path=)'(\.\.\/([^/'"]+)(?:\/[^'"]*)?)'/g)) {
      const workflowName = match[2]?.trim();
      if (workflowName) {
        discovered.add(workflowName);
      }
    }
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
}

async function ensureRemoteProjectExists({ serverUrl, adminToken, project }) {
  const response = await fetchApiJson(
    `${trimTrailingSlash(serverUrl)}/api/workflows`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: project.workflowName,
        workflowId: project.workflowId,
      }),
    },
  );

  assertApiOk(response, `Failed to create project ${project.dirName}.`);
}

async function uploadWorkflowArchive({ serverUrl, adminToken, workflowId, archivePath }) {
  const archiveName = path.basename(archivePath);
  const archiveBuffer = await readFile(archivePath);
  const response = await fetchApiJson(
    `${trimTrailingSlash(serverUrl)}/api/workflows/${encodeURIComponent(workflowId)}/package?fileName=${encodeURIComponent(archiveName)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/octet-stream",
        "x-workflow-package-name": archiveName,
      },
      body: archiveBuffer,
    },
  );

  assertApiOk(response, `Failed to upload package for workflow ${workflowId}.`);
}

async function publishWorkflowProject({ serverUrl, adminToken, workflowId, releaseLog }) {
  const response = await fetchApiJson(
    `${trimTrailingSlash(serverUrl)}/api/workflows/${encodeURIComponent(workflowId)}/publish`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ releaseLog }),
    },
  );

  assertApiOk(response, `Failed to publish workflow ${workflowId}.`);
}

async function fetchApiJson(url, options) {
  const response = await fetch(url, options);
  const bodyText = await response.text();
  let parsed;
  try {
    parsed = bodyText === "" ? {} : JSON.parse(bodyText);
  } catch (error) {
    throw new Error(
      `Unexpected non-JSON response (${response.status} ${response.statusText}) from ${url}: ${bodyText}`,
      { cause: error },
    );
  }

  if (!response.ok) {
    const message = parsed?.errMessage || `${response.status} ${response.statusText}`;
    throw new Error(`Request failed for ${url}: ${message}`);
  }

  return parsed;
}

function assertApiOk(response, fallbackMessage) {
  if (response?.errCode !== 0) {
    throw new Error(response?.errMessage || fallbackMessage);
  }
}

async function cleanupLegacyFilesystem({ dataRoot, legacyWorkflowIds }) {
  for (const workflowId of legacyWorkflowIds) {
    await rm(path.join(dataRoot, "workflows", workflowId), {
      recursive: true,
      force: true,
    });
    await rm(path.join(dataRoot, "runtime-cache", workflowId), {
      recursive: true,
      force: true,
    });
  }
}

async function cleanupLegacyManagedFiles({ dataRoot, legacyWorkflowIds }) {
  const fileDirs = await findManagedFileDirectoriesForWorkflowIds(
    path.join(dataRoot, "files"),
    legacyWorkflowIds,
  );
  for (const fileDir of fileDirs) {
    await rm(fileDir, { recursive: true, force: true });
  }
}


function isMissingPathError(error) {
  return Boolean(error) && typeof error === "object" && error.code === "ENOENT";
}

async function runCommand(command, args, options = {}) {
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}${error.message}`,
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Command failed: ${command} ${args.join(" ")}`);
  }
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
const scriptPath = path.resolve(fileURLToPath(import.meta.url));
if (entryPoint !== "" && entryPoint === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
