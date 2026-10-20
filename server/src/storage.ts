import { applyConfigurationAction, configurationSnapshot, exportConfigurations, parseConfigurationDefinition, readConfigurationState, validateConfigurationAction, ProjectConfigurationError, type ProjectConfigurationAction, type ProjectConfigurationState, type ProjectConfigurationExport, type ProjectConfiguration } from "@steamharness/project-configuration";
import { createLocalProjectConfigurationStore } from "steamharness";

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { create as createTar, extract as extractTar, list as listTar, type ReadEntry } from "tar";
import { Open as openZip } from "unzipper";
import { copyProjectUploadFiles } from "@steamharness/project-upload/node";
import { createProjectUploadPortablePathKey } from "@steamharness/project-upload";
import { createKnowledgeDocument, createProjectKVContext, createProjectPersistentValueContext, createProjectRelatedProjectsContext, deleteKnowledgeDocument, editKnowledgeDocument, getKnowledgeDocument, isProjectKind, listKnowledgeDocumentPage, searchKnowledgeDocuments, readKnowledgeDocumentLines, HarnessError, type KVScope, type KVStore, type KVStoreGetInput, type KVWriteSource, type StorageKind, type ProjectKind, type StorageLocationContext, type KnowledgeDocument, type KnowledgeDocumentSummaryRecord, type KnowledgeSearchResultRecord, type KnowledgeDocumentLinesResult, type TokenUsageAggregate, type TokenUsageEntry, describeKnowledgeMutationKeys, isKnowledgeDocumentStorageKey } from "steamharness";
import { getAuthCookieSecret } from "./account-auth";
import { resolveServerPathRoots } from "./paths";
import { ArtifactStorage, createObjectPath, DatabaseRepository, type ProjectMemberRecord, type ProjectInvitationRecord, type ProjectRole, type Visibility, type DbRecord, type DbVersionRecord, type ProjectStorageRevisionEvent, type DeploymentRecord } from "./persistence";
import { HttpError, toHttpErrorWithStatus } from "./protocol";
import { createProjectLocalStorageFromEnv } from "./local-storage";
import { isProjectStorageNotFoundError, type ObjectStorage } from "./object-storage";
import { resolveProjectStorageDriver } from "./storage-driver";
import { resolveServerDataRootFromEnv } from "./release-paths";
import { createInvalidProjectUuidMessage, createUnsafeProjectIdMessage, isSafeProjectId, isProjectUuid, resolveProjectRoot } from "./workflow-ids";
import { generateProjectCardMetadata, readProjectCardMetadataFromPackageJson, type ProjectCardMetadata } from "@steamharness/project-card-metadata";
import { assertProjectDataStorageLocationAllowed, createDefaultProjectRelatedProjectGrant, isProjectAccessAllowed, isProjectKVAccessAllowed, normalizeDeclaredProjectInfoInput, normalizeProjectInfo, readProjectInfo, resolveProjectRelatedProjectAccess, writeProjectInfo, type DeclaredProjectInfo, type ProjectInfoContract, type RelatedProject, type RelatedProjectKVGrant } from "@steamharness/project-info";
import { createKanbanContentSecurityPolicy, createKanbanArtifactEntryPath, injectKanbanBridge, isSafeKanbanPublicAssetPath, readKanbanArtifactConfig, readKanbanAssetMimeType, readPackageProjectType, type KanbanArtifactConfig } from "@steamharness/kanban-project";
import { readRequiredCoreVersion } from "@steamharness/runtime-compatibility";
import { readServerBuildInfo, type ServerBuildInfo } from "./build-info";
import { STEAMHARNESS_PROJECT_GROUP_MANIFEST_FILE, createExternalProjectDependencyLocks, finalizeProjectDependencyLock, isProjectGroupHostDataPath, parseProjectDependencyLocks, parseProjectGroupManifest, type ProjectAccessRequest, type ProjectCapabilityGrant, type ProjectDependencyLock, type ProjectDependencyStatusResult, type ProjectDownloadPlan, type ProjectGroupManifestV1 } from "@steamharness/project-dependencies";
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

interface DeploymentPreparation {
  deploymentId: string;
  archiveName: string;
  createdAt: string;
}

export interface Summary {
  id: string;
  name: string;
  projectType: ProjectKind;
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
  canManage?: boolean;
  canWriteData?: boolean;
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
    dependencies: ProjectDependencyLock[];
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

/**
 * Whether a target's grant covers every key a knowledge mutation touches.
 *
 * The mutation is applied by the store as a whole — index bookkeeping included
 * — so the document it names and the index it is listed in both have to be
 * granted, on the side that is being read and the side that is being written.
 * A mutation whose keys cannot be named is refused: "cannot say" is not the
 * same as "touches nothing".
 */
export function isKnowledgeMutationGranted(
  grant: RelatedProjectKVGrant,
  mutation: PersistentValueKnowledgeMutation,
): boolean {
  const keys = describeKnowledgeMutationKeys(mutation);
  if (keys === undefined) return false;
  const covered = (
    // A grant written before Knowledge existed has no rule here at all, and
    // "no rule" is a refusal rather than an open door.
    rule: RelatedProjectKVGrant["read"] | undefined,
    key: string,
  ): boolean => isKnowledgeDocumentStorageKey(key) && isProjectAccessAllowed(rule, key);
  return keys.read.every((key) => covered(grant.knowledge?.read, key))
    && keys.write.every((key) => covered(grant.knowledge?.write, key));
}

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
  dependencies: ProjectDependencyLock[];
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
  projectType?: ProjectKind;
  dependencies?: ProjectDependencyLock[];
}

export interface ProjectGroupDownloadResult extends ProjectDownloadPlan {
  projects: Array<{
    alias?: string;
    projectId: string;
    projectName: string;
    version: string;
    sourceHash: string;
    role: "root" | "dependency";
    files: File[];
  }>;
}

export interface PackageMetadata {
  id: string;
  name: string;
  version: string;
  projectType: ProjectKind;
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
}

export interface ProjectCreateResult {
  projectId: string;
  projectName: string;
  projectType: ProjectKind;
  projectInfo: DeclaredProjectInfo;
  visibility: Visibility;
}

export interface RelatedProjectStatus {
  relation: RelatedProject;
  projectName?: string;
  reciprocalAlias?: string;
  grantFromRelatedProject?: RelatedProjectKVGrant;
  confirmed: boolean;
}

export interface RelatedProjectListResult {
  projectId: string;
  relatedProjects: RelatedProjectStatus[];
}

export interface KanbanWorkspaceState {
  projectId: string;
  projectName: string;
  target: string;
  resolvedTarget: string;
  artifactDir: string;
  entry: string;
  relatedProjects: RelatedProject[];
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
  resolvedTarget: string;
  actorId: string;
  expiresAtMs: number;
}

