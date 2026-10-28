import { readProjectManifestFromDirectory } from '@steamharness/project-manifest/node';
import { readProjectDeclaration, projectManifestForDistribution, type ProjectEntry } from "@steamharness/project-manifest";
import { configurationTemplatePath } from "@steamharness/project-configuration";
import { defaultServerUrl } from "./service-url";

import type {ProjectConfigurationState} from '@steamharness/project-configuration';
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeProjectIdentity } from './project-identity';
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isProjectAuthExpiringSoon } from "@steamharness/auth-config";
import { isProjectUuid } from "@steamharness/workflow-ids";
import {
  copyProjectUploadFiles,
  createProjectUploadPlan,
  type UploadPlan,
} from "@steamharness/project-upload/node";
import {
  readProjectInfo,
  type ProjectInfoContract,
} from "@steamharness/project-info";
import { cacheVerifiedConfigurationTemplate, parseConfigurationTemplate, CONFIGURATION_TEMPLATE_FILE, isProjectKind, parseProjectFileReferences, RemoteProjectFileStore, type ProjectKind } from "steamharness";
import { clearCliAuthConfig, readCliAuthConfig, readCliAuthConfigSync, writeCliAuthConfig } from "./auth-config";
import { findWorkspaceRepositoryRoot } from "./env";
import {
  getCurrentLocale,
  i18n,
  translateSteamHarnessError,
} from "@steamharness/i18n";
import { prepareCliInvocation } from "./locale";

interface CliOptions {
  server: string;
  token: string;
  target?: string;
  releaseLog?: string;
  file?: string;
  mimeType?: string;
  output?: string;
  path?: string;
  create?: boolean;
  noWait?: boolean;
  groupId?: string;
}

interface PreparationJob {
  jobId: string;
  projectId: string;
  archiveName: string;
  createOnly: boolean;
  status: "queued" | "preparing" | "success" | "failed";
  stage: "queued" | "extracting" | "validating" | "committing";
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  failureReason?: string;
  result?: unknown;
}

interface ParsedArgs {
  command: string;
  positional: string[];
  options: CliOptions;
  effective: CliEffectiveTarget;
}

/** Where a command's server and token actually come from. */
export type CliValueSource = "env" | "flag" | "file" | "default";

export interface CliEffectiveTarget {
  serverUrl: string;
  serverSource: CliValueSource;
  tokenSource: "env" | "flag" | "file" | "none";
}

interface ApiResponse<T = unknown> {
  errCode: number;
  errMessage: string;
  data?: T;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  intervalSeconds: number;
}

interface DeviceTokenResult {
  accessToken: string;
  apiKey: {
    prefix?: string;
    expiresAt?: string;
  };
  user: {
    userId: string;
    email: string;
    displayName: string;
  };
  expiresAt?: string;
}

const CLI_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEVICE_FLOW_CLIENT_NAME = "Workflow Workspace CLI";



export async function main(
  argv = process.argv.slice(2),
  options: { localeInitialized?: boolean } = {},
): Promise<void> {
  if (options.localeInitialized !== true) {
    argv = prepareCliInvocation(argv).argv;
  }
  const parsed = parseArgs(argv);

  switch (parsed.command) {
    case "login":
      await commandLogin(parsed);
      return;
    case "logout":
      await commandLogout();
      return;
    case "status":
      await commandStatus(parsed);
      return;
    case "pack":
      await commandPack(parsed);
      return;
    case "upload":
      await commandUpload(parsed);
      return;
    case "file-upload":
      await commandFileUpload(parsed);
      return;
    case "file-download":
      await commandFileDownload(parsed);
      return;
    case "file-delete":
      await commandFileDelete(parsed);
      return;
    case "preparation":
      await commandPreparation(parsed);
      return;
    case "download":
      await commandDownload(parsed);
      return;
    case "publish":
      await commandPublish(parsed);
      return;
    case "versions":
      await commandVersions(parsed);
      return;
    case "health":
      await commandHealth(parsed);
      return;
    case "":
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default:
      throw new Error(i18n.t("unknownWorkspaceCommand", { ns: "cli", command: parsed.command }));
  }
}

