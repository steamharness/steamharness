import type { ProjectAccessRequest, ProjectAccessRequestStatus } from "@steamharness/project-access";
import { readProjectManifest, selectProjectEntry, projectManifestForDistribution, type ProjectEntry } from '@steamharness/project-manifest';
import { DatabaseSpaceRepository } from './database-spaces';
import { type AccessActor, type AccessCapability, type ResourceAccess } from "@steamharness/project-access";
import {isDeepStrictEqual} from "node:util";
import { bindConfigurationProfiles, configurationAccessView, type ConfigurationProfilePolicy, type ConfigurationAccess, bindConfigurationTemplate, configurationAgentModelPolicy, createPublicationDraft, parsePublicationDraft, freezeConfigurationTemplate, parseConfigurationTemplate, configurationTemplatePath, CONFIGURATION_TEMPLATE_FILE, type ConfigurationPublicationDraft, type ProjectConfigurationTemplate, configurationCapability, parseConfigurationFile, validateConfigurationFileSelection, type ProjectConfigurationField,parseConfigurationField, applyConfigurationAction, configurationSnapshot, exportConfigurations, parseConfigurationDefinition, readConfigurationState, validateConfigurationAction, ProjectConfigurationError, type ProjectConfigurationAction, type ProjectConfigurationState, type ProjectConfigurationExport, type ProjectConfiguration } from "@steamharness/project-configuration";
import { createLocalProjectConfigurationStore, readProjectConfigurationDefinition } from "steamharness";

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { create as createTar, extract as extractTar, list as listTar, type ReadEntry } from "tar";
import { Open as openZip } from "unzipper";
import { copyProjectUploadFiles } from "@steamharness/project-upload/node";
import { createProjectUploadPortablePathKey } from "@steamharness/project-upload";
import { createKnowledgeDocument, createProjectKVContext, createProjectPersistentValueContext, deleteKnowledgeDocument, editKnowledgeDocument, getKnowledgeDocument, isProjectKind, listKnowledgeDocumentPage, searchKnowledgeDocuments, readKnowledgeDocumentLines, HarnessError, type KVScope, type KVStore, type KVStoreGetInput, type KVWriteSource, type StorageKind, type ProjectKind, type KnowledgeContext, type KnowledgeDocument, type KnowledgeDocumentSummaryRecord, type KnowledgeSearchResultRecord, type KnowledgeDocumentLinesResult, type TokenUsageAggregate, type TokenUsageEntry, describeKnowledgeMutationKeys, isKnowledgeDocumentStorageKey } from "steamharness";
import { getAuthCookieSecret } from "./account-auth";
import { resolveServerPathRoots } from "./paths";
import { ArtifactStorage, createObjectPath, DatabaseRepository, type ProjectMemberRecord, type ProjectInvitationRecord, type ProjectRole, type Visibility, type DbRecord, type DbVersionRecord, type ProjectStorageRevisionEvent } from "./persistence";
import { HttpError, toHttpErrorWithStatus } from "./protocol";
import { createProjectLocalStorageFromEnv } from "./local-storage";
import { isProjectStorageNotFoundError, type ObjectStorage } from "./object-storage";
import { resolveProjectStorageDriver } from "./storage-driver";
import { resolveServerDataRootFromEnv } from "./release-paths";
import { createInvalidProjectUuidMessage, createUnsafeProjectIdMessage, isSafeProjectId, isProjectUuid, resolveProjectRoot } from "./workflow-ids";
import { generateProjectCardMetadata, readProjectCardMetadataFromPackageJson, type ProjectCardMetadata } from "@steamharness/project-card-metadata";
import { normalizeDeclaredProjectInfoInput, normalizeProjectInfo, readProjectInfo, writeProjectInfo, type DeclaredProjectInfo, type ProjectInfoContract } from "@steamharness/project-info";
import { createKanbanContentSecurityPolicy, createKanbanArtifactEntryPath, injectKanbanBridge, isSafeKanbanPublicAssetPath,  readKanbanAssetMimeType,  type KanbanArtifactConfig } from "@steamharness/kanban-project";
import { readRequiredCoreVersion } from "@steamharness/runtime-compatibility";
import { readServerBuildInfo, type ServerBuildInfo } from "./build-info";
export const PROJECT_CARD_IMAGE_MAX_BYTES = 1024 * 1024;
const PROJECT_CARD_IMAGE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_KANBAN_ASSET_SIZE_BYTES = 20 * 1024 * 1024;
const KANBAN_PREVIEW_CAPABILITY_TTL_MS = 15 * 60 * 1000;

export interface File {
  path: string;
  content: string;
  size: number;
  encoding?: "base64";
}

type FileInput = Pick<File, "path" | "content" | "encoding">;

export type ManagedFileStorage = "server";
export type ManagedFileKind = "image" | "file";

export interface ManagedFileReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ManagedFileKind;
  storage: ManagedFileStorage;
  projectId?: string;
  entryId?: string;
  conversationId?: string;
  createdAt: string;
}

export interface ProjectCardImage {
  projectId: string;
  url: string;
  mimeType: "image/webp";
  size: number;
  hash: string;
}
export type PreparationStatus = "queued" | "preparing" | "success" | "failed";
export type PreparationStage =
  | "queued"
  | "extracting"
  | "validating"
  | "committing";

export interface PreparationJob {
  jobId: string;
  projectId: string;
  archiveName: string;
  createOnly: boolean;
  status: PreparationStatus;
  stage: PreparationStage;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  failureReason?: string;
  result?: UploadPackageResult;
}

export interface Summary {
  id: string;
  name: string;
  entries: ProjectEntry[];
  defaultEntry: string;
  projectCard: ProjectCardMetadata;
  projectInfo: ProjectInfoContract;
  ownerUserId?: string;
  visibility: Visibility;
  createdByUserId?: string;
  createdAt?: string;
  updatedAt?: string;
  hasDraft: boolean;
  latest: string | null;
  versions: string[];
  nextVersion: string;
  sourceDownload?: SourceDownloadAvailability;
  groupId?: string | null;
  access?: ResourceAccess;
}

export interface SourceDownloadAvailability {
  allowed: boolean;
  available: boolean;
  target: string | null;
}

export interface SourceShare {
  id: string;
  name: string;
  version: string;
  createdAt: string;
  releaseLog?: string;
  sourceHash: string;
}

export interface VersionSummary {
  id: string;
  name: string;
  latest: string | null;
  nextVersion: string;
  totalDownloadCount: number;
  versions: Array<{
    version: string;
    downloadCount: number;
    createdAt?: string;
    createdByUserId?: string;
    createdByProfile?: UserProfileSummary;
    releaseLog?: string;
    sourceHash?: string;
    sourceObjectPath?: string;
      latest: boolean;
  }>;
}

export type KVEntryScope = "project" | "conversation";
export type KVEntryValueType =
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean";

export interface KVEntrySummary {
  storageKind: StorageKind;
  scope: KVEntryScope;
  key: string;
  // KV list responses intentionally omit full values so the web
  // inspector does not freeze on large conversation state rows.
  value?: unknown;
  valueType: KVEntryValueType;
  valueSizeBytes: number;
  valuePreview: string;
  projectId: string;
  conversationId?: string;
  updatedAt: string;
  lastProjectId?: string;
  lastRunId?: string;
  lastConversationId?: string;
}

export interface KVEntryDetail extends KVEntrySummary {
  value: unknown;
}

export interface KVEntryPage {
  items: KVEntrySummary[];
  nextCursor?: string;
  hasMore: boolean;
  // server/web KV pagination and Keys metrics use the full filtered total.
  total: number;
}

export interface ProjectDataSummary {
  kv: {
    entryCount: number;
    projectEntryCount: number;
    conversationEntryCount: number;
    valueSizeBytes: number;
    textCharacterCount: number;
    updatedAt: string | null;
  };
  knowledge: {
    documentCount: number;
    characterCount: number;
    lineCount: number;
    markdownSizeBytes: number;
    updatedAt: string | null;
  };
}

export interface PersistentValueGetResult {
  exists: boolean;
  value?: unknown;
  revision?: string;
}

export interface PersistentValueCompareAndSetResult {
  applied: boolean;
  revision?: string;
}

export type PersistentValueKnowledgeMutation =
  | {
      type: "create";
      input: { id?: string; title: string; markdown: string };
    }
  | {
      type: "edit";
      input: { documentId: string; title?: string; markdown?: string };
    }
  | {
      type: "delete";
      input: { documentId: string };
    };

export type KnowledgeDocumentRecord = KnowledgeDocument;
export type KnowledgeDocumentListItem = KnowledgeDocumentSummaryRecord;
export type KnowledgeDocumentSearchResult = KnowledgeSearchResultRecord;
export type KnowledgeDocumentLinesRecord = KnowledgeDocumentLinesResult;