interface StoredProjectAccessRequestToken {
  version: 1;
  projectId: string;
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
  private readonly activeDeploymentPreparations = new Set<string>();
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
    await this.resumePendingPreparationJobs();
    await this.resumePendingProjectGroupPreparations();
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
    projectType: ProjectKind;
    projectInfo: DeclaredProjectInfo;
    ownerUserId?: string;
    visibility?: Visibility;
    createdByUserId?: string;
    projectCard?: ProjectCardMetadata;
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
      if (existing.name !== projectName) {
        throw new HttpError(409, 409, `Workflow "${projectId}" is already bound to "${existing.name}".`);
      }
      if (existing.projectType !== options.projectType) {
        throw new HttpError(
          409,
          409,
          `Workflow "${projectId}" was created as projectType "${existing.projectType}", not "${options.projectType}".`,
        );
      }
      if (options.ownerUserId) {
        const existingMember = await this.db.getProjectMember(projectId, options.ownerUserId);
        const ownsExisting = existing.ownerUserId === options.ownerUserId ||
          existing.createdByUserId === options.ownerUserId ||
          existingMember?.role === "owner" ||
          existingMember?.role === "manager";
        if (!ownsExisting) {
          throw new HttpError(409, 409, `Workflow "${projectId}" already exists and is owned by another account.`);
        }
      }
      const updated = await this.db.updateProjectInfo(
        projectId,
        projectName,
        projectInfo,
      );
      if (updated === undefined) {
        throw new HttpError(404, 404, `Workflow "${projectId}" does not exist.`);
      }
      if (options.projectCard !== undefined) {
        await this.db.updateProjectCard(projectId, options.projectCard);
      }
      await this.updateMaterializedDraftProjectInfo(projectId, projectName, projectInfo);
      return {
        projectId: updated.id,
        projectName: updated.name,
        projectType: updated.projectType,
        projectInfo,
        visibility: updated.visibility,
      };
    }

    let created: DbRecord;
    try {
      created = await this.db.createProjectRecord({
        projectId,
        projectName,
        projectType: options.projectType,
        projectCard: options.projectCard ?? generateProjectCardMetadata(options.projectType),
        projectInfo,
        packageVersion: "0.0.0",
        ownerUserId: options.ownerUserId,
        visibility: options.visibility ?? "private",
        createdByUserId: options.createdByUserId,
      });
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        throw new HttpError(409, 409, `Workflow "${projectName}" already exists.`);
      }
      throw error;
    }

    if (options.ownerUserId) {
      await this.db.upsertProjectMember({
        projectId,
        userId: options.ownerUserId,
        role: "owner",
        createdBy: options.createdByUserId ?? options.ownerUserId,
      });
    }

    return {
      projectId: created.id,
      projectName: created.name,
      projectType: created.projectType,
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

  async listRelatedProjects(projectId: string): Promise<RelatedProjectListResult> {
    this.assertProjectId(projectId);
    const db = this.requireProjectDependencyDatabase();
    const project = await db.getProject(projectId);
    if (project === undefined) {
      throw new HttpError(404, 404, `Workflow "${projectId}" does not exist.`);
    }
    const relatedProjects = await Promise.all(project.projectInfo.relatedProjects.map(async (relation) => {
      const target = await db.getProject(relation.projectId);
      const reciprocal = target?.projectInfo.relatedProjects.find(
        (item) => item.projectId.toLowerCase() === projectId.toLowerCase(),
      );
      const confirmed = target !== undefined && resolveProjectRelatedProjectAccess({
        consumerProjectId: projectId,
        consumerProjectInfo: project.projectInfo,
        targetProjectId: target.id,
        targetProjectInfo: target.projectInfo,
        alias: relation.alias,
      }) !== undefined;
      return {
        relation: cloneRelatedProject(relation),
        projectName: target?.name,
        reciprocalAlias: reciprocal?.alias,
        grantFromRelatedProject: reciprocal === undefined
          ? undefined
          : cloneRelatedProjectGrant(reciprocal.grantToRelatedProject),
        confirmed,
      } satisfies RelatedProjectStatus;
    }));
    return { projectId, relatedProjects };
  }

  async setRelatedProject(options: {
    projectId: string;
    alias: string;
    targetProjectId: string;
    grantToRelatedProject?: RelatedProject["grantToRelatedProject"];
    updateTarget: boolean;
    targetAlias?: string;
    targetGrantToRelatedProject?: RelatedProject["grantToRelatedProject"];
  }): Promise<RelatedProjectListResult> {
    this.assertProjectId(options.projectId);
    this.assertProjectId(options.targetProjectId);
    const db = this.requireProjectDependencyDatabase();
    const [project, target] = await Promise.all([
      db.getProject(options.projectId),
      db.getProject(options.targetProjectId),
    ]);
    if (project === undefined || target === undefined) {
      throw new HttpError(404, 404, "Related project does not exist.");
    }
    const projectInfo = this.normalizeDeclaredProjectInfo(upsertRelatedProject(
      project.projectInfo,
      {
        alias: options.alias,
        projectId: target.id,
        grantToRelatedProject: options.grantToRelatedProject ?? createDefaultProjectRelatedProjectGrant(),
      },
    ));
    const updates = [{ projectId: project.id, projectName: project.name, projectInfo }];
    let targetInfo: DeclaredProjectInfo | undefined;
    if (options.updateTarget) {
      const targetAlias = options.targetAlias?.trim();
      if (!targetAlias) {
        throw new HttpError(400, 400, "targetAlias is required when both projects are managed.");
      }
      targetInfo = this.normalizeDeclaredProjectInfo(upsertRelatedProject(
        target.projectInfo,
        {
          alias: targetAlias,
          projectId: project.id,
          grantToRelatedProject: options.targetGrantToRelatedProject ?? createDefaultProjectRelatedProjectGrant(),
        },
      ));
      updates.push({ projectId: target.id, projectName: target.name, projectInfo: targetInfo });
    }
    await db.updateProjectInfos(updates);
    await Promise.all([
      this.updateMaterializedDraftProjectInfo(project.id, project.name, projectInfo),
      ...(targetInfo === undefined
        ? []
        : [this.updateMaterializedDraftProjectInfo(target.id, target.name, targetInfo)]),
    ]);
    return this.listRelatedProjects(project.id);
  }

  async removeRelatedProject(options: {
    projectId: string;
    alias: string;
    updateTarget: boolean;
  }): Promise<{ removed: boolean; relatedProjects: RelatedProjectStatus[] }> {
    this.assertProjectId(options.projectId);
    const db = this.requireProjectDependencyDatabase();
    const project = await db.getProject(options.projectId);
    if (project === undefined) {
      throw new HttpError(404, 404, `Workflow "${options.projectId}" does not exist.`);
    }
    const relation = project.projectInfo.relatedProjects.find((item) => item.alias === options.alias);
    if (relation === undefined) {
      return { removed: false, relatedProjects: (await this.listRelatedProjects(project.id)).relatedProjects };
    }
    const projectInfo = this.normalizeDeclaredProjectInfo(removeRelatedProjectByAlias(
      project.projectInfo,
      options.alias,
    ));
    const updates = [{ projectId: project.id, projectName: project.name, projectInfo }];
    let target: DbRecord | undefined;
    let targetInfo: DeclaredProjectInfo | undefined;
    if (options.updateTarget) {
      target = await db.getProject(relation.projectId);
      if (target !== undefined) {
        targetInfo = this.normalizeDeclaredProjectInfo(removeRelatedProjectByProjectId(
          target.projectInfo,
          project.id,
        ));
        updates.push({ projectId: target.id, projectName: target.name, projectInfo: targetInfo });
      }
    }
    await db.updateProjectInfos(updates);
    await Promise.all([
      this.updateMaterializedDraftProjectInfo(project.id, project.name, projectInfo),
      ...(target !== undefined && targetInfo !== undefined
        ? [this.updateMaterializedDraftProjectInfo(target.id, target.name, targetInfo)]
        : []),
    ]);
    return { removed: true, relatedProjects: (await this.listRelatedProjects(project.id)).relatedProjects };
  }

  async resolveRelatedProjectKVAccess(options: {
    consumerProjectId: string;
    alias: string;
    key: string;
    operation: "read" | "write" | "update";
  }): Promise<{ targetProjectId: string }> {
    const access = await this.resolveConfirmedRelatedProject(options.consumerProjectId, options.alias);
    const readAllowed = isProjectKVAccessAllowed(access.grant.read, options.key);
    const writeAllowed = isProjectKVAccessAllowed(access.grant.write, options.key);
    const allowed = options.operation === "read"
      ? readAllowed
      : options.operation === "write"
        ? writeAllowed
        : readAllowed && writeAllowed;
    if (!allowed) {
      throw new HttpError(403, 403, "Related project KV access is not granted for this key.");
    }
    return { targetProjectId: access.targetProjectId };
  }

  /**
   * Whether a consumer may reach one of the target's knowledge keys.
   *
   * Knowledge is a grant of its own — a project that let another read its KV
   * never agreed to hand over its documents — and it is decided per key, so a
   * prefix rule opens the documents it names while the index every document is
   * listed in stays out of reach unless the rule covers that too.
   */
  async resolveRelatedProjectKnowledgeAccess(options: {
    consumerProjectId: string;
    alias: string;
    key: string;
    operation: "read" | "write";
  }): Promise<{ targetProjectId: string }> {
    const access = await this.resolveConfirmedRelatedProject(options.consumerProjectId, options.alias);
    const rule = options.operation === "read"
      ? access.grant.knowledge?.read
      : access.grant.knowledge?.write;
    if (!isKnowledgeDocumentStorageKey(options.key) || !isProjectAccessAllowed(rule, options.key)) {
      throw new HttpError(403, 403, "Related project Knowledge access is not granted for this key.");
    }
    return { targetProjectId: access.targetProjectId };
  }

  /**
   * Whether a consumer may apply this mutation to the target's knowledge base.
   *
   * A mutation is applied by the store as a whole — index bookkeeping included
   * — so the grant has to cover every key it reads and writes, not just the
   * index the document is listed in: a rule that names one document must not
   * let another be rewritten through the same call. A mutation whose keys
   * cannot be named is refused rather than trusted.
   */
  async resolveRelatedProjectKnowledgeMutationAccess(options: {
    consumerProjectId: string;
    alias: string;
    mutation: PersistentValueKnowledgeMutation;
  }): Promise<{ targetProjectId: string }> {
    const access = await this.resolveConfirmedRelatedProject(options.consumerProjectId, options.alias);
    if (!isKnowledgeMutationGranted(access.grant, options.mutation)) {
      throw new HttpError(403, 403, "Related project Knowledge access is not granted for this mutation.");
    }
    return { targetProjectId: access.targetProjectId };
  }

  async resolveConfirmedRelatedProject(
    consumerProjectId: string,
    alias: string,
  ): Promise<{ targetProjectId: string; grant: RelatedProjectKVGrant }> {
    this.assertProjectId(consumerProjectId);
    const db = this.requireProjectDependencyDatabase();
    const consumer = await db.getProject(consumerProjectId);
    if (consumer === undefined) {
      throw new HttpError(404, 404, "Related project is unavailable or awaiting confirmation.");
    }
    const declared = consumer.projectInfo.relatedProjects.find((item) => item.alias === alias);
    if (declared === undefined) {
      throw new HttpError(404, 404, "Related project is unavailable or awaiting confirmation.");
    }
    const target = await db.getProject(declared.projectId);
    if (target === undefined) {
      throw new HttpError(404, 404, "Related project is unavailable or awaiting confirmation.");
    }
    await this.assertServerProjectDataAccess(target.id);
    const access = resolveProjectRelatedProjectAccess({
      consumerProjectId: consumer.id,
      consumerProjectInfo: consumer.projectInfo,
      targetProjectId: target.id,
      targetProjectInfo: target.projectInfo,
      alias,
    });
    if (access === undefined) {
      throw new HttpError(404, 404, "Related project is unavailable or awaiting confirmation.");
    }
    return { targetProjectId: target.id, grant: access.grant };
  }

  async assertServerProjectDataAccess(projectId: string): Promise<ProjectInfoContract> {
    return this.assertServerProjectStorageMode(projectId, "access server data");
  }

  async listProjectMembers(projectId: string): Promise<ProjectMember[]> {
    this.assertProjectId(projectId);
    if (this.db === undefined) {
      return [];
    }
    return await this.db.listProjectMemberRecords(projectId);
  }

  async setProjectMember(options: {
    projectId: string;
    userId: string;
    role: ProjectRole;
    createdBy?: string;
  }): Promise<ProjectMember> {
    this.assertProjectId(options.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project member management requires PostgreSQL storage.");
    }
    return this.db.upsertProjectMember(options);
  }

  async removeProjectMember(projectId: string, userId: string): Promise<{ removed: boolean }> {
    this.assertProjectId(projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project member management requires PostgreSQL storage.");
    }
    return { removed: await this.db.deleteProjectMember(projectId, userId) };
  }

  async createProjectInvitation(options: {
    projectId: string;
    role: ProjectRole;
    createdBy?: string;
    ttlMs?: number;
  }): Promise<{ invitation: ProjectInvitation; token: string }> {
    this.assertProjectId(options.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project invitations require PostgreSQL storage.");
    }
    if (options.role === "owner") {
      throw new HttpError(400, 400, "Owner role cannot be granted via invitation.");
    }
    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const ttl = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    const invitation = await this.db.createProjectInvitation({
      id,
      projectId: options.projectId,
      token,
      role: options.role,
      createdBy: options.createdBy,
      expiresAt,
    });
    return { invitation, token };
  }

  async listProjectInvitations(projectId: string): Promise<ProjectInvitation[]> {
    this.assertProjectId(projectId);
    if (this.db === undefined) {
      return [];
    }
    return await this.db.listProjectInvitations(projectId);
  }

  async getInvitationByToken(token: string): Promise<ProjectInvitation | undefined> {
    if (this.db === undefined) {
      return undefined;
    }
    return await this.db.getProjectInvitationByToken(token);
  }

  async revokeProjectInvitation(
    projectId: string,
    invitationId: string,
  ): Promise<{ revoked: boolean }> {
    this.assertProjectId(projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project invitations require PostgreSQL storage.");
    }
    return { revoked: await this.db.revokeProjectInvitation(projectId, invitationId) };
  }

  async acceptInvitation(input: {
    token: string;
    acceptedBy: string;
  }): Promise<{ invitation: ProjectInvitation; member: ProjectMember }> {
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project invitations require PostgreSQL storage.");
    }
    const pending = await this.db.getProjectInvitationByToken(input.token);
    if (!pending) {
      throw new HttpError(404, 404, "Invitation not found.");
    }
    if (pending.acceptedAt) {
      throw new HttpError(409, 409, "Invitation already accepted.");
    }
    if (pending.revokedAt) {
      throw new HttpError(410, 410, "Invitation was revoked.");
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      throw new HttpError(410, 410, "Invitation expired.");
    }
    const accepted = await this.db.acceptProjectInvitation({
      id: pending.id,
      acceptedBy: input.acceptedBy,
    });
    if (!accepted) {
      throw new HttpError(409, 409, "Invitation could not be accepted.");
    }
    const member = await this.db.upsertProjectMember({
      projectId: pending.projectId,
      userId: input.acceptedBy,
      role: pending.role,
      createdBy: pending.createdBy ?? input.acceptedBy,
    });
    return { invitation: accepted, member };
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

  canReadProject(options: {
    access: ProjectAccessSummary;
    canReadAll?: boolean;
    canReadPublic?: boolean;
    userId?: string;
  }): boolean {
    if (options.canReadAll) return true;
    if (options.userId && options.access.member !== undefined) return true;
    return options.canReadPublic === true && options.access.visibility === "public";
  }

  canManageProject(options: {
    access: ProjectAccessSummary;
    canManageAll?: boolean;
    canManageOwn?: boolean;
    canUpload?: boolean;
    canPublish?: boolean;
    userId?: string;
  }): boolean {
    if (options.canManageAll) return true;
    if (!options.userId) return false;
    if (options.access.member?.role === "owner" || options.access.member?.role === "manager") {
      return true;
    }
    const isOwnerOrCreator = options.access.ownerUserId === options.userId || options.access.createdByUserId === options.userId;
    if (options.canManageOwn && isOwnerOrCreator) {
      return true;
    }
    return Boolean(
      options.canUpload ||
      options.canPublish,
    ) && isOwnerOrCreator;
  }

  canDownloadProjectSource(options: {
    access: ProjectAccessSummary;
    canDownloadSource?: boolean;
    userId?: string;
  }): boolean {
    if (options.canDownloadSource) return true;
    if (!options.userId) return false;
    return options.access.member?.role === "owner" ||
      options.access.member?.role === "manager";
  }

  assertReadableProject(options: {
    access: ProjectAccessSummary;
    canReadAll?: boolean;
    canReadPublic?: boolean;
    userId?: string;
  }): void {
    if (!this.canReadProject(options)) {
      throw new HttpError(403, 403, "Permission denied.");
    }
  }

  assertManageableProject(options: Parameters<Storage["canManageProject"]>[0]): void {
    if (!this.canManageProject(options)) {
      throw new HttpError(403, 403, "Permission denied.");
    }
  }

  assertDataWritableProject(options: { access: ProjectAccessSummary; userId?: string; canWriteAll?: boolean }): void {
    if (this.canWriteProjectData(options)) return;
    throw new HttpError(403, 403, "Project data write access is required.");
  }

  canWriteProjectData(options: { access: ProjectAccessSummary; userId?: string; canWriteAll?: boolean }): boolean {
    const role = options.access.member?.role;
    return options.canWriteAll === true || Boolean(options.userId && (role === "owner" || role === "manager" || role === "writer"));
  }

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
      dependencies: (version.dependencies ?? []).map(cloneProjectDependencyLock),
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
      await this.assertUploadedProjectType(options.projectName, metadata.projectType);

      await copyUploadedProjectSource(packageRoot, stagedSourceDir);
      await copyWorkspaceDependencySources(packageRoot, stagedSourceDir);
      await options.onStage?.("validating");
      await validateProjectPackage(
        stagedSourceDir,
        options.projectName,
      );

      const sourceHash = await hashDirectory(stagedSourceDir);
      await options.onStage?.("committing");
      await this.commitStagedDraft(options.projectName, stagedDraftDir);

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

    await this.assertProjectDoesNotExist(options.projectName);

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

  async getDownloadableSourceFiles(options: { projectName: string; target?: string }): Promise<{ projectId: string; projectName: string; target: string; resolvedTarget: string; files: File[] }> {
    this.assertProjectId(options.projectName);
    const target = options.target?.trim() || "latest";
    if (target === "draft") throw new HttpError(400, 400, "Download a published project version.");
    const resolved = await this.resolveSourceTarget(options.projectName, target);
    const metadata = await this.readPackageMetadataForTarget(options.projectName, resolved.resolvedTarget);
    return { projectId: options.projectName, projectName: metadata.name, target, resolvedTarget: resolved.resolvedTarget,
      files: await readProjectFiles(resolved.sourceDir, true) };
  }

  async createProjectGroupDeployment(options: {
    manifest: ProjectGroupManifestV1;
    releaseLog?: string;
    createdByUserId: string;
  }): Promise<DeploymentRecord> {
    const db = this.requireProjectDependencyDatabase();
    let manifest: ProjectGroupManifestV1;
    try {
      manifest = parseProjectGroupManifest(options.manifest);
    } catch (error) {
      throw toHttpErrorWithStatus(error, 400, 400, "Project group manifest is invalid.");
    }

    const root = await db.getProject(manifest.rootProjectId);
    if (root === undefined || root.projectType !== "kanban") {
      throw new HttpError(409, 409, "A project group root must be an existing Kanban project.");
    }
    for (const project of manifest.projects) {
      const record = await db.getProject(project.projectId);
      if (record === undefined) {
        throw new HttpError(409, 409, `Included project "${project.projectId}" does not exist on this Server.`);
      }
      if (project.role === "dependency" && record.projectType !== "workflow") {
        throw new HttpError(409, 409, `Included dependency "${project.projectId}" must be a Workflow project.`);
      }
    }

    const deployment = await db.createProjectDeployment({
      id: randomUUID(),
      rootProjectId: manifest.rootProjectId,
      manifest,
      releaseLog: normalizeReleaseLog(options.releaseLog),
      createdByUserId: options.createdByUserId,
    });
    try {
      return await this.reserveProjectGroupDeploymentVersions(deployment, false);
    } catch (error) {
      await db.releaseProjectDeploymentVersionReservations(deployment.id).catch(() => undefined);
      await db.updateProjectDeployment({
        id: deployment.id,
        status: "failed",
        error: readErrorMessage(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  async getProjectGroupDeployment(deploymentId: string): Promise<DeploymentRecord> {
    if (!isProjectUuid(deploymentId)) {
      throw new HttpError(400, 400, createInvalidProjectUuidMessage(deploymentId, "deployment id"));
    }
    const deployment = await this.requireProjectDependencyDatabase().getProjectDeployment(deploymentId);
    if (deployment === undefined) {
      throw new HttpError(404, 404, `Deployment "${deploymentId}" does not exist.`);
    }
    return deployment;
  }

  async prepareProjectGroupDeployment(options: {
    deploymentId: string;
    archiveName: string;
    archiveBuffer: Buffer;
  }): Promise<DeploymentRecord> {
    return this.withProjectGroupDeploymentLock(options.deploymentId, () =>
      this.prepareProjectGroupDeploymentLocked(options));
  }

  async enqueueProjectGroupPreparation(options: {
    deploymentId: string;
    archiveName: string;
    archiveBuffer: Buffer;
  }): Promise<DeploymentRecord> {
    assertArchiveName(options.archiveName);
    if (!isTarGzipName(options.archiveName)) {
      throw new HttpError(400, 400, "Project-group packages must use .tar.gz or .tgz format.");
    }

    return this.withProjectGroupDeploymentLock(options.deploymentId, async () => {
      const db = this.requireProjectDependencyDatabase();
      const deployment = await this.getProjectGroupDeployment(options.deploymentId);
      if (deployment.status !== "planned" && deployment.status !== "failed") {
        throw new HttpError(
          409,
          409,
          `Deployment "${deployment.id}" cannot accept a package from status "${deployment.status}".`,
        );
      }

      const preparation: DeploymentPreparation = {
        deploymentId: deployment.id,
        archiveName: options.archiveName,
        createdAt: new Date().toISOString(),
      };
      const preparationDir = this.deploymentPreparationDir(deployment.id);
      await rm(preparationDir, { recursive: true, force: true });
      await mkdir(preparationDir, { recursive: true });
      try {
        await writeFile(this.deploymentPreparationArchivePath(preparation), options.archiveBuffer);
        await writeJson(this.deploymentPreparationMetadataPath(deployment.id), preparation);
        const transitioned = await db.transitionProjectDeploymentStatus({
          id: deployment.id,
          from: ["planned", "failed"],
          status: "preparing",
        });
        if (!transitioned) {
          throw new HttpError(409, 409, `Deployment "${deployment.id}" is already being prepared or published.`);
        }
      } catch (error) {
        await rm(preparationDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      this.scheduleProjectGroupPreparation(preparation);
      return this.getProjectGroupDeployment(deployment.id);
    });
  }

  private scheduleProjectGroupPreparation(preparation: DeploymentPreparation): void {
    if (this.activeDeploymentPreparations.has(preparation.deploymentId)) return;
    this.activeDeploymentPreparations.add(preparation.deploymentId);
    setImmediate(() => {
      void this.runProjectGroupPreparation(preparation).finally(() => {
        this.activeDeploymentPreparations.delete(preparation.deploymentId);
      });
    });
  }

  private async runProjectGroupPreparation(preparation: DeploymentPreparation): Promise<void> {
    try {
      const archiveBuffer = await readFile(this.deploymentPreparationArchivePath(preparation));
      await this.prepareProjectGroupDeployment({
        deploymentId: preparation.deploymentId,
        archiveName: preparation.archiveName,
        archiveBuffer,
      });
    } catch (error) {
      await this.requireProjectDependencyDatabase().updateProjectDeployment({
        id: preparation.deploymentId,
        status: "failed",
        error: readErrorMessage(error),
      }).catch(() => undefined);
    } finally {
      await rm(this.deploymentPreparationDir(preparation.deploymentId), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }

  private async resumePendingProjectGroupPreparations(): Promise<void> {
    const root = this.deploymentPreparationsRoot();
    if (!(await exists(root))) return;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isProjectUuid(entry.name)) continue;
      const deployment = await this.requireProjectDependencyDatabase().getProjectDeployment(entry.name);
      if (deployment === undefined) continue;
      if (deployment.status !== "planned" && deployment.status !== "preparing") continue;

      const preparation = await readJson<DeploymentPreparation>(
        this.deploymentPreparationMetadataPath(entry.name),
      );
      const valid = preparation !== undefined &&
        preparation.deploymentId === entry.name &&
        isTarGzipName(preparation.archiveName) &&
        await exists(this.deploymentPreparationArchivePath(preparation));
      if (!valid) {
        await this.requireProjectDependencyDatabase().updateProjectDeployment({
          id: entry.name,
          status: "failed",
          error: "Project-group preparation archive is missing after server restart.",
        });
        continue;
      }

      if (deployment.status === "planned") {
        const transitioned = await this.requireProjectDependencyDatabase().transitionProjectDeploymentStatus({
          id: entry.name,
          from: ["planned"],
          status: "preparing",
        });
        if (!transitioned) continue;
      }
      this.scheduleProjectGroupPreparation(preparation);
    }
  }

  private async prepareProjectGroupDeploymentLocked(options: {
    deploymentId: string;
    archiveName: string;
    archiveBuffer: Buffer;
  }): Promise<DeploymentRecord> {
    assertArchiveName(options.archiveName);
    if (!isTarGzipName(options.archiveName)) {
      throw new HttpError(400, 400, "Project-group packages must use .tar.gz or .tgz format.");
    }
    const db = this.requireProjectDependencyDatabase();
    let deployment = await this.getProjectGroupDeployment(options.deploymentId);
    if (
      deployment.status !== "planned" &&
      deployment.status !== "failed" &&
      deployment.status !== "preparing"
    ) {
      throw new HttpError(409, 409, `Deployment "${deployment.id}" cannot be prepared from status "${deployment.status}".`);
    }

    const previousStatus = deployment.status;
    if (!await db.transitionProjectDeploymentStatus({
      id: deployment.id,
      from: ["planned", "failed", "preparing"],
      status: "preparing",
    })) {
      throw new HttpError(409, 409, `Deployment "${deployment.id}" is already being prepared or published.`);
    }
    try {
      deployment = await this.reserveProjectGroupDeploymentVersions(
        deployment,
        previousStatus === "failed",
      );
    } catch (error) {
      await db.updateProjectDeployment({
        id: deployment.id,
        status: "failed",
        error: readErrorMessage(error),
      }).catch(() => undefined);
      throw error;
    }
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const archivePath = path.join(tempDir, options.archiveName);
    const extractDir = path.join(tempDir, "group");
    try {
      const plannedVersions = new Map(deployment.items.map((item) => [item.projectId, item.plannedVersion!]));
      await mkdir(extractDir, { recursive: true });
      await writeFile(archivePath, options.archiveBuffer);
      let projectGroupExpandedSize = await this.extractArchive(
        archivePath,
        options.archiveName,
        extractDir,
      );
      const manifestPath = path.join(extractDir, STEAMHARNESS_PROJECT_GROUP_MANIFEST_FILE);
      let uploadedManifest: ProjectGroupManifestV1;
      try {
        uploadedManifest = parseProjectGroupManifest(
          JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
        );
      } catch (error) {
        throw new HttpError(400, 400, `Invalid ${STEAMHARNESS_PROJECT_GROUP_MANIFEST_FILE}: ${readErrorMessage(error)}`);
      }
      if (JSON.stringify(uploadedManifest) !== JSON.stringify(deployment.manifest)) {
        throw new HttpError(409, 409, "Uploaded project-group manifest does not match the deployment plan.");
      }

      const allowedFiles = new Set([
        STEAMHARNESS_PROJECT_GROUP_MANIFEST_FILE,
        ...uploadedManifest.projects.map((project) => project.archivePath),
      ]);
      await walkFiles(extractDir, async (filePath) => {
        const relativePath = normalizeSlash(path.relative(extractDir, filePath));
        if (!allowedFiles.has(relativePath) || isProjectGroupHostDataPath(relativePath)) {
          throw new HttpError(400, 400, `Project group contains forbidden file "${relativePath}".`);
        }
      });

      const orderedProjects = [...uploadedManifest.projects].sort((left, right) => (
        left.role === right.role ? 0 : left.role === "dependency" ? -1 : 1
      ));
      for (const project of orderedProjects) {
        await db.updateProjectDeploymentItem({
          deploymentId: deployment.id,
          projectId: project.projectId,
          status: "preparing",
          stage: "validating",
        });
        const projectArchivePath = path.join(extractDir, ...project.archivePath.split("/"));
        const innerExtractDir = path.join(tempDir, "inspect", project.projectId);
        await mkdir(innerExtractDir, { recursive: true });
        const remainingExpandedBytes = MAX_ARCHIVE_EXPANDED_SIZE_BYTES - projectGroupExpandedSize;
        projectGroupExpandedSize += await extractTarGz(projectArchivePath, innerExtractDir, {
          maxExpandedSizeBytes: remainingExpandedBytes,
        });
        await walkFiles(innerExtractDir, async (filePath) => {
          const relativePath = normalizeSlash(path.relative(innerExtractDir, filePath));
          if (isProjectGroupHostDataPath(relativePath)) {
            throw new HttpError(400, 400, `Included project "${project.projectId}" contains forbidden host data "${relativePath}".`);
          }
        });
        const packageRoot = await resolvePackageRoot(innerExtractDir, project.projectId);
        const metadata = await validateProjectPackage(
          packageRoot,
          project.projectId,
        );
        const plannedVersion = plannedVersions.get(project.projectId)!;
        if (metadata.version !== plannedVersion) {
          throw new HttpError(
            409,
            409,
            `Project "${project.projectId}" package version "${metadata.version}" does not match reserved version "${plannedVersion}".`,
            {
              projectId: project.projectId,
              packageVersion: metadata.version,
              expectedVersion: plannedVersion,
            },
          );
        }
        if (project.role === "root" && metadata.projectType !== "kanban") {
          throw new HttpError(409, 409, "The project-group root archive must contain a Kanban project.");
        }
        if (project.role === "dependency" && metadata.projectType !== "workflow") {
          throw new HttpError(409, 409, `Included dependency "${project.projectId}" must contain a Workflow project.`);
        }
        const result = await this.uploadPackage({
          projectName: project.projectId,
          archiveName: path.basename(project.archivePath),
          archiveBuffer: await readFile(projectArchivePath),
          onStage: async (stage) => db.updateProjectDeploymentItem({
            deploymentId: deployment.id,
            projectId: project.projectId,
            status: "preparing",
            stage,
          }),
        });
        await db.updateProjectDeploymentItem({
          deploymentId: deployment.id,
          projectId: project.projectId,
          status: "prepared",
          stage: "prepared",
          plannedVersion,
          preparedSourceHash: result.sourceHash,
        });
      }
      await db.updateProjectDeployment({ id: deployment.id, status: "prepared" });
    } catch (error) {
      await db.updateProjectDeployment({
        id: deployment.id,
        status: "failed",
        error: readErrorMessage(error),
      });
      throw error;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    return this.getProjectGroupDeployment(deployment.id);
  }

  async publishProjectGroupDeployment(deploymentId: string): Promise<DeploymentRecord> {
    return this.withProjectGroupDeploymentLock(deploymentId, () =>
      this.publishProjectGroupDeploymentLocked(deploymentId));
  }

  private async publishProjectGroupDeploymentLocked(
    deploymentId: string,
  ): Promise<DeploymentRecord> {
    const db = this.requireProjectDependencyDatabase();
    const deployment = await this.getProjectGroupDeployment(deploymentId);
    if (deployment.status === "published") return deployment;
    if (
      deployment.status !== "prepared" &&
      deployment.status !== "failed" &&
      deployment.status !== "publishing"
    ) {
      throw new HttpError(409, 409, `Deployment "${deployment.id}" must be prepared before publishing.`);
    }
    if (deployment.items.some((item) => !item.plannedVersion || !item.preparedSourceHash)) {
      throw new HttpError(409, 409, `Deployment "${deployment.id}" has not finished preparing every project.`);
    }
    const projectIds = deployment.items.map((item) => item.projectId).sort();

    if (!await db.transitionProjectDeploymentStatus({
      id: deployment.id,
      from: ["prepared", "failed", "publishing"],
      status: "publishing",
    })) {
      throw new HttpError(409, 409, `Deployment "${deployment.id}" is already being prepared or published.`);
    }
    try {
      await this.assertProjectGroupPublishReady(deployment);
      await this.withProjectPublishLocks(projectIds, async () => {
        const publishedDependencies = new Map<string, { version: string; sourceHash: string }>();
        const dependencyProjects = deployment.manifest.projects.filter((project) => project.role === "dependency");
        for (const project of dependencyProjects) {
          const item = deployment.items.find((candidate) => candidate.projectId === project.projectId)!;
          const existing = await this.resolvePublishedDeploymentItem(item);
          if (existing !== undefined) {
            publishedDependencies.set(project.projectId, existing);
            await db.updateProjectDeploymentItem({
              deploymentId: deployment.id,
              projectId: project.projectId,
              status: "published",
              stage: "published",
              publishedVersion: existing.version,
              publishedSourceHash: existing.sourceHash,
            });
            continue;
          }
          await this.assertReservedDeploymentVersion(item);
          await db.updateProjectDeploymentItem({
            deploymentId: deployment.id,
            projectId: project.projectId,
            status: "publishing",
            stage: "publishing",
          });
          const result = await this.publishLocked({
            projectName: project.projectId,
            releaseLog: deployment.releaseLog,
            createdByUserId: deployment.createdByUserId,
            expectedVersion: item.plannedVersion,
            expectedSourceHash: item.preparedSourceHash,
            reservationDeploymentId: deployment.id,
          });
          const publishedManifest = await this.readManifest(project.projectId, result.version);
          if (!publishedManifest) throw new Error(`Published dependency "${project.projectId}" has no manifest.`);
          publishedDependencies.set(project.projectId, {
            version: result.version,
            sourceHash: publishedManifest.sourceHash,
          });
          await db.updateProjectDeploymentItem({
            deploymentId: deployment.id,
            projectId: project.projectId,
            status: "published",
            stage: "published",
            publishedVersion: result.version,
            publishedSourceHash: publishedManifest.sourceHash,
          });
        }

        const dependencies = deployment.manifest.dependencies.map((dependency) => (
          finalizeProjectDependencyLock(dependency, publishedDependencies.get(dependency.projectId))
        ));
        const rootProject = deployment.manifest.projects.find((project) => project.role === "root")!;
        const rootItem = deployment.items.find((item) => item.projectId === rootProject.projectId)!;
        const existingRoot = await this.resolvePublishedDeploymentItem(rootItem);
        let rootVersion: string;
        let rootManifest: Manifest | undefined;
        if (existingRoot !== undefined) {
          if (JSON.stringify(existingRoot.manifest.dependencies ?? []) !== JSON.stringify(dependencies)) {
            throw new HttpError(409, 409, "The previously published Kanban root has a different dependency lock.");
          }
          rootVersion = existingRoot.version;
          rootManifest = existingRoot.manifest;
        } else {
          await this.assertReservedDeploymentVersion(rootItem);
          await db.updateProjectDeploymentItem({
            deploymentId: deployment.id,
            projectId: rootProject.projectId,
            status: "publishing",
            stage: "activating_root",
          });
          const rootResult = await this.publishLocked({
            projectName: rootProject.projectId,
            releaseLog: deployment.releaseLog,
            createdByUserId: deployment.createdByUserId,
            dependencies,
            expectedVersion: rootItem.plannedVersion,
            expectedSourceHash: rootItem.preparedSourceHash,
            reservationDeploymentId: deployment.id,
          });
          rootVersion = rootResult.version;
          rootManifest = await this.readManifest(rootProject.projectId, rootResult.version);
        }
        await db.updateProjectDeploymentItem({
          deploymentId: deployment.id,
          projectId: rootProject.projectId,
          status: "published",
          stage: "published",
          publishedVersion: rootVersion,
          publishedSourceHash: rootManifest?.sourceHash,
        });
      });
      await db.updateProjectDeployment({
        id: deployment.id,
        status: "published",
        publishedAt: new Date().toISOString(),
      });
    } catch (error) {
      await db.updateProjectDeployment({
        id: deployment.id,
        status: "failed",
        error: readErrorMessage(error),
      });
      throw error;
    }
    return this.getProjectGroupDeployment(deployment.id);
  }

  async getProjectDependencyStatus(options: {
    projectName: string;
    target?: string;
    canDownloadProject: (projectId: string) => Promise<boolean>;
    requestUrlForProject?: (projectId: string) => string;
  }): Promise<ProjectDependencyStatusResult> {
    const target = options.target?.trim() || "latest";
    const resolved = await this.resolveSourceTarget(options.projectName, target);
    const dependencies = resolved.resolvedTarget === "draft"
      ? createExternalProjectDependencyLocks(
          (await this.readPackageMetadataForTarget(options.projectName, "draft"))
            .projectInfo.relatedProjects,
        )
      : await this.readVersionDependencyLocks(options.projectName, resolved.resolvedTarget);
    const db = this.requireProjectDependencyDatabase();
    const statuses = await Promise.all(dependencies.map(async (dependency) => {
      const project = await db.getProject(dependency.projectId);
      const sourceAvailable = dependency.delivery === "included"
        ? await this.isPinnedProjectSourceAvailable(dependency)
        : project !== undefined;
      const sourceDownloadAllowed = project !== undefined && await options.canDownloadProject(dependency.projectId);
      const root = await db.getProject(options.projectName);
      const relationshipConfirmed = project !== undefined && root !== undefined &&
        resolveProjectRelatedProjectAccess({
          consumerProjectId: root.id,
          consumerProjectInfo: root.projectInfo,
          targetProjectId: project.id,
          targetProjectInfo: project.projectInfo,
          alias: dependency.alias,
        }) !== undefined;
      const dataInitialized = project !== undefined && await db.hasProjectKV(dependency.projectId);
      return {
        dependency: cloneProjectDependencyLock(dependency),
        projectName: project?.name,
        projectAvailable: project !== undefined,
        sourceAvailable,
        sourceDownloadAllowed,
        relationshipConfirmed,
        dataInitialized,
        ...(dependency.delivery === "included" && project !== undefined && sourceAvailable &&
          !sourceDownloadAllowed && options.requestUrlForProject
          ? { requestUrl: options.requestUrlForProject(dependency.projectId) }
          : {}),
      };
    }));
    return {
      rootProjectId: options.projectName,
      rootVersion: resolved.resolvedTarget,
      dependencies: statuses,
      publishable: statuses.every((status) => (
        status.projectAvailable &&
        status.relationshipConfirmed &&
        (status.dependency.delivery === "external" || status.sourceAvailable)
      )),
    };
  }

  async getProjectGroupDownload(options: {
    projectName: string;
    target?: string;
    canDownloadProject: (projectId: string) => Promise<boolean>;
    requestUrlForProject?: (projectId: string) => string;
  }): Promise<ProjectGroupDownloadResult> {
    const target = options.target?.trim() || "latest";
    if (target === "draft") throw new HttpError(400, 400, "Project groups can only download immutable published versions.");
    const resolved = await this.resolveSourceTarget(options.projectName, target);
    const rootManifest = (await this.readManifest(options.projectName, resolved.resolvedTarget))!;
    const dependencies = await this.readVersionDependencyLocks(options.projectName, resolved.resolvedTarget, rootManifest);
    const downloads: ProjectDownloadPlan["downloads"] = [];
    const skippedDependencies: ProjectDownloadPlan["skippedDependencies"] = [];
    downloads.push({
      projectId: options.projectName,
      version: resolved.resolvedTarget,
      sourceHash: rootManifest.sourceHash,
      projectName: rootManifest.projectName,
      role: "root",
    });
    const downloadsByProject = new Map<string, ProjectDownloadPlan["downloads"][number]>([
      [`${options.projectName}\0${resolved.resolvedTarget}\0${rootManifest.sourceHash}`, downloads[0]!],
    ]);
    for (const dependency of dependencies) {
      if (dependency.delivery === "external") {
        skippedDependencies.push({ dependency: cloneProjectDependencyLock(dependency), reason: "external" });
        continue;
      }
      if (!await this.isPinnedProjectSourceAvailable(dependency)) {
        skippedDependencies.push({ dependency: cloneProjectDependencyLock(dependency), reason: "source_unavailable" });
        continue;
      }
      if (!await options.canDownloadProject(dependency.projectId)) {
        skippedDependencies.push({
          dependency: cloneProjectDependencyLock(dependency),
          reason: "permission_required",
          ...(options.requestUrlForProject ? { requestUrl: options.requestUrlForProject(dependency.projectId) } : {}),
        });
        continue;
      }
      const metadata = await this.readPackageMetadataForTarget(dependency.projectId, dependency.version!);
      const downloadKey = `${dependency.projectId}\0${dependency.version}\0${dependency.sourceHash}`;
      const existingDownload = downloadsByProject.get(downloadKey);
      if (existingDownload !== undefined) {
        delete existingDownload.alias;
        continue;
      }
      const download = {
        alias: dependency.alias,
        projectId: dependency.projectId,
        version: dependency.version!,
        sourceHash: dependency.sourceHash!,
        projectName: metadata.name,
        role: "dependency",
      } satisfies ProjectDownloadPlan["downloads"][number];
      downloads.push(download);
      downloadsByProject.set(downloadKey, download);
    }
    const missingIncluded = skippedDependencies.some((item) => item.dependency.delivery === "included");
    const plan: ProjectDownloadPlan = {
      rootProjectId: options.projectName,
      rootVersion: resolved.resolvedTarget,
      dependencies: dependencies.map(cloneProjectDependencyLock),
      downloads,
      skippedDependencies,
      complete: !missingIncluded,
      copyAllowed: !missingIncluded,
    };
    const projects = await Promise.all(downloads.map(async (item) => {
      const source = await this.readRetainedSourceFiles(item.projectId, item.version);
      const forbiddenFile = source.files.find((file) => isProjectGroupHostDataPath(file.path));
      if (forbiddenFile !== undefined) {
        throw new HttpError(
          409,
          409,
          `Project "${item.projectId}" version "${item.version}" contains host data that cannot be included in a project-group download.`,
        );
      }
      return {
        alias: item.alias,
        projectId: item.projectId,
        projectName: source.projectName,
        version: item.version,
        sourceHash: item.sourceHash,
        role: item.role,
        files: source.files,
      };
    }));
    return { ...plan, projects };
  }

  async hasProjectSourceCapability(projectId: string, userId: string): Promise<boolean> {
    return this.requireProjectDependencyDatabase().hasProjectCapabilityGrant({
      projectId,
      userId,
      capability: "download_source",
    });
  }

  async listProjectSourceCapabilities(projectId: string): Promise<ProjectCapabilityGrant[]> {
    this.assertProjectId(projectId);
    return this.requireProjectDependencyDatabase().listProjectCapabilityGrants(projectId);
  }

  async listProjectAccessRequests(projectId: string): Promise<ProjectAccessRequest[]> {
    this.assertProjectId(projectId);
    return this.requireProjectDependencyDatabase().listProjectAccessRequests(projectId);
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
    const db = this.requireProjectDependencyDatabase();
    const project = await db.getProject(options.projectId);
    if (project === undefined) {
      throw new HttpError(404, 404, `Workflow "${options.projectId}" does not exist.`);
    }
    return db.createProjectAccessRequest({
      id: randomUUID(),
      projectId: options.projectId,
      requesterUserId: options.requesterUserId,
      capability: "download_source",
      reason,
    });
  }

  async resolveProjectAccessRequest(options: {
    projectId: string;
    requestId: string;
    status: "approved" | "rejected";
    resolvedByUserId?: string;
  }): Promise<ProjectAccessRequest> {
    const resolved = await this.requireProjectDependencyDatabase().resolveProjectAccessRequest({
      ...options,
    });
    if (resolved === undefined) {
      throw new HttpError(404, 404, `Pending access request "${options.requestId}" does not exist.`);
    }
    return resolved;
  }

  async revokeProjectSourceCapability(options: {
    projectId: string;
    userId: string;
    revokedByUserId?: string;
  }): Promise<{ revoked: boolean }> {
    return {
      revoked: await this.requireProjectDependencyDatabase().revokeProjectCapabilityGrant({
        ...options,
        capability: "download_source",
      }),
    };
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

  private async isPinnedProjectSourceAvailable(dependency: ProjectDependencyLock): Promise<boolean> {
    if (dependency.delivery !== "included" || !dependency.version || !dependency.sourceHash) return false;
    try {
      const manifest = await this.readManifest(dependency.projectId, dependency.version);
      return manifest?.sourceHash === dependency.sourceHash;
    } catch {
      return false;
    }
  }

  private async resolvePublishedDeploymentItem(
    item: DeploymentRecord["items"][number],
  ): Promise<{ version: string; sourceHash: string; manifest: Manifest } | undefined> {
    const version = item.publishedVersion ?? item.plannedVersion;
    const sourceHash = item.publishedSourceHash ?? item.preparedSourceHash;
    if (!version || !sourceHash) return undefined;
    const manifest = await this.readManifest(item.projectId, version);
    if (!manifest || manifest.sourceHash !== sourceHash) return undefined;
    return { version, sourceHash, manifest };
  }

  private async assertReservedDeploymentVersion(
    item: DeploymentRecord["items"][number],
  ): Promise<void> {
    if (!item.plannedVersion || !await this.requireProjectDependencyDatabase().hasProjectVersionReservation({
      deploymentId: item.deploymentId,
      projectId: item.projectId,
      version: item.plannedVersion,
    })) {
      throw new HttpError(409, 409, `Reserved version for project "${item.projectId}" changed.`, {
        expectedVersion: item.plannedVersion,
      });
    }
  }

  private async reserveProjectGroupDeploymentVersions(
    deployment: DeploymentRecord,
    reset: boolean,
  ): Promise<DeploymentRecord> {
    const db = this.requireProjectDependencyDatabase();
    const projectIds = deployment.items.map((item) => item.projectId).sort();
    return this.withProjectPublishLocks(projectIds, async () => {
      if (reset) {
        await db.resetProjectDeploymentItemsForPreparation(deployment.id);
      }
      let current = (await db.getProjectDeployment(deployment.id)) ?? deployment;
      for (const item of current.items) {
        if (item.plannedVersion !== undefined) continue;
        const requestedVersion = current.manifest.projects.find(
          (project) => project.projectId === item.projectId,
        )?.version;
        const plannedVersion = requestedVersion ?? await this.resolveNextVersion(item.projectId);
        await this.assertVersionPublishable(item.projectId, plannedVersion, deployment.id);
        await db.updateProjectDeploymentItem({
          deploymentId: deployment.id,
          projectId: item.projectId,
          status: "planned",
          stage: "version_reserved",
          plannedVersion,
        });
      }
      current = (await db.getProjectDeployment(deployment.id)) ?? current;
      if (current.items.some((item) => item.plannedVersion === undefined)) {
        throw new HttpError(409, 409, `Deployment "${deployment.id}" could not reserve every project version.`);
      }
      return current;
    });
  }

  private async assertProjectGroupPublishReady(deployment: DeploymentRecord): Promise<void> {
    const rootProject = deployment.manifest.projects.find((project) => project.role === "root");
    if (rootProject === undefined) {
      throw new HttpError(409, 409, "Project-group root is missing.");
    }
    const packageJson = await readPackageJson(this.draftSourceDir(rootProject.projectId));
    const rootProjectInfo = readProjectInfo(packageJson);
    const db = this.requireProjectDependencyDatabase();
    for (const actual of deployment.manifest.dependencies) {
      const expected = rootProjectInfo.relatedProjects.find(
        (relation) => relation.alias === actual.alias,
      );
      if (
        expected === undefined ||
        actual.projectId !== expected.projectId
      ) {
        throw new HttpError(
          409,
          409,
          `Project-group dependency ${JSON.stringify(actual.alias)} no longer matches the root project draft.`,
        );
      }
      const target = await db.getProject(actual.projectId);
      if (target === undefined || resolveProjectRelatedProjectAccess({
        consumerProjectId: rootProject.projectId,
        consumerProjectInfo: rootProjectInfo,
        targetProjectId: target.id,
        targetProjectInfo: target.projectInfo,
        alias: actual.alias,
      }) === undefined) {
        throw new HttpError(409, 409, "Project-group relationships must be confirmed before publishing.");
      }
    }
  }

  private requireProjectDependencyDatabase(): DatabaseRepository {
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project dependency delivery requires PostgreSQL storage.");
    }
    return this.db;
  }

  async saveManagedFiles(options: {
    projectName: string;
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

  async getKanbanWorkspace(options: {
    projectName: string;
    target?: string;
    actorId: string;
  }): Promise<KanbanWorkspaceState> {
    const project = await this.resolveKanbanProject(options.projectName, options.target);
    const state = await this.projectConfigurations(options, {action: "get"}) as ProjectConfigurationState;
    return { ...project, configurations: state.configurations.map(item => ({ ...item, values: configurationSnapshot(state, item.id, false).values })), activeConfigurationId: state.activeConfigurationId };

  }

  async resolveKanbanRelatedProject(options: {
    projectName: string;
    target?: string;
    alias: string;
  }): Promise<RelatedProject> {
    const project = await this.resolveKanbanProject(options.projectName, options.target);
    const relation = project.relatedProjects.find((item) => item.alias === options.alias);
    if (relation === undefined) {
      throw new HttpError(404, 404, "Kanban related project is unavailable.");
    }
    return relation;
  }

  async getKanbanRelatedProjectBindings(options: {
    projectName: string;
    target?: string;
  }): Promise<{
    resolvedTarget: string;
    relatedProjects: RelatedProject[];
  }> {
    this.assertProjectId(options.projectName);
    await this.assertServerProjectDataAccess(options.projectName);
    const target = options.target?.trim() || "draft";
    const resolved = await this.resolveSourceTarget(options.projectName, target);
    const metadata = await this.readPackageMetadataForTarget(
      options.projectName,
      resolved.resolvedTarget,
    );
    if (metadata.projectType !== "kanban") {
      throw new HttpError(409, 409, `Project "${metadata.name}" is not a Kanban project.`);
    }
    return {
      resolvedTarget: resolved.resolvedTarget,
      relatedProjects: metadata.projectInfo.relatedProjects.map(cloneRelatedProject),
    };
  }

  async getProjectStorageRevision(projectId: string): Promise<string> {
    this.assertProjectId(projectId);
    await this.assertServerProjectDataAccess(projectId);
    return this.db?.getProjectStorageRevision(projectId) ?? "0";
  }

  async subscribeProjectStorageRevisions(
    listener: (event: ProjectStorageRevisionEvent) => void,
  ): Promise<() => Promise<void>> {
    if (!this.db) return async () => undefined;
    this.projectStorageRevisionListeners.add(listener);
    try {
      this.projectStorageRevisionSubscription ??= this.db.listenProjectStorageRevisions((event) => {
        for (const current of this.projectStorageRevisionListeners) current(event);
      });
      await this.projectStorageRevisionSubscription;
    } catch (error) {
      this.projectStorageRevisionListeners.delete(listener);
      this.projectStorageRevisionSubscription = undefined;
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.projectStorageRevisionListeners.delete(listener);
      if (this.projectStorageRevisionListeners.size > 0) return;
      const subscription = this.projectStorageRevisionSubscription;
      this.projectStorageRevisionSubscription = undefined;
      if (subscription) await (await subscription)();
    };
  }

  async issueKanbanPreviewCapability(options: {
    projectName: string;
    target?: string;
    actorId: string;
  }): Promise<KanbanPreviewCapability> {
    const project = await this.resolveKanbanProject(options.projectName, options.target);
    const actorId = requireKanbanActorId(options.actorId);
    const now = Date.now();
    const expiresAtMs = now + KANBAN_PREVIEW_CAPABILITY_TTL_MS;
    const token = createKanbanPreviewCapabilityToken({
      version: 1,
      projectName: options.projectName,
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
        )
      : requireKanbanActorId(options.actorId ?? "");
    const project = await this.resolveKanbanProject(
      options.projectName,
      options.target,
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
      capability.resolvedTarget !== target
    ) {
      throw new HttpError(404, 404, "Kanban preview does not exist or has expired.");
    }
    return capability.actorId;
  }

  async projectConfigurations(options: { projectName: string; actorId: string; target?: string }, call: ProjectConfigurationAction): Promise<ProjectConfigurationState | ProjectConfigurationExport> {
    this.assertProjectId(options.projectName);
    const actor = requireKanbanActorId(options.actorId);
    const source = await this.resolveSourceTarget(options.projectName, options.target ?? "draft");
    try {
      validateConfigurationAction(call);
      if (!this.db) {
        const store = await createLocalProjectConfigurationStore(source.sourceDir, {
          rootDir: path.join(this.dataRoot, "project-configurations"), storageKey: JSON.stringify([options.projectName, actor]),
        });
        return await store.dispatch(call);
      }
      let fields: ProjectConfigurationState["fields"] = [];
      try { fields = parseConfigurationDefinition(JSON.parse(await readFile(path.join(source.sourceDir, "configuration.json"), "utf8"))).fields; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const initialId = `default-${createHash("sha256").update(JSON.stringify([options.projectName, actor])).digest("hex").slice(0,24)}`;
      const state = await this.db.projectConfigurationState(options.projectName, actor, stored => {
        const current = readConfigurationState(stored, fields, () => initialId);
        if (stored && JSON.stringify((stored as ProjectConfigurationState).fields) !== JSON.stringify(current.fields)) current.revision++;
        return call.action === "get" || call.action === "export" ? current : applyConfigurationAction(current,call,randomUUID);
      });
      return call.action === "export" ? exportConfigurations(state,call.id) : state;
    } catch (error) {
      if (error instanceof ProjectConfigurationError) throw new HttpError(error.code === "CONFIGURATION_CONFLICT" ? 409 : 400, error.code === "CONFIGURATION_CONFLICT" ? 409 : 400, error.message, {code:error.code});
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
        projectType: metadata.projectType,
        projectInfo: this.normalizeDeclaredProjectInfo(metadata.projectInfo),
        projectCard: metadata.projectCard,
        ownerUserId: options.ownerUserId,
        createdByUserId: options.ownerUserId,
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

  async deleteProject(projectName: string): Promise<DeleteProjectResult> {
    this.assertProjectId(projectName);
    const hasDbProject = this.db !== undefined
      ? (await this.db.getProject(projectName)) !== undefined
      : false;
    const hasFileProject = await exists(this.projectDirectory(projectName));

    if (!hasDbProject && !hasFileProject) {
      throw new HttpError(404, 404, `Workflow "${projectName}" does not exist.`);
    }

    if (this.db !== undefined) {
      await this.db.deleteProject(projectName);
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
    dependencies?: ProjectDependencyLock[];
    expectedVersion?: string;
    expectedSourceHash?: string;
  }): Promise<PublishResult> {
    this.assertProjectId(options.projectName);

    // Publish must reserve versions serially per project so
    // concurrent requests cannot compute and mutate the same next version.
    return this.withProjectPublishLock(options.projectName, () => this.publishLocked(options));
  }

  private async publishLocked(options: {
    projectName: string; releaseLog?: string; createdByUserId?: string; dependencies?: ProjectDependencyLock[];
    expectedVersion?: string; expectedSourceHash?: string; reservationDeploymentId?: string;
  }): Promise<PublishResult> {
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
      if (options.reservationDeploymentId && !await this.requireProjectDependencyDatabase().hasProjectVersionReservation({
        deploymentId: options.reservationDeploymentId, projectId: options.projectName, version })) {
        throw new HttpError(409, 409, "Project version reservation is unavailable.");
      }
      await this.assertVersionPublishable(options.projectName, version, options.reservationDeploymentId);
      const releaseLog = normalizeReleaseLog(options.releaseLog);
      const dependencies = await this.resolvePublishDependencyLocks({ projectName: options.projectName, sourceDir, projectType: metadata.projectType, dependencies: options.dependencies });
      const sourceHash = await hashDirectory(sourceDir);
      if (options.expectedSourceHash !== undefined && sourceHash !== options.expectedSourceHash) {
        throw new HttpError(409, 409, "Project draft changed after preparation.");
      }
      const artifacts = await this.uploadVersionArtifacts({ projectName: options.projectName, version, sourceHash, sourceDir });
      const manifest: Manifest = { projectId: options.projectName, projectName: metadata.name, version,
        createdAt: new Date().toISOString(), createdByUserId: options.createdByUserId, releaseLog, sourceHash,
        sourceObjectPath: artifacts?.sourceObjectPath, projectType: metadata.projectType, dependencies };
      await writeJson(path.join(stagedVersionDir, "manifest.json"), manifest);
      await moveDirectoryIfAbsent(stagedVersionDir, this.versionDir(options.projectName, version), "Project version already exists.");
      versionDirCreated = true;
      if (this.db) {
        await this.db.saveVersion({ ...manifest, sourceObjectPath: manifest.sourceObjectPath ?? "", releaseLog, dependencies, updateLatest: false });
        dbVersionCreated = true;
      }
      await this.activatePublishedVersion({ projectId: options.projectName, projectName: metadata.name, version });
      committed = true;
      return { projectId: options.projectName, projectName: metadata.name, version, latest: version,
        nextVersion: formatNextManagedVersion(parseSemver(version)), releaseLog, dependencies };
    } catch (error) {
      if (!committed && dbVersionCreated && version) await this.db?.deleteVersion(options.projectName, version);
      if (!committed && versionDirCreated && version) await rm(this.versionDir(options.projectName, version), { recursive: true, force: true });
      throw error;
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }

  private async resolvePublishDependencyLocks(options: {
    projectName: string;
    sourceDir: string;
    projectType: ProjectKind;
    dependencies?: ProjectDependencyLock[];
  }): Promise<ProjectDependencyLock[]> {
    const packageJson = await readPackageJson(options.sourceDir);
    const projectInfo = readProjectInfo(packageJson);
    const confirmed: RelatedProject[] = [];
    if (this.db !== undefined) {
      for (const relation of projectInfo.relatedProjects) {
        const target = await this.db.getProject(relation.projectId);
        if (target !== undefined && resolveProjectRelatedProjectAccess({
          consumerProjectId: options.projectName,
          consumerProjectInfo: projectInfo,
          targetProjectId: target.id,
          targetProjectInfo: target.projectInfo,
          alias: relation.alias,
        }) !== undefined) confirmed.push(relation);
      }
    }
    const declared = createExternalProjectDependencyLocks(confirmed);
    if (options.dependencies === undefined) {
      return declared;
    }

    let dependencies: ProjectDependencyLock[];
    try {
      dependencies = parseProjectDependencyLocks(options.dependencies, { published: true });
    } catch (error) {
      throw toHttpErrorWithStatus(error, 400, 400, "Project dependency lock is invalid.");
    }
    if (dependencies.length !== declared.length) {
      throw new HttpError(409, 409, "Published dependency lock does not match confirmed related projects.");
    }
    for (const expected of declared) {
      const actual = dependencies.find((dependency) => dependency.alias === expected.alias);
      if (
        actual === undefined ||
        actual.projectId !== expected.projectId
      ) {
        throw new HttpError(409, 409, `Published dependency lock ${JSON.stringify(expected.alias)} does not match a confirmed related project.`);
      }
    }
    return dependencies.map(cloneProjectDependencyLock);
  }

  async close(): Promise<void> {
    if (this.projectStorageRevisionSubscription) await (await this.projectStorageRevisionSubscription)();
    await this.db?.close();
  }

  async getProjectDataSummary(projectId: string): Promise<ProjectDataSummary> {
    this.assertProjectId(projectId);
    await this.assertServerProjectDataAccess(projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project data statistics require PostgreSQL storage.");
    }
    return this.db.getProjectDataSummary(projectId);
  }

  async listProjectKVEntries(options: {
    projectId: string;
    pageSize?: number;
    cursor?: string;
    scope?: "project" | "conversation";
    query?: string;
    valueType?: KVEntryValueType;
    conversationId?: string;
    runId?: string;
  }): Promise<KVEntryPage> {
    this.assertProjectId(options.projectId);
    await this.assertServerProjectDataAccess(options.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Server KV inspection requires PostgreSQL storage.");
    }

    return this.db.listProjectKVEntries({
      projectId: options.projectId,
      pageSize: clampKVPageSize(options.pageSize),
      cursor: options.cursor,
      scope: options.scope,
      query: normalizeRunQuery(options.query),
      valueType: options.valueType,
      conversationId: normalizeExactFilter(options.conversationId),
      runId: normalizeExactFilter(options.runId),
    });
  }

  async getProjectKVEntry(options: {
    projectId: string;
    scope: "project" | "conversation";
    key: string;
    conversationId?: string;
  }): Promise<KVEntryDetail> {
    this.assertProjectId(options.projectId);
    await this.assertServerProjectDataAccess(options.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Server KV inspection requires PostgreSQL storage.");
    }

    const key = normalizeExactFilter(options.key);
    if (key === "") {
      throw new HttpError(400, 400, "KV key must be a non-empty string.");
    }
    const conversationId = normalizeExactFilter(options.conversationId);
    if (options.scope === "conversation" && conversationId === "") {
      throw new HttpError(400, 400, "conversationId is required for conversation KV entries.");
    }

    const entry = await this.db.getProjectKVEntry({
      projectId: options.projectId,
      scope: options.scope,
      key,
      conversationId: options.scope === "conversation" ? conversationId : undefined,
    });
    if (entry === undefined) {
      throw new HttpError(404, 404, `Project KV entry "${key}" does not exist.`);
    }
    return entry;
  }

  async deleteProjectKVEntry(options: {
    projectId: string;
    scope: "project" | "conversation";
    key: string;
    conversationId?: string;
  }): Promise<{ scope: "project" | "conversation"; key: string; conversationId?: string }> {
    this.assertProjectId(options.projectId);
    await this.assertServerProjectDataAccess(options.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Server KV inspection requires PostgreSQL storage.");
    }

    const key = normalizeExactFilter(options.key);
    if (key === "") {
      throw new HttpError(400, 400, "KV key must be a non-empty string.");
    }
    const conversationId = normalizeExactFilter(options.conversationId);
    if (options.scope === "conversation" && conversationId === "") {
      throw new HttpError(400, 400, "conversationId is required for conversation KV entries.");
    }

    // Storage-level delete is idempotent, but the console is deleting a row it
    // is currently showing, so an already-absent entry is reported as missing
    // rather than silently succeeding.
    const removed = await this.db.deleteValue({
      storageKind: "kv",
      scope: options.scope,
      projectId: options.projectId,
      key,
      ...(options.scope === "conversation" ? { conversationId } : {}),
    });
    if (!removed) {
      throw new HttpError(404, 404, `Project KV entry "${key}" does not exist.`);
    }

    return {
      scope: options.scope,
      key,
      ...(options.scope === "conversation" ? { conversationId } : {}),
    };
  }

  async getProjectStorageValue(options: {
    storageKind: StorageKind;
    scope: KVScope;
    projectId: string;
    key: string;
    conversationId?: string;
  }): Promise<PersistentValueGetResult> {
    const input = normalizeProjectStorageInput(options);
    await this.assertServerProjectDataAccess(input.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "PersistentValue requires PostgreSQL storage.");
    }

    const value = await this.db.getValueWithRevision(input);
    return value === undefined
      ? { exists: false }
      : { exists: true, value: value.value, revision: value.revision };
  }

  async setProjectStorageValue(options: {
    storageKind: StorageKind;
    scope: KVScope;
    projectId: string;
    key: string;
    conversationId?: string;
    value: unknown;
    source?: KVWriteSource;
  }): Promise<{ ok: true }> {
    const input = normalizeProjectStorageInput(options);
    await this.assertServerProjectDataAccess(input.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "PersistentValue requires PostgreSQL storage.");
    }

    if (options.value === undefined) {
      throw new HttpError(400, 400, "Project storage value cannot be undefined.");
    }

    // HTTP writes share the storage-kind-isolated project domain with local clients.
    await this.db.setValue({
      ...input,
      value: options.value,
      source: normalizeProjectStorageSource(options.source),
    });
    return { ok: true };
  }

  async deleteProjectStorageValue(options: {
    storageKind: StorageKind;
    scope: KVScope;
    projectId: string;
    key: string;
    conversationId?: string;
  }): Promise<{ removed: boolean }> {
    const input = normalizeProjectStorageInput(options);
    await this.assertServerProjectDataAccess(input.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "PersistentValue requires PostgreSQL storage.");
    }

    return { removed: await this.db.deleteValue(input) };
  }

  async compareAndSetProjectStorageValue(options: {
    storageKind: StorageKind;
    scope: KVScope;
    projectId: string;
    key: string;
    conversationId?: string;
    value: unknown;
    expectedRevision: string | null;
    source?: KVWriteSource;
  }): Promise<PersistentValueCompareAndSetResult> {
    const input = normalizeProjectStorageInput(options);
    await this.assertServerProjectDataAccess(input.projectId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "PersistentValue requires PostgreSQL storage.");
    }

    if (options.value === undefined) {
      throw new HttpError(400, 400, "Project storage value cannot be undefined.");
    }

    return this.db.compareAndSetValue({
      ...input,
      value: options.value,
      source: normalizeProjectStorageSource(options.source),
    }, options.expectedRevision);
  }

  async mutateProjectStorageKnowledgeDocument(options: {
    projectId: string;
    mutation: PersistentValueKnowledgeMutation;
  }): Promise<KnowledgeDocumentRecord | { id: string; deleted: boolean }> {
    return this.withPersistentValueKnowledgeMutationContext<
      KnowledgeDocumentRecord | { id: string; deleted: boolean }
    >(
      options.projectId,
      async (context) => {
        switch (options.mutation.type) {
          case "create":
            return createKnowledgeDocument(context, options.mutation.input);
          case "edit":
            return editKnowledgeDocument(context, {
              id: options.mutation.input.documentId,
              title: options.mutation.input.title,
              markdown: options.mutation.input.markdown,
            });
          case "delete":
            return deleteKnowledgeDocument(context, options.mutation.input.documentId);
        }
      },
      { conflictAs: 409, notFoundAs: 404 },
    );
  }

  async listKnowledgeDocuments(
    projectName: string,
    options: { pageSize?: number; cursor?: string } = {},
  ): Promise<KnowledgeDocumentPageRecord> {
    this.assertProjectId(projectName);
    return this.withKnowledgeContext(projectName, (context) =>
      listKnowledgeDocumentPage(context, options));
  }

  async getKnowledgeDocument(options: {
    projectName: string;
    documentId: string;
  }): Promise<KnowledgeDocumentRecord> {
    this.assertProjectId(options.projectName);
    const document = await this.withKnowledgeContext(options.projectName, (context) =>
      getKnowledgeDocument(context, options.documentId));
    if (document === undefined) {
      throw new HttpError(404, 404, `Knowledge document "${options.documentId}" does not exist.`);
    }
    return document;
  }

  async createKnowledgeDocument(options: {
    projectName: string;
    id?: string;
    title: string;
    markdown: string;
  }): Promise<KnowledgeDocumentRecord> {
    this.assertProjectId(options.projectName);
    return this.withPersistentValueKnowledgeMutationContext(options.projectName, (context) =>
      createKnowledgeDocument(context, {
        id: options.id,
        title: options.title,
        markdown: options.markdown,
      }), { conflictAs: 409 });
  }

  async editKnowledgeDocument(options: {
    projectName: string;
    documentId: string;
    title?: string;
    markdown?: string;
  }): Promise<KnowledgeDocumentRecord> {
    this.assertProjectId(options.projectName);
    return this.withPersistentValueKnowledgeMutationContext(options.projectName, (context) =>
      editKnowledgeDocument(context, {
        id: options.documentId,
        title: options.title,
        markdown: options.markdown,
      }), { notFoundAs: 404 });
  }

  async deleteKnowledgeDocument(options: {
    projectName: string;
    documentId: string;
  }): Promise<{ id: string; deleted: boolean }> {
    this.assertProjectId(options.projectName);
    return this.withPersistentValueKnowledgeMutationContext(options.projectName, (context) =>
      deleteKnowledgeDocument(context, options.documentId));
  }

  async searchKnowledgeDocuments(options: {
    projectName: string;
    query: string;
    documentId?: string;
    beforeLines?: number;
    afterLines?: number;
    maxMatches?: number;
    pageSize?: number;
    cursor?: string;
  }): Promise<KnowledgeDocumentSearchResult> {
    this.assertProjectId(options.projectName);
    return this.withKnowledgeContext(options.projectName, (context) =>
      searchKnowledgeDocuments(context, {
        query: options.query,
        documentId: options.documentId,
        beforeLines: options.beforeLines,
        afterLines: options.afterLines,
        maxMatches: options.maxMatches,
        pageSize: options.pageSize,
        cursor: options.cursor,
      }), { notFoundAs: 404 });
  }

  async readKnowledgeDocumentLines(options: {
    projectName: string;
    documentId: string;
    startLine: number;
    endLine: number;
  }): Promise<KnowledgeDocumentLinesRecord> {
    this.assertProjectId(options.projectName);
    return this.withKnowledgeContext(options.projectName, (context) =>
      readKnowledgeDocumentLines(context, {
        documentId: options.documentId,
        startLine: options.startLine,
        endLine: options.endLine,
      }), { notFoundAs: 404 });
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

  private async commitStagedDraft(projectName: string, stagedDraftDir: string): Promise<void> {
    await this.withProjectPublishLock(projectName, async () => {
      const sourceDir = path.join(stagedDraftDir, "source");
      const metadata = await validateProjectPackage(sourceDir, projectName);
      await this.persistDraftFromSourceDir(projectName, sourceDir);
      await replaceDirectory(stagedDraftDir, this.draftDir(projectName));
      this.materializedDraftSourceRevisions.delete(projectName);
      if (!this.db) await writeJson(this.projectInfoMetadataPath(projectName), {
        name: metadata.name, projectInfo: this.normalizeDeclaredProjectInfo(metadata.projectInfo) });
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

  private async assertServerProjectStorageMode(
    projectId: string,
    action: "access server data",
  ): Promise<ProjectInfoContract> {
    this.assertProjectId(projectId);
    const stored = await this.db?.getProject(projectId);
    const projectInfo = stored?.projectInfo ?? (await this.readPackageMetadata(projectId)).projectInfo;
    try {
      assertProjectDataStorageLocationAllowed(projectInfo, "server");
      return projectInfo;
    } catch {
      const mode = projectInfo.dataStorage?.mode ?? null;
      const data = {
        projectId,
        dataStorageMode: mode,
        requiredLocation: "server" as const,
        allowedModes: ["server", "both"] as const,
      };
      if (mode === null) {
        throw new HttpError(
          409,
          409,
          `Project "${projectId}" cannot ${action} because steamHarness.projectInfo.dataStorage.mode is not declared. Open the project in Desktop and save Project Info before retrying.`,
          data,
          {
            messageKey: "server:projectDataStorageDeclarationRequired",
            params: { projectId, action },
          },
        );
      }
      throw new HttpError(
        409,
        409,
        `Project "${projectId}" cannot ${action} because data storage mode "${mode}" does not allow server storage.`,
        data,
        {
          messageKey: "server:projectDataStorageServerForbidden",
          params: { projectId, action, mode },
        },
      );
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
          projectType: record.projectType,
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

  private async readProjectMetadataForEditing(
    projectId: string,
  ): Promise<PackageMetadata> {
    try {
      return await this.readPackageMetadata(projectId);
    } catch (error) {
      const record = await this.db?.getProject(projectId);
      if (record !== undefined) {
        return {
          id: record.id,
          name: record.name,
          version: record.packageVersion,
          projectType: record.projectType,
          projectCard: record.projectCard,
          projectInfo: record.projectInfo,
          requiredCoreVersion: "unknown",
        };
      }
      throw error;
    }
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
    const reservations = this.db === undefined
      ? []
      : await this.db.listProjectVersionReservations(projectName);
    const candidates = latest !== null && SEMVER_PATTERN.test(latest)
      ? [latest, ...versions, ...reservations]
      : [...versions, ...reservations];
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
    reservationDeploymentId?: string,
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

    const reservations = this.db === undefined
      ? []
      : await this.db.listProjectVersionReservations(projectName, reservationDeploymentId);
    const conflictingReservation = reservations.find((candidate) => candidate === version);
    if (conflictingReservation !== undefined) {
      throw new HttpError(
        409,
        409,
        `Workflow "${projectName}" version "${version}" is reserved by another deployment.`,
        { projectId: projectName, version, reason: "version_reserved" },
      );
    }

    const higherVersion = [...existing, ...reservations]
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
          dependencies: record.dependencies.map(cloneProjectDependencyLock),
        };
      }
    }

    return readJson<Manifest>(this.versionManifestPath(projectName, version));
  }

  private async readVersionDependencyLocks(projectName: string, version: string, manifest?: Manifest): Promise<ProjectDependencyLock[]> {
    const stored = manifest ?? await this.readManifest(projectName, version);
    if (!stored) throw new HttpError(404, 404, "Published version does not exist.");
    try { return parseProjectDependencyLocks(stored.dependencies, { published: true }); }
    catch (error) { throw new HttpError(409, 409, "Invalid project dependency lock.", { reason: readErrorMessage(error) }); }
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

  private async withProjectPublishLocks<T>(
    projectNames: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const names = [...new Set(projectNames)].sort();
    const acquire = (index: number): Promise<T> => {
      const projectName = names[index];
      if (projectName === undefined) return operation();
      return this.withProjectPublishLock(projectName, () => acquire(index + 1));
    };
    return acquire(0);
  }

  private async withProjectGroupDeploymentLock<T>(
    deploymentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withLocalProjectGroupDeploymentLock(deploymentId, () =>
      this.db?.withProjectDeploymentLock(deploymentId, operation) ?? operation());
  }

  private async withLocalProjectGroupDeploymentLock<T>(
    deploymentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.deploymentLocks.get(deploymentId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.deploymentLocks.set(deploymentId, next);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.deploymentLocks.get(deploymentId) === next) {
        this.deploymentLocks.delete(deploymentId);
      }
    }
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
    return { id: record.id, name: record.name, projectType: record.projectType, projectCard: record.projectCard,
      projectInfo: record.projectInfo, ownerUserId: record.ownerUserId, visibility: record.visibility,
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
      projectType: metadata.projectType,
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
      createdByUserId: record.createdByUserId, member: this.db && userId ? await this.db.getProjectMember(record.id, userId) : undefined };
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
    await this.assertUploadedProjectType(projectName, metadata.projectType);
    await this.db.saveDraft({ projectId: metadata.id, projectName: metadata.name, projectType: metadata.projectType,
      packageVersion: metadata.version, projectCard: metadata.projectCard, projectInfo: this.normalizeDeclaredProjectInfo(metadata.projectInfo),
      files: await readProjectFiles(sourceDir, true) });
  }

  private async assertUploadedProjectType(
    projectId: string,
    sourceProjectType: ProjectKind,
  ): Promise<void> {
    if (this.db === undefined) {
      return;
    }
    const existing = await this.db.getProject(projectId);
    if (existing === undefined || existing.projectType === sourceProjectType) return;
    if (existing.hasDraft) return;
    if ((await this.db.listVersions(projectId)).length > 0) return;

    throw new HttpError(
      409,
      409,
      `Workflow "${projectId}" was created as projectType "${existing.projectType}", but package.json declares "${sourceProjectType}". Create a project with the matching type or update steamHarness.projectType before uploading.`,
    );
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

  private async resolveKanbanProject(
    projectName: string,
    requestedTarget?: string,
  ): Promise<Omit<KanbanWorkspaceState, "configurations" | "activeConfigurationId">> {
    this.assertProjectId(projectName);
    await this.assertServerProjectDataAccess(projectName);
    const target = requestedTarget?.trim() || "draft";
    const resolved = await this.resolveSourceTarget(projectName, target);
    const metadata = await this.readPackageMetadataForTarget(projectName, resolved.resolvedTarget);
    if (metadata.projectType !== "kanban") {
      throw new HttpError(409, 409, `Project "${metadata.name}" is not a Kanban project.`);
    }
    return {
      projectId: projectName,
      projectName: metadata.name,
      target,
      resolvedTarget: resolved.resolvedTarget,
      ...readKanbanArtifactConfig(await readPackageJson(resolved.sourceDir)),
      relatedProjects: metadata.projectInfo.relatedProjects.map(cloneRelatedProject),
    };
  }

  private async withKnowledgeContext<T>(
    projectName: string,
    run: (context: StorageLocationContext) => Promise<T>,
    options: { conflictAs?: number; notFoundAs?: number } = {},
  ): Promise<T> {
    this.assertProjectId(projectName);
    return this.withPersistentValueKnowledgeContext(projectName, run, options);
  }

  private async withPersistentValueKnowledgeContext<T>(
    projectName: string,
    run: (context: StorageLocationContext) => Promise<T>,
    options: { conflictAs?: number; notFoundAs?: number } = {},
  ): Promise<T> {
    await this.assertServerProjectDataAccess(projectName);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "PersistentValue knowledge base requires PostgreSQL storage.");
    }

    const context = this.createKnowledgeProjectContext(
      projectName,
    );
    try {
      return await run(context);
    } catch (error) {
      throw mapKnowledgeError(error, options);
    }
  }

  private async withPersistentValueKnowledgeMutationContext<T>(
    projectName: string,
    run: (context: StorageLocationContext) => Promise<T>,
    options: { conflictAs?: number; notFoundAs?: number } = {},
  ): Promise<T> {
    await this.assertServerProjectDataAccess(projectName);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "PersistentValue knowledge base requires PostgreSQL storage.");
    }

    this.assertProjectId(projectName);
    try {
      return await this.db.withNamespaceTransaction(
        { storageKind: "persistent_value", scope: "project", projectId: projectName },
        (store) => run(this.createKnowledgeProjectContext(projectName, store)),
      );
    } catch (error) {
      throw mapKnowledgeError(error, options);
    }
  }

  private createKnowledgeProjectContext(
    projectId: string,
    store?: KVStore,
  ): StorageLocationContext {
    const persistentStore = store ?? this.db;
    if (persistentStore === undefined) {
      throw new HttpError(501, 501, "Project knowledge base requires PostgreSQL storage.");
    }

    // The management knowledge base uses the same PersistentValue project
    // domain as local client writes, without introducing a new table.
    const source = { projectId };
    return {
      kv: createProjectKVContext({
        store: persistentStore,
        projectId,
        source,
      }),
      persistentValue: createProjectPersistentValueContext({
        store: persistentStore,
        projectId,
        source,
      }),
      relatedProjects: createProjectRelatedProjectsContext(),
    };
  }

  private projectsRoot(): string {
    return path.join(this.dataRoot, "projects");
  }

  private preparationsRoot(): string {
    return path.join(this.dataRoot, "preparations");
  }

  private deploymentPreparationsRoot(): string {
    return path.join(this.dataRoot, "deployment-preparations");
  }

  private deploymentPreparationDir(deploymentId: string): string {
    return path.join(this.deploymentPreparationsRoot(), deploymentId);
  }

  private deploymentPreparationMetadataPath(deploymentId: string): string {
    return path.join(this.deploymentPreparationDir(deploymentId), "preparation.json");
  }

  private deploymentPreparationArchivePath(
    preparation: Pick<DeploymentPreparation, "deploymentId" | "archiveName">,
  ): string {
    return path.join(this.deploymentPreparationDir(preparation.deploymentId), preparation.archiveName);
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

function cloneRelatedProject(relation: RelatedProject): RelatedProject {
  return {
    alias: relation.alias,
    projectId: relation.projectId,
    grantToRelatedProject: {
      read: relation.grantToRelatedProject.read.mode === "prefixes"
        ? { mode: "prefixes", prefixes: [...relation.grantToRelatedProject.read.prefixes] }
        : { mode: relation.grantToRelatedProject.read.mode },
      write: relation.grantToRelatedProject.write.mode === "prefixes"
        ? { mode: "prefixes", prefixes: [...relation.grantToRelatedProject.write.prefixes] }
        : { mode: relation.grantToRelatedProject.write.mode },
    },
  };
}

function cloneRelatedProjectGrant(
  grant: RelatedProjectKVGrant,
): RelatedProjectKVGrant {
  return {
    read: grant.read.mode === "prefixes"
      ? { mode: "prefixes", prefixes: [...grant.read.prefixes] }
      : { mode: grant.read.mode },
    write: grant.write.mode === "prefixes"
      ? { mode: "prefixes", prefixes: [...grant.write.prefixes] }
      : { mode: grant.write.mode },
  };
}

function upsertRelatedProject(
  projectInfo: ProjectInfoContract,
  relation: RelatedProject,
): ProjectInfoContract {
  const next = projectInfo.relatedProjects.filter((item) => item.alias !== relation.alias);
  const existingForProject = next.find(
    (item) => item.projectId.toLowerCase() === relation.projectId.toLowerCase(),
  );
  if (existingForProject !== undefined) {
    throw new HttpError(409, 409, "The related project is already declared with another alias.");
  }
  return { ...projectInfo, relatedProjects: [...next, cloneRelatedProject(relation)] };
}

function removeRelatedProjectByAlias(
  projectInfo: ProjectInfoContract,
  alias: string,
): ProjectInfoContract {
  return {
    ...projectInfo,
    relatedProjects: projectInfo.relatedProjects
      .filter((item) => item.alias !== alias)
      .map(cloneRelatedProject),
  };
}

function removeRelatedProjectByProjectId(
  projectInfo: ProjectInfoContract,
  projectId: string,
): ProjectInfoContract {
  return {
    ...projectInfo,
    relatedProjects: projectInfo.relatedProjects
      .filter((item) => item.projectId.toLowerCase() !== projectId.toLowerCase())
      .map(cloneRelatedProject),
  };
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

  const configurationPath = path.join(sourceDir, "configuration.json");
  if (await exists(configurationPath)) {
    try { parseConfigurationDefinition(JSON.parse(await readFile(configurationPath, "utf8"))); }
    catch (error) { throw new HttpError(400, 400, readErrorMessage(error)); }
  }
  const packageJson = await readPackageJson(sourceDir);
  if (readPackageProjectType(packageJson) === "kanban") {
    let artifact: KanbanArtifactConfig;
    try {
      artifact = readKanbanArtifactConfig(packageJson);
    } catch (error) {
      throw new HttpError(400, 400, readErrorMessage(error));
    }
    const artifactEntryPath = createKanbanArtifactEntryPath(artifact);
    const entryPath = path.join(sourceDir, ...artifactEntryPath.split("/"));
    const entryStat = await lstat(entryPath).catch(() => undefined);
    if (entryStat === undefined || !entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw new HttpError(400, 400, `Kanban package must contain regular artifact entry ${artifactEntryPath}.`);
    }
    try {
      await assertKanbanAssetHasNoSymbolicLinks(sourceDir, artifactEntryPath);
    } catch {
      throw new HttpError(400, 400, `Kanban artifact entry ${artifactEntryPath} must not contain symbolic links.`);
    }
    // Static Kanban projects follow the same Core compatibility contract.
    return readProjectPackageMetadata(
      sourceDir,
      expectedId,
      undefined,
      hostCoreVersion,
    );
  }

  if (!(await exists(path.join(sourceDir, "index.ts")))) {
    throw new HttpError(400, 400, "Workflow package must contain index.ts.");
  }
  return readProjectPackageMetadata(
    sourceDir,
    expectedId,
    undefined,
    hostCoreVersion,
  );
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

  const steamHarness = packageJson["steamHarness"];
  const projectType = isRecord(steamHarness) ? steamHarness["projectType"] : undefined;
  if (!isProjectKind(projectType)) {
    throw new HttpError(400, 400, "package.json.steamHarness.projectType must be workflow, conversation or kanban.");
  }
  if (persistedProjectType !== undefined && persistedProjectType !== projectType) {
    throw new HttpError(409, 409, "Uploaded project type does not match the stored project.");
  }

  return {
    id,
    name,
    version,
    projectType,
    projectCard: readProjectCardMetadataFromPackageJson(packageJson, projectType),
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
  if (!(await exists(path.join(directory, "package.json")))) return false;
  if (await exists(path.join(directory, "index.ts"))) return true;
  try {
    const packageJson = await readPackageJson(directory);
    if (readPackageProjectType(packageJson) !== "kanban") return false;
    const entryPath = createKanbanArtifactEntryPath(readKanbanArtifactConfig(packageJson));
    return exists(path.join(directory, ...entryPath.split("/")));
  } catch {
    return false;
  }
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

async function copyWorkspaceDependencySources(
  packageRoot: string,
  stagedSourceDir: string,
): Promise<void> {
  const dependencyRoots = await collectWorkspaceDependencyRoots(packageRoot);
  if (dependencyRoots.length === 0) {
    return;
  }

  const dependencyStoreRoot = path.join(stagedSourceDir, ".workspace-deps");
  await mkdir(dependencyStoreRoot, { recursive: true });

  for (const dependencyRoot of dependencyRoots) {
    await copyUploadedProjectSource(
      dependencyRoot,
      path.join(dependencyStoreRoot, path.basename(dependencyRoot)),
    );
  }
}

async function collectWorkspaceDependencyRoots(packageRoot: string): Promise<string[]> {
  const workspaceRoot = path.dirname(packageRoot);
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const dependencyRoots: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === path.basename(packageRoot)) {
      continue;
    }

    const candidate = path.join(workspaceRoot, entry.name);
    if (
      !(await exists(path.join(candidate, "package.json"))) ||
      !(await exists(path.join(candidate, "index.ts")))
    ) {
      continue;
    }

    try {
      await validateProjectPackage(candidate);
      dependencyRoots.push(candidate);
    } catch {
      // Ignore sibling directories that are not valid project packages.
    }
  }

  return dependencyRoots.sort((left, right) => left.localeCompare(right));
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

function cloneProjectDependencyLock(
  dependency: ProjectDependencyLock,
): ProjectDependencyLock {
  return {
    alias: dependency.alias,
    projectId: dependency.projectId,
    delivery: dependency.delivery,
    ...(dependency.version === undefined ? {} : { version: dependency.version }),
    ...(dependency.sourceHash === undefined ? {} : { sourceHash: dependency.sourceHash }),
  };
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