async function commandLogin(parsed: ParsedArgs): Promise<void> {
  const server = parsed.options.server.trim();
  if (server === "") {
    throw new Error(i18n.t("loginRequiresServer", { ns: "cli" }));
  }

  const started = await fetchApi<DeviceStartResult>({
    server,
    token: "",
    path: "/api/auth/device/start",
    method: "POST",
    body: {
      // phase 1 moves workspace login to device flow and stores a
      // dedicated CLI auth file instead of sharing the App config.
      clientName: DEFAULT_DEVICE_FLOW_CLIENT_NAME,
      source: "cli",
    },
    auth: false,
  });
  if (started.errCode !== 0 || started.data === undefined) {
    printApiResponse(started);
    assertApiOk(started);
    return;
  }

  const verificationUrl = started.data.verificationUriComplete || started.data.verificationUri;
  void openExternalBrowser(verificationUrl);

  console.error(i18n.t("deviceLoginPrompt", {
    ns: "cli",
    url: verificationUrl,
    code: started.data.userCode,
  }));

  const completed = await waitForDeviceToken({
    server,
    deviceCode: started.data.deviceCode,
    intervalSeconds: started.data.intervalSeconds,
    expiresAt: started.data.expiresAt,
  });
  if (completed.errCode !== 0 || completed.data === undefined) {
    printApiResponse(completed);
    assertApiOk(completed);
    return;
  }

  await writeCliAuthConfig({
    serverUrl: server,
    apiKey: completed.data.accessToken,
    expiresAt: completed.data.expiresAt ?? completed.data.apiKey.expiresAt,
    user: completed.data.user,
    source: "device_flow",
  });

  printApiResponse({
    errCode: 0,
    errMessage: "",
    data: {
      loggedIn: true,
      serverUrl: server,
      user: completed.data.user,
      expiresAt: completed.data.expiresAt ?? completed.data.apiKey.expiresAt,
      apiKeyPrefix: completed.data.apiKey.prefix,
    },
  });
}

async function commandLogout(): Promise<void> {
  await clearCliAuthConfig();
  printApiResponse({ errCode: 0, errMessage: "", data: { loggedIn: false } });
}

async function commandStatus(parsed: ParsedArgs): Promise<void> {
  const authConfig = await readCliAuthConfig();
  // Everything above `effective` describes the saved login file, which is only
  // the fallback identity. `effective` is what a command started with these
  // arguments would actually use, so a caller comparing a project's server
  // binding against this output reads the right field.
  printApiResponse({
    errCode: 0,
    errMessage: "",
    data: {
      loggedIn: authConfig.serverUrl.trim() !== "" && authConfig.apiKey.trim() !== "",
      serverUrl: authConfig.serverUrl,
      user: authConfig.user,
      expiresAt: authConfig.expiresAt,
      expiringSoon: isProjectAuthExpiringSoon(authConfig.expiresAt),
      source: authConfig.source ?? null,
      effective: parsed.effective,
    },
  });
}

async function commandPack(parsed: ParsedArgs): Promise<void> {
  const projectName = requirePositional(parsed, 0, "workflow");
  const archivePath = await packProject(projectName, parsed.options.output, parsed.options.path);

  console.log(JSON.stringify({ archivePath }, null, 2));
}

async function commandUpload(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  if (parsed.options.create && parsed.options.file) { throw new Error(i18n.t('newApplicationArchiveUnsupported', { ns: 'cli' })); }
  const projectArg = requirePositional(parsed, 0, "workflow");
  const packageContext = await readProjectPackageContext(projectArg, parsed.options.path);
  let projectId = packageContext.projectId;

  if (parsed.options.create === true) {
    const created = await ensureProjectCreated({
      packageContext,
      groupId: parsed.options.groupId,
      server: parsed.options.server,
      token: parsed.options.token,
      allowNewApplication: true,
    });
    projectId = created.projectId;
  }

  if (!projectId) {
    throw new Error(i18n.t("projectIdRequired", { ns: "cli" }));
  }

  const archivePath = parsed.options.file
    ? path.resolve(parsed.options.file)
    : await packProject(projectArg, parsed.options.output, parsed.options.path);
  const uploadResult = await uploadPackage({
    projectId,
    archivePath,
    server: parsed.options.server,
    token: parsed.options.token,
  });

  if (uploadResult.errCode !== 0 || uploadResult.data === undefined) {
    printApiResponse(uploadResult);
    assertApiOk(uploadResult);
    return;
  }
  if (parsed.options.noWait === true) {
    printApiResponse(uploadResult);
    return;
  }

  const preparationResult = await waitForPreparation({
    projectId,
    jobId: uploadResult.data.jobId,
    server: parsed.options.server,
    token: parsed.options.token,
  });
  printApiResponse(preparationResult);
  assertApiOk(preparationResult);
  if (preparationResult.errCode !== 0) {
    return;
  }

  if (parsed.options.releaseLog !== undefined) {
    const publishResult = await fetchApi({
      server: parsed.options.server,
      token: parsed.options.token,
      path: `/api/projects/${encodeURIComponent(projectId)}/publish`,
      method: "POST",
      body: {
        releaseLog: parsed.options.releaseLog,
      },
    });

    printApiResponse(publishResult);
    assertApiOk(publishResult);
  }
}