export interface KnowledgeDocumentPageRecord {
  items: KnowledgeDocumentListItem[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface TokenUsageProjectSummary {
  projectId: string;
  total: TokenUsageAggregate;
  updatedAt?: string;
}

export interface TokenUsagePage {
  systemTotal: TokenUsageAggregate;
  projects: TokenUsageProjectSummary[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface TokenUsageDetail {
  projectId: string;
  projectTotal: TokenUsageAggregate;
  conversationId?: string;
  conversationTotal?: TokenUsageAggregate;
  entries?: TokenUsageEntry[];
}

export interface UploadPackageResult {
  projectId: string;
  projectName: string;
  archiveName: string;
  sourceHash: string;
  nextVersion: string;
}

export interface SaveDraftFilesResult {
  projectId: string;
  projectName: string;
  updatedFiles: string[];
  removedFiles: string[];
  nextVersion: string;
}

export interface PublishResult {
  projectId: string;
  projectName: string;
  version: string;
  latest: string;
  nextVersion: string;
  releaseLog: string;
}

export interface CloneProjectResult {
  projectId: string;
  projectName: string;
  sourceTarget: string;
  resolvedSourceTarget: string;
  nextVersion: string;
}

export interface UpdateProjectInfoResult {
  projectId: string;
  projectName: string;
  target: string;
  resolvedTarget: string;
}

export interface DeleteProjectResult {
  projectId: string;
}

export interface Manifest {
  projectId: string;
  projectName: string;
  version: string;
  createdAt: string;
  createdByUserId?: string;
  releaseLog?: string;
  sourceHash: string;
  sourceObjectPath?: string;
  entries: ProjectEntry[];
  defaultEntry: string;
}

export interface PackageMetadata {
  id: string;
  name: string;
  version: string;
  entries: ProjectEntry[];
  defaultEntry: string;
  projectCard: ProjectCardMetadata;
  projectInfo: ProjectInfoContract;
  requiredCoreVersion: string;
}

interface StoredProjectInfoMetadata {
  name: string;
  projectInfo: ProjectInfoContract;
}

export interface UserProfileSummary {
  userId: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

export type {
  ProjectRole,
  Visibility,
};

export interface ProjectMember extends ProjectMemberRecord {
  profile?: UserProfileSummary;
  createdByProfile?: UserProfileSummary;
}

export interface ProjectInvitation extends ProjectInvitationRecord {
  createdByProfile?: UserProfileSummary;
  acceptedByProfile?: UserProfileSummary;
}

export interface ProjectAccessSummary {
  projectId: string;
  projectName: string;
  ownerUserId?: string;
  visibility: Visibility;
  createdByUserId?: string;
  member?: ProjectMember;
  groupId?: string | null;
  access?: ResourceAccess;
}

export interface ProjectCreateResult {
  projectId: string;
  projectName: string;
  entries: ProjectEntry[];
  defaultEntry: string;
  projectInfo: DeclaredProjectInfo;
  visibility: Visibility;
}

export interface KanbanWorkspaceState {
  projectId: string;
  projectName: string;
  target: string;
  resolvedTarget: string;
  artifactDir: string;
  entry: string;
  entryId: string;
  databases: import("@steamharness/database-spaces").DatabaseRequirement[];
  configurations: ProjectConfiguration[];
  activeConfigurationId?: string;
}

export interface KanbanAsset {
  content: Buffer | string;
  contentType: string;
  contentLength: number;
  contentSecurityPolicy: string;
}

export interface KanbanPreviewCapability {
  token: string;
  resolvedTarget: string;
  expiresAt: string;
}

interface StoredKanbanPreviewCapability {
  version: 1;
  projectName: string;
  entryId: string;
  resolvedTarget: string;
  actorId: string;
  expiresAtMs: number;
}

const TEXT_FILE_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MANAGED_FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_COUNT = 100_000;
const MAX_ARCHIVE_EXPANDED_SIZE_BYTES = 512 * 1024 * 1024;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const MANAGED_FILE_ID_PATTERN = /^wf_[A-Za-z0-9_-]{20,80}$/;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".md",
  ".mts",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
export class Storage {
  readonly databases: DatabaseSpaceRepository;
  readonly serverRoot: string;
  readonly repoRoot: string;
  readonly dataRoot: string;
  private readonly db?: DatabaseRepository;
  private readonly artifacts?: ArtifactStorage;
  readonly objectStorage?: ObjectStorage;
  private readonly publishLocks = new Map<string, Promise<void>>();
  private readonly deploymentLocks = new Map<string, Promise<void>>();
  private readonly preparationLocks = new Map<string, Promise<void>>();
  private readonly activePreparationJobs = new Set<string>();
  // HTML and its subresources can resolve the same database-backed
  // source concurrently; share materialization instead of deleting one directory twice.
  private readonly sourceMaterializationTasks = new Map<string, Promise<void>>();
  private readonly materializedDraftSourceRevisions = new Map<string, string>();
  private readonly projectStorageRevisionListeners = new Set<(
    event: ProjectStorageRevisionEvent,
  ) => void>();
  private projectStorageRevisionSubscription?: Promise<() => Promise<void>>;
  private readonly kanbanPreviewCapabilitySecret: string;
  private buildInfo?: ServerBuildInfo;

  constructor(options: {
    serverRoot: string;
    repoRoot: string;
    dataRoot?: string;
    db?: DatabaseRepository;
    artifacts?: ArtifactStorage;
    objectStorage?: ObjectStorage;
    kanbanPreviewCapabilitySecret?: string;
    buildInfo?: ServerBuildInfo;
  }) {
    this.serverRoot = options.serverRoot;
    this.repoRoot = options.repoRoot;
    this.dataRoot = options.dataRoot ?? path.join(options.serverRoot, ".data");
    this.db = options.db;
    this.databases = new DatabaseSpaceRepository(options.db?.connectionString);
    this.artifacts = options.artifacts;
    this.objectStorage = options.objectStorage;
    this.kanbanPreviewCapabilitySecret = options.kanbanPreviewCapabilitySecret?.trim() ||
      getAuthCookieSecret() ||
      randomBytes(32).toString("base64url");
    this.buildInfo = options.buildInfo;
  }

  async init(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
    this.buildInfo ??= await readServerBuildInfo({ repoRoot: this.repoRoot, serverRoot: this.serverRoot,
      strict: process.env.NODE_ENV === "production" && process.env.STEAMHARNESS_SERVER_DEV !== "1" });
    await this.db?.init();
    await this.databases.init();
    await this.resumePendingPreparationJobs();
    if (this.artifacts) void this.artifacts.init().catch(() => {
      console.warn("[steamharness-server] artifact storage initialization failed; continuing with degraded artifact availability.");
    });
  }

  getBuildInfo(): ServerBuildInfo {
    return { ...this.requireBuildInfo() };
  }

  async createProject(options: {
    projectId: string;
    projectName: string;
    entries: ProjectEntry[];
  defaultEntry: string;
    projectInfo: DeclaredProjectInfo;
    ownerUserId?: string;
    visibility?: Visibility;
    createdByUserId?: string;
    projectCard?: ProjectCardMetadata;
    groupId?: string | null;
    isSystemAdmin?: boolean;
  }): Promise<ProjectCreateResult> {
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project creation API requires PostgreSQL storage.");
    }

    const projectName = options.projectName.trim();
    if (projectName === "") {
      throw new HttpError(400, 400, "projectName must not be empty.");
    }
    const projectId = options.projectId.trim();
    this.assertProjectId(projectId);
    const projectInfo = this.normalizeDeclaredProjectInfo(options.projectInfo);

    const existing = await this.db.getProject(projectId);
    if (existing) {
      await this.db.access.assert("project", projectId, {userId: options.ownerUserId,isSystemAdmin: options.isSystemAdmin === true}, "upload");
      if (options.groupId !== undefined && options.groupId !== existing.groupId) throw new HttpError(403,403,"Use the project transfer API to change its group.");
      return {projectId:existing.id,projectName:existing.name,entries:existing.entries,defaultEntry:existing.defaultEntry,projectInfo:this.normalizeDeclaredProjectInfo(existing.projectInfo),visibility:existing.visibility};
    }
    if (!options.ownerUserId) throw new HttpError(401,401,"Account login is required to create a project.");
    if (options.groupId) await this.db.access.assert("group",options.groupId,{userId:options.ownerUserId,isSystemAdmin:options.isSystemAdmin===true},"createProject");

    let created: DbRecord;
    try {
      created = await this.db.createProjectRecord({
        projectId,
        projectName,
        entries: options.entries, defaultEntry: options.defaultEntry,
        projectCard: options.projectCard ?? generateProjectCardMetadata(options.entries[0]!.type),
        projectInfo,
        packageVersion: "0.0.0",
        ownerUserId: options.ownerUserId,
        groupId: options.groupId,
        visibility: options.visibility ?? "private",
        createdByUserId: options.createdByUserId,
      },{userId:options.ownerUserId,isSystemAdmin:options.isSystemAdmin===true});
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        throw new HttpError(409, 409, `Workflow "${projectName}" already exists.`);
      }
      throw error;
    }


    return {
      projectId: created.id,
      projectName: created.name,
      entries: created.entries, defaultEntry: created.defaultEntry,
      projectInfo,
      visibility: created.visibility,
    };
  }

  async saveProjectCardImage(options: {
    projectName: string;
    buffer: Buffer;
    origin: string;
  }): Promise<ProjectCardImage> {
    this.assertProjectId(options.projectName);
    assertProjectCardImage(options.buffer);

    const hash = createHash("sha256").update(options.buffer).digest("hex");
    const imageDir = this.projectCardImageDir(options.projectName);
    const imagePath = this.projectCardImagePath(options.projectName, hash);
    const tempPath = path.join(imageDir, `.${hash}-${randomUUID()}.tmp`);

    await mkdir(imageDir, { recursive: true });
    if (!(await exists(imagePath))) {
      await writeFile(tempPath, options.buffer);
      await rename(tempPath, imagePath);
    }

    return {
      projectId: options.projectName,
      url: `${options.origin.replace(/\/+$/, "")}/project-card-images/${options.projectName}/${hash}.webp`,
      mimeType: "image/webp",
      size: options.buffer.byteLength,
      hash,
    };
  }

  async getProjectCardImage(projectName: string, hash: string): Promise<{
    filePath: string;
    size: number;
    hash: string;
  }> {
    this.assertProjectId(projectName);
    assertProjectCardImageHash(hash);
    const filePath = this.projectCardImagePath(projectName, hash);
    try {
      const metadata = await stat(filePath);
      if (!metadata.isFile()) {
        throw new Error("Project card image is not a file.");
      }
      return { filePath, size: metadata.size, hash };
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new HttpError(404, 404, "Project card image does not exist.");
      }
      throw error;
    }
  }

  async updateProjectCardMetadata(options: {
    projectName: string;
    projectCard: ProjectCardMetadata;
  }): Promise<ProjectCardMetadata> {
    this.assertProjectId(options.projectName);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project card updates require PostgreSQL storage.");
    }

    const updated = await this.db.updateProjectCard(
      options.projectName,
      options.projectCard,
    );
    if (updated === undefined) {
      throw new HttpError(404, 404, `Workflow "${options.projectName}" does not exist.`);
    }

    return updated.projectCard;
  }

  async updateProjectInfoMetadata(options: {
    projectName: string;
    name: string;
    projectInfo: DeclaredProjectInfo;
  }): Promise<{ name: string; projectInfo: DeclaredProjectInfo }> {
    this.assertProjectId(options.projectName);
    const name = options.name.trim();
    if (name === "") throw new HttpError(400, 400, "name must not be empty.");
    const projectInfo = this.normalizeDeclaredProjectInfo(options.projectInfo);
    if (this.db !== undefined) {
      const updated = await this.db.updateProjectInfo(
        options.projectName,
        name,
        projectInfo,
      );
      if (updated === undefined) {
        throw new HttpError(404, 404, `Workflow "${options.projectName}" does not exist.`);
      }
      await this.updateMaterializedDraftProjectInfo(options.projectName, name, projectInfo);
      return { name: updated.name, projectInfo };
    }

    if (
      !(await exists(this.draftSourceDir(options.projectName))) &&
      (await this.readLatest(options.projectName)) === null
    ) {
      throw new HttpError(404, 404, `Workflow "${options.projectName}" does not exist.`);
    }
    await this.updateMaterializedDraftProjectInfo(options.projectName, name, projectInfo);
    await writeJson(this.projectInfoMetadataPath(options.projectName), { name, projectInfo });
    return { name, projectInfo };
  }

  async assertServerProjectDataAccess(projectId: string): Promise<ProjectInfoContract> {
    return (await this.readPackageMetadata(projectId)).projectInfo;
  }

  async updateProjectVisibility(options: {
    projectId: string;
    visibility: Visibility;
  }): Promise<Summary> {
    this.assertProjectId(options.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project access management requires PostgreSQL storage.");
    }
    const updated = await this.db.updateProjectAccess({
      projectId: options.projectId,
      visibility: options.visibility,
    });
    if (updated === undefined) {
      throw new HttpError(404, 404, `Workflow "${options.projectId}" does not exist.`);
    }
    return this.summarizeDbProject(updated);
  }

  async getProjectAccessSummary(projectId: string, userId?: string): Promise<ProjectAccessSummary> {
    this.assertProjectId(projectId);
    const record = await this.readProjectRecordForAccess(projectId);
    return this.createProjectAccessSummary(record, userId);
  }

  get accessRepository() {return this.requireProjectDatabase().access;}
  async requireProjectCapability(projectId:string,actor:AccessActor,capability:AccessCapability):Promise<ResourceAccess> {return this.accessRepository.assert("project",projectId,actor,capability);}
  async getProjectSummary(projectId:string):Promise<Summary> {return this.summarizeDbProject(await this.readProjectRecordForAccess(projectId));}
  async listProjects(): Promise<Summary[]> {
    if (this.db) {
      const workflows = await this.db.listProjects();
      const versions = await this.db.listVersionsForProjects(workflows.map(item => item.id));
      return Promise.all(workflows.map(item => this.summarizeDbProject(item, versions.get(item.id))));
    }
    await mkdir(this.projectsRoot(), { recursive: true });
    const entries = await readdir(this.projectsRoot(), { withFileTypes: true });
    const summaries = await Promise.all(entries.filter(entry => entry.isDirectory() && isProjectUuid(entry.name)).map(async entry => {
      const record = await this.readProjectRecordForAccess(entry.name);
      return this.summarizeDbProject(record, await Promise.all((await this.listVersionNames(entry.name)).map(async version => ({ version }))));
    }));
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listVersions(projectId: string): Promise<VersionSummary> {
    this.assertProjectId(projectId);
    const metadata = await this.readProjectRecordForAccess(projectId);
    const versions = this.db ? await this.db.listVersions(projectId) : await Promise.all((await this.listVersionNames(projectId)).map(version => this.readManifest(projectId, version)));
    const downloadCounts = await this.readVersionDownloadCounts(projectId);
    const publishedVersions = versions.filter(isDefined).map(version => ({
      version: version.version,
      downloadCount: downloadCounts[version.version] ?? 0,
      createdAt: version.createdAt,
      createdByUserId: version.createdByUserId,
      releaseLog: version.releaseLog,
      sourceHash: version.sourceHash,

      latest: metadata.latest === version.version,
    }));
    return {
      id: projectId,
      name: metadata.name,
      latest: metadata.latest,
      nextVersion: await this.resolveNextVersion(projectId),
      totalDownloadCount: publishedVersions.reduce((total, version) => total + version.downloadCount, 0),
      versions: publishedVersions,
    };
  }

  async recordSourceDownloads(downloads: readonly { projectId: string; version: string }[]): Promise<void> {
    const versionsByProject = new Map<string, Set<string>>();
    for (const item of downloads) {
      this.assertProjectId(item.projectId);
      assertVersion(item.version);
      const versions = versionsByProject.get(item.projectId) ?? new Set<string>();
      versions.add(item.version);
      versionsByProject.set(item.projectId, versions);
    }
    if (this.db !== undefined) {
      await this.db.recordSourceDownloads(downloads);
      return;
    }
    for (const [projectId, versions] of versionsByProject) {
      await this.withLocalProjectPublishLock(projectId, async () => {
        const counts = await this.readVersionDownloadCounts(projectId);
        for (const version of versions) {
          await this.assertVersionExists(projectId, version);
          counts[version] = (counts[version] ?? 0) + 1;
        }
        const target = path.join(this.projectDirectory(projectId), "download-counts.json");
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await writeJson(temporary, counts);
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    }
  }

  private async readVersionDownloadCounts(projectId: string): Promise<Record<string, number>> {
    if (this.db !== undefined) {
      return Object.fromEntries(await this.db.listVersionDownloadCounts(projectId));
    }
    try {
      return JSON.parse(await readFile(path.join(this.projectDirectory(projectId), "download-counts.json"), "utf8")) as Record<string, number>;
    } catch (error) {
      if (isMissingFileError(error)) return {};
      throw error;
    }
  }

  async uploadPackage(options: {
    projectName: string;
    archiveName: string;
    archiveBuffer: Buffer;
    createOnly?: boolean;
    onStage?: (stage: PreparationStage) => Promise<void>;
  }): Promise<UploadPackageResult> {
    this.assertProjectId(options.projectName);
    assertArchiveName(options.archiveName);

    if (options.createOnly === true) {
      await this.assertProjectDoesNotExist(options.projectName);
    }

    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const archivePath = path.join(tempDir, options.archiveName);
    const extractDir = path.join(tempDir, "extract");
    const stagedDraftDir = path.join(tempDir, "draft");
    const stagedSourceDir = path.join(stagedDraftDir, "source");

    await mkdir(extractDir, { recursive: true });
    await writeFile(archivePath, options.archiveBuffer);

    try {
      await options.onStage?.("extracting");
      await this.extractArchive(archivePath, options.archiveName, extractDir);
      const packageRoot = await resolvePackageRoot(extractDir, options.projectName);
      const metadata = await validateProjectPackage(
        packageRoot,
        options.projectName,
      );

      await copyUploadedProjectSource(packageRoot, stagedSourceDir);
      await options.onStage?.("validating");
      await validateProjectPackage(
        stagedSourceDir,
        options.projectName,
      );

      await options.onStage?.("committing");
      const sourceHash = await this.commitStagedDraft(options.projectName, stagedDraftDir);

      return {
        projectId: metadata.id,
        projectName: metadata.name,
        archiveName: options.archiveName,
        sourceHash,
        nextVersion: await this.resolveNextVersion(options.projectName),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async enqueuePackagePreparation(options: {
    projectName: string;
    archiveName: string;
    archiveBuffer: Buffer;
    createOnly?: boolean;
  }): Promise<PreparationJob> {
    this.assertProjectId(options.projectName);
    assertArchiveName(options.archiveName);
    return this.withLocalPreparationLock(options.projectName, async () => {
      return this.enqueuePackagePreparationLocked(options);
    });
  }

  private async enqueuePackagePreparationLocked(options: {
    projectName: string;
    archiveName: string;
    archiveBuffer: Buffer;
    createOnly?: boolean;
  }): Promise<PreparationJob> {
    if (options.createOnly === true) {
      await this.assertProjectDoesNotExist(options.projectName);
    }

    const latest = await this.getLatestPreparationJob(options.projectName);
    if (latest?.status === "queued" || latest?.status === "preparing") {
      throw new HttpError(409, 409, `Workflow "${options.projectName}" already has an active preparation job.`, {
        jobId: latest.jobId,
        status: latest.status,
        stage: latest.stage,
      });
    }

    const createdAt = new Date().toISOString();
    const job: PreparationJob = {
      jobId: randomUUID(),
      projectId: options.projectName,
      archiveName: options.archiveName,
      createOnly: options.createOnly === true,
      status: "queued",
      stage: "queued",
      createdAt,
    };
    await mkdir(this.preparationJobDir(job.projectId, job.jobId), { recursive: true });
    await writeFile(this.preparationArchivePath(job), options.archiveBuffer);
    await this.writePreparationJob(job);
    this.schedulePreparationJob(job.jobId, job.projectId, options.createOnly === true);
    return job;
  }

  private async withLocalPreparationLock<T>(projectName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.preparationLocks.get(projectName) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const next = previous.catch(() => undefined).then(() => current);
    this.preparationLocks.set(projectName, next);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.preparationLocks.get(projectName) === next) {
        this.preparationLocks.delete(projectName);
      }
    }
  }

  async getPreparationJob(projectName: string, jobId: string): Promise<PreparationJob> {
    this.assertProjectId(projectName);
    if (!isProjectUuid(jobId)) {
      throw new HttpError(400, 400, createInvalidProjectUuidMessage(jobId, "preparation job id"));
    }
    const job = await readJson<PreparationJob>(this.preparationJobPath(projectName, jobId));
    if (job === undefined || job.projectId !== projectName || job.jobId !== jobId) {
      throw new HttpError(404, 404, `Preparation job "${jobId}" does not exist for project "${projectName}".`);
    }
    return job;
  }

  async getLatestPreparationJob(projectName: string): Promise<PreparationJob | undefined> {
    this.assertProjectId(projectName);
    const root = this.preparationProjectRoot(projectName);
    if (!(await exists(root))) return undefined;
    const entries = await readdir(root, { withFileTypes: true });
    const jobs = (await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJson<PreparationJob>(this.preparationJobPath(projectName, entry.name)))))
      .filter(isDefined);
    return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  private schedulePreparationJob(jobId: string, projectId: string, createOnly: boolean): void {
    if (this.activePreparationJobs.has(jobId)) return;
    this.activePreparationJobs.add(jobId);
    setImmediate(() => {
      void this.runPreparationJob(projectId, jobId, createOnly).finally(() => {
        this.activePreparationJobs.delete(jobId);
      });
    });
  }

  private async runPreparationJob(projectId: string, jobId: string, createOnly: boolean): Promise<void> {
    let job = await this.getPreparationJob(projectId, jobId);
    const updateStage = async (stage: PreparationStage): Promise<void> => {
      job = {
        ...job,
        status: "preparing",
        stage,
        startedAt: job.startedAt ?? new Date().toISOString(),
        endedAt: undefined,
        failureReason: undefined,
      };
      await this.writePreparationJob(job);
    };

    try {
      const archiveBuffer = await readFile(this.preparationArchivePath(job));
      const result = await this.uploadPackage({
        projectName: projectId,
        archiveName: job.archiveName,
        archiveBuffer,
        createOnly,
        onStage: updateStage,
      });
      job = {
        ...job,
        status: "success",
        stage: "committing",
        endedAt: new Date().toISOString(),
        result,
      };
      await this.writePreparationJob(job);
    } catch (error) {
      job = {
        ...job,
        status: "failed",
        endedAt: new Date().toISOString(),
        failureReason: readErrorMessage(error),
      };
      await this.writePreparationJob(job);
    } finally {
      await rm(this.preparationArchivePath(job), { force: true });
    }
  }

  private async resumePendingPreparationJobs(): Promise<void> {
    const root = this.preparationsRoot();
    if (!(await exists(root))) return;
    const projectEntries = await readdir(root, { withFileTypes: true });
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || !isProjectUuid(projectEntry.name)) continue;
      const latest = await this.getLatestPreparationJob(projectEntry.name);
      if (latest?.status === "queued" || latest?.status === "preparing") {
        if (await exists(this.preparationArchivePath(latest))) {
          this.schedulePreparationJob(latest.jobId, latest.projectId, latest.createOnly);
        } else {
          await this.writePreparationJob({
            ...latest,
            status: "failed",
            endedAt: new Date().toISOString(),
            failureReason: "Preparation archive is missing after server restart.",
          });
        }
      }
    }
  }

  private async writePreparationJob(job: PreparationJob): Promise<void> {
    const target = this.preparationJobPath(job.projectId, job.jobId);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeJson(temp, job);
    await rename(temp, target);
  }

  async createProjectFromFiles(options: {
    projectName: string;
    files: FileInput[];
  }): Promise<UploadPackageResult> {
    this.assertProjectId(options.projectName);

    if (this.db) {
      const record = await this.db.getProject(options.projectName);
      if (!record || record.hasDraft || record.latest) throw new HttpError(409,409,"Create an empty project before initializing its source.");
    } else await this.assertProjectDoesNotExist(options.projectName);

    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const stagedDraftDir = path.join(tempDir, "draft");
    const rawSourceDir = path.join(tempDir, "raw-source");
    const stagedSourceDir = path.join(stagedDraftDir, "source");

    try {
      await mkdir(rawSourceDir, { recursive: true });

      for (const file of options.files) {
        const safePath = normalizeProjectFilePath(file.path);
        const targetPath = path.join(rawSourceDir, safePath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, decodeProjectFileContent(file));
      }

      await copyUploadedProjectSource(rawSourceDir, stagedSourceDir);
      const metadata = await validateProjectPackage(
        stagedSourceDir,
        options.projectName,
      );
      await this.commitStagedDraft(options.projectName, stagedDraftDir);

      return {
        projectId: metadata.id,
        projectName: metadata.name,
        archiveName: "",
        sourceHash: await hashDirectory(this.draftSourceDir(options.projectName)),
        nextVersion: await this.resolveNextVersion(options.projectName),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async getFiles(options: {
    projectName: string;
    target: string;
    includeBinary?: boolean;
  }): Promise<{
    projectId: string;
    projectName: string;
    target: string;
    resolvedTarget: string;
    files: File[];
    sourceHash: string;
    entries: ProjectEntry[];
    defaultEntry: string;
  }> {
    this.assertProjectId(options.projectName);
    const resolved = await this.resolveSourceTarget(
      options.projectName,
      options.target,
    );
    const metadata = await this.readProjectMetadataForEditing(options.projectName);

    return {
      projectId: options.projectName,
      projectName: metadata.name,
      target: options.target,
      resolvedTarget: resolved.resolvedTarget,
      sourceHash: await hashDirectory(resolved.sourceDir),
      entries: (await this.readPackageMetadataForTarget(options.projectName,resolved.resolvedTarget)).entries,
      defaultEntry: (await this.readPackageMetadataForTarget(options.projectName,resolved.resolvedTarget)).defaultEntry,
      files: await readProjectFiles(
        resolved.sourceDir,
        options.includeBinary === true,
      ),
    };
  }

  async getSourceDownloadAvailability(projectName: string): Promise<Omit<SourceDownloadAvailability, "allowed">> {
    const latest = await this.readLatest(projectName);
    return { available: latest !== null, target: latest };
  }

  async getDownloadableSourceFiles(options: { projectName: string; target?: string }): Promise<{ projectId: string; projectName: string; target: string; resolvedTarget: string; files: File[]; sourceHash: string; entries: ProjectEntry[]; defaultEntry: string }> {
    this.assertProjectId(options.projectName);
    const target = options.target?.trim() || "latest";
    if (target === "draft") throw new HttpError(400, 400, "Download a published project version.");
    const resolved = await this.resolveSourceTarget(options.projectName, target);
    const metadata = await this.readPackageMetadataForTarget(options.projectName, resolved.resolvedTarget);
    return { projectId: options.projectName, projectName: metadata.name, target, resolvedTarget: resolved.resolvedTarget,
      sourceHash: await hashDirectory(resolved.sourceDir), entries: metadata.entries, defaultEntry: metadata.defaultEntry,
      files: await readProjectFiles(resolved.sourceDir, true) };
  }



  async listProjectAccessRequests(projectId: string): Promise<ProjectAccessRequest[]> {
    this.assertProjectId(projectId);
    return this.requireProjectDatabase().listProjectAccessRequests(projectId);
  }

  async createProjectAccessRequest(options: {
    projectId: string;
    requesterUserId: string;
    reason: string;
  }): Promise<ProjectAccessRequest> {
    this.assertProjectId(options.projectId);
    const reason = options.reason.trim();
    if (reason.length < 2 || reason.length > 1000) {
      throw new HttpError(400, 400, "Access request reason must contain 2 to 1000 characters.");
    }
    const db = this.requireProjectDatabase();
    const project = await db.getProject(options.projectId);
    if (project === undefined) {
      throw new HttpError(404, 404, `Workflow "${options.projectId}" does not exist.`);
    }
    return db.createProjectAccessRequest({
      id: randomUUID(),
      projectId: options.projectId,
      requesterUserId: options.requesterUserId,
      reason,
    });
  }

  async resolveProjectAccessRequest(options: {
    projectId: string;
    requestId: string;
    status: "approved" | "rejected";
    actor: AccessActor;
  }): Promise<ProjectAccessRequest> {
    const resolved = await this.requireProjectDatabase().resolveProjectAccessRequest({
      ...options,
    });
    if (resolved === undefined) {
      throw new HttpError(404, 404, `Pending access request "${options.requestId}" does not exist.`);
    }
    return resolved;
  }

  createProjectAccessRequestUrl(origin: string, projectId: string): string {
    this.assertProjectId(projectId);
    const token = createProjectAccessRequestToken({
      projectId,
      expiresAtMs: Date.now() + 15 * 60 * 1000,
    }, this.kanbanPreviewCapabilitySecret);
    return `${origin.replace(/\/+$/, "")}/access-requests/${encodeURIComponent(token)}`;
  }

  readProjectAccessRequestToken(token: string): { projectId: string } {
    const payload = readProjectAccessRequestToken(token, this.kanbanPreviewCapabilitySecret);
    if (payload === undefined || payload.expiresAtMs <= Date.now()) {
      throw new HttpError(410, 410, "Project source access request link is invalid or expired.");
    }
    return { projectId: payload.projectId };
  }
  private requireProjectDatabase(): DatabaseRepository {
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project membership requests require PostgreSQL storage.");
    }
    return this.db;
  }

  async saveManagedFiles(options: {
    projectName: string;
    /** Written before public metadata so a failed upload never exposes a personal file. */
    configurationOwnerUserId?: string;
    entryId?: string;
    files: Array<{
      name: string;
      mimeType?: string;
      buffer: Buffer;
      conversationId?: string;
    }>;
  }): Promise<ManagedFileReference[]> {
    // Keep uploaded run attachments outside project source/runtime
    // trees; workflows receive opaque references and resolve them at run time.
    this.assertProjectId(options.projectName);
    const now = new Date().toISOString();
    const entries = options.files.map((file) => {
      assertManagedFileSize(file.buffer.byteLength);
      const id = createManagedFileId();
      const mimeType = normalizeMimeType(file.mimeType, file.name);
      const ref: ManagedFileReference = {
        id,
        name: normalizeManagedFileName(file.name),
        mimeType,
        size: file.buffer.byteLength,
        kind: mimeType.startsWith("image/") ? "image" : "file",
        storage: "server",
        projectId: options.projectName,
        ...(options.entryId === undefined ? {} : {entryId: options.entryId}),
        conversationId: normalizeOptionalText(file.conversationId),
        createdAt: now,
      };
      return { buffer: file.buffer, dir: this.managedFileDir(id), ref };
    });
    const touchedDirs: string[] = [];

    try {
      for (const entry of entries) {
        touchedDirs.push(entry.dir);
        await mkdir(entry.dir, { recursive: true });
        await writeFile(path.join(entry.dir, "content"), entry.buffer);
        if (options.configurationOwnerUserId) {
          await writeJson(path.join(entry.dir, "configuration-owner.json"), { projectId: options.projectName, entryId: options.entryId, userId: options.configurationOwnerUserId });
        }
        await writeJson(path.join(entry.dir, "metadata.json"), entry.ref);
      }
    } catch (cause) {
      await Promise.allSettled(touchedDirs.map((dir) => rm(dir, { recursive: true, force: true })));
      throw cause;
    }

    return entries.map(({ ref }) => ref);
  }

  async getManagedFile(fileId: string): Promise<{
    metadata: ManagedFileReference;
    filePath: string;
  }> {
    assertManagedFileId(fileId);
    const metadata = await readJson<ManagedFileReference>(
      path.join(this.managedFileDir(fileId), "metadata.json"),
    );

    if (metadata === undefined) {
      throw new HttpError(404, 404, `Workflow file "${fileId}" does not exist.`);
    }

    return {
      metadata,
      filePath: path.join(this.managedFileDir(fileId), "content"),
    };
  }

  async deleteManagedFile(fileId: string): Promise<{ id: string }> {
    assertManagedFileId(fileId);
    await rm(this.managedFileDir(fileId), { recursive: true, force: true });
    return { id: fileId };
  }

  /** Configuration uploads are personal even when the containing project is shared. */
  async assertManagedFileAccountAccess(fileId: string, actorId?: string, entryId?: string): Promise<void> {
    assertManagedFileId(fileId);
    const owner=await readJson<{userId:string;entryId:string}>(path.join(this.managedFileDir(fileId),'configuration-owner.json'));
    if(owner && (owner.userId!==actorId || entryId !== undefined && owner.entryId!==entryId)) throw new HttpError(404,404,'Configuration attachment does not exist.');
  }

  async getKanbanWorkspace(options: {
    projectName: string;
    entryId?: string;
    target?: string;
    actorId: string;
  }): Promise<KanbanWorkspaceState> {
    const project = await this.resolveKanbanProject(options.projectName, options.target, options.entryId);
    const state = await this.projectConfigurations(options, {action: "get"}) as ProjectConfigurationState;
    return { ...project, configurations: state.configurations.map(item => ({ ...item, values: configurationSnapshot(state, item.id, false).values })), activeConfigurationId: state.activeConfigurationId };

  }

  async issueKanbanPreviewCapability(options: {
    projectName: string;
    entryId?: string;
    target?: string;
    actorId: string;
  }): Promise<KanbanPreviewCapability> {
    const project = await this.resolveKanbanProject(options.projectName, options.target, options.entryId);
    const actorId = requireKanbanActorId(options.actorId);
    const now = Date.now();
    const expiresAtMs = now + KANBAN_PREVIEW_CAPABILITY_TTL_MS;
    const token = createKanbanPreviewCapabilityToken({
      version: 1,
      projectName: options.projectName,
      entryId: project.entryId,
      resolvedTarget: project.resolvedTarget,
      actorId,
      expiresAtMs,
    }, this.kanbanPreviewCapabilitySecret);
    return {
      token,
      resolvedTarget: project.resolvedTarget,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async getKanbanAsset(options: {
    projectName: string;
    entryId?: string;
    target?: string;
    actorId?: string;
    previewCapabilityToken?: string;
    assetPath: string;
    nonce: string;
  }): Promise<KanbanAsset> {
    const actorId = options.previewCapabilityToken
      ? this.requireKanbanPreviewCapability(
          options.previewCapabilityToken,
          options.projectName,
          options.target,
          options.entryId,
        )
      : requireKanbanActorId(options.actorId ?? "");
    if (this.db) {
      const user = await this.db.getAccessAccount(actorId);
      if (!user || user.status !== 'active') throw new HttpError(403,403,"Permission denied.");
      await this.requireProjectCapability(options.projectName,{userId:actorId,isSystemAdmin:user.isSystemAdmin}, options.target==='draft'?'readDraft':'read');
    }
    const project = await this.resolveKanbanProject(
      options.projectName,
      options.target,
      options.entryId,
    ).catch(() => {
      throw new HttpError(404, 404, "Kanban asset does not exist.");
    });
    const assetPath = options.assetPath.replaceAll("\\", "/");
    if (!isSafeKanbanPublicAssetPath(assetPath, project.entry)) {
      throw new HttpError(404, 404, "Kanban asset does not exist.");
    }
    const nonce = normalizeKanbanNonce(options.nonce);
    const source = await this.resolveSourceTarget(options.projectName, project.resolvedTarget);
    let content: Buffer;
    try {
      // Missing or concurrently replaced artifact paths stay inside
      // the public 404 boundary and never surface raw filesystem failures.
      const sourceRealPath = await realpath(source.sourceDir);
      if (project.artifactDir !== ".") {
        await assertKanbanAssetHasNoSymbolicLinks(sourceRealPath, project.artifactDir);
      }
      const artifactRoot = await realpath(path.resolve(
        sourceRealPath,
        ...project.artifactDir.split("/"),
      ));
      assertResolvedPathInsideRoot(sourceRealPath, artifactRoot, true);
      await assertKanbanAssetHasNoSymbolicLinks(artifactRoot, assetPath);
      const targetRealPath = await realpath(path.resolve(artifactRoot, ...assetPath.split("/")));
      assertResolvedPathInsideRoot(artifactRoot, targetRealPath, false);
      const file = await open(targetRealPath, "r");
      try {
        const fileStat = await file.stat();
        if (!fileStat.isFile() || fileStat.size > MAX_KANBAN_ASSET_SIZE_BYTES) {
          throw new Error("Kanban asset is not a supported regular file.");
        }
        content = await file.readFile();
        if (content.byteLength > MAX_KANBAN_ASSET_SIZE_BYTES) {
          throw new Error("Kanban asset exceeds the preview size limit.");
        }
      } finally {
        await file.close();
      }
    } catch {
      throw new HttpError(404, 404, "Kanban asset does not exist.");
    }
    const contentSecurityPolicy = createKanbanContentSecurityPolicy(nonce);
    if (assetPath === project.entry) {
      const workspace = await this.getKanbanWorkspace({
        projectName: options.projectName,
        target: project.resolvedTarget,
        entryId: project.entryId,
        actorId,
      });
      const active = workspace.configurations.find((item) => item.id === workspace.activeConfigurationId)
        ?? workspace.configurations[0];
      const configuration = active
        ? {
            id: active.id,
            name: active.name,
            params: active.values,
          }
        : { id: "default", name: "默认配置", params: {} };
      const html = injectKanbanBridge(content.toString("utf8"), configuration, nonce);
      return {
        content: html,
        contentType: "text/html; charset=utf-8",
        contentLength: Buffer.byteLength(html),
        contentSecurityPolicy,
      };
    }
    return {
      content,
      contentType: readKanbanAssetMimeType(assetPath),
      contentLength: content.byteLength,
      contentSecurityPolicy,
    };
  }

  private requireKanbanPreviewCapability(
    token: string,
    projectName: string,
    target?: string,
    entryId?: string,
  ): string {
    const now = Date.now();
    const capability = readKanbanPreviewCapabilityToken(
      token,
      this.kanbanPreviewCapabilitySecret,
    );
    if (
      capability === undefined ||
      capability.expiresAtMs <= now ||
      capability.projectName !== projectName ||
      capability.resolvedTarget !== target ||
      capability.entryId !== entryId
    ) {
      throw new HttpError(404, 404, "Kanban preview does not exist or has expired.");
    }
    return capability.actorId;
  }

  private async freezeConfigurationAttachments(projectId:string,sourceDir:string,template:ProjectConfigurationTemplate,actorId?:string):Promise<void> {
    const copies = new Map<string, {id:string;path:string;sha256:string}>();
    template.attachments = [];
    for(const configuration of template.configurations) for(const field of template.fields.filter(f=>f.type==='file')) {
      const value=configuration.values[field.name]; if(value===undefined) continue;
      const refs=field.multiple ? value as unknown[] : [value];
      const frozen=[];
      for(const input of refs) {
        const ref=parseConfigurationFile(input);
        await this.assertManagedFileAccountAccess(ref.id,actorId,template.entryId);
        const file=await this.getManagedFile(ref.id);
        if(file.metadata.projectId!==projectId || file.metadata.entryId!==template.entryId) throw new HttpError(403,403,'Configuration attachment belongs to another project.');
        if(file.metadata.size!==ref.size||file.metadata.name!==ref.name||file.metadata.mimeType!==ref.mimeType)throw new HttpError(400,400,'Invalid server file reference.');
        let copy=copies.get(ref.id);
        if(!copy) {
          const bytes=await readFile(file.filePath),id=createManagedFileId();
          if(bytes.length!==ref.size) throw new HttpError(409,409,'Configuration attachment changed.');
          copy={id,path:`configuration-assets/${id}`,sha256:createHash('sha256').update(bytes).digest('hex')};
          await mkdir(path.join(sourceDir,'configuration-assets'),{recursive:true});
          await writeFile(path.join(sourceDir,copy.path),bytes,{flag:'wx'});
          copies.set(ref.id,copy);template.attachments.push(copy);
        }
        frozen.push({...ref,id:copy.id});
      }
      configuration.values[field.name]=field.multiple ? frozen : frozen[0]!;
    }
    if(!template.attachments.length) delete template.attachments;
  }

  async uploadConfigurationFile(options:{projectName:string;entryId?:string;actorId:string;key:string;name:string;mimeType:string;buffer:Buffer;target?:string;administrator?:boolean;actor?:AccessActor;field?:unknown}):Promise<ManagedFileReference[]> {
    try {
    const metadata=await this.readPackageMetadataForTarget(options.projectName,options.target??'draft');
    const entryId=selectProjectEntry({entries:metadata.entries,defaultEntry:metadata.defaultEntry},options.entryId).entryId;
    const state=await this.projectConfigurations({...options,entryId},{action:'get'}) as ProjectConfigurationState;
    const field=state.fields.find(f=>f.name===options.key) ?? (options.field===undefined?undefined:parseConfigurationField(options.field));
    if(!field || field.type!=='file'||field.name!==options.key) throw new HttpError(400,400,'Unknown configuration file field.');
    if(!state.fields.some(existing=>existing.name===field.name)) applyConfigurationAction(state,{action:'field.save',revision:state.revision,field},randomUUID,undefined,state.capabilities?{subject:options.actorId,role:state.capabilities.role,online:state.capabilities.online}:undefined);
    if(!configurationCapability(state,field).editable) throw new HttpError(403,403,'Configuration is locked by the author.');
    validateConfigurationFileSelection(field,{name:options.name,mimeType:options.mimeType,size:options.buffer.length});
    return await this.saveManagedFiles({projectName:options.projectName,configurationOwnerUserId:options.actorId,entryId,files:[{name:options.name,mimeType:options.mimeType,buffer:options.buffer}]});
    } catch(error) {if(error instanceof ProjectConfigurationError)throw new HttpError(error.code==='CONFIGURATION_FORBIDDEN'?403:400,400,error.message,{code:error.code});throw error;}
  }

  async configurationAttachment(options:{projectName:string;entryId?:string;actorId:string;target?:string;actor?:AccessActor;administrator?:boolean},fileId:string):Promise<{metadata:ManagedFileReference;filePath:string}> {
    const metadata=await this.readPackageMetadataForTarget(options.projectName,options.target??'draft');
    const entryId=selectProjectEntry({entries:metadata.entries,defaultEntry:metadata.defaultEntry},options.entryId).entryId;
    const state=await this.projectConfigurations({...options,entryId},{action:'get'}) as ProjectConfigurationState;
    try {
      const file=await this.getManagedFile(fileId);
      const owner=await readJson<{projectId:string;entryId:string;userId:string}>(path.join(this.managedFileDir(fileId),'configuration-owner.json'));
      if(owner?.projectId===options.projectName && owner.userId===options.actorId && owner.entryId===entryId) return file;
      const access=await this.getProjectAccessSummary(options.projectName,options.actorId);
      if(!owner && access.access?.capabilities.includes("manageSettings") && file.metadata.projectId===options.projectName && file.metadata.entryId===entryId) return file;
    } catch(error) {if(!(error instanceof HttpError && error.statusCode===404))throw error;}
    const template=state.template ?? (options.target && options.target!=='draft'?await this.configurationTemplate(options.projectName,options.target,options.entryId):undefined);
    const asset=template?.attachments?.find(a=>a.id===fileId);
    if(asset) {
      const refs=template!.configurations.flatMap(profile=>template!.fields.filter(f=>f.type==='file').flatMap(field=>{
        const value=profile.values[field.name];return value===undefined?[]:(field.multiple?value as unknown[]:[value]).map(parseConfigurationFile);
      }));
      const reference=refs.find(ref=>ref.id===fileId);
      if(reference) {
        const source=await this.resolveSourceTarget(options.projectName,template!.projectVersion);
        return {metadata:{...reference,kind:reference.kind??'file',createdAt:reference.createdAt??''},filePath:path.join(source.sourceDir,asset.path)};
      }
    }
    throw new HttpError(404,404,'Configuration attachment does not exist.');
  }

  async configurationTemplate(projectName: string, target = "latest", entryId?: string): Promise<ProjectConfigurationTemplate | undefined> {
    const source = await this.resolveSourceTarget(projectName, target);
    const registration = selectProjectEntry(readProjectManifest(await readPackageJson(source.sourceDir)), entryId);
    if (this.db) {
      const cached = await this.db.readConfigurationTemplate(projectName, registration.entryId, source.resolvedTarget);
      if (cached) return parseConfigurationTemplate(cached);
    }
    try { return parseConfigurationTemplate(JSON.parse(await readFile(path.join(source.sourceDir, configurationTemplatePath(registration.entryId)), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private async configurationPublicationDraft(projectId: string, entryId: string, update?: (stored: unknown) => ConfigurationPublicationDraft): Promise<ConfigurationPublicationDraft | undefined> {
    if (this.db) return this.db.configurationPublicationDraft(projectId, entryId, update);
    const file = path.join(this.projectDirectory(projectId), `configuration-publication-${entryId}.json`);
    let stored: ConfigurationPublicationDraft | undefined;
    try { stored = parsePublicationDraft(JSON.parse(await readFile(file, "utf8"))); }
    catch(error) { if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!update) return stored;
    const next = update(stored), temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeJson(temporary,next); await rename(temporary,file); } finally { await rm(temporary,{force:true}); }
    return next;
  }

  async projectConfigurations(options: { projectName: string; entryId?: string; actorId: string; target?: string; administrator?: boolean; actor?: AccessActor }, call: ProjectConfigurationAction): Promise<ProjectConfigurationState | ProjectConfigurationExport> {
    try {
      validateConfigurationAction(call);
      const run=()=>this.projectConfigurationsUnlocked(options,call);
      return await (call.action==='get'||call.action==='export'?run():this.withProjectPublishLock(options.projectName,run));
    } catch(error) {
      if(error instanceof ProjectConfigurationError) {const status=error.code==='CONFIGURATION_CONFLICT'?409:error.code==='CONFIGURATION_FORBIDDEN'?403:400;throw new HttpError(status,status,error.message,{code:error.code});}
      throw error;
    }
  }

  private async projectConfigurationsUnlocked(options: { projectName: string; entryId?: string; actorId: string; target?: string; administrator?: boolean; actor?: AccessActor }, call: ProjectConfigurationAction): Promise<ProjectConfigurationState | ProjectConfigurationExport> {
    this.assertProjectId(options.projectName);
    const actor = requireKanbanActorId(options.actorId);
    const access = await this.getProjectAccessSummary(options.projectName, actor);
    const resolvedAccess = this.db ? await this.requireProjectCapability(options.projectName,options.actor??{userId:actor,isSystemAdmin:options.administrator===true},"read") : access.access;
    const configurationAccess:ConfigurationAccess={subject:actor,role:options.administrator===true?"owner":resolvedAccess?.effectiveRole??"guest",online:true};
    const canManagePublication = options.administrator === true || resolvedAccess?.capabilities.includes("manageSettings") === true;
    if(String(call?.action).startsWith("publication.") && !canManagePublication)throw new HttpError(403,403,"Maintainer access is required to manage official configurations.");
    let target = options.target ?? "draft";
    if (!access.access?.capabilities.includes("readDraft") && !canManagePublication && target === "draft") {
      target = "latest";
    }
    const source = await this.resolveSourceTarget(options.projectName, target);
    const entry = selectProjectEntry(readProjectManifest(await readPackageJson(source.sourceDir)), options.entryId);
    const entryId = entry.entryId;
    options = { ...options, entryId };
    try {
      validateConfigurationAction(call);
      let fields: ProjectConfigurationState["fields"] = [];
      let agentModelPolicy: ProjectConfigurationState["agentModelPolicy"];
      let definitionVersion = 1;
      let profilePolicy:ConfigurationProfilePolicy|undefined;
      try { const definition = readProjectConfigurationDefinition(source.sourceDir, entryId); fields = definition.fields; definitionVersion = definition.version; agentModelPolicy=definition.agentModelPolicy;profilePolicy=definition.profilePolicy; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Personal values use the released template. Reading source drafts does
      // not grant access to an author's unpublished configuration fields.
      if (!canManagePublication && definitionVersion === 2 && source.resolvedTarget === 'draft') {
        const latest = await this.readLatest(options.projectName);
        if (latest) return this.projectConfigurationsUnlocked({...options,target:latest},call);
        if (profilePolicy) throw new ProjectConfigurationError('Publish the project configuration template before using role-controlled configurations.');
      }
      const template = !canManagePublication && source.resolvedTarget !== 'draft' ? await this.configurationTemplate(options.projectName,source.resolvedTarget,options.entryId) : undefined;
      agentModelPolicy=configurationAgentModelPolicy({fields,agentModelPolicy},template??{fields:[]});
      profilePolicy=template?.profilePolicy??profilePolicy;
      if (!canManagePublication && definitionVersion === 2 && !template) fields = [];
      const references = async (definitions:ProjectConfigurationField[], input:Record<string,unknown>) => {
        for(const field of definitions.filter(f=>f.type==='file')) {
          const value=input[field.name];if(value===undefined)continue;
          const refs=field.multiple?value as unknown[]:[value];
          if(!Array.isArray(refs))throw new ProjectConfigurationError('Invalid configuration files.');
          for(const input of refs) {
            const ref=parseConfigurationFile(input);
            if(template?.attachments?.some(a=>a.id===ref.id))continue;
            const file=await this.getManagedFile(ref.id);
            const owner=await readJson<{userId:string;entryId:string}>(path.join(this.managedFileDir(ref.id),'configuration-owner.json'));
            if(file.metadata.projectId!==options.projectName || owner && owner.userId!==actor || !owner && !canManagePublication)throw new HttpError(403,403,'Configuration file is not available to this account.');
            if(file.metadata.size!==ref.size||file.metadata.name!==ref.name||file.metadata.mimeType!==ref.mimeType)throw new HttpError(400,400,'Invalid server file reference.');
          }
        }
      };
      if(call.values) {
        const current=await this.projectConfigurations(options,{action:'get'}) as ProjectConfigurationState;
        await references(current.fields,call.values);
      }
      if(call.field?.type==='file' && call.field.defaultValue!==undefined) await references([call.field],{[call.field.name]:call.field.defaultValue});
      for(const document of [call.document,call.publication])if(document) {
        await references(document.fields,Object.fromEntries(document.fields.filter(field=>field.defaultValue!==undefined).map(field=>[field.name,field.defaultValue])));
        for(const profile of document.configurations)await references(document.fields,profile.values);
      }
      const initialId = `default-${createHash("sha256").update(JSON.stringify([options.projectName, entryId, actor])).digest("hex").slice(0,24)}`;
      const publicationCall = call.action.startsWith('publication.');
      if (publicationCall && !canManagePublication) throw new HttpError(403,403,"Maintainer access is required to manage official configurations.");
      let state: ProjectConfigurationState;
      if (!this.db) {
        const store = await createLocalProjectConfigurationStore(source.sourceDir, {
          entryId, rootDir: path.join(this.dataRoot, "project-configurations"), storageKey: JSON.stringify([options.projectName, entryId, actor]), template:template??null,fields,agentModelPolicy,profilePolicy,access:configurationAccess,
        });
        const result = await store.dispatch(publicationCall ? {action:'get'} : call);
        if(call.action === 'export') return result;
        state = result as ProjectConfigurationState;
      } else {
        state = await this.db.projectConfigurationState(options.projectName, entryId, actor, stored => {
          let current = readConfigurationState(stored, template?.fields ?? fields, () => initialId,agentModelPolicy);
          if (template) current = bindConfigurationTemplate(current,template);
          else delete current.template;
          if(profilePolicy)current=bindConfigurationProfiles(current,profilePolicy);
          if(current.profilePolicy)current.activeConfigurationId=configurationAccessView(current,configurationAccess).activeConfigurationId;
          if (stored && current.revision === (stored as ProjectConfigurationState).revision && (!isDeepStrictEqual((stored as ProjectConfigurationState).fields,current.fields) || !isDeepStrictEqual((stored as ProjectConfigurationState).agentModelPolicy,current.agentModelPolicy) || !isDeepStrictEqual((stored as ProjectConfigurationState).profilePolicy,current.profilePolicy) || (stored as ProjectConfigurationState).activeConfigurationId!==current.activeConfigurationId)) current.revision++;
          return call.action === "get" || call.action === "export" || publicationCall ? current : applyConfigurationAction(current,call,randomUUID,undefined,configurationAccess);
        });
      }
      if (canManagePublication) {
        const withSourcePolicy = (draft: ConfigurationPublicationDraft) => parsePublicationDraft({...draft,profilePolicy:state.profilePolicy,agentModelPolicy:configurationAgentModelPolicy(state,draft)});
        const operation = async () => {
          let draft = await this.configurationPublicationDraft(options.projectName, entryId);
          if(call.action === 'publication.save') {
            if(call.revision !== state.revision) throw new ProjectConfigurationError("Configuration changed. Refresh before saving your draft.","CONFIGURATION_CONFLICT");
            const input = withSourcePolicy(parsePublicationDraft(call.publication));
            draft = await this.configurationPublicationDraft(options.projectName, entryId, stored => {
              if(input.revision !== (stored ? parsePublicationDraft(stored).revision : 0)) throw new ProjectConfigurationError("Publication draft changed. Refresh before saving.","CONFIGURATION_CONFLICT");
              return {...input,revision:input.revision+1,configurationRevision:state.revision,configurationAccountId:actor};
            });
          }
          state.publication = draft ? withSourcePolicy(draft) : createPublicationDraft(state);
          state.canManagePublication = true;
        state.sourceHash = await hashDirectory(source.sourceDir);
          if(call.action === 'publication.preview') state.publicationPreview = freezeConfigurationTemplate(withSourcePolicy(call.publication??state.publication),{projectId:options.projectName,entryId,projectVersion:'preview',sourceHash:'0'.repeat(64)});
        };
        await operation();
      } else state.canManagePublication = false;
      if(source.resolvedTarget === "draft" && access.access?.capabilities.includes("publish")) {
        state.publicationRevision=(await this.configurationPublicationDraft(options.projectName, entryId))?.revision;
        state.sourceHash=await hashDirectory(source.sourceDir);
      }
      state.fieldCapabilities=Object.fromEntries(state.fields.map(field=>[field.name,{...configurationCapability(state,field),paths:Object.fromEntries(Object.keys(field.paths??{}).map(pointer=>[pointer,configurationCapability(state,field,pointer)]))}]));
      return call.action === "export" ? exportConfigurations(state,call.id,configurationAccess) : configurationAccessView(state,configurationAccess);
    } catch (error) {
      if (error instanceof ProjectConfigurationError) { const status = error.code === "CONFIGURATION_CONFLICT" ? 409 : error.code === "CONFIGURATION_FORBIDDEN" ? 403 : 400; throw new HttpError(status,status,error.message,{code:error.code}); }
      throw error;
    }
  }

  async saveDraftFiles(options: {
    projectName: string;
    files: FileInput[];
    removePaths?: string[];
  }): Promise<SaveDraftFilesResult> {
    this.assertProjectId(options.projectName);

    const updatedFiles: string[] = [];
    const removedFiles: string[] = [];
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const stagedDraftDir = path.join(tempDir, "draft");
    const stagedSourceDir = path.join(stagedDraftDir, "source");

    try {
      await this.materializeDbDraftSource(options.projectName);
      if (await exists(this.draftSourceDir(options.projectName))) {
        await copyProjectSource(this.draftSourceDir(options.projectName), stagedSourceDir);
      } else {
        await mkdir(stagedSourceDir, { recursive: true });
      }

      for (const removePath of options.removePaths ?? []) {
        const safePath = normalizeProjectFilePath(removePath);
        await rm(path.join(stagedSourceDir, safePath), {
          recursive: true,
          force: true,
        });
        removedFiles.push(safePath);
      }

      for (const file of options.files) {
        const safePath = normalizeProjectFilePath(file.path);
        const targetPath = path.join(stagedSourceDir, safePath);

        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, decodeProjectFileContent(file));
        updatedFiles.push(safePath);
      }

      const metadata = await validateProjectPackage(
        stagedSourceDir,
        options.projectName,
      );
      await this.commitStagedDraft(
        options.projectName,
        stagedDraftDir,
      );

      return {
        projectId: metadata.id,
        projectName: metadata.name,
        updatedFiles,
        removedFiles,
        nextVersion: await this.resolveNextVersion(options.projectName),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async cloneProject(options: {
    projectName: string;
    sourceTarget?: string;
    targetProjectName: string;
    displayName?: string;
    ownerUserId?: string;
    groupId?: string | null;
    isSystemAdmin?: boolean;
  }): Promise<CloneProjectResult> {
    this.assertProjectId(options.projectName);
    this.assertProjectId(options.targetProjectName);

    if (options.projectName === options.targetProjectName) {
      throw new HttpError(409, 409, "Clone target id must be different from source project id.");
    }

    const existingProject = this.db === undefined
      ? undefined
      : await this.db.getProject(options.targetProjectName);
    if (
      existingProject !== undefined ||
      await exists(this.draftSourceDir(options.targetProjectName)) ||
      await exists(this.projectDirectory(options.targetProjectName))
    ) {
      throw new HttpError(
        409,
        409,
        `Workflow "${options.targetProjectName}" already exists. Delete it first or choose a different name.`,
      );
    }

    const sourceTarget = options.sourceTarget?.trim() || "latest";
    const resolved = await this.resolveSourceTarget(options.projectName, sourceTarget);
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const stagedDraftDir = path.join(tempDir, "draft");
    const stagedSourceDir = path.join(stagedDraftDir, "source");

    try {
      await copyProjectSource(resolved.sourceDir, stagedSourceDir);

      if (options.displayName?.trim()) {
        await this.updatePackageMetadataName(
          stagedSourceDir,
          options.targetProjectName,
          options.displayName.trim(),
        );
      } else {
        const packageJson = await this.readPackageMetadata(options.projectName);
        await this.updatePackageMetadataName(
          stagedSourceDir,
          options.targetProjectName,
          packageJson.name,
        );
      }

      const metadata = await validateProjectPackage(
        stagedSourceDir,
        options.targetProjectName,
      );
      if (this.db) await this.createProject({
        projectId: metadata.id,
        projectName: metadata.name,
        entries: metadata.entries, defaultEntry: metadata.defaultEntry,
        projectInfo: this.normalizeDeclaredProjectInfo(metadata.projectInfo),
        projectCard: metadata.projectCard,
        ownerUserId: options.ownerUserId,
        createdByUserId: options.ownerUserId,
        groupId: options.groupId,
        isSystemAdmin: options.isSystemAdmin,
      });
      await this.commitStagedDraft(
        options.targetProjectName,
        stagedDraftDir,
      );

      return {
        projectId: metadata.id,
        projectName: metadata.name,
        sourceTarget,
        resolvedSourceTarget: resolved.resolvedTarget,
        nextVersion: await this.resolveNextVersion(options.targetProjectName),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async updateProjectInfo(options: {
    projectName: string;
    target?: string;
    displayName: string;
  }): Promise<UpdateProjectInfoResult> {
    this.assertProjectId(options.projectName);
    const displayName = options.displayName.trim();
    if (displayName === "") {
      throw new HttpError(400, 400, "displayName must not be empty.");
    }

    const target = options.target?.trim() || "draft";
    const resolvedTarget = await this.resolveProjectConfigTarget(
      options.projectName,
      target,
    );

    if (resolvedTarget === "draft") {
      await this.ensureEditableDraft(options.projectName, target);
      await this.stageDraftEdit(options.projectName, async (sourceDir) => {
        await this.updatePackageMetadataName(
          sourceDir,
          options.projectName,
          displayName,
        );
      });
      if (this.db !== undefined) {
        await this.db.updateProjectName(options.projectName, displayName);
      }

      return {
        projectId: options.projectName,
        projectName: displayName,
        target,
        resolvedTarget: "draft",
      };
    }

    await this.stageDraftFromVersionSource(
      options.projectName,
      resolvedTarget,
      async (sourceDir) => {
        await this.updatePackageMetadataName(
          sourceDir,
          options.projectName,
          displayName,
        );
      },
    );
    if (this.db !== undefined) {
      await this.db.updateProjectName(options.projectName, displayName);
    }

    return {
      projectId: options.projectName,
      projectName: displayName,
      target,
      resolvedTarget,
    };
  }

  async deleteProject(projectName: string, actor?: AccessActor): Promise<DeleteProjectResult> {
    this.assertProjectId(projectName);
    const hasDbProject = this.db !== undefined
      ? (await this.db.getProject(projectName)) !== undefined
      : false;
    const hasFileProject = await exists(this.projectDirectory(projectName));

    if (!hasDbProject && !hasFileProject) {
      throw new HttpError(404, 404, `Workflow "${projectName}" does not exist.`);
    }

    if (this.db !== undefined) {
      if(actor) await this.db.access.transaction(async client=>{
        await this.db!.access.assert("project",projectName,actor,"delete",client);
        await client.query("delete from resource_invitations where resource_type='project' and resource_id=$1",[projectName]);
        await client.query("delete from projects where id=$1",[projectName]);
      }); else await this.db.deleteProject(projectName);
    }
    await rm(this.projectDirectory(projectName), {
      recursive: true,
      force: true,
    });
    return {
      projectId: projectName,
    };
  }

  async publish(options: {
    projectName: string;
    releaseLog?: string;
    createdByUserId?: string;
      expectedVersion?: string;
    expectedSourceHash?: string;
    expectedConfigurationRevisions?: Record<string,number>;
    administrator?: boolean;
  }): Promise<PublishResult> {
    this.assertProjectId(options.projectName);

    // Publish must reserve versions serially per project so
    // concurrent requests cannot compute and mutate the same next version.
    return this.withProjectPublishLock(options.projectName, () => this.publishLocked(options));
  }

  private async publishLocked(options: {
    projectName: string; releaseLog?: string; createdByUserId?: string;
    expectedVersion?: string; expectedSourceHash?: string; expectedConfigurationRevisions?: Record<string,number>; administrator?: boolean;
  }): Promise<PublishResult> {
    const assertPublisher = async () => {
      if (this.db && (options.createdByUserId || options.administrator)) {
        await this.requireProjectCapability(options.projectName, {userId:options.createdByUserId,isSystemAdmin:options.administrator===true}, "publish");
      }
    };
    await assertPublisher();
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const stagedVersionDir = path.join(tempDir, "version");
    const sourceDir = path.join(stagedVersionDir, "source");
    let version: string | undefined;
    let dbVersionCreated = false;
    let versionDirCreated = false;
    let committed = false;
    try {
      if (this.db) {
        await writeProjectFiles(sourceDir, await this.db.readDraftFiles(options.projectName));
      } else {
        await copyProjectSource(this.draftSourceDir(options.projectName), sourceDir);
      }
      const metadata = await validateProjectPackage(sourceDir, options.projectName);
      version = metadata.version;
      assertVersion(version);
      if (options.expectedVersion !== undefined && options.expectedVersion !== version) {
        throw new HttpError(409, 409, "Project version differs from its reservation.");
      }
      await this.assertVersionPublishable(options.projectName, version);
      const releaseLog = normalizeReleaseLog(options.releaseLog);
      const authoredSourceHash = await hashDirectory(sourceDir);
      if (options.expectedSourceHash !== undefined && authoredSourceHash !== options.expectedSourceHash) {
        throw new HttpError(409, 409, "Project draft changed after preparation.");
      }
      await rm(path.join(sourceDir, "configuration-templates"), { recursive: true, force: true });
      await rm(path.join(sourceDir, "configuration-assets"), { recursive: true, force: true });
      const templates = new Map<string, ProjectConfigurationTemplate>();
      for (const entry of metadata.entries) {
        const entryId = entry.entryId;
        const publication = await this.configurationPublicationDraft(options.projectName, entryId);
        const definition = readProjectConfigurationDefinition(sourceDir, entryId);
        let template: ProjectConfigurationTemplate | undefined;
        if (publication) {
          if (options.expectedSourceHash === undefined || options.expectedConfigurationRevisions?.[entryId] !== publication.revision) throw new HttpError(409,409,`Confirm source and configuration publication revision for entry "${entryId}".`);
          const access = await this.getProjectAccessSummary(options.projectName, options.createdByUserId);
          const configurationAccountId = publication.configurationAccountId ?? access.ownerUserId ?? options.createdByUserId!;
          const ownerState = await this.projectConfigurations({ projectName: options.projectName, entryId, actorId: configurationAccountId, administrator: true }, { action: "get" }) as ProjectConfigurationState;
          if (ownerState.revision !== publication.configurationRevision) throw new HttpError(409,409,`Configuration changed for entry "${entryId}". Save its publication draft again.`);
          template = freezeConfigurationTemplate({ ...publication, agentModelPolicy: configurationAgentModelPolicy(ownerState,publication), profilePolicy: ownerState.profilePolicy }, { projectId: options.projectName, entryId, projectVersion: version, sourceHash: authoredSourceHash });
          await this.freezeConfigurationAttachments(options.projectName, sourceDir, template, configurationAccountId);
        } else if (definition.version === 2) {
          let empty = readConfigurationState(undefined, definition.fields, () => "default", definition.agentModelPolicy);
          if (definition.profilePolicy) empty = bindConfigurationProfiles(empty, definition.profilePolicy);
          template = freezeConfigurationTemplate(createPublicationDraft(empty), { projectId: options.projectName, entryId, projectVersion: version, sourceHash: authoredSourceHash });
          await this.freezeConfigurationAttachments(options.projectName, sourceDir, template, options.createdByUserId);
        }
        if (template) {
          templates.set(entryId, template);
          await writeJson(path.join(sourceDir, configurationTemplatePath(entryId)), template);
          if (entry.configuration) await writeJson(path.join(sourceDir,entry.root,entry.configuration), { version: 2, fields: template.fields, ...(template.agentModelPolicy ? { agentModelPolicy: template.agentModelPolicy } : {}), ...(template.profilePolicy ? { profilePolicy: template.profilePolicy } : {}) });
        }
      }
      const distribution = projectManifestForDistribution(await readPackageJson(sourceDir));
      await writeJson(path.join(sourceDir, "package.json"), distribution);
      const published = readProjectManifest(distribution);
      const sourceHash = await hashDirectory(sourceDir);
      const artifacts = await this.uploadVersionArtifacts({ projectName: options.projectName, version, sourceHash, sourceDir });
      const manifest: Manifest = { projectId: options.projectName, projectName: metadata.name, version,
        createdAt: new Date().toISOString(), createdByUserId: options.createdByUserId, releaseLog, sourceHash,
        sourceObjectPath: artifacts?.sourceObjectPath, entries: published.entries, defaultEntry: published.defaultEntry, };
      await writeJson(path.join(stagedVersionDir, "manifest.json"), manifest);
      await assertPublisher();
      await moveDirectoryIfAbsent(stagedVersionDir, this.versionDir(options.projectName, version), "Project version already exists.");
      versionDirCreated = true;
      if (this.db) {
        await this.db.saveVersion({ ...manifest, sourceObjectPath: manifest.sourceObjectPath ?? "", releaseLog, updateLatest: false });
        dbVersionCreated = true;
        for (const [entryId, template] of templates) await this.db.saveConfigurationTemplate(options.projectName, entryId, version, template);
      }
      await this.activatePublishedVersion({ projectId: options.projectName, projectName: metadata.name, version });
      committed = true;
      return { projectId: options.projectName, projectName: metadata.name, version, latest: version,
        nextVersion: formatNextManagedVersion(parseSemver(version)), releaseLog, };
    } catch (error) {
      if (!committed && dbVersionCreated && version) await this.db?.deleteVersion(options.projectName, version);
      if (!committed && versionDirCreated && version) await rm(this.versionDir(options.projectName, version), { recursive: true, force: true });
      throw error;
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }

  async close(): Promise<void> {
    await this.databases.close();
    await this.db?.close();
  }

  async getSystemTokenUsage(options: {
    pageSize?: number;
    cursor?: string;
  } = {}): Promise<TokenUsagePage> {
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Server token usage inspection requires PostgreSQL storage.");
    }

    return this.db.getSystemTokenUsage({
      pageSize: clampKVPageSize(options.pageSize),
      cursor: options.cursor,
    });
  }

  async getProjectTokenUsage(options: {
    projectId: string;
    conversationId?: string;
    includeEntries?: boolean;
  }): Promise<TokenUsageDetail> {
    this.assertProjectId(options.projectId);
    await this.assertServerProjectDataAccess(options.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Server token usage inspection requires PostgreSQL storage.");
    }

    return this.db.getProjectTokenUsage({
      projectId: options.projectId,
      conversationId: normalizeExactFilter(options.conversationId),
      includeEntries: options.includeEntries === true,
    });
  }

  private async ensureEditableDraft(
    projectName: string,
    requestedTarget: string,
  ): Promise<void> {
    await this.materializeDbDraftSource(projectName);
    if (await exists(this.draftSourceDir(projectName))) {
      return;
    }

    const sourceTarget = requestedTarget.trim() || "latest";
    if (sourceTarget === "draft") {
      throw new HttpError(404, 404, `Workflow "${projectName}" has no draft.`);
    }

    const resolved = await this.resolveSourceTarget(projectName, sourceTarget);
    await rm(this.draftSourceDir(projectName), {
      recursive: true,
      force: true,
    });
    await copyProjectSource(resolved.sourceDir, this.draftSourceDir(projectName));
  }

  private async stageDraftEdit(projectName: string, editSourceDir: (sourceDir: string) => Promise<void>): Promise<void> {
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const draft = path.join(tempDir, "draft");
    try {
      await this.materializeDbDraftSource(projectName);
      await copyProjectSource(this.draftSourceDir(projectName), path.join(draft, "source"));
      await editSourceDir(path.join(draft, "source"));
      await this.commitStagedDraft(projectName, draft);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }

  private async stageDraftFromVersionSource(projectName: string, sourceVersion: string, editSourceDir?: (sourceDir: string) => Promise<void>): Promise<void> {
    await this.ensureDbVersionSourceMaterializedIfNeeded(projectName, sourceVersion);
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const draft = path.join(tempDir, "draft");
    try {
      await copyProjectSource(this.versionSourceDir(projectName, sourceVersion), path.join(draft, "source"));
      await editSourceDir?.(path.join(draft, "source"));
      await this.commitStagedDraft(projectName, draft);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }

  private async ensureDbVersionSourceMaterializedIfNeeded(
    projectName: string,
    version: string,
  ): Promise<void> {
    if (this.db !== undefined) {
      await this.materializeDbVersionSource(projectName, version);
    }
  }

  private async updatePackageMetadataName(
    sourceDir: string,
    projectId: string,
    displayName: string,
  ): Promise<void> {
    const packageJsonPath = path.join(sourceDir, "package.json");
    const current = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
    if (!isRecord(current)) {
      throw new HttpError(500, 500, `Workflow "${projectId}" package.json root must be an object.`);
    }

    const nextPackageJson = {
      ...current,
      id: projectId,
      name: displayName,
    };
    await writeFile(packageJsonPath, `${JSON.stringify(nextPackageJson, null, 2)}\n`);
  }

  private async assertProjectDoesNotExist(projectName: string): Promise<void> {
    const existingProject = this.db === undefined
      ? undefined
      : await this.db.getProject(projectName);
    if (
      existingProject !== undefined ||
      await exists(this.draftSourceDir(projectName)) ||
      await exists(this.projectDirectory(projectName))
    ) {
      throw new HttpError(
        409,
        409,
        `Workflow "${projectName}" already exists. Delete it first or choose a different name.`,
      );
    }
  }

  private async commitStagedDraft(projectName: string, stagedDraftDir: string): Promise<string> {
    return this.withProjectPublishLock(projectName, async () => {
      const sourceDir = path.join(stagedDraftDir, "source");
      const metadata = await validateProjectPackage(sourceDir, projectName);
      await this.persistDraftFromSourceDir(projectName, sourceDir);
      const committedHash=await hashDirectory(sourceDir);
      await replaceDirectory(stagedDraftDir, this.draftDir(projectName));
      this.materializedDraftSourceRevisions.delete(projectName);
      if (!this.db) await writeJson(this.projectInfoMetadataPath(projectName), {
        name: metadata.name, projectInfo: this.normalizeDeclaredProjectInfo(metadata.projectInfo) });
      return committedHash;
    });
  }

  private async updateMaterializedDraftProjectInfo(
    projectName: string,
    name: string,
    projectInfo: DeclaredProjectInfo,
  ): Promise<void> {
    const sourceDir = this.draftSourceDir(projectName);
    if (!(await exists(sourceDir))) return;
    const packageJson = await readPackageJson(sourceDir);
    await writeJson(
      path.join(sourceDir, "package.json"),
      writeProjectInfo({
        ...packageJson,
        name,
      }, projectInfo),
    );
  }
  private async extractArchive(
    archivePath: string,
    archiveName: string,
    extractDir: string,
  ): Promise<number> {
    if (isTarGzipName(archiveName)) {
      return extractTarGz(archivePath, extractDir);
    }

    if (archiveName.endsWith(".zip")) {
      return extractZipArchive(archivePath, extractDir);
    }

    throw new HttpError(400, 400, "Unsupported package format. Use .tar.gz, .tgz, or .zip.");
  }

  private async resolveSourceTarget(
    projectName: string,
    target: string,
  ): Promise<{ resolvedTarget: string; sourceDir: string }> {
    const normalizedTarget = target.trim() || "draft";

    if (normalizedTarget === "draft") {
      await this.materializeDbDraftSource(projectName);
      const sourceDir = this.draftSourceDir(projectName);
      if (!(await exists(sourceDir))) {
        throw new HttpError(404, 404, `Workflow "${projectName}" has no draft.`);
      }
      return { resolvedTarget: "draft", sourceDir };
    }

    const version =
      normalizedTarget === "latest"
        ? await this.requireLatest(projectName)
        : normalizedTarget;

    assertVersion(version);
    await this.assertVersionReadable(projectName, version);
    if (this.db !== undefined) {
      await this.materializeDbVersionSource(projectName, version);
    }

    const sourceDir = this.versionSourceDir(projectName, version);
    if (!(await exists(sourceDir))) {
      throw new HttpError(404, 404, `Workflow "${projectName}" version "${version}" does not exist.`);
    }

    return { resolvedTarget: version, sourceDir };
  }

  private async readRetainedSourceFiles(projectName: string, version: string): Promise<{ projectName: string; files: File[] }> {
    const resolved = await this.resolveSourceTarget(projectName, version);
    const metadata = await this.readPackageMetadataForTarget(projectName, version);
    return { projectName: metadata.name, files: await readProjectFiles(resolved.sourceDir, true) };
  }

  async getSourceShare(projectId: string, version: string): Promise<SourceShare> {
    this.assertProjectId(projectId);
    assertVersion(version);
    await this.assertVersionReadable(projectId, version);
    const manifest = await this.readManifest(projectId, version);
    if (!manifest) throw new HttpError(404, 404, `Workflow "${projectId}" version "${version}" does not exist.`);
    return {
      id: projectId,
      name: manifest.projectName,
      version: manifest.version,
      createdAt: manifest.createdAt,
      releaseLog: manifest.releaseLog,
      sourceHash: manifest.sourceHash,
    };
  }

  async getSourceArchive(projectName: string, target = "latest"): Promise<{ version: string; archive: Buffer }> {
    this.assertProjectId(projectName);
    if (target === "draft") throw new HttpError(400, 400, "Download a published project version.");
    const source = await this.resolveSourceTarget(projectName, target);
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    try {
      await mkdir(tempDir, { recursive: true });
      const filePath = path.join(tempDir, "source.tar.gz");
      await createTarGz(source.sourceDir, filePath);
      return { version: source.resolvedTarget, archive: await readFile(filePath) };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private requireBuildInfo(): ServerBuildInfo {
    if (this.buildInfo === undefined) {
      throw new Error("Storage.init() must complete before runtime versions are used.");
    }
    return this.buildInfo;
  }

  private async requireDbVersion(
    projectName: string,
    version: string,
  ): Promise<DbVersionRecord> {
    const record = this.db === undefined
      ? undefined
      : await this.db.getVersion(projectName, version);
    if (record === undefined) {
      throw new HttpError(404, 404, `Workflow "${projectName}" version "${version}" does not exist.`);
    }
    return record;
  }

  private assertProjectId(projectId: string): void {
    if (!isSafeProjectId(projectId)) {
      throw new HttpError(400, 400, createUnsafeProjectIdMessage(projectId));
    }
    if (!isProjectUuid(projectId)) {
      throw new HttpError(400, 400, createInvalidProjectUuidMessage(projectId));
    }
  }

  private normalizeDeclaredProjectInfo(value: unknown): DeclaredProjectInfo {
    try {
      return normalizeDeclaredProjectInfoInput(value);
    } catch (error) {
      throw new HttpError(400, 400, readErrorMessage(error));
    }
  }

  private async readPackageMetadata(projectId: string): Promise<PackageMetadata> {
    const sourceDir = this.draftSourceDir(projectId);
    if (await exists(sourceDir)) {
      const metadata = await validateProjectPackage(sourceDir, projectId);
      return this.db === undefined
        ? this.applyStoredProjectInfoMetadata(projectId, metadata)
        : metadata;
    }
    if (this.db !== undefined) {
      const record = await this.db.getProject(projectId);
      if (record !== undefined) {
        return {
          id: record.id,
          name: record.name,
          version: record.packageVersion,
          entries: record.entries, defaultEntry: record.defaultEntry,
          projectCard: record.projectCard,
          projectInfo: record.projectInfo,
          requiredCoreVersion: "unknown",
        };
      }
    }

    const latest = await this.readLatest(projectId);
    if (latest !== null) {
      const metadata = await validateProjectPackage(
        this.versionSourceDir(projectId, latest),
        projectId,
      );
      return this.db === undefined
        ? this.applyStoredProjectInfoMetadata(projectId, metadata)
        : metadata;
    }

    throw new HttpError(404, 404, `Workflow "${projectId}" does not exist.`);
  }

  private async applyStoredProjectInfoMetadata(
    projectId: string,
    metadata: PackageMetadata,
  ): Promise<PackageMetadata> {
    const stored = await readJson<StoredProjectInfoMetadata>(
      this.projectInfoMetadataPath(projectId),
    );
    if (stored === undefined) return metadata;
    const name = typeof stored.name === "string" ? stored.name.trim() : "";
    if (name === "") return metadata;
    try {
      return {
        ...metadata,
        name,
        projectInfo: normalizeProjectInfo(stored.projectInfo),
      };
    } catch {
      return metadata;
    }
  }

  private async readPackageMetadataForTarget(projectName: string, target: string): Promise<PackageMetadata> {
    const resolved = await this.resolveSourceTarget(projectName, target);
    return this.applyStoredProjectInfoMetadata(projectName, await validateProjectPackage(resolved.sourceDir, projectName));
  }

  private async readProjectMetadataForEditing(projectId: string): Promise<PackageMetadata> {
    // readPackageMetadata already supports registered projects without a draft.
    // An existing invalid draft must fail validation, never use stale catalog data.
    return this.readPackageMetadata(projectId);
  }

  private async resolveProjectConfigTarget(
    projectName: string,
    target: string,
  ): Promise<string> {
    const normalizedTarget = target.trim() || "draft";

    if (normalizedTarget === "draft") {
      if (this.db !== undefined) {
        const record = await this.db.getProject(projectName);
        if (record?.hasDraft) {
          return "draft";
        }
      }
      if (!(await exists(this.draftSourceDir(projectName)))) {
        throw new HttpError(404, 404, `Workflow "${projectName}" has no draft.`);
      }

      return "draft";
    }

    if (normalizedTarget === "latest") {
      return await this.requireLatest(projectName);
    }

    assertVersion(normalizedTarget);
    await this.assertVersionReadable(projectName, normalizedTarget);
    if (this.db !== undefined) {
      if ((await this.db.getVersion(projectName, normalizedTarget)) !== undefined) {
        return normalizedTarget;
      }
    }
    if (!(await exists(this.versionDir(projectName, normalizedTarget)))) {
      throw new HttpError(
        404,
        404,
        `Workflow "${projectName}" version "${normalizedTarget}" does not exist.`,
      );
    }

    return normalizedTarget;
  }

  private async readLatest(projectName: string): Promise<string | null> {
    if (this.db !== undefined) {
      return (await this.db.getProject(projectName))?.latest ?? null;
    }

    const latest = await readJson<{ version?: unknown }>(this.latestPath(projectName));

    return typeof latest?.version === "string" && SEMVER_PATTERN.test(latest.version)
      ? latest.version
      : null;
  }

  private async requireLatest(projectName: string): Promise<string> {
    const latest = await this.readLatest(projectName);

    if (latest === null) {
      throw new HttpError(404, 404, `Workflow "${projectName}" has no latest version.`);
    }

    return latest;
  }

  private async listVersionNames(projectName: string): Promise<string[]> {
    if (this.db !== undefined) {
      return (await this.db.listVersions(projectName))
        .map((version) => version.version)
        .sort(compareSemverVersions);
    }

    const versionsRoot = this.versionsRoot(projectName);

    if (!(await exists(versionsRoot))) {
      return [];
    }

    const entries = await readdir(versionsRoot, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((version) => SEMVER_PATTERN.test(version))
      .sort(compareSemverVersions);
  }

  private async resolveNextVersion(projectName: string): Promise<string> {
    // A checked-in draft carries the version the user intends to publish. Do
    // not silently rewrite it to a server-generated number: doing so would
    // make the package and the immutable source snapshot disagree.
    try {
      const draftMetadata = await this.readPackageMetadata(projectName);
      if (SEMVER_PATTERN.test(draftMetadata.version)) return draftMetadata.version;
    } catch {
      // Projects created without uploaded source use the published version list.
    }
    const versions = await this.listVersionNames(projectName);
    const latest = await this.readLatest(projectName);
    const candidates = latest !== null && SEMVER_PATTERN.test(latest)
      ? [latest, ...versions]
      : versions;
    const sorted = candidates
      .map(parseSemver)
      .sort((left, right) =>
        left.major - right.major ||
        left.minor - right.minor ||
        left.patch - right.patch,
      );
    const current = sorted.at(-1);

    if (current === undefined) {
      return "0.0.1";
    }

    return formatNextManagedVersion(current);
  }

  private async assertVersionPublishable(
    projectName: string,
    version: string,
  ): Promise<void> {
    assertVersion(version);
    const existing = await this.listVersionNames(projectName);
    if (existing.includes(version)) {
      throw new HttpError(
        409,
        409,
        `Workflow "${projectName}" version "${version}" already exists.`,
        { projectId: projectName, version, reason: "version_exists" },
      );
    }

    const higherVersion = existing
      .filter((candidate) => SEMVER_PATTERN.test(candidate))
      .sort(compareSemverVersions)
      .at(-1);
    if (higherVersion !== undefined && compareSemverVersions(version, higherVersion) <= 0) {
      throw new HttpError(
        409,
        409,
        `Workflow "${projectName}" version "${version}" must be higher than existing version "${higherVersion}".`,
        {
          projectId: projectName,
          version,
          highestVersion: higherVersion,
          reason: "version_not_increasing",
        },
      );
    }
  }

  private async readManifest(
    projectName: string,
    version: string,
  ): Promise<Manifest | undefined> {
    if (this.db !== undefined) {
      const record = await this.db.getVersion(projectName, version);
      if (record !== undefined) {
        return {
          projectId: record.projectId,
          projectName: record.projectName,
          version: record.version,
          createdAt: record.createdAt,
          releaseLog: record.releaseLog,
          sourceHash: record.sourceHash,
          sourceObjectPath: record.sourceObjectPath,
          entries: record.entries,
          defaultEntry: record.defaultEntry,
        };
      }
    }

    return readJson<Manifest>(this.versionManifestPath(projectName, version));
  }

  private async assertVersionExists(
    projectName: string,
    version: string,
  ): Promise<void> {
    if (this.db !== undefined) {
      if ((await this.db.getVersion(projectName, version)) !== undefined) {
        return;
      }
    } else if (await exists(this.versionDir(projectName, version))) {
      return;
    }

    throw new HttpError(404, 404, `Workflow "${projectName}" version "${version}" does not exist.`);
  }

  private async assertVersionReadable(projectName: string, version: string): Promise<void> { await this.assertVersionExists(projectName, version); }

  private async withProjectPublishLock<T>(
    projectName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.db !== undefined) {
      return this.withLocalProjectPublishLock(projectName, () =>
        this.db?.withProjectPublishLock(projectName, operation) ?? operation(),
      );
    }

    return this.withLocalProjectPublishLock(projectName, operation);
  }

  private async withLocalProjectPublishLock<T>(
    projectName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.publishLocks.get(projectName) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.publishLocks.set(projectName, next);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.publishLocks.get(projectName) === next) {
        this.publishLocks.delete(projectName);
      }
    }
  }

  private async activatePublishedVersion(options: { projectId: string; projectName: string; version: string }): Promise<void> {
    if (this.db) {
      await this.db.markVersionLatest(options);
      return;
    }
    const target = this.latestPath(options.projectId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeJson(temporary, { version: options.version });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async summarizeDbProject(record: DbRecord, records?: Array<{ version: string }>): Promise<Summary> {
    const versions = (records ?? await this.db?.listVersions(record.id) ?? []).map(item => item.version).sort(compareSemverVersions);
    return { id: record.id, name: record.name, entries: record.entries, defaultEntry: record.defaultEntry, projectCard: record.projectCard,
      projectInfo: record.projectInfo, ownerUserId: record.ownerUserId, groupId:record.groupId, visibility: record.visibility,
      createdByUserId: record.createdByUserId, createdAt: record.createdAt, updatedAt: record.updatedAt,
      hasDraft: record.hasDraft, latest: record.latest, versions, nextVersion: resolveNextManagedVersionFromRecords(record.latest, versions) };
  }

  private async readProjectRecordForAccess(
    projectId: string,
  ): Promise<DbRecord> {
    if (this.db !== undefined) {
      const record = await this.db.getProject(projectId);
      if (record === undefined) {
        throw new HttpError(404, 404, `Workflow "${projectId}" does not exist.`);
      }
      return record;
    }

    const metadata = await this.readPackageMetadata(projectId);
    const versions = await this.listVersionNames(projectId);
    const timestamps = await this.readFileProjectTimestamps(projectId, versions);
    return {
      id: metadata.id,
      name: metadata.name,
      entries: metadata.entries, defaultEntry: metadata.defaultEntry,
      projectCard: metadata.projectCard,
      projectInfo: metadata.projectInfo,
      packageVersion: metadata.version,
      hasDraft: await exists(this.draftSourceDir(projectId)),
      latest: await this.readLatest(projectId),
      visibility: "private",
      createdAt: timestamps.createdAt ?? new Date().toISOString(),
      updatedAt: timestamps.updatedAt ?? timestamps.createdAt ?? new Date().toISOString(),
    };
  }

  private async createProjectAccessSummary(record: DbRecord, userId?: string): Promise<ProjectAccessSummary> {
    return { projectId: record.id, projectName: record.name, ownerUserId: record.ownerUserId, visibility: record.visibility,
      createdByUserId: record.createdByUserId, groupId: record.groupId, member: this.db && userId ? await this.db.getProjectMember(record.id, userId) : undefined,
      access: this.db ? await this.db.access.resolve("project",record.id,{userId,isSystemAdmin:false}) : undefined };
  }

  private async readFileProjectTimestamps(
    projectName: string,
    versions: string[],
  ): Promise<{ createdAt?: string; updatedAt?: string }> {
    const candidates = [
      await statIfExists(this.projectDirectory(projectName)),
      await statIfExists(this.draftSourceDir(projectName)),
      ...(await Promise.all(
        versions.map((version) => statIfExists(this.versionDir(projectName, version))),
      )),
    ].filter(isDefined);

    if (candidates.length === 0) {
      return {};
    }

    return {
      createdAt: new Date(Math.min(...candidates.map((item) => item.birthtimeMs))).toISOString(),
      updatedAt: new Date(Math.max(...candidates.map((item) => item.mtimeMs))).toISOString(),
    };
  }

  private async persistDraftFromSourceDir(projectName: string, sourceDir = this.draftSourceDir(projectName)): Promise<void> {
    if (!this.db) return;
    const metadata = await validateProjectPackage(sourceDir, projectName);
    const record=await this.db.getProject(projectName);
    if(record) {
      const packageJson=await readPackageJson(sourceDir);
      await writeJson(path.join(sourceDir,"package.json"),writeProjectInfo({...packageJson,name:record.name,steamHarness:{...(isRecord(packageJson.steamHarness)?packageJson.steamHarness:{}),projectCard:record.projectCard}},this.normalizeDeclaredProjectInfo(record.projectInfo)));
    }
    await this.db.saveDraft({ projectId: metadata.id, projectName: metadata.name, entries: metadata.entries, defaultEntry: metadata.defaultEntry,
      packageVersion: metadata.version, projectCard: metadata.projectCard, projectInfo: this.normalizeDeclaredProjectInfo(metadata.projectInfo),
      files: await readProjectFiles(sourceDir, true) });
  }

  private async materializeDbDraftSource(projectName: string): Promise<void> {
    const db = this.db;
    if (db === undefined) {
      return;
    }

    await this.materializeSourceOnce(`draft\0${projectName}`, async () => {
      const record = await db.getProject(projectName);
      if (!record?.hasDraft) {
        this.materializedDraftSourceRevisions.delete(projectName);
        return;
      }

      const sourceDir = this.draftSourceDir(projectName);
      if (
        this.materializedDraftSourceRevisions.get(projectName) === record.updatedAt &&
        await exists(sourceDir)
      ) {
        return;
      }

      await writeProjectFiles(sourceDir, await db.readDraftFiles(projectName));
      this.materializedDraftSourceRevisions.set(projectName, record.updatedAt);
    });
  }

  private async materializeDbVersionSource(
    projectName: string,
    version: string,
  ): Promise<void> {
    const db = this.db;
    if (db === undefined) {
      return;
    }

    await this.materializeSourceOnce(`version\0${projectName}\0${version}`, async () => {
      const record = await db.getVersion(projectName, version);
      if (record === undefined || await exists(this.versionSourceDir(projectName, version))) {
        return;
      }

      if (this.artifacts === undefined) {
        return;
      }

      try {
        await this.downloadAndExtractArtifact(
          record.sourceObjectPath,
          this.versionSourceDir(projectName, version),
          record.sourceHash,
        );
      } catch (error) {
        throw this.createArtifactReadError({
          projectId: projectName,
          version,
          artifact: "source",
          objectPath: record.sourceObjectPath,
          error,
        });
      }
    });
  }

  private materializeSourceOnce(
    key: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const active = this.sourceMaterializationTasks.get(key);
    if (active !== undefined) {
      return active;
    }

    let task: Promise<void>;
    task = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.sourceMaterializationTasks.get(key) === task) {
          this.sourceMaterializationTasks.delete(key);
        }
      });
    this.sourceMaterializationTasks.set(key, task);
    return task;
  }

  private createArtifactReadError(options: {
    projectId: string;
    version: string;
    artifact: "source";
    objectPath: string;
    error: unknown;
  }): HttpError {
    const isMissing = isProjectStorageNotFoundError(options.error);
    const reason = readErrorMessage(options.error);
    const message = isMissing
      ? `Workflow "${options.projectId}" version "${options.version}" ${options.artifact} artifact is missing from storage.`
      : `Failed to read project "${options.projectId}" version "${options.version}" ${options.artifact} artifact. ${reason}`;
    return new HttpError(
      isMissing ? 404 : 500,
      isMissing ? 404 : 500,
      message,
      {
        projectId: options.projectId,
        version: options.version,
        artifact: options.artifact,
        objectPath: options.objectPath,
        reason,
      },
    );
  }

  private async uploadVersionArtifacts(options: {
    projectName: string;
    version: string;
    sourceHash: string;
    sourceDir: string;
  }): Promise<{
    sourceObjectPath: string;
  } | undefined> {
    // Object storage is only absent in a storage-less fixture; a real Server
    // always builds one, so publishing must not silently skip the archive.
    if (this.artifacts === undefined) {
      if (this.db !== undefined) {
        throw new HttpError(
          500,
          500,
          "Workflow object storage is required to publish database-backed project versions.",
        );
      }
      return undefined;
    }

    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const sourceArchive = path.join(tempDir, "source.tar.gz");
    const sourceObjectPath = createObjectPath({
      projectId: options.projectName,
      version: options.version,
      hash: options.sourceHash,
      fileName: "source.tar.gz",
    });
    try {
      await mkdir(tempDir, { recursive: true });
      await createTarGz(options.sourceDir, sourceArchive);
      await this.uploadArtifactFile("source", sourceObjectPath, sourceArchive);
      return { sourceObjectPath };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async uploadArtifactFile(
    artifactName: "source",
    objectPath: string,
    archivePath: string,
  ): Promise<void> {
    if (this.artifacts === undefined) {
      throw new HttpError(500, 500, "Workflow artifact storage is not configured.");
    }
    try {
      await this.artifacts.uploadFile(objectPath, archivePath);
    } catch (error) {
      const archiveSize = (await stat(archivePath)).size;
      throw new HttpError(
        500,
        500,
        `Failed to upload project ${artifactName} artifact ${objectPath} (${formatBytes(archiveSize)}). ${readErrorMessage(error)}`,
        {
          artifact: artifactName,
          objectPath,
          archiveSize,
          archiveSizeLabel: formatBytes(archiveSize),
        },
      );
    }
  }

  private async downloadAndExtractArtifact(
    objectPath: string,
    targetDir: string,
    expectedHash?: string,
  ): Promise<void> {
    if (this.artifacts === undefined) {
      throw new HttpError(500, 500, "Workflow artifact storage is not configured.");
    }

    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const archivePath = path.join(tempDir, "artifact.tar.gz");

    try {
      await mkdir(tempDir, { recursive: true });
      await this.artifacts.downloadFile(objectPath, archivePath);
      await rm(targetDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });
      await extractTarGz(archivePath, targetDir);
      if (expectedHash !== undefined) {
        const actualHash = await hashDirectory(targetDir);
        if (actualHash !== expectedHash) {
          await rm(targetDir, { recursive: true, force: true });
          throw new HttpError(
            500,
            500,
            `Artifact hash mismatch for "${objectPath}".`,
            { expectedHash, actualHash },
          );
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async resolveKanbanProject(projectName: string, requestedTarget?: string, entryId?: string): Promise<Omit<KanbanWorkspaceState, "configurations" | "activeConfigurationId">> {
    this.assertProjectId(projectName);
    const target = requestedTarget?.trim() || "draft";
    const resolved = await this.resolveSourceTarget(projectName, target);
    const metadata = await this.readPackageMetadataForTarget(projectName, resolved.resolvedTarget);
    const registration = selectProjectEntry({entries: metadata.entries, defaultEntry: metadata.defaultEntry }, entryId);
    if (registration.type !== "kanban") throw new HttpError(409, 409, "The selected entry is not Kanban.");
    const artifact = path.posix.join(registration.root, registration.entry);
    return { projectId: projectName, projectName: metadata.name, entryId: registration.entryId, databases: registration.databases, target, resolvedTarget: resolved.resolvedTarget, artifactDir: path.posix.dirname(artifact), entry: path.posix.basename(artifact) };
  }

  async entryDatabaseRequirements(projectId: string, entryId: string, target = "draft") {
    const metadata = target === "draft" ? await this.readProjectMetadataForEditing(projectId) : await this.readPackageMetadataForTarget(projectId,target);
    return selectProjectEntry({entries:metadata.entries,defaultEntry:metadata.defaultEntry},entryId).databases;
  }
  async bindEntryDatabase(projectId: string, entryId: string, alias: string, bindingRef: string, actor: AccessActor) {
    await this.requireProjectCapability(projectId,actor,"manageSettings");
    const requirements = await this.entryDatabaseRequirements(projectId,entryId);
    if(!requirements.some(item=>item.host==="server"&&item.alias===alias)) throw new HttpError(400,400,"The entry does not declare this server database alias.");
    return this.databases.bind({projectId,entryId,alias},bindingRef);
  }
  async entryDatabases(projectId: string, entryId: string, actor: AccessActor, target = "draft", conversationId?: string) {
    await this.requireProjectCapability(projectId, actor, "read");
    const metadata = target === "draft" ? await this.readProjectMetadataForEditing(projectId) : await this.readPackageMetadataForTarget(projectId, target);
    const entry = selectProjectEntry({entries: metadata.entries, defaultEntry: metadata.defaultEntry }, entryId);
    const { createDatabasesContext, RemoteDatabaseSpaceStore } = await import("steamharness");
    return createDatabasesContext({ projectId, entryId: entry.entryId, conversationId, requirements: await Promise.all(entry.databases.map(async requirement => requirement.host === "server" ? { ...requirement, bindingRef: await this.databases.bindingFor({projectId,entryId,alias:requirement.alias}) ?? requirement.bindingRef } : requirement)), resolver: { resolve: async requirement => {
      if (requirement.host !== "server" || !requirement.bindingRef) return undefined;
      const authorization = await this.databases.authorization(requirement.bindingRef, { projectId, entryId: entry.entryId });
      const store = new RemoteDatabaseSpaceStore({ serverUrl: "", token: "" }, { projectId, entryId: entry.entryId, alias: requirement.alias, bindingRef: requirement.bindingRef }, authorization.space.spaceId, authorization.grant.credentialVersion, async <T>(body: Record<string, unknown>): Promise<T> => {
        const write = !["get", "revision", "list"].includes(String(body.operation)) && !(body.operation === "transaction" && (body.entries as any[]).every(item => !item.mutation));
        await this.requireProjectCapability(projectId, actor, write ? "writeData" : "read");
        return await this.databases.data(authorization.space.spaceId, body, { ...actor, userId: actor.userId ?? "system-admin" }, false, requirement) as T;
      });
      return { authorization, store };
    } } });
  }

  private projectsRoot(): string {
    return path.join(this.dataRoot, "projects");
  }

  private preparationsRoot(): string {
    return path.join(this.dataRoot, "preparations");
  }

  private preparationProjectRoot(projectName: string): string {
    return path.join(this.preparationsRoot(), projectName);
  }

  private preparationJobDir(projectName: string, jobId: string): string {
    return path.join(this.preparationProjectRoot(projectName), jobId);
  }

  private preparationJobPath(projectName: string, jobId: string): string {
    return path.join(this.preparationJobDir(projectName, jobId), "job.json");
  }

  private preparationArchivePath(job: Pick<PreparationJob, "projectId" | "jobId" | "archiveName">): string {
    return path.join(this.preparationJobDir(job.projectId, job.jobId), job.archiveName);
  }

  private projectDirectory(projectName: string): string {
    try {
      return resolveProjectRoot(this.projectsRoot(), projectName);
    } catch (error) {
      throw new HttpError(400, 400, error instanceof Error ? error.message : String(error));
    }
  }

  private draftDir(projectName: string): string {
    return path.join(this.projectDirectory(projectName), "draft");
  }

  private draftSourceDir(projectName: string): string {
    return path.join(this.draftDir(projectName), "source");
  }

  private versionsRoot(projectName: string): string {
    return path.join(this.projectDirectory(projectName), "versions");
  }

  private versionDir(projectName: string, version: string): string {
    return path.join(this.versionsRoot(projectName), version);
  }

  private versionSourceDir(projectName: string, version: string): string {
    return path.join(this.versionDir(projectName, version), "source");
  }

  private versionManifestPath(projectName: string, version: string): string {
    return path.join(this.versionDir(projectName, version), "manifest.json");
  }

  private latestPath(projectName: string): string {
    return path.join(this.projectDirectory(projectName), "latest.json");
  }

  private projectInfoMetadataPath(projectName: string): string {
    return path.join(this.projectDirectory(projectName), "project-info.json");
  }

  private kvRoot(): string {
    return path.join(this.dataRoot, "kv");
  }

  private filesRoot(): string {
    return path.join(this.dataRoot, "files");
  }

  private projectCardImagesRoot(): string {
    return path.join(this.dataRoot, "project-card-images");
  }

  private projectCardImageDir(projectName: string): string {
    return path.join(this.projectCardImagesRoot(), projectName);
  }

  private projectCardImagePath(projectName: string, hash: string): string {
    assertProjectCardImageHash(hash);
    return path.join(this.projectCardImageDir(projectName), `${hash}.webp`);
  }

  private managedFileDir(fileId: string): string {
    return path.join(this.filesRoot(), fileId);
  }
}

function assertProjectCardImage(buffer: Buffer): void {
  if (buffer.byteLength === 0) {
    throw new HttpError(400, 400, "Project card image must not be empty.");
  }
  if (buffer.byteLength > PROJECT_CARD_IMAGE_MAX_BYTES) {
    throw new HttpError(413, 413, `Project card image must not exceed ${PROJECT_CARD_IMAGE_MAX_BYTES} bytes.`);
  }
  if (
    buffer.byteLength < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new HttpError(400, 400, "Project card image must be a valid WebP file.");
  }
}

function assertProjectCardImageHash(hash: string): void {
  if (!PROJECT_CARD_IMAGE_HASH_PATTERN.test(hash)) {
    throw new HttpError(400, 400, "Project card image hash is invalid.");
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function mapKnowledgeError(
  error: unknown,
  options: { conflictAs?: number; notFoundAs?: number },
): unknown {
  if (!(error instanceof HarnessError)) {
    return error;
  }

  const message = error.message;
  if (message.includes("already exists") && options.conflictAs !== undefined) {
    return new HttpError(options.conflictAs, options.conflictAs, message, error.metadata);
  }
  if (message.includes("does not exist") && options.notFoundAs !== undefined) {
    return new HttpError(options.notFoundAs, options.notFoundAs, message, error.metadata);
  }
  return new HttpError(400, 400, message, error.metadata);
}

function normalizeProjectStorageInput(input: {
  storageKind: StorageKind;
  scope: KVScope;
  projectId: string;
  key: string;
  conversationId?: string;
}): KVStoreGetInput {
  const key = normalizeExactFilter(input.key);
  if (key === "") {
    throw new HttpError(400, 400, "Project storage key must be a non-empty string.");
  }
  const projectId = normalizeExactFilter(input.projectId);
  if (!isProjectUuid(projectId)) {
    throw new HttpError(400, 400, "Project storage projectId must be a UUID.");
  }
  if (input.scope === "project") {
    return { storageKind: input.storageKind, scope: "project", projectId, key };
  }
  if (input.scope === "conversation") {
    const conversationId = normalizeExactFilter(input.conversationId);
    if (conversationId === "") {
      throw new HttpError(400, 400, "Project storage conversation scope requires a conversation id.");
    }
    return { storageKind: input.storageKind, scope: "conversation", projectId, conversationId, key };
  }
  throw new HttpError(400, 400, `Invalid project storage scope "${String(input.scope)}".`);
}

function normalizeProjectStorageSource(
  source: KVWriteSource | undefined,
): KVWriteSource | undefined {
  if (source === undefined) {
    return undefined;
  }

  return {
    projectId: normalizeOptionalExactFilter(source.projectId),
    runId: normalizeOptionalExactFilter(source.runId),
    conversationId: normalizeOptionalExactFilter(source.conversationId),
  };
}

function normalizeOptionalExactFilter(value: string | undefined): string | undefined {
  const normalized = normalizeExactFilter(value);
  return normalized === "" ? undefined : normalized;
}

/**
 * Build the configured object storage backend.
 *
 * The Server stores objects on local disk, so this always returns a usable backend:
 * a checkout runs with no object-storage configuration at all, and a driver value
 * this build does not implement fails at startup instead of being ignored.
 */
export function createProjectObjectStorageFromEnv(options: {
  dataRoot: string;
  env?: NodeJS.ProcessEnv;
}): ObjectStorage {
  const env = options.env ?? process.env;
  resolveProjectStorageDriver(env);
  return createProjectLocalStorageFromEnv({ env, dataRoot: options.dataRoot });
}
export async function createStorageFromEnv(): Promise<Storage> {
  const { repoRoot, serverRoot } = resolveServerPathRoots();
  const dataRoot = resolveServerDataRootFromEnv({ serverRoot });
  const connectionString = process.env.STEAMHARNESS_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("STEAMHARNESS_DATABASE_URL is required for project storage.");
  const objectStorage = createProjectObjectStorageFromEnv({ dataRoot });
  const storage = new Storage({ repoRoot, serverRoot, dataRoot, db: new DatabaseRepository(connectionString),
    objectStorage, artifacts: new ArtifactStorage(objectStorage) });
  await storage.init();
  return storage;
}

async function validateProjectPackage(
  sourceDir: string,
  expectedId?: string,
  hostCoreVersion?: string,
): Promise<PackageMetadata> {
  if (!(await exists(path.join(sourceDir, "package.json")))) {
    throw new HttpError(400, 400, "Workflow package must contain package.json.");
  }

  try {
    const { resolveProjectEntry } = await import("@steamharness/project-manifest/node");
    const manifest = readProjectManifest(await readPackageJson(sourceDir));
    for (const entry of manifest.entries) {
      await resolveProjectEntry(sourceDir, entry.entryId);
      readProjectConfigurationDefinition(sourceDir, entry.entryId);
    }
  } catch (error) { throw new HttpError(400, 400, readErrorMessage(error)); }
  return readProjectPackageMetadata(sourceDir, expectedId, undefined, hostCoreVersion);
}

async function readProjectPackageMetadata(
  sourceDir: string,
  expectedId?: string,
  persistedProjectType?: ProjectKind,
  hostCoreVersion?: string,
): Promise<PackageMetadata> {
  if (!(await exists(path.join(sourceDir, "package.json")))) {
    throw new HttpError(400, 400, "Workflow package must contain package.json.");
  }

  const packageJson = await readPackageJson(sourceDir);
  const id = readRequiredPackageString(packageJson, "id");
  const name = readRequiredPackageString(packageJson, "name");
  const version = readRequiredPackageString(packageJson, "version");
  let requiredCoreVersion: string;
  try {
    requiredCoreVersion = readRequiredCoreVersion(packageJson);
  } catch (error) {
    throw new HttpError(400, 400, readErrorMessage(error));
  }

  if (!isProjectUuid(id)) {
    throw new HttpError(400, 400, createInvalidProjectUuidMessage(id, "project package id"));
  }

  if (!SEMVER_PATTERN.test(version)) {
    throw new HttpError(400, 400, `Workflow package version "${version}" must use x.y.z format.`);
  }

  if (expectedId !== undefined && id !== expectedId) {
    throw new HttpError(
      400,
      400,
      `Workflow package id "${id}" does not match requested id "${expectedId}".`,
    );
  }

  let manifest;
  try { manifest = readProjectManifest(packageJson); }
  catch (error) { throw new HttpError(400, 400, error instanceof Error ? error.message : 'Invalid aggregate project.'); }
  return {
    id,
    name,
    version,
    entries: manifest.entries,
    defaultEntry: manifest.defaultEntry,
    projectCard: readProjectCardMetadataFromPackageJson(packageJson, selectProjectEntry(manifest).type),
    projectInfo: readProjectInfo(packageJson),
    requiredCoreVersion,
  };
}

async function readPackageJson(sourceDir: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path.join(sourceDir, "package.json"), "utf8")) as unknown;
    if (isRecord(value)) {
      return value;
    }
    throw new Error("package.json root must be an object.");
  } catch (error) {
    throw new HttpError(400, 400, "Workflow package.json is invalid JSON.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readRequiredPackageString(
  packageJson: Record<string, unknown>,
  key: "id" | "name" | "version",
): string {
  const value = packageJson[key];

  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, 400, `Workflow package.json must include string "${key}".`);
  }

  return value.trim();
}

async function resolvePackageRoot(extractDir: string, expectedId?: string): Promise<string> {
  if (await isProjectPackageRoot(extractDir)) {
    if (expectedId === undefined) {
      return extractDir;
    }
    if (await packageRootMatchesExpectedId(extractDir, expectedId)) {
      return extractDir;
    }
  }

  const queue = [extractDir];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir || visited.has(currentDir)) {
      continue;
    }
    visited.add(currentDir);

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(currentDir, entry.name);
      if (await isProjectPackageRoot(candidate)) {
        // Workspace uploads may include sibling workflow sources, so
        // the server must locate the package root by matching the expected UUID.
        if (expectedId === undefined) {
          return candidate;
        }
        if (await packageRootMatchesExpectedId(candidate, expectedId)) {
          return candidate;
        }
      }
      queue.push(candidate);
    }
  }

  throw new HttpError(
    400,
    400,
    expectedId === undefined
      ? "Package root must contain package.json and the entry required by its project configuration."
      : `Package root must contain package.json and the configured entry for project "${expectedId}".`,
  );
}

async function isProjectPackageRoot(directory: string): Promise<boolean> {
  try { readProjectManifest(await readPackageJson(directory)); return true; } catch { return false; }
}

async function packageRootMatchesExpectedId(
  packageRoot: string,
  expectedId: string,
): Promise<boolean> {
  try {
    return (await readPackageJson(packageRoot))["id"] === expectedId;
  } catch {
    return false;
  }
}

async function copyProjectSource(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
}

async function copyUploadedProjectSource(sourceDir: string, targetDir: string): Promise<void> {
  try {
    await copyProjectUploadFiles(sourceDir, targetDir);
  } catch (error) {
    throw new HttpError(400, 400, readErrorMessage(error));
  }
}

async function replaceDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(path.dirname(targetDir), { recursive: true });
  const backupDir = `${targetDir}.${randomUUID()}.backup`;
  const hadTarget = await exists(targetDir);
  if (hadTarget) await rename(targetDir, backupDir);
  try {
    await rename(sourceDir, targetDir);
  } catch (error) {
    if (hadTarget) await rename(backupDir, targetDir);
    throw error;
  }
  await rm(backupDir, { recursive: true, force: true });
}

async function moveDirectoryIfAbsent(
  sourceDir: string,
  targetDir: string,
  conflictMessage: string,
): Promise<void> {
  await mkdir(path.dirname(targetDir), { recursive: true });
  try {
    await mkdir(targetDir);
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new HttpError(409, 409, conflictMessage);
    }
    throw error;
  }

  try {
    for (const entry of await readdir(sourceDir)) {
      await rename(path.join(sourceDir, entry), path.join(targetDir, entry));
    }
    await rm(sourceDir, { recursive: true, force: true });
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
}

async function writeProjectFiles(
  targetDir: string,
  files: File[],
): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  for (const file of files) {
    const safePath = normalizeProjectFilePath(file.path);
    const targetPath = path.join(targetDir, safePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, decodeProjectFileContent(file));
  }
}

function decodeProjectFileContent(file: FileInput): string | Buffer {
  if (file.encoding !== "base64") return file.content;
  if (file.content === "") return Buffer.alloc(0);
  const decoded = Buffer.from(file.content, "base64");
  if (decoded.toString("base64") !== file.content) {
    throw new HttpError(400, 400, `Workflow file "${file.path}" contains invalid base64 content.`);
  }
  return decoded;
}

async function createTarGz(sourceDir: string, archivePath: string): Promise<void> {
  await createTar({
    cwd: sourceDir,
    file: archivePath,
    gzip: true,
    portable: true,
    noMtime: true,
    follow: false,
    strict: true,
  }, ["."]);

  try {
    await validateTarEntries(archivePath);
  } catch (error) {
    throw new HttpError(
      500,
      500,
      `Failed to create portable project artifact archive. ${readErrorMessage(error)}`,
    );
  }
}

function isFileExistsError(error: unknown): boolean {
  return isRecord(error) && error["code"] === "EEXIST";
}

async function extractTarGz(
  archivePath: string,
  targetDir: string,
  options: { maxExpandedSizeBytes?: number } = {},
): Promise<number> {
  const expandedSize = await validateTarEntries(archivePath, options);
  try {
    await extractTar({
      file: archivePath,
      cwd: targetDir,
      gzip: true,
      strict: true,
      preservePaths: false,
    });
  } catch (error) {
    throw new HttpError(400, 400, "Failed to extract project artifact archive.", {
      error: readErrorMessage(error),
    });
  }
  return expandedSize;
}

async function readProjectFiles(
  rootDir: string,
  includeBinaryFiles: boolean,
): Promise<File[]> {
  const files: File[] = [];

  await walkFiles(rootDir, async (filePath) => {
    const relative = normalizeSlash(path.relative(rootDir, filePath));

    if (await isEditableTextFile(filePath)) {
      const content = await readFile(filePath, "utf8");
      files.push({
        path: relative,
        content,
        size: Buffer.byteLength(content),
      });
      return;
    }

    if (includeBinaryFiles) {
      const content = await readFile(filePath);
      files.push({
        path: relative,
        content: content.toString("base64"),
        size: content.byteLength,
        encoding: "base64",
      });
    }
  });

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function isEditableTextFile(filePath: string): Promise<boolean> {
  const fileStat = await stat(filePath);

  if (fileStat.size > TEXT_FILE_LIMIT_BYTES) {
    return false;
  }

  const extension = path.extname(filePath);
  const baseName = path.basename(filePath);

  if (
    !TEXT_EXTENSIONS.has(extension) &&
    baseName !== ".env.example" &&
    baseName !== ".steamharnessignore"
  ) {
    return false;
  }

  const buffer = await readFile(filePath);

  return !buffer.includes(0);
}

async function walkFiles(
  rootDir: string,
  visitor: (filePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      await walkFiles(fullPath, visitor);
      continue;
    }

    if (entry.isFile()) {
      await visitor(fullPath);
    }
  }
}

function normalizeProjectFilePath(filePath: string): string {
  const normalized = normalizeSlash(filePath).replace(/^\.\/+/, "");

  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new HttpError(400, 400, `Invalid project file path "${filePath}".`);
  }

  return normalized;
}

async function validateTarEntries(
  archivePath: string,
  options: { maxExpandedSizeBytes?: number } = {},
): Promise<number> {
  const entries: Array<Pick<ReadEntry, "path" | "type" | "size">> = [];
  try {
    await listTar({
      file: archivePath,
      gzip: true,
      strict: true,
      onReadEntry: (entry) => {
        entries.push({ path: entry.path, type: entry.type, size: entry.size });
      },
    });
  } catch (error) {
    throw new HttpError(400, 400, "Failed to inspect tar.gz package.", {
      error: readErrorMessage(error),
    });
  }
  return validateTarArchiveEntries(entries, options);
}

async function extractZipArchive(archivePath: string, targetDir: string): Promise<number> {
  let directory: Awaited<ReturnType<typeof openZip.file>>;
  try {
    directory = await openZip.file(archivePath);
  } catch (error) {
    throw new HttpError(400, 400, "Failed to inspect zip package.", {
      error: readErrorMessage(error),
    });
  }
  if (directory.files.length > MAX_ARCHIVE_ENTRY_COUNT) {
    throw new HttpError(400, 400, "Archive contains too many entries.");
  }
  const names: string[] = [];
  let expandedSize = 0;
  for (const entry of directory.files) {
    if (entry.type !== "File" && entry.type !== "Directory") {
      throw new HttpError(400, 400, `Archive entry "${entry.path}" uses unsupported type "${entry.type}".`);
    }
    const size = Number(entry.uncompressedSize ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new HttpError(400, 400, `Archive entry "${entry.path}" has an invalid size.`);
    }
    expandedSize += size;
    if (!Number.isSafeInteger(expandedSize) || expandedSize > MAX_ARCHIVE_EXPANDED_SIZE_BYTES) {
      throw new HttpError(400, 400, "Archive expanded size exceeds the 512 MB limit.");
    }
    names.push(entry.type === "Directory" && !/[\\/]$/u.test(entry.path) ? `${entry.path}/` : entry.path);
  }
  validateArchiveEntries(names);
  for (const entry of directory.files) {
    const relative = normalizeSlash(entry.path).replace(/^(?:\.\/)+/u, "").replace(/\/$/u, "");
    if (!relative) continue;
    const target = path.join(targetDir, ...relative.split("/"));
    if (entry.type === "Directory") {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await entry.buffer());
    }
  }
  return expandedSize;
}

export function validateArchiveEntries(entries: string[]): void {
  const normalizedPathPrefixes = new Map<string, string>();
  const normalizedEntryPaths = new Set<string>();
  const regularFilePaths = new Set<string>();
  const requiredDirectoryPaths = new Set<string>();
  for (const entry of entries) {
    const raw = entry.endsWith("\r") ? entry.slice(0, -1) : entry;
    const directory = /[\\/]$/.test(raw);
    const normalized = normalizeSlash(raw).replace(/^(?:\.\/)+/, "").replace(/\/$/, "");

    if (normalized === "" || normalized === ".") {
      continue;
    }

    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.includes("\0") ||
      normalized.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new HttpError(400, 400, `Unsafe archive entry "${entry}".`);
    }
    const parts = normalized.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const candidate = parts.slice(0, index).join("/");
      const portablePath = createProjectUploadPortablePathKey(candidate);
      const conflictingPath = normalizedPathPrefixes.get(portablePath);
      if (conflictingPath !== undefined && conflictingPath !== candidate) {
        throw new HttpError(
          400,
          400,
          `Duplicate or case-conflicting archive entry "${entry}" conflicts with "${conflictingPath}".`,
        );
      }
      normalizedPathPrefixes.set(portablePath, candidate);
      if (index < parts.length) {
        if (regularFilePaths.has(portablePath)) {
          throw new HttpError(
            400,
            400,
            `Archive entry "${entry}" uses file "${candidate}" as a directory.`,
          );
        }
        requiredDirectoryPaths.add(portablePath);
      }
    }
    const portableEntryPath = createProjectUploadPortablePathKey(normalized);
    if (normalizedEntryPaths.has(portableEntryPath)) {
      throw new HttpError(400, 400, `Duplicate archive entry "${entry}".`);
    }
    // Archives must extract identically across platforms. A path
    // cannot be both a regular file and an implied parent directory.
    if (!directory && requiredDirectoryPaths.has(portableEntryPath)) {
      throw new HttpError(400, 400, `Archive file entry "${entry}" conflicts with a directory path.`);
    }
    normalizedEntryPaths.add(portableEntryPath);
    if (!directory) regularFilePaths.add(portableEntryPath);
  }
}

export function validateTarArchiveEntries(
  entries: ReadonlyArray<{ path: string; type: string; size: number }>,
  options: { maxExpandedSizeBytes?: number } = {},
): number {
  if (entries.length > MAX_ARCHIVE_ENTRY_COUNT) {
    throw new HttpError(400, 400, "Archive contains too many entries.");
  }
  let expandedSize = 0;
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "ContiguousFile" && entry.type !== "Directory") {
      throw new HttpError(
        400,
        400,
        `Archive entry "${entry.path}" uses unsupported type "${entry.type}". Only regular files and directories are allowed.`,
      );
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new HttpError(400, 400, `Archive entry "${entry.path}" has an invalid size.`);
    }
    expandedSize += entry.size;
    const maxExpandedSizeBytes = options.maxExpandedSizeBytes ?? MAX_ARCHIVE_EXPANDED_SIZE_BYTES;
    if (!Number.isSafeInteger(expandedSize) || expandedSize > maxExpandedSizeBytes) {
      throw new HttpError(400, 400, "Archive expanded size exceeds the 512 MB limit.");
    }
    paths.push(
      entry.type === "Directory" && !/[\\/]$/.test(entry.path)
        ? `${entry.path}/`
        : entry.path,
    );
  }
  validateArchiveEntries(paths);
  return expandedSize;
}

function assertArchiveName(archiveName: string): void {
  if (
    archiveName.includes("/") ||
    archiveName.includes("\\") ||
    !(isTarGzipName(archiveName) || archiveName.endsWith(".zip"))
  ) {
    throw new HttpError(400, 400, "Archive name must end with .tar.gz, .tgz, or .zip.");
  }
}

function isTarGzipName(archiveName: string): boolean {
  return archiveName.endsWith(".tar.gz") || archiveName.endsWith(".tgz");
}

function assertVersion(version: string): void {
  if (!SEMVER_PATTERN.test(version)) {
    throw new HttpError(400, 400, `Invalid project version "${version}". Use x.y.z format.`);
  }
}

function parseSemver(version: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const [major, minor, patch] = version.split(".").map((part) => Number(part));

  return { major, minor, patch };
}

function formatNextManagedVersion(version: {
  major: number;
  minor: number;
  patch: number;
}): string {
  let major = version.major;
  let minor = version.minor;
  let patch = version.patch + 1;

  minor += Math.floor(patch / 100);
  patch %= 100;

  major += Math.floor(minor / 100);
  minor %= 100;

  return `${major}.${minor}.${patch}`;
}

function normalizeReleaseLog(value: string | undefined): string {
  return value?.trim() ?? "";
}

function compareSemverVersions(left: string, right: string): number {
  const leftSemver = parseSemver(left);
  const rightSemver = parseSemver(right);

  return leftSemver.major - rightSemver.major ||
    leftSemver.minor - rightSemver.minor ||
    leftSemver.patch - rightSemver.patch;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "unknown size";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function normalizeRunQuery(query: string | undefined): string {
  return query?.trim().toLowerCase() ?? "";
}

function normalizeExactFilter(value: string | undefined): string {
  return value?.trim() ?? "";
}

function resolveNextManagedVersionFromRecords(latest: string | null, versions: string[]): string {
  const candidates = latest !== null && SEMVER_PATTERN.test(latest)
    ? [latest, ...versions]
    : versions;
  const sorted = candidates
    .map(parseSemver)
    .sort((left, right) =>
      left.major - right.major ||
      left.minor - right.minor ||
      left.patch - right.patch,
    );
  const current = sorted.at(-1);

  return current === undefined ? "0.0.1" : formatNextManagedVersion(current);
}

function clampKVPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) {
    return 20;
  }

  return Math.min(Math.max(Math.floor(pageSize), 1), 100);
}

function createManagedFileId(): string {
  return `wf_${randomUUID().replaceAll("-", "")}`;
}

function assertManagedFileId(value: string): void {
  if (!MANAGED_FILE_ID_PATTERN.test(value)) {
    throw new HttpError(400, 400, `Invalid project file id "${value}".`);
  }
}

function assertManagedFileSize(size: number): void {
  const limit = readNumberEnv(
    "STEAMHARNESS_MANAGED_FILE_SIZE_LIMIT_BYTES",
    DEFAULT_MANAGED_FILE_SIZE_LIMIT_BYTES,
  );

  if (size > limit) {
    throw new HttpError(413, 413, `Workflow file exceeds ${formatBytes(limit)} limit.`);
  }
}

function normalizeManagedFileName(value: string): string {
  const name = path.basename(value.trim() || "file");
  return name.length > 180 ? name.slice(0, 180) : name;
}

function normalizeMimeType(value: string | undefined, fileName: string): string {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return normalized && normalized !== "application/octet-stream"
    ? normalized
    : guessMimeType(fileName);
}

function guessMimeType(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json";
    case ".txt":
    case ".md":
      return "text/plain";
    case ".wav":
      return "audio/wav";
    case ".aif":
    case ".aiff":
      return "audio/aiff";
    case ".flac":
      return "audio/flac";
    case ".alac":
      return "audio/alac";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".aac":
      return "audio/aac";
    case ".opus":
      return "audio/ogg";
    case ".ogg":
      return "audio/ogg";
    case ".webm":
      return "video/webm";
    case ".mp4":
      return "video/mp4";
    case ".m4v":
      return "video/x-m4v";
    case ".mov":
      return "video/quicktime";
    case ".avi":
      return "video/x-msvideo";
    case ".mkv":
      return "video/x-matroska";
    case ".ogv":
      return "video/ogg";
    case ".mpg":
    case ".mpeg":
      return "video/mpeg";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function requireKanbanActorId(value: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new HttpError(401, 401, "Login is required to use project configurations.");
  return normalized;
}

function normalizeKanbanNonce(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(normalized)) {
    throw new HttpError(400, 400, "Invalid Kanban preview nonce.");
  }
  return normalized;
}

async function assertKanbanAssetHasNoSymbolicLinks(
  projectRoot: string,
  assetPath: string,
): Promise<void> {
  let current = projectRoot;
  for (const segment of assetPath.split("/")) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new HttpError(404, 404, "Kanban asset does not exist.");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, 404, "Kanban asset does not exist.");
    }
  }
}

function assertResolvedPathInsideRoot(rootPath: string, targetPath: string, allowRoot: boolean): void {
  const relativePath = path.relative(rootPath, targetPath);
  if (
    (!allowRoot && relativePath === "") ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new HttpError(404, 404, "Kanban asset does not exist.");
  }
}

function createKanbanPreviewCapabilityToken(
  capability: StoredKanbanPreviewCapability,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(capability), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readKanbanPreviewCapabilityToken(
  token: string,
  secret: string,
): StoredKanbanPreviewCapability | undefined {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return undefined;
    const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (
      signatureBuffer.byteLength !== expectedBuffer.byteLength ||
      !timingSafeEqual(signatureBuffer, expectedBuffer)
    ) return undefined;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<
      StoredKanbanPreviewCapability
    >;
    if (
      parsed.version !== 1 ||
      typeof parsed.projectName !== "string" ||
      typeof parsed.resolvedTarget !== "string" ||
      typeof parsed.actorId !== "string" ||
      parsed.actorId.trim() === "" ||
      typeof parsed.expiresAtMs !== "number" ||
      !Number.isSafeInteger(parsed.expiresAtMs)
    ) return undefined;
    return parsed as StoredKanbanPreviewCapability;
  } catch {
    return undefined;
  }
}



interface StoredProjectAccessRequestToken {
  version: 1;
  projectId: string;
  expiresAtMs: number;
}

function createProjectAccessRequestToken(
  token: Omit<StoredProjectAccessRequestToken, "version">,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, ...token }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readProjectAccessRequestToken(
  token: string,
  secret: string,
): StoredProjectAccessRequestToken | undefined {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return undefined;
    const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
    const actual = Buffer.from(signature);
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<
      StoredProjectAccessRequestToken
    >;
    if (
      parsed.version !== 1 ||
      typeof parsed.projectId !== "string" ||
      !isProjectUuid(parsed.projectId) ||
      typeof parsed.expiresAtMs !== "number" ||
      !Number.isSafeInteger(parsed.expiresAtMs)
    ) return undefined;
    return parsed as StoredProjectAccessRequestToken;
  } catch {
    return undefined;
  }
}
async function hashDirectory(rootDir: string): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];

  await walkFiles(rootDir, async (filePath) => {
    files.push(filePath);
  });

  for (const filePath of files.sort()) {
    const relative = normalizeSlash(path.relative(rootDir, filePath));

    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);

    return true;
  } catch {
    return false;
  }
}

async function statIfExists(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeSlash(value: string): string {
  return value.replaceAll("\\", "/");
}

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
