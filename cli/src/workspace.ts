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
  createProjectDependencyLocks,
  isProjectGroupHostDataPath,
  parseProjectDependencyLocks,
  type ProjectDependencyLock,
  type ProjectGroupManifestV1,
} from "@steamharness/project-dependencies";
import {
  readProjectInfo,
  resolveProjectRelatedProjectAccess,
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
  dependencies: string[];
  projectGroup?: boolean;
  groupId?: string;
  deployment?: string;
  publishGroup?: boolean;
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

interface ProjectGroupDownloadResult {
  rootProjectId: string;
  rootVersion: string;
  dependencies: ProjectDependencyLock[];
  complete: boolean;
  copyAllowed: boolean;
  skippedDependencies: Array<{
    dependency: ProjectDependencyLock;
    reason: "external" | "source_unavailable" | "permission_required";
    requestUrl?: string;
  }>;
  projects: Array<{
    alias?: string;
    projectId: string;
    projectName: string;
    version: string;
    sourceHash: string;
    role: "root" | "dependency";
    files: Array<{ path: string; content: string; encoding?: "base64" }>;
  }>;
}

interface DeploymentResult {
  id: string;
  rootProjectId: string;
  status: string;
  manifest: ProjectGroupManifestV1;
  error?: string;
  items?: Array<{
    projectId: string;
    status: string;
    stage?: string;
    error?: string;
  }>;
}

interface ProjectGroupPackResult {
  archivePath: string;
  manifest: ProjectGroupManifestV1;
  root: PackageContext;
  dependencies: PackageContext[];
}

interface ProjectGroupDependencyContext {
  alias: string;
  packageContext: PackageContext;
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
  if (
    parsed.options.projectGroup === true ||
    parsed.options.publishGroup === true ||
    parsed.options.dependencies.length > 0
  ) {
    const packed = await packProjectGroup({
      projectArg: projectName,
      sourcePath: parsed.options.path,
      outputPath: parsed.options.output,
      dependencyOptions: parsed.options.dependencies,
    });
    console.log(JSON.stringify({ archivePath: packed.archivePath, manifest: packed.manifest }, null, 2));
    return;
  }
  const archivePath = await packProject(projectName, parsed.options.output, parsed.options.path);

  console.log(JSON.stringify({ archivePath }, null, 2));
}

async function commandUpload(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  if (parsed.options.create && parsed.options.file) { throw new Error(i18n.t('newApplicationArchiveUnsupported', { ns: 'cli' })); }
  const projectArg = requirePositional(parsed, 0, "workflow");
  if (shouldUseProjectGroupUpload(parsed.options)) {
    await commandProjectGroupUpload(parsed, projectArg);
    return;
  }
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

function shouldUseProjectGroupUpload(options: Pick<
  CliOptions,
  "projectGroup" | "publishGroup" | "dependencies"
>): boolean {
  return options.projectGroup === true ||
    options.publishGroup === true ||
    options.dependencies.length > 0;
}

async function commandProjectGroupUpload(
  parsed: ParsedArgs,
  projectArg: string,
  forcePublish = false,
): Promise<void> {
  if (parsed.options.file !== undefined) {
    throw new Error(i18n.t("projectGroupUploadFileUnsupported", { ns: "cli" }));
  }

  let rootContext = await readProjectPackageContext(projectArg, parsed.options.path);
  if (parsed.options.create === true || rootContext.projectId !== undefined) {
    await ensureProjectCreated({
      packageContext: rootContext,
      groupId: parsed.options.groupId,
      server: parsed.options.server,
      token: parsed.options.token,
    });
    rootContext = await readProjectPackageContext(projectArg, parsed.options.path);
  }
  if (!rootContext.projectId) {
    throw new Error(i18n.t("projectGroupUploadRootIdRequired", { ns: "cli" }));
  }

  const contexts = await readProjectGroupContexts({
    projectArg,
    sourcePath: parsed.options.path,
    dependencyOptions: parsed.options.dependencies,
  });
  for (const dependency of contexts.dependencies) {
    await ensureProjectCreated({
      packageContext: dependency.packageContext,
      groupId: parsed.options.groupId,
      server: parsed.options.server,
      token: parsed.options.token,
    });
  }

  const packed = await packProjectGroup({
    projectArg,
    sourcePath: parsed.options.path,
    outputPath: parsed.options.output,
    dependencyOptions: parsed.options.dependencies,
    contexts,
  });

  const planned = await fetchApi<DeploymentResult>({
    server: parsed.options.server,
    token: parsed.options.token,
    path: "/api/deployments",
    method: "POST",
    body: {
      manifest: packed.manifest,
      releaseLog: parsed.options.releaseLog,
    },
  });
  if (planned.errCode !== 0 || planned.data === undefined) {
    printApiResponse(planned);
    assertApiOk(planned);
    return;
  }

  const queued = await uploadProjectGroupPackage({
    deploymentId: planned.data.id,
    archivePath: packed.archivePath,
    server: parsed.options.server,
    token: parsed.options.token,
  });
  if (queued.errCode !== 0 || queued.data === undefined) {
    printApiResponse(queued);
    assertApiOk(queued);
    return;
  }

  const prepared = await waitForProjectGroupPreparation({
    deploymentId: planned.data.id,
    server: parsed.options.server,
    token: parsed.options.token,
  });
  if (prepared.errCode !== 0 || prepared.data === undefined) {
    printApiResponse(prepared);
    assertApiOk(prepared);
    return;
  }

  if (
    !forcePublish &&
    parsed.options.releaseLog === undefined &&
    parsed.options.publishGroup !== true
  ) {
    printApiResponse(prepared);
    return;
  }
  const published = await fetchApi<DeploymentResult>({
    server: parsed.options.server,
    token: parsed.options.token,
    path: `/api/deployments/${encodeURIComponent(planned.data.id)}/publish`,
    method: "POST",
  });
  printApiResponse(published);
  assertApiOk(published);
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
  if (target !== "draft") {
    const result = await fetchApi<ProjectGroupDownloadResult>({
      server: parsed.options.server,
      token: parsed.options.token,
      path: `/api/projects/${encodeURIComponent(projectId)}/project-group-download?target=${encodeURIComponent(target)}`,
    });
    assertApiOk(result);
    if (result.errCode !== 0 || result.data === undefined) {
      printApiResponse(result);
      return;
    }
    const repoRoot = resolveRepoRoot();
    const rootTargetDir = parsed.options.path
      ? path.resolve(parsed.options.path)
      : path.join(repoRoot, "workspace", "workflow", projectArg);
    const materialized = await materializeProjectGroupDownload(result.data, rootTargetDir);
    const locallyAvailableProjectIds = new Set(materialized.map((project) => project.projectId));
    const skippedDependencies = result.data.skippedDependencies.filter((item) => (
      item.dependency.delivery !== "included" ||
      !locallyAvailableProjectIds.has(item.dependency.projectId)
    ));
    const complete = !skippedDependencies.some((item) => item.dependency.delivery === "included");
    printApiResponse({
      ...result,
      data: {
        ...result.data,
        complete,
        copyAllowed: complete,
        skippedDependencies,
        projects: materialized,
      },
    });
    return;
  }
  const result = await fetchApi<{
    files: Array<{ path: string; content: string; encoding?: "base64" }>;
  }>({
    server: parsed.options.server,
    token: parsed.options.token,
    path: `/api/projects/${encodeURIComponent(projectId)}/files?target=${encodeURIComponent(target)}&includeBinary=true`,
  });
  printApiResponse(result);
  assertApiOk(result);
  if (result.errCode !== 0 || result.data === undefined) {
    return;
  }

  const repoRoot = resolveRepoRoot();
  const targetDir = parsed.options.path
    ? path.resolve(parsed.options.path)
    : path.join(repoRoot, "workspace", "workflow", projectArg);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  for (const file of result.data.files) {
    const safePath = normalizeProjectFilePath(file.path);
    const targetPath = path.join(targetDir, safePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, decodeProjectFileContent(file));
  }
}

async function commandPublish(parsed: ParsedArgs): Promise<void> {
  requireLogin(parsed);
  if (parsed.options.deployment !== undefined) {
    const publishResult = await fetchApi({
      server: parsed.options.server,
      token: parsed.options.token,
      path: `/api/deployments/${encodeURIComponent(parsed.options.deployment)}/publish`,
      method: "POST",
    });
    printApiResponse(publishResult);
    assertApiOk(publishResult);
    return;
  }
  if (shouldUseProjectGroupUpload(parsed.options)) {
    const projectArg = requirePositional(parsed, 0, "workflow");
    await commandProjectGroupUpload(parsed, projectArg, true);
    return;
  }
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

async function materializeProjectGroupDownload(
  download: ProjectGroupDownloadResult,
  rootTargetDir: string,
): Promise<Array<{
  alias?: string;
  projectId: string;
  projectName: string;
  role: "root" | "dependency";
  path: string;
  alreadyAvailable: boolean;
}>> {
  if (!isProjectUuid(download.rootProjectId)) {
    throw new Error(i18n.t("projectGroupDownloadInvalidRootId", { ns: "cli" }));
  }
  const dependencies = parseProjectDependencyLocks(download.dependencies, { published: true });
  const includedDependencies = dependencies.filter((dependency) => dependency.delivery === "included");
  const includedProjectIds = new Set(includedDependencies.map((dependency) => dependency.projectId));
  const rootProjects = download.projects.filter((project) => project.role === "root");
  if (rootProjects.length !== 1 || rootProjects[0]?.projectId !== download.rootProjectId) {
    throw new Error(i18n.t("projectGroupDownloadRootCountInvalid", { ns: "cli" }));
  }
  const rootProject = rootProjects[0]!;
  if (rootProject.version !== download.rootVersion) {
    throw new Error(i18n.t("projectGroupDownloadRootVersionMismatch", { ns: "cli" }));
  }
  const rootPackageFile = rootProject.files.find((file) => normalizeProjectFilePath(file.path) === "package.json");
  if (rootPackageFile === undefined || rootPackageFile.encoding === "base64") {
    throw new Error(i18n.t("projectGroupDownloadRootPackageUtf8", { ns: "cli" }));
  }
  let rootPackageJson: Record<string, unknown>;
  try {
    rootPackageJson = JSON.parse(rootPackageFile.content) as Record<string, unknown>;
  } catch {
    throw new Error(i18n.t("projectGroupDownloadRootPackageInvalidJson", { ns: "cli" }));
  }
  const rootProjectInfo = readProjectInfo(rootPackageJson);
  const declaredRelations = rootProjectInfo.relatedProjects;
  // Only mutually confirmed relationships enter the published dependency lock.
  if (dependencies.some((dependency) => !declaredRelations.some((relation) => (
    dependency.alias === relation.alias && dependency.projectId.toLowerCase() === relation.projectId.toLowerCase()
  )))) {
    throw new Error(i18n.t("projectGroupDownloadLockMismatch", { ns: "cli" }));
  }
  const responseProjectIds = new Set<string>();
  for (const project of download.projects) {
    if (!isProjectUuid(project.projectId) || responseProjectIds.has(project.projectId)) {
      throw new Error(i18n.t("projectGroupDownloadInvalidOrDuplicateProjectId", {
        ns: "cli",
        projectId: JSON.stringify(project.projectId),
      }));
    }
    responseProjectIds.add(project.projectId);
    const filePaths = new Set<string>();
    for (const file of project.files) {
      const safePath = normalizeProjectFilePath(file.path);
      if (isProjectGroupHostDataPath(safePath)) {
        throw new Error(i18n.t("projectGroupDownloadForbiddenHostData", {
          ns: "cli",
          path: JSON.stringify(file.path),
        }));
      }
      const fileKey = createPortableLocalPathKey(safePath);
      if (filePaths.has(fileKey)) {
        throw new Error(i18n.t("projectGroupDownloadDuplicateFile", {
          ns: "cli",
          path: JSON.stringify(safePath),
        }));
      }
      filePaths.add(fileKey);
    }
    const packageFile = project.files.find((file) => normalizeProjectFilePath(file.path) === "package.json");
    if (packageFile === undefined || packageFile.encoding === "base64") {
      throw new Error(i18n.t("projectGroupDownloadPackageUtf8", { ns: "cli", role: project.role }));
    }
    let packageJson: Record<string, unknown>;
    try {
      packageJson = JSON.parse(packageFile.content) as Record<string, unknown>;
    } catch {
      throw new Error(i18n.t("projectGroupDownloadPackageInvalidJson", { ns: "cli", role: project.role }));
    }
    if (packageJson["id"] !== project.projectId) {
      throw new Error(i18n.t("projectGroupDownloadedPackageIdMismatch", {
        ns: "cli",
        projectId: JSON.stringify(project.projectId),
      }));
    }
    if (hashProjectSourceFiles(project.files) !== project.sourceHash) {
      throw new Error(i18n.t("projectGroupDownloadSourceHashMismatch", {
        ns: "cli",
        role: project.role,
        projectId: JSON.stringify(project.projectId),
      }));
    }
    if (project.role === "root" && project.alias !== undefined) {
      throw new Error(i18n.t("projectGroupDownloadRootAliasForbidden", { ns: "cli" }));
    }
    if (project.role === "dependency") {
      const matchingDependencies = includedDependencies.filter((dependency) => (
        dependency.projectId === project.projectId &&
        dependency.version === project.version &&
        dependency.sourceHash === project.sourceHash
      ));
      if (
        matchingDependencies.length === 0 ||
        (project.alias !== undefined && !matchingDependencies.some((dependency) => dependency.alias === project.alias))
      ) {
        throw new Error(i18n.t("projectGroupDownloadUndeclaredDependency", {
          ns: "cli",
          projectId: JSON.stringify(project.projectId),
        }));
      }
      const matchingDependency = project.alias === undefined
        ? matchingDependencies[0]
        : matchingDependencies.find((dependency) => dependency.alias === project.alias);
      if (matchingDependency !== undefined) {
        assertConfirmedRelatedProject({
          rootProjectId: download.rootProjectId,
          rootProjectInfo,
          targetProjectId: project.projectId,
          targetPackageJson: packageJson,
          alias: matchingDependency.alias,
        });
      }
    }
  }

  const parentDir = path.dirname(rootTargetDir);
  const expectedVersions = new Map(includedDependencies.map(dependency => [dependency.projectId, dependency.version!]));
  expectedVersions.set(download.rootProjectId, download.rootVersion);
  const existingById = await findSiblingProjectsById(parentDir, expectedVersions);
  const materialized: Array<{
    alias?: string;
    projectId: string;
    projectName: string;
    role: "root" | "dependency";
    path: string;
    alreadyAvailable: boolean;
  }> = [];
  const pending: Array<{
    project: ProjectGroupDownloadResult["projects"][number];
    targetDir: string;
  }> = [];
  const targetKeys = new Set<string>();
  const orderedProjects = [...download.projects].sort((left, right) => (
    left.role === right.role ? left.projectId.localeCompare(right.projectId) : left.role === "root" ? -1 : 1
  ));

  for (const project of orderedProjects) {
    const existingPath = existingById.get(project.projectId);
    if (existingPath !== undefined) {
      const packageJson = await assertDownloadedProjectMetadata(existingPath, project.projectId);
      if (project.role === "dependency") {
        const dependency = includedDependencies.find((candidate) => (
          candidate.projectId === project.projectId &&
          (project.alias === undefined || candidate.alias === project.alias)
        ));
        if (dependency !== undefined) {
          assertConfirmedRelatedProject({
            rootProjectId: download.rootProjectId,
            rootProjectInfo,
            targetProjectId: project.projectId,
            targetPackageJson: packageJson,
            alias: dependency.alias,
          });
        }
      }
      materialized.push({
        ...(project.alias === undefined ? {} : { alias: project.alias }),
        projectId: project.projectId,
        projectName: project.projectName,
        role: project.role,
        path: existingPath,
        alreadyAvailable: true,
      });
      continue;
    }

    const targetDir = project.role === "root"
      ? rootTargetDir
      : path.join(parentDir, createProjectDirectoryName(project.projectName, project.projectId));
    if (existsSync(targetDir)) {
      const existing = await readPackageJsonFile(path.join(targetDir, "package.json")).catch(() => undefined);
      throw new Error(i18n.t(existing?.["id"] === project.projectId ? "projectGroupDownloadDirectoryCollision" : "projectGroupDownloadDirectoryProjectMismatch", {
        ns: "cli",
        projectName: JSON.stringify(project.projectName),
        path: JSON.stringify(targetDir),
      }));
    }
    const targetKey = createPortableLocalPathKey(path.resolve(targetDir));
    if (targetKeys.has(targetKey)) {
      throw new Error(i18n.t("projectGroupDownloadDirectoryCollision", {
        ns: "cli",
        projectName: JSON.stringify(project.projectName),
        path: JSON.stringify(targetDir),
      }));
    }
    targetKeys.add(targetKey);
    pending.push({ project, targetDir });
  }

  for (const projectId of includedProjectIds) {
    if (responseProjectIds.has(projectId)) continue;
    const existingPath = existingById.get(projectId);
    if (existingPath === undefined) continue;
    const packageJson = await assertDownloadedProjectMetadata(existingPath, projectId);
    const dependency = includedDependencies.find((candidate) => candidate.projectId === projectId);
    if (dependency !== undefined) {
      assertConfirmedRelatedProject({
        rootProjectId: download.rootProjectId,
        rootProjectInfo,
        targetProjectId: projectId,
        targetPackageJson: packageJson,
        alias: dependency.alias,
      });
    }
    materialized.push({
      projectId,
      projectName: readRequiredPackageString(packageJson, "name"),
      role: "dependency",
      path: existingPath,
      alreadyAvailable: true,
    });
  }

  await mkdir(parentDir, { recursive: true });
  const stagingRoot = path.join(parentDir, `.workflow-download-group-${randomUUID()}`);
  const staged: Array<{
    project: ProjectGroupDownloadResult["projects"][number];
    targetDir: string;
    stagingDir: string;
  }> = [];
  const moved: string[] = [];
  try {
    await mkdir(stagingRoot, { recursive: false });
    for (const item of pending) {
      const { project, targetDir } = item;
      const stagingDir = path.join(stagingRoot, project.projectId);
      await mkdir(stagingDir, { recursive: true });
      for (const file of project.files) {
        const safePath = normalizeProjectFilePath(file.path);
        const targetPath = path.join(stagingDir, ...safePath.split("/"));
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, decodeProjectFileContent(file));
      }
      const packageJson = await readPackageJsonFile(path.join(stagingDir, "package.json"));
      if (packageJson["id"] !== project.projectId) {
        throw new Error(i18n.t("projectGroupDownloadedPackageIdMismatch", {
          ns: "cli",
          projectId: JSON.stringify(project.projectId),
        }));
      }
      await assertDownloadedProjectMetadata(stagingDir, project.projectId, packageJson);
      const templateFile=project.files.find(file=>file.path===CONFIGURATION_TEMPLATE_FILE);
      if(templateFile) {
        const template=parseConfigurationTemplate(JSON.parse(templateFile.content));
        if(template.projectId!==project.projectId||template.projectVersion!==project.version)throw new Error('Downloaded configuration binding mismatch.');
        const attachments=(template.attachments??[]).map(asset=>{
          const file=project.files.find(file=>file.path===asset.path);if(!file)throw new Error('Downloaded configuration attachment is missing.');
          return {id:asset.id,bytes:Buffer.from(decodeProjectFileContent(file))};
        });
        await cacheVerifiedConfigurationTemplate(template,attachments);
      }
      staged.push({ project, targetDir, stagingDir });
    }
    for (const item of staged) {
      await rename(item.stagingDir, item.targetDir);
      moved.push(item.targetDir);
      existingById.set(item.project.projectId, item.targetDir);
      materialized.push({
        ...(item.project.alias === undefined ? {} : { alias: item.project.alias }),
        projectId: item.project.projectId,
        projectName: item.project.projectName,
        role: item.project.role,
        path: item.targetDir,
        alreadyAvailable: false,
      });
    }
  } catch (error) {
    for (const targetDir of moved) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  return materialized.sort((left, right) => (
    left.role === right.role ? left.projectId.localeCompare(right.projectId) : left.role === "root" ? -1 : 1
  ));
}

async function assertDownloadedProjectMetadata(
  projectDir: string,
  projectId: string,
  packageJson?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const metadata = packageJson ?? await readPackageJsonFile(path.join(projectDir, "package.json"));
  if (metadata["id"] !== projectId) {
    throw new Error(i18n.t("projectGroupDownloadedPackageIdMismatch", {
      ns: "cli",
      projectId: JSON.stringify(projectId),
    }));
  }
  readStaticProjectType(metadata);
  return metadata;
}

function assertConfirmedRelatedProject(options: {
  rootProjectId: string;
  rootProjectInfo: ProjectInfoContract;
  targetProjectId: string;
  targetPackageJson: Record<string, unknown>;
  alias: string;
}): void {
  const targetProjectInfo = readProjectInfo(options.targetPackageJson);
  if (resolveProjectRelatedProjectAccess({
    consumerProjectId: options.rootProjectId,
    consumerProjectInfo: options.rootProjectInfo,
    targetProjectId: options.targetProjectId,
    targetProjectInfo,
    alias: options.alias,
  }) === undefined) {
    throw new Error(i18n.t("projectGroupRelatedProjectPending", {
      ns: "cli",
      alias: JSON.stringify(options.alias),
    }));
  }
}

function createPortableLocalPathKey(filePath: string): string {
  return filePath.normalize("NFC").toLowerCase();
}

async function findSiblingProjectsById(parentDir: string, expectedVersions: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const projects = new Map<string, string>();
  const entries = await readdir(parentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(parentDir, entry.name);
    const packageJson = await readPackageJsonFile(path.join(projectDir, "package.json")).catch(() => undefined);
    const projectId = packageJson?.["id"];
    if (typeof projectId === "string" && isProjectUuid(projectId) && expectedVersions.has(projectId)
      && expectedVersions.get(projectId) === packageJson?.["version"] && !projects.has(projectId)) {
      projects.set(projectId, projectDir);
    }
  }
  return projects;
}

function createProjectDirectoryName(projectName: string, projectId: string): string {
  const normalized = projectName
    .normalize("NFC")
    .replace(/^@/, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return normalized === "" ? projectId : normalized;
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
  options: { projectGroupSafe?: boolean } = {},
): Promise<string> {
  const repoRoot = resolveRepoRoot();
  const projectDir = sourcePath === undefined
    ? path.join(repoRoot, "workspace", "workflow", projectName)
    : path.resolve(sourcePath);
  await readPackageJsonFile(path.join(projectDir, "package.json"));
  // Packaged App uploads run the workspace CLI from app.asar, so
  // temporary packs must be writable and sibling workflow imports should be
  // resolved relative to the explicit --path source directory.
  const packsDir = process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR
    ? path.resolve(process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR)
    : path.join(repoRoot, "workspace", ".packs");
  const stagingDir = path.join(packsDir, "tmp", randomUUID(), projectName);
  const archivePath = outputPath
    ? path.resolve(outputPath)
    : path.join(packsDir, `${projectName}-${createTimestamp()}.tgz`);
  const workspaceRoot = sourcePath === undefined
    ? path.join(repoRoot, "workspace", "workflow")
    : path.dirname(projectDir);

  await rm(path.dirname(stagingDir), { recursive: true, force: true });
  await mkdir(path.join(stagingDir, "workspace", "workflow"), { recursive: true });
  await mkdir(path.dirname(archivePath), { recursive: true });
  // Uploading a UUID-bound workflow must stage any sibling workflow
  // source imports so the downloaded project can resolve workspace-local modules.
  await stageProjectWithLocalDependencies({
    workspaceRoot,
    projectDir,
    projectName,
    stagingRoot: path.join(stagingDir, "workspace", "workflow"),
    projectGroupSafe: options.projectGroupSafe === true,
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

async function readProjectGroupContexts(options: {
  projectArg: string;
  sourcePath?: string;
  dependencyOptions: readonly string[];
}): Promise<{
  root: PackageContext;
  dependencies: ProjectGroupDependencyContext[];
  locks: ProjectDependencyLock[];
}> {
  const root = await readProjectPackageContext(options.projectArg, options.sourcePath);
  if (root.projectType !== "kanban") {
    throw new Error(i18n.t("projectGroupRootMustBeKanban", { ns: "cli" }));
  }
  if (!root.projectId) {
    throw new Error(i18n.t("projectGroupRootIdRequired", { ns: "cli" }));
  }

  const rootProjectInfo = readProjectInfo(root.packageJson);
  const relatedProjects = rootProjectInfo.relatedProjects;
  const dependencyPaths = new Map<string, string>();
  for (const option of options.dependencyOptions) {
    const separator = option.indexOf("=");
    const alias = separator < 1 ? "" : option.slice(0, separator).trim();
    const dependencyPath = separator < 0 ? "" : option.slice(separator + 1).trim();
    if (alias === "" || dependencyPath === "") {
      throw new Error(i18n.t("invalidDependencyOption", {
        ns: "cli",
        option: JSON.stringify(option),
      }));
    }
    if (dependencyPaths.has(alias)) {
      throw new Error(i18n.t("duplicateDependencySource", {
        ns: "cli",
        alias: JSON.stringify(alias),
      }));
    }
    dependencyPaths.set(alias, path.resolve(dependencyPath));
  }

  const locks = createProjectDependencyLocks(
    relatedProjects,
    [...dependencyPaths.keys()].map((alias) => ({ alias, delivery: "included" as const })),
  );
  const dependenciesByProject = new Map<string, ProjectGroupDependencyContext>();
  for (const [alias, dependencyPath] of dependencyPaths) {
    const relation = relatedProjects.find((candidate) => candidate.alias === alias)!;
    const context = await readProjectPackageContext(alias, dependencyPath);
    if (context.projectId !== relation.projectId) {
      throw new Error(i18n.t("dependencyPackageIdMismatch", {
        ns: "cli",
        alias: JSON.stringify(alias),
        projectId: JSON.stringify(relation.projectId),
      }));
    }
    assertConfirmedRelatedProject({
      rootProjectId: root.projectId,
      rootProjectInfo,
      targetProjectId: context.projectId,
      targetPackageJson: context.packageJson,
      alias,
    });
    const existing = dependenciesByProject.get(relation.projectId);
    if (existing !== undefined && existing.packageContext.projectDir !== context.projectDir) {
      throw new Error(i18n.t("dependencyProjectPathConflict", {
        ns: "cli",
        projectId: JSON.stringify(relation.projectId),
      }));
    }
    dependenciesByProject.set(relation.projectId, { alias, packageContext: context });
  }

  return { root, dependencies: [...dependenciesByProject.values()], locks };
}

async function packProjectGroup(options: {
  projectArg: string;
  sourcePath?: string;
  outputPath?: string;
  dependencyOptions: readonly string[];
  contexts?: Awaited<ReturnType<typeof readProjectGroupContexts>>;
}): Promise<ProjectGroupPackResult> {
  const contexts = options.contexts ?? await readProjectGroupContexts(options);
  const repoRoot = resolveRepoRoot();
  const packsDir = process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR
    ? path.resolve(process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR)
    : path.join(repoRoot, "workspace", ".packs");
  const groupRoot = path.join(packsDir, "tmp", `project-group-${randomUUID()}`);
  const projectsDir = path.join(groupRoot, "projects");
  const archivePath = options.outputPath
    ? path.resolve(options.outputPath)
    : path.join(packsDir, `project-group-${createTimestamp()}.tgz`);
  await mkdir(projectsDir, { recursive: true });
  await mkdir(path.dirname(archivePath), { recursive: true });

  const rootArchivePath = `projects/${contexts.root.projectId}.tgz`;
  const projects: ProjectGroupManifestV1["projects"] = [{
    projectId: contexts.root.projectId!,
    role: "root",
    archivePath: rootArchivePath,
    version: readProjectPackageVersion(contexts.root.packageJson),
  }];

  try {
    await packProject(
      contexts.root.projectArg,
      path.join(groupRoot, ...rootArchivePath.split("/")),
      contexts.root.projectDir,
      { projectGroupSafe: true },
    );
    for (const dependency of contexts.dependencies) {
      const dependencyArchivePath = `projects/${dependency.packageContext.projectId}.tgz`;
      projects.push({
        projectId: dependency.packageContext.projectId!,
        role: "dependency",
        archivePath: dependencyArchivePath,
        alias: dependency.alias,
        version: readProjectPackageVersion(dependency.packageContext.packageJson),
      });
      await packProject(
        dependency.packageContext.projectArg,
        path.join(groupRoot, ...dependencyArchivePath.split("/")),
        dependency.packageContext.projectDir,
        { projectGroupSafe: true },
      );
    }

    const manifest: ProjectGroupManifestV1 = {
      version: 1,
      rootProjectId: contexts.root.projectId!,
      projects,
      dependencies: contexts.locks,
    };
    await writeFile(path.join(groupRoot, "project-group.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await runCommand("tar", ["-czf", archivePath, "-C", groupRoot, "."], { cwd: repoRoot });
    if (result.exitCode !== 0) {
      throw new Error(i18n.t("projectGroupArchiveCreateFailed", {
        ns: "cli",
        details: result.stderr || result.stdout,
      }));
    }
    return {
      archivePath,
      manifest,
      root: contexts.root,
      dependencies: contexts.dependencies.map((dependency) => dependency.packageContext),
    };
  } finally {
    await rm(groupRoot, { recursive: true, force: true });
  }
}

async function uploadProjectGroupPackage(options: {
  deploymentId: string;
  archivePath: string;
  server: string;
  token: string;
}): Promise<ApiResponse<DeploymentResult>> {
  const archiveBuffer = await readFile(options.archivePath);
  const archiveName = path.basename(options.archivePath);
  const query = new URLSearchParams({ fileName: archiveName });
  const response = await fetch(
    `${trimTrailingSlash(options.server)}/api/deployments/${encodeURIComponent(options.deploymentId)}/package?${query.toString()}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/octet-stream",
        "x-steamharness-package-name": archiveName,
      },
      body: new Blob([archiveBuffer]),
    },
  );
  return response.json() as Promise<ApiResponse<DeploymentResult>>;
}

async function waitForProjectGroupPreparation(options: {
  deploymentId: string;
  server: string;
  token: string;
  pollIntervalMs?: number;
}): Promise<ApiResponse<DeploymentResult>> {
  let previousProgress = "";
  while (true) {
    const response = await fetchApi<DeploymentResult>({
      server: options.server,
      token: options.token,
      path: `/api/deployments/${encodeURIComponent(options.deploymentId)}`,
    });
    if (response.errCode !== 0 || response.data === undefined) return response;

    const activeItem = response.data.items?.find((item) => item.status === "preparing");
    const progress = `${response.data.status}:${activeItem?.stage ?? response.data.status}`;
    if (response.data.status === "preparing" && progress !== previousProgress) {
      previousProgress = progress;
      process.stderr.write(`${i18n.t("preparationProgress", {
        ns: "cli",
        status: response.data.status,
        stage: activeItem?.stage ?? response.data.status,
      })}\n`);
    }

    if (response.data.status === "prepared" || response.data.status === "published") {
      return response;
    }
    if (response.data.status === "failed") {
      return {
        errCode: 500,
        errMessage: response.data.error ??
          response.data.items?.find((item) => item.error)?.error ??
          "Project-group preparation failed.",
        data: response.data,
      };
    }
    await delay(options.pollIntervalMs ?? 1_000);
  }
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
  const projectType = readStaticProjectType(packageJson);

  return {
    projectArg,
    projectDir,
    packageJsonPath,
    projectId,
    projectName,
    projectType,
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
  if (projectInfo.dataStorage === null) {
    throw new Error(i18n.t("projectInfoDataStorageRequired", { ns: "cli" }));
  }
  const projectId = options.packageContext.projectId;
  if (projectId !== undefined) {
    const existing = await fetchApi<{ id: string; name: string; projectType: ProjectKind; visibility: ProjectCreateResult['visibility'] }>({
      server: options.server, token: options.token, path: `/api/projects/${encodeURIComponent(projectId)}`, method: 'GET',
    });
    if (existing.errCode === 0 && existing.data) {
      if (typeof existing.data.id !== 'string' || existing.data.id.toLowerCase() !== projectId.toLowerCase() || existing.data.projectType !== options.packageContext.projectType) { throw new Error(i18n.t('projectCreationIdMismatch', { ns: 'cli' })); }
      return { projectId, projectName: existing.data.name, projectType: existing.data.projectType, visibility: existing.data.visibility };
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
      projectType: options.packageContext.projectType,
      projectInfo,
      ...(options.groupId?{groupId:options.groupId}:{}),
    },
  });
  if (created.errCode !== 0 || created.data === undefined) {
    printApiResponse(created);
    assertApiOk(created);
    throw new Error(i18n.t("projectCreationFailed", { ns: "cli" }));
  }

  if (!isProjectUuid(created.data.projectId) || created.data.projectId.toLowerCase() === projectId?.toLowerCase() || created.data.projectType !== options.packageContext.projectType) {
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

function readStaticProjectType(packageJson: Record<string, unknown>): ProjectKind {
  const config = packageJson["steamHarness"];
  const value = config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)["projectType"] : undefined;
  if (!isProjectKind(value)) {
    throw new Error(i18n.t("packageProjectTypeRequired", { ns: "cli" }));
  }
  return value;
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
    const configurations=await fetchApi<ProjectConfigurationState>({server:options.server,token:options.token,path:options.path.replace(/\/publish$/,'/configurations?target=draft')});
    assertApiOk(configurations);
    const publicationRevision=configurations.data?.publicationRevision??configurations.data?.publication?.revision;
    if(publicationRevision) options={...options,body:{...options.body,expectedSourceHash:configurations.data?.sourceHash,...options.body,expectedConfigurationRevision:publicationRevision}};
  }
  const response = await fetch(`${trimTrailingSlash(options.server)}${options.path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  return response.json() as Promise<ApiResponse<T>>;
}

async function copyProjectSource(
  sourceDir: string,
  targetDir: string,
  options: { projectGroupSafe?: boolean } = {},
): Promise<UploadPlan> {
  if (options.projectGroupSafe !== true) return copyProjectUploadFiles(sourceDir, targetDir);

  const plan = await createProjectUploadPlan(sourceDir);
  const files = plan.files.filter((file) => !isProjectGroupHostDataPath(file.path));
  const forbiddenRequiredPath = plan.requiredPaths.find((requiredPath) => isProjectGroupHostDataPath(requiredPath));
  if (forbiddenRequiredPath !== undefined) {
    throw new Error(i18n.t("projectGroupRequiredPathForbidden", {
      ns: "cli",
      path: JSON.stringify(forbiddenRequiredPath),
    }));
  }
  await mkdir(targetDir, { recursive: true });
  for (const file of files) {
    const targetPath = path.join(targetDir, ...file.path.split("/"));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(file.absolutePath, targetPath);
  }
  return {
    ...plan,
    files,
    ignoredPaths: [...plan.ignoredPaths, ...plan.files
      .filter((file) => isProjectGroupHostDataPath(file.path))
      .map((file) => file.path)]
      .sort((left, right) => left.localeCompare(right)),
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  };
}

async function stageProjectWithLocalDependencies(options: {
  workspaceRoot: string;
  projectDir: string;
  projectName: string;
  stagingRoot: string;
  projectGroupSafe?: boolean;
}): Promise<void> {
  const queue = [options.projectName];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentProjectName = queue.shift();
    if (!currentProjectName || visited.has(currentProjectName)) {
      continue;
    }
    visited.add(currentProjectName);

    const sourceDir = currentProjectName === options.projectName
      ? options.projectDir
      : path.join(options.workspaceRoot, currentProjectName);
    if (!existsSync(path.join(sourceDir, "package.json"))) {
      throw new Error(i18n.t("localDependencyMissingPackage", {
        ns: "cli",
        project: options.projectName,
        dependency: currentProjectName,
        path: sourceDir,
      }));
    }

    const uploadPlan = await copyProjectSource(
      sourceDir,
      path.join(options.stagingRoot, currentProjectName),
      { projectGroupSafe: options.projectGroupSafe },
    );
    if (currentProjectName === options.projectName && !uploadPlan.projectIgnoreConfigured) {
      process.stderr.write(`${i18n.t("projectIgnoreWarning", {
        ns: "cli",
        files: uploadPlan.files.length,
        bytes: uploadPlan.totalBytes,
      })}\n`);
    }

    for (const dependency of await findLocalProjectDependencies(sourceDir)) {
      if (!visited.has(dependency)) {
        queue.push(dependency);
      }
    }
  }
}

async function findLocalProjectDependencies(sourceDir: string): Promise<string[]> {
  const discovered = new Set<string>();

  for (const fileName of ["index.ts", "interface.ts", "globals.d.ts"]) {
    const filePath = path.join(sourceDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    const source = await readFile(filePath, "utf8");
    for (const match of source.matchAll(/(?:from\s+|reference path=)\"(\.\.\/([^/\"']+)(?:\/[^\"']*)?)\"/g)) {
      const projectName = match[2]?.trim();
      if (projectName) {
        discovered.add(projectName);
      }
    }
    for (const match of source.matchAll(/(?:from\s+|reference path=)'(\.\.\/([^/'"]+)(?:\/[^'"]*)?)'/g)) {
      const projectName = match[2]?.trim();
      if (projectName) {
        discovered.add(projectName);
      }
    }
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
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
    dependencies: [],
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
      case "--dependency":
        options.dependencies.push(requireValue(rest, (index += 1), "--dependency"));
        break;
      case "--grant-data-access":
        throw new Error(i18n.t("unknownWorkspaceOption", { ns: "cli", option: arg }));
      case "--project-group":
        options.projectGroup = true;
        break;
      case "--publish-group":
        options.publishGroup = true;
        break;
      case "--deployment":
        options.deployment = requireValue(rest, (index += 1), "--deployment");
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
  if (command === "upload" && options.noWait === true && shouldUseProjectGroupUpload(options)) {
    throw new Error(i18n.t("noWaitProjectGroupUnsupported", { ns: "cli" }));
  }
  if (options.dependencies.length > 0 && command !== "pack" && command !== "upload" && command !== "publish") {
    throw new Error(i18n.t("dependencyOptionCommandUnsupported", { ns: "cli" }));
  }
  if (options.deployment !== undefined && command !== "publish") {
    throw new Error(i18n.t("deploymentCommandUnsupported", { ns: "cli" }));
  }
  if (options.publishGroup === true && command !== "upload") {
    throw new Error(i18n.t("publishGroupCommandUnsupported", { ns: "cli" }));
  }
  if (options.projectGroup === true && command !== "pack" && command !== "upload" && command !== "publish") {
    throw new Error(i18n.t("projectGroupCommandUnsupported", { ns: "cli" }));
  }
  if (
    options.deployment !== undefined &&
    (
      options.projectGroup === true ||
      options.dependencies.length > 0 ||
      options.path !== undefined ||
      options.file !== undefined ||
      options.output !== undefined ||
      options.create === true ||
      options.releaseLog !== undefined
    )
  ) {
    throw new Error(i18n.t("deploymentOptionsConflict", { ns: "cli" }));
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
  projectType?: ProjectKind;
}

interface PackageContext {
  projectArg: string;
  projectDir: string;
  packageJsonPath: string;
  projectId?: string;
  projectName: string;
  projectType: ProjectKind;
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
  findLocalProjectDependencies,
  decodeProjectFileContent,
  packProject,
  getPreparation,
  readPackageJsonFile,
  readProjectPackageContext,
  materializeProjectGroupDownload,
  packProjectGroup,
  readProjectGroupContexts,
  resolveRemoteProjectId,
  stageProjectWithLocalDependencies,
  shouldUseProjectGroupUpload,
  waitForProjectGroupPreparation,
  waitForPreparation,
};