async function commandPreparation(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  const projectId = requirePositional(parsed, 0, "workflow");
  const jobId = requirePositional(parsed, 1, "jobId");
  const result = await getPreparation({
    projectId,
    jobId,
    server: parsed.options.server,
    token: parsed.options.token,
  });
  printApiResponse(result);
  assertApiOk(result);
}

async function commandFileUpload(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  if (!parsed.options.file) throw new Error(i18n.t("fileUploadRequiresFile", { ns: "cli" }));
  const projectId = await resolveRemoteProjectId(parsed);
  const filePath = path.resolve(parsed.options.file);
  const info = await stat(filePath);
  if (!info.isFile() || info.size > 50 * 1024 * 1024) {
    throw new Error(i18n.t("invalidUploadFile", { ns: "cli" }));
  }
  const [source] = parseProjectFileReferences(filePath);
  const store = new RemoteProjectFileStore({
    serverUrl: parsed.options.server,
    token: parsed.options.token,
    projectName: projectId,
  });
  const file = await store.createFile({
    name: path.basename(filePath),
    mimeType: parsed.options.mimeType ?? source!.mimeType,
    buffer: await readFile(filePath),
  });
  printApiResponse({ errCode: 0, errMessage: "", data: file });
}

async function commandFileDownload(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  const fileId = requirePositional(parsed, 0, "file-id");
  if (!parsed.options.output) throw new Error(i18n.t("fileDownloadRequiresOutput", { ns: "cli" }));
  const response = await fetch(
    `${trimTrailingSlash(parsed.options.server)}/api/projects/files/${encodeURIComponent(fileId)}`,
    { headers: { Authorization: `Bearer ${parsed.options.token}` }, redirect: "error" },
  );
  if (!response.ok) {
    const result = await response.json() as ApiResponse;
    printApiResponse(result);
    assertApiOk(result.errCode === 0 ? { errCode: response.status, errMessage: response.statusText } : result);
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const output = path.resolve(parsed.options.output);
  await writeFile(output, buffer, { flag: "wx" });
  printApiResponse({ errCode: 0, errMessage: "", data: { id: fileId, output, size: buffer.byteLength } });
}

async function commandFileDelete(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  const fileId = requirePositional(parsed, 0, "file-id");
  const result = await fetchApi({
    server: parsed.options.server,
    token: parsed.options.token,
    path: `/api/projects/files/${encodeURIComponent(fileId)}`,
    method: "DELETE",
  });
  printApiResponse(result);
  assertApiOk(result);
}

async function commandVersions(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  const projectId = await resolveRemoteProjectId(parsed);
  const result = await fetchApi({
    server: parsed.options.server,
    token: parsed.options.token,
    path: `/api/projects/${encodeURIComponent(projectId)}/versions`,
  });

  printApiResponse(result);
  assertApiOk(result);
}

async function commandDownload(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  const projectArg = requirePositional(parsed, 0, "workflow");
  const projectId = await resolveRemoteProjectId(parsed);
  const target = parsed.options.target ?? "latest";
  const result = await fetchApi<AggregateDownload>({ server: parsed.options.server, token: parsed.options.token,
    path: `/api/projects/${encodeURIComponent(projectId)}/${target === "draft" ? "files" : "source-files"}?target=${encodeURIComponent(target)}&includeBinary=true` });
  assertApiOk(result); if (!result.data) throw new Error("Project download is unavailable.");
  const targetDir = parsed.options.path ? path.resolve(parsed.options.path) : path.join(resolveRepoRoot(), "workspace", "workflow", projectArg);
  await materializeAggregateDownload({ ...result.data, projectId }, targetDir);
  printApiResponse({ ...result, data: { projectId, path: targetDir, entries: (await readProjectManifestFromDirectory(targetDir, {})).entries } });
}

interface AggregateDownload { projectId: string; resolvedTarget?: string; sourceHash?: string; files: Array<{path:string;content:string;encoding?:"base64"}> }
export async function materializeAggregateDownload(download: AggregateDownload, targetDir: string): Promise<void> {
  if (existsSync(targetDir)) throw new Error("The download destination already exists. Choose an empty destination.");
  if (download.sourceHash && hashProjectSourceFiles(download.files) !== download.sourceHash) throw new Error("Downloaded project source hash mismatch.");
  const stage = `${targetDir}.${randomUUID()}.download`;
  const seen = new Set<string>();
  try {
    await mkdir(stage, { recursive: true });
    for (const file of download.files) {
      const relative = normalizeProjectFilePath(file.path), portable = createPortableLocalPathKey(relative);
      if (seen.has(portable) || relative.split("/").some(part => [".git", "node_modules", ".env", ".steamharness", ".data"].includes(part) || part.startsWith(".env."))) throw new Error("Invalid or duplicate download path.");
      seen.add(portable);
      const destination = path.join(stage, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, decodeProjectFileContent(file), { flag: "wx" });
    }
    const pkg = await assertDownloadedProjectMetadata(stage, download.projectId);
    const manifest = await readProjectManifestFromDirectory(stage, {});
    for (const entry of manifest.entries) {
      const templateFile = download.files.find(file => file.path === configurationTemplatePath(entry.entryId));
      if (!templateFile) continue;
      const template = parseConfigurationTemplate(JSON.parse(templateFile.content));
      if (template.projectId !== download.projectId || template.entryId !== entry.entryId || template.projectVersion !== download.resolvedTarget) throw new Error("Downloaded configuration binding mismatch.");
      const attachments = (template.attachments ?? []).map(asset => { const file = download.files.find(file => file.path === asset.path); if (!file) throw new Error("Downloaded configuration attachment is missing."); return { id: asset.id, bytes: Buffer.from(decodeProjectFileContent(file)) }; });
      await cacheVerifiedConfigurationTemplate(template, attachments);
    }
    await writeFile(path.join(stage, "package.json"), JSON.stringify(projectManifestForDistribution(pkg), null, 2) + "\n");
    await rename(stage, targetDir);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function commandPublish(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  const projectId = await resolveRemoteProjectId(parsed);
  const publishResult = await fetchApi({
    server: parsed.options.server,
    token: parsed.options.token,
    path: `/api/projects/${encodeURIComponent(projectId)}/publish`,
    method: "POST",
    body: {
      releaseLog: parsed.options.releaseLog,
    },
  });

  printApiResponse(publishResult);
  assertApiOk(publishResult);
}

async function assertDownloadedProjectMetadata(
  projectDir: string,
  projectId: string,
  packageJson?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const metadata = packageJson ?? await readPackageJsonFile(path.join(projectDir, "package.json"));
  if (metadata["id"] !== projectId) {
    throw new Error(i18n.t("downloadedPackageIdMismatch", {
      ns: "cli",
      projectId: JSON.stringify(projectId),
    }));
  }
  readProjectDeclaration(metadata);
  return metadata;
}

function createPortableLocalPathKey(filePath: string): string {
  return filePath.normalize("NFC").toLowerCase();
}

async function commandHealth(parsed: ParsedArgs): Promise<void> {
  const result = await fetchApi({
    server: parsed.options.server,
    token: "",
    path: "/health",
    auth: false,
  });

  printApiResponse(result);
  assertApiOk(result);
}

async function packProject(
  projectName: string,
  outputPath: string | undefined,
  sourcePath: string | undefined,
): Promise<string> {
  const repoRoot = resolveRepoRoot();
  const projectDir = sourcePath === undefined
    ? path.join(repoRoot, "workspace", "workflow", projectName)
    : path.resolve(sourcePath);
  await readPackageJsonFile(path.join(projectDir, "package.json"));
  // Packaged Studio uploads need a writable temporary archive directory.
  const packsDir = process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR
    ? path.resolve(process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR)
    : path.join(repoRoot, "workspace", ".packs");
  const stagingDir = path.join(packsDir, "tmp", randomUUID(), projectName);
  const archivePath = outputPath
    ? path.resolve(outputPath)
    : path.join(packsDir, `${projectName}-${createTimestamp()}.tgz`);


  await rm(path.dirname(stagingDir), { recursive: true, force: true });
  await mkdir(path.join(stagingDir, "workspace", "workflow"), { recursive: true });
  await mkdir(path.dirname(archivePath), { recursive: true });
  // Every registered entry is included in this single aggregate unit.
  await stageProjectSource({
    projectDir,
    projectName,
    stagingRoot: path.join(stagingDir, "workspace", "workflow"),
  });

  const result = await runCommand("tar", ["-czf", archivePath, "-C", stagingDir, "."], {
    cwd: repoRoot,
  });

  await rm(path.dirname(stagingDir), { recursive: true, force: true });

  if (result.exitCode !== 0) {
    throw new Error(i18n.t("archiveCreateFailed", {
      ns: "cli",
      details: result.stderr || result.stdout,
    }));
  }

  return archivePath;
}

async function resolveRemoteProjectId(parsed: ParsedArgs): Promise<string> {
  const projectArg = requirePositional(parsed, 0, "workflow");
  if (isProjectUuid(projectArg)) {
    return projectArg;
  }
  const packageContext = await readProjectPackageContext(projectArg, parsed.options.path);
  if (packageContext.projectId) {
    return packageContext.projectId;
  }
  throw new Error(i18n.t("projectNotBound", {
    ns: "cli",
    workflow: projectArg,
  }));
}

async function readProjectPackageContext(
  projectArg: string,
  sourcePath: string | undefined,
): Promise<PackageContext> {
  const repoRoot = resolveRepoRoot();
  const projectDir = sourcePath === undefined
    ? path.join(repoRoot, "workspace", "workflow", projectArg)
    : path.resolve(sourcePath);
  const packageJsonPath = path.join(projectDir, "package.json");
  const packageJson = await readPackageJsonFile(packageJsonPath);
  const projectId = typeof packageJson.id === "string" && isProjectUuid(packageJson.id)
    ? packageJson.id.trim()
    : undefined;
  const projectName = readRequiredPackageString(packageJson, "name");
  const manifest = await readProjectManifestFromDirectory(projectDir, {});

  return {
    projectArg,
    projectDir,
    packageJsonPath,
    projectId,
    projectName,
    entries: manifest.entries, defaultEntry: manifest.defaultEntry,
    packageJson,
  };
}

async function ensureProjectCreated(options: {
  packageContext: PackageContext;
  groupId?: string;
  server: string;
  token: string;
  allowNewApplication?: boolean;
}): Promise<ProjectCreateResult> {
  const projectInfo = readProjectInfo(options.packageContext.packageJson);
  const projectId = options.packageContext.projectId;
  if (projectId !== undefined) {
    const existing = await fetchApi<{ id: string; name: string; entries: ProjectEntry[]; defaultEntry: string; visibility: ProjectCreateResult['visibility'] }>({
      server: options.server, token: options.token, path: `/api/projects/${encodeURIComponent(projectId)}`, method: 'GET',
    });
    if (existing.errCode === 0 && existing.data) {
      if (typeof existing.data.id !== 'string' || existing.data.id.toLowerCase() !== projectId.toLowerCase()) { throw new Error(i18n.t('projectCreationIdMismatch', { ns: 'cli' })); }
      return { projectId, projectName: existing.data.name, entries: existing.data.entries, defaultEntry: existing.data.defaultEntry, visibility: existing.data.visibility };
    }
    if (existing.errCode !== 404) { assertApiOk(existing); }
  }
  if (!options.allowNewApplication) { throw new Error(i18n.t('projectRegistrationRequired', { ns: 'cli' })); }
  const source = await readFile(options.packageContext.packageJsonPath, 'utf8');
  if (JSON.stringify(JSON.parse(source)) !== JSON.stringify(options.packageContext.packageJson)) { throw new Error(i18n.t('projectIdentityChanged', { ns: 'cli' })); }
  const created = await fetchApi<ProjectCreateResult>({
    server: options.server,
    token: options.token,
    path: "/api/projects",
    method: "POST",
    body: {
      name: options.packageContext.projectName,
      entries: options.packageContext.entries, defaultEntry: options.packageContext.defaultEntry,
      projectInfo,
      ...(options.groupId?{groupId:options.groupId}:{}),
    },
  });
  if (created.errCode !== 0 || created.data === undefined) {
    printApiResponse(created);
    assertApiOk(created);
    throw new Error(i18n.t("projectCreationFailed", { ns: "cli" }));
  }

  if (!isProjectUuid(created.data.projectId) || created.data.projectId.toLowerCase() === projectId?.toLowerCase()) {
    throw new Error(i18n.t("projectCreationIdMismatch", { ns: "cli" }));
  }
  await writeProjectIdentity(options.packageContext.projectDir, source, created.data.projectId);
  return created.data;
}

async function readPackageJsonFile(packageJsonPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(i18n.t("packageMustBeObject", { ns: "cli", path: packageJsonPath }));
    }
    return raw as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(i18n.t("packageReadFailed", { ns: "cli", path: packageJsonPath }));
  }
}

function readRequiredPackageString(packageJson: Record<string, unknown>, key: string): string {
  const value = packageJson[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(i18n.t("packageStringRequired", { ns: "cli", key }));
  }
  return value.trim();
}

function readProjectPackageVersion(packageJson: Record<string, unknown>): string {
  const version = readRequiredPackageString(packageJson, "version");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(i18n.t("packageVersionInvalid", { ns: "cli", version }));
  }
  return version;
}

async function uploadPackage(options: {
  projectId: string;
  archivePath: string;
  server: string;
  token: string;
}): Promise<ApiResponse<PreparationJob>> {
  const archiveBuffer = await readFile(options.archivePath);
  const archiveName = path.basename(options.archivePath);
  const query = new URLSearchParams({ fileName: archiveName });
  const response = await fetch(
    `${trimTrailingSlash(options.server)}/api/projects/${encodeURIComponent(options.projectId)}/package?${query.toString()}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/octet-stream",
        "x-steamharness-package-name": archiveName,
        "x-steamharness-locale": getCurrentLocale(),
      },
      body: new Blob([archiveBuffer]),
    },
  );

  return response.json() as Promise<ApiResponse<PreparationJob>>;
}

async function waitForPreparation(options: {
  projectId: string;
  jobId: string;
  server: string;
  token: string;
  pollIntervalMs?: number;
}): Promise<ApiResponse> {
  // CLI cancellation only stops polling; the persisted server job
  // remains queryable and continues independently.
  let previousStage = "";
  while (true) {
    const response = await fetchApi<PreparationJob>({
      server: options.server,
      token: options.token,
      path: `/api/projects/${encodeURIComponent(options.projectId)}/preparations/${encodeURIComponent(options.jobId)}`,
    });
    if (response.errCode !== 0 || response.data === undefined) {
      return response;
    }
    if (response.data.stage !== previousStage) {
      previousStage = response.data.stage;
      process.stderr.write(`${i18n.t("preparationProgress", {
        ns: "cli",
        status: response.data.status,
        stage: response.data.stage,
      })}\n`);
    }
    if (response.data.status === "success") {
      return {
        errCode: 0,
        errMessage: "",
        data: response.data.result,
      };
    }
    if (response.data.status === "failed") {
      return {
        errCode: 500,
        errMessage: response.data.failureReason ?? `Preparation failed during ${response.data.stage}.`,
        data: response.data,
      };
    }
    await delay(options.pollIntervalMs ?? 1_000);
  }
}

async function getPreparation(options: {
  projectId: string;
  jobId: string;
  server: string;
  token: string;
}): Promise<ApiResponse<PreparationJob>> {
  return fetchApi<PreparationJob>({
    server: options.server,
    token: options.token,
    path: `/api/projects/${encodeURIComponent(options.projectId)}/preparations/${encodeURIComponent(options.jobId)}`,
  });
}

async function fetchApi<T = unknown>(options: {
  server: string;
  token: string;
  path: string;
  method?: string;
  body?: unknown;
  auth?: boolean;
}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};

  if (options.auth !== false) {
    headers.authorization = `Bearer ${options.token}`;
  }

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  headers["x-steamharness-locale"] = getCurrentLocale();

  if(options.method==='POST' && /^\/api\/projects\/[^/]+\/publish$/.test(options.path) && options.body && typeof options.body==='object') {
    const projectPath=options.path.replace(/\/publish$/,'');
    const project=await fetchApi<{entries:ProjectEntry[]}>({server:options.server,token:options.token,path:projectPath});assertApiOk(project);
    const revisions:Record<string,number>={};let sourceHash:string|undefined;
    for(const entry of project.data!.entries){
      const configurations=await fetchApi<ProjectConfigurationState>({server:options.server,token:options.token,path:`${projectPath}/configurations?target=draft&entryId=${encodeURIComponent(entry.entryId)}`});assertApiOk(configurations);
      revisions[entry.entryId]=configurations.data?.publicationRevision??configurations.data?.publication?.revision??0;
      sourceHash??=configurations.data?.sourceHash;
    }
    options={...options,body:{expectedSourceHash:sourceHash,...options.body,expectedConfigurationRevisions:revisions}};
  }
  const response = await fetch(`${trimTrailingSlash(options.server)}${options.path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  return response.json() as Promise<ApiResponse<T>>;
}

async function copyProjectSource(sourceDir: string, targetDir: string): Promise<UploadPlan> { return copyProjectUploadFiles(sourceDir, targetDir); }

async function stageProjectSource(options: {
  projectDir: string;
  projectName: string;
  stagingRoot: string;
}): Promise<void> {
  const uploadPlan=await copyProjectSource(options.projectDir,path.join(options.stagingRoot,options.projectName));
  if(!uploadPlan.projectIgnoreConfigured)process.stderr.write(`${i18n.t('projectIgnoreWarning',{ns:'cli',files:uploadPlan.files.length,bytes:uploadPlan.totalBytes})}\n`);
}

export function normalizeProjectFilePath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(i18n.t("invalidProjectFilePath", { ns: "cli", path: filePath }));
  }
  return normalized;
}

function decodeProjectFileContent(file: {
  path: string;
  content: string;
  encoding?: "base64";
}): string | Buffer {
  if (file.encoding === undefined) {
    return file.content;
  }
  if (file.encoding !== "base64") {
    throw new Error(i18n.t("unsupportedProjectEncoding", { ns: "cli", path: file.path }));
  }

  const normalized = file.content.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) {
    throw new Error(i18n.t("invalidBase64Content", { ns: "cli", path: file.path }));
  }
  const decoded = Buffer.from(file.content, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== normalized) {
    throw new Error(i18n.t("invalidBase64Content", { ns: "cli", path: file.path }));
  }
  return decoded;
}

function hashProjectSourceFiles(
  files: ReadonlyArray<{ path: string; content: string; encoding?: "base64" }>,
): string {
  const hash = createHash("sha256");
  const normalizedFiles = files.map((file) => ({
    file,
    path: normalizeProjectFilePath(file.path),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const item of normalizedFiles) {
    hash.update(item.path);
    hash.update("\0");
    hash.update(decodeProjectFileContent(item.file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const authConfig = readCliAuthConfigSync();
  const envServer = process.env.STEAMHARNESS_SERVER_URL;
  const envToken = process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  // The saved CLI login is only the fallback: a host that spawns this CLI
  // (SteamHarness Desktop) passes its own session through the environment,
  // and that is the server the command really talks to.
  const options: CliOptions = {
    server: envServer ?? (authConfig.serverUrl.trim() || defaultServerUrl()),
    token: envToken ?? authConfig.apiKey ?? "",
  };
  const effective: CliEffectiveTarget = {
    serverUrl: options.server,
    serverSource: envServer !== undefined
      ? "env"
      : authConfig.serverUrl.trim() !== "" ? "file" : "default",
    tokenSource: envToken !== undefined
      ? "env"
      : authConfig.apiKey.trim() !== "" ? "file" : "none",
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      positional.push(...rest.slice(index + 1));
      break;
    }

    switch (arg) {
      case "--server":
        options.server = requireValue(rest, (index += 1), "--server");
        effective.serverUrl = options.server;
        effective.serverSource = "flag";
        break;
      case "--token":
        options.token = requireValue(rest, (index += 1), "--token");
        effective.tokenSource = "flag";
        break;
      case "--group-id":
        options.groupId = requireValue(rest, (index += 1), "--group-id");
        break;
      case "--target":
        options.target = requireValue(rest, (index += 1), "--target");
        break;
      case "--version":
        throw new Error(i18n.t("versionOptionUnsupported", { ns: "cli" }));
      case "--release-log":
        options.releaseLog = requireValue(rest, (index += 1), "--release-log");
        break;
      case "--file":
        options.file = requireValue(rest, (index += 1), "--file");
        break;
      case "--mime-type":
        options.mimeType = requireValue(rest, (index += 1), "--mime-type");
        break;
      case "--output":
        options.output = requireValue(rest, (index += 1), "--output");
        break;
      case "--path":
        options.path = requireValue(rest, (index += 1), "--path");
        break;
      case "--create":
        options.create = true;
        break;
      case "--no-wait":
        options.noWait = true;
        break;
      default:
        if (arg?.startsWith("--")) throw new Error(i18n.t("unknownWorkspaceOption", { ns: "cli", option: arg }));
        positional.push(arg);
        break;
    }
  }

  if (command === "upload" && options.noWait === true && options.releaseLog !== undefined) {
    throw new Error(i18n.t("noWaitReleaseLogConflict", { ns: "cli" }));
  }
  if (options.mimeType !== undefined && command !== "file-upload") {
    throw new Error(i18n.t("mimeTypeCommandUnsupported", { ns: "cli" }));
  }
  if (options.noWait === true && command !== "upload") {
    throw new Error(i18n.t("noWaitCommandUnsupported", { ns: "cli" }));
  }

  return {
    command,
    positional,
    options,
    effective: { ...effective, serverUrl: options.server },
  };
}

interface ProjectCreateResult {
  projectId: string;
  projectName: string;
  visibility: "private" | "public";
  entries: ProjectEntry[];
  defaultEntry: string;
}

interface PackageContext {
  projectArg: string;
  projectDir: string;
  packageJsonPath: string;
  projectId?: string;
  projectName: string;
  entries: ProjectEntry[];
  defaultEntry: string;
  packageJson: Record<string, unknown>;
}

function requireLogin(parsed: ParsedArgs): void {
  if (parsed.options.server.trim() === "" || parsed.options.token.trim() === "") {
    throw new Error(i18n.t("notLoggedIn", { ns: "cli" }));
  }
}

function requirePositional(parsed: ParsedArgs, index: number, name: string): string {
  const value = parsed.positional[index];

  if (value === undefined || value.trim() === "") {
    throw new Error(i18n.t("missingPositional", { ns: "cli", name }));
  }

  return value;
}

function requireValue(argv: string[], index: number, name: string): string {
  const value = argv[index];

  if (value === undefined || value.trim() === "") {
    throw new Error(i18n.t("missingOptionValue", { ns: "cli", name }));
  }

  return value;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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
}

function printApiResponse(response: ApiResponse): void {
  console.log(JSON.stringify(response, null, 2));
}

function assertApiOk(response: ApiResponse): void {
  if (response.errCode !== 0) {
    if (response.errCode === 403) {
      process.stderr.write(`${formatForbiddenMessage(response)}\n`);
    }
    process.exitCode = 1;
  }
}

function formatForbiddenMessage(response: ApiResponse): string {
  const message = response.errMessage.toLowerCase();
  if (message.includes("permission denied")) {
    return i18n.t("forbiddenNoPermission", { ns: "cli" });
  }
  return i18n.t("forbiddenFallback", { ns: "cli", message: response.errMessage });
}

function printUsage(): void {
  console.log(i18n.t("workspaceHelp", { ns: "cli" }));
}

export function resolveRepoRoot(startDir = process.cwd()): string {
  if (process.env.STEAMHARNESS_REPO_ROOT !== undefined) {
    return path.resolve(process.env.STEAMHARNESS_REPO_ROOT);
  }

  // Source commands may start inside the Core repository workspace.
  for (const candidate of [startDir, CLI_MODULE_DIR]) {
    const repoRoot = findWorkspaceRepositoryRoot(candidate);
    if (repoRoot !== undefined) {
      return repoRoot;
    }
  }

  return process.cwd();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function createTimestamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

// keeps the CLI device-flow poll contract reusable in tests so
// slow_down / expired_token behavior stays stable across later phases.
export async function waitForDeviceToken(options: {
  server: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresAt: string;
}): Promise<ApiResponse<DeviceTokenResult>> {
  const expiresAtMs = new Date(options.expiresAt).getTime();
  const pollMs = Math.max(1000, options.intervalSeconds * 1000);

  while (!Number.isFinite(expiresAtMs) || Date.now() < expiresAtMs) {
    const response = await fetchApi<DeviceTokenResult>({
      server: options.server,
      token: "",
      path: "/api/auth/device/token",
      method: "POST",
      body: { deviceCode: options.deviceCode },
      auth: false,
    });
    if (response.errCode === 0) {
      return response;
    }
    if (response.errMessage === "slow_down") {
      const retryAfterSeconds =
        readRetryAfterSeconds(response.data) ?? Math.max(options.intervalSeconds * 2, 5);
      await delay(retryAfterSeconds * 1000);
      continue;
    }
    if (response.errMessage !== "authorization_pending") {
      return response;
    }
    await delay(pollMs);
  }

  return {
    errCode: 409,
    errMessage: "expired_token",
  };
}

async function openExternalBrowser(url: string): Promise<void> {
  const commands = process.platform === "darwin"
    ? [["open", url]]
    : process.platform === "win32"
      ? [["cmd", "/c", "start", "", url]]
      : [["xdg-open", url]];

  for (const [command, ...args] of commands) {
    const result = await runCommand(command, args);
    if (result.exitCode === 0) {
      return;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRetryAfterSeconds(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const value = (data as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

// keeps the server workspace CLI importable for unit tests without
// executing network or filesystem commands at module load time.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(translateSteamHarnessError(error));
    process.exitCode = 1;
  });
}

export {
  ensureProjectCreated,
  formatForbiddenMessage,
  decodeProjectFileContent,
  packProject,
  getPreparation,
  readPackageJsonFile,
  readProjectPackageContext,
  resolveRemoteProjectId,
  stageProjectSource,
  waitForPreparation,
};
