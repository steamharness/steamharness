
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { create as createTar, extract as extractTar, list as listTar, type ReadEntry } from "tar";
import { Open as openZip } from "unzipper";
import { copyWorkflowUploadFiles } from "@steamharness/project-upload/node";
import { createWorkflowUploadPortablePathKey } from "@steamharness/project-upload";
import { createKnowledgeDocument, createWorkflowKVContext, createWorkflowPersistentValueContext, createWorkflowRelatedProjectsContext, deleteKnowledgeDocument, editKnowledgeDocument, getKnowledgeDocument, isWorkflowProjectType, listKnowledgeDocumentPage, searchKnowledgeDocuments, readKnowledgeDocumentLines, WorkflowError, type WorkflowKVScope, type WorkflowKVStore, type WorkflowKVStoreGetInput, type WorkflowKVWriteSource, type WorkflowStorageKind, type WorkflowProjectType, type WorkflowStorageLocationContext, type WorkflowKnowledgeDocument, type WorkflowKnowledgeDocumentSummary, type WorkflowKnowledgeSearchResult, type WorkflowKnowledgeDocumentLinesResult, type WorkflowTokenUsageAggregate, type WorkflowTokenUsageEntry, describeKnowledgeMutationKeys, isKnowledgeDocumentStorageKey } from "steamharness";
import { getAuthCookieSecret } from "./account-auth";
import { resolveServerPathRoots } from "./paths";
import { ArtifactStorage, createObjectPath, DatabaseRepository, type WorkflowProjectMemberRecord, type WorkflowProjectInvitationRecord, type WorkflowProjectRole, type WorkflowVisibility, type WorkflowDbRecord, type WorkflowDbVersionRecord, type WorkflowKanbanConfigurationStateRecord, type WorkflowProjectStorageRevisionEvent, type WorkflowDeploymentRecord } from "./persistence";
import { HttpError, toHttpErrorWithStatus } from "./protocol";
import { createWorkflowLocalStorageFromEnv } from "./local-storage";
import { isWorkflowStorageNotFoundError, type WorkflowObjectStorage } from "./object-storage";
import { resolveWorkflowStorageDriver } from "./storage-driver";
import { resolveServerDataRootFromEnv } from "./release-paths";
import { createInvalidWorkflowUuidMessage, createUnsafeWorkflowIdMessage, isSafeWorkflowId, isWorkflowUuid, resolveWorkflowRoot } from "./workflow-ids";
import { readProjectCardMetadataFromPackageJson, type ProjectCardMetadata } from "@steamharness/project-card-metadata";
import { assertWorkflowProjectDataStorageLocationAllowed, createDefaultWorkflowRelatedProjectGrant, isWorkflowProjectAccessAllowed, isWorkflowProjectKVAccessAllowed, normalizeDeclaredWorkflowProjectInfo, normalizeWorkflowProjectInfo, readWorkflowProjectInfo, resolveWorkflowRelatedProjectAccess, writeWorkflowProjectInfo, type DeclaredWorkflowProjectInfo, type WorkflowProjectInfo, type WorkflowRelatedProject, type WorkflowRelatedProjectKVGrant } from "@steamharness/project-info";
import { KANBAN_MANIFEST_FILE, areKanbanValuesEqual, createInjectedKanbanParams, createKanbanContentSecurityPolicy, createKanbanArtifactEntryPath, createDefaultKanbanValues, injectKanbanBridge, isSafeKanbanPublicAssetPath, parseKanbanManifestText, readKanbanArtifactConfig, readKanbanAssetMimeType, readPackageProjectType, sanitizeKanbanValues, type KanbanConfiguration, type KanbanArtifactConfig, type KanbanManifest } from "@steamharness/kanban-project";
import { readRequiredCoreVersion } from "@steamharness/runtime-compatibility";
import { readServerBuildInfo, type ServerBuildInfo } from "./build-info";
import { STEAMHARNESS_PROJECT_GROUP_MANIFEST_FILE, createExternalWorkflowProjectDependencyLocks, finalizeWorkflowProjectDependencyLock, isProjectGroupHostDataPath, parseWorkflowProjectDependencyLocks, parseWorkflowProjectGroupManifest, type WorkflowProjectAccessRequest, type WorkflowProjectCapabilityGrant, type WorkflowProjectDependencyLock, type WorkflowProjectDependencyStatusResult, type WorkflowProjectDownloadPlan, type WorkflowProjectGroupManifestV1 } from "@steamharness/project-dependencies";
export const PROJECT_CARD_IMAGE_MAX_BYTES = 1024 * 1024;
const PROJECT_CARD_IMAGE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_KANBAN_ASSET_SIZE_BYTES = 20 * 1024 * 1024;
const KANBAN_PREVIEW_CAPABILITY_TTL_MS = 15 * 60 * 1000;

export interface WorkflowFile {
  path: string;
  content: string;
  size: number;
  encoding?: "base64";
}

type WorkflowFileInput = Pick<WorkflowFile, "path" | "content" | "encoding">;

export type WorkflowManagedFileStorage = "server";
export type WorkflowManagedFileKind = "image" | "file";

export interface WorkflowManagedFileReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: WorkflowManagedFileKind;
  storage: WorkflowManagedFileStorage;
  workflowId?: string;
  conversationId?: string;
  createdAt: string;
}

export interface WorkflowProjectCardImage {
  workflowId: string;
  url: string;
  mimeType: "image/webp";
  size: number;
  hash: string;
}
export type WorkflowPreparationStatus = "queued" | "preparing" | "success" | "failed";
export type WorkflowPreparationStage =
  | "queued"
  | "extracting"
  | "validating"
  | "committing";

export interface WorkflowPreparationJob {
  jobId: string;
  workflowId: string;
  archiveName: string;
  createOnly: boolean;
  status: WorkflowPreparationStatus;
  stage: WorkflowPreparationStage;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  failureReason?: string;
  result?: UploadPackageResult;
}

interface WorkflowDeploymentPreparation {
  deploymentId: string;
  archiveName: string;
  createdAt: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  projectType: WorkflowProjectType;
  projectCard: ProjectCardMetadata;
  projectInfo: WorkflowProjectInfo;
  ownerUserId?: string;
  visibility: WorkflowVisibility;
  createdByUserId?: string;
  createdAt?: string;
  updatedAt?: string;
  hasDraft: boolean;
  latest: string | null;
  versions: string[];
  nextVersion: string;
  sourceDownload?: WorkflowSourceDownloadAvailability;
  canManage?: boolean;
  canWriteData?: boolean;
}

export interface WorkflowSourceDownloadAvailability {
  allowed: boolean;
  available: boolean;
  target: string | null;
}

export interface WorkflowSourceShare {
  id: string;
  name: string;
  version: string;
  createdAt: string;
  releaseLog?: string;
  sourceHash: string;
}

export interface WorkflowVersionSummary {
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
    createdByProfile?: WorkflowUserProfileSummary;
    releaseLog?: string;
    sourceHash?: string;
    sourceObjectPath?: string;
    dependencies: WorkflowProjectDependencyLock[];
    latest: boolean;
  }>;
}

export type WorkflowKVEntryScope = "project" | "conversation";
export type WorkflowKVEntryValueType =
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean";

export interface WorkflowKVEntrySummary {
  storageKind: WorkflowStorageKind;
  scope: WorkflowKVEntryScope;
  key: string;
  // KV list responses intentionally omit full values so the web
  // inspector does not freeze on large conversation state rows.
  value?: unknown;
  valueType: WorkflowKVEntryValueType;
  valueSizeBytes: number;
  valuePreview: string;
  projectId: string;
  conversationId?: string;
  updatedAt: string;
  lastProjectId?: string;
  lastRunId?: string;
  lastConversationId?: string;
}

export interface WorkflowKVEntryDetail extends WorkflowKVEntrySummary {
  value: unknown;
}

export interface WorkflowKVEntryPage {
  items: WorkflowKVEntrySummary[];
  nextCursor?: string;
  hasMore: boolean;
  // server/web KV pagination and Keys metrics use the full filtered total.
  total: number;
}

export interface WorkflowProjectDataSummary {
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

export interface WorkflowPersistentValueGetResult {
  exists: boolean;
  value?: unknown;
  revision?: string;
}

export interface WorkflowPersistentValueCompareAndSetResult {
  applied: boolean;
  revision?: string;
}

export type WorkflowPersistentValueKnowledgeMutation =
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
  grant: WorkflowRelatedProjectKVGrant,
  mutation: WorkflowPersistentValueKnowledgeMutation,
): boolean {
  const keys = describeKnowledgeMutationKeys(mutation);
  if (keys === undefined) return false;
  const covered = (
    // A grant written before Knowledge existed has no rule here at all, and
    // "no rule" is a refusal rather than an open door.
    rule: WorkflowRelatedProjectKVGrant["read"] | undefined,
    key: string,
  ): boolean => isKnowledgeDocumentStorageKey(key) && isWorkflowProjectAccessAllowed(rule, key);
  return keys.read.every((key) => covered(grant.knowledge?.read, key))
    && keys.write.every((key) => covered(grant.knowledge?.write, key));
}

export type WorkflowKnowledgeDocumentRecord = WorkflowKnowledgeDocument;
export type WorkflowKnowledgeDocumentListItem = WorkflowKnowledgeDocumentSummary;
export type WorkflowKnowledgeDocumentSearchResult = WorkflowKnowledgeSearchResult;
export type WorkflowKnowledgeDocumentLinesRecord = WorkflowKnowledgeDocumentLinesResult;

export interface WorkflowKnowledgeDocumentPage {
  items: WorkflowKnowledgeDocumentListItem[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface WorkflowTokenUsageWorkflowSummary {
  projectId: string;
  total: WorkflowTokenUsageAggregate;
  updatedAt?: string;
}

export interface WorkflowTokenUsagePage {
  systemTotal: WorkflowTokenUsageAggregate;
  projects: WorkflowTokenUsageWorkflowSummary[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface WorkflowTokenUsageDetail {
  projectId: string;
  projectTotal: WorkflowTokenUsageAggregate;
  conversationId?: string;
  conversationTotal?: WorkflowTokenUsageAggregate;
  entries?: WorkflowTokenUsageEntry[];
}

export interface UploadPackageResult {
  workflowId: string;
  workflowName: string;
  archiveName: string;
  sourceHash: string;
  nextVersion: string;
}

export interface SaveDraftFilesResult {
  workflowId: string;
  workflowName: string;
  updatedFiles: string[];
  removedFiles: string[];
  nextVersion: string;
}

export interface PublishResult {
  workflowId: string;
  workflowName: string;
  version: string;
  latest: string;
  nextVersion: string;
  releaseLog: string;
  dependencies: WorkflowProjectDependencyLock[];
}

export interface CloneWorkflowResult {
  workflowId: string;
  workflowName: string;
  sourceTarget: string;
  resolvedSourceTarget: string;
  nextVersion: string;
}

export interface UpdateWorkflowInfoResult {
  workflowId: string;
  workflowName: string;
  target: string;
  resolvedTarget: string;
}

export interface DeleteWorkflowResult {
  workflowId: string;
}

export interface WorkflowManifest {
  workflowId: string;
  workflowName: string;
  version: string;
  createdAt: string;
  createdByUserId?: string;
  releaseLog?: string;
  sourceHash: string;
  sourceObjectPath?: string;
  projectType?: WorkflowProjectType;
  dependencies?: WorkflowProjectDependencyLock[];
}

export interface WorkflowProjectGroupDownloadResult extends WorkflowProjectDownloadPlan {
  projects: Array<{
    alias?: string;
    projectId: string;
    projectName: string;
    version: string;
    sourceHash: string;
    role: "root" | "dependency";
    files: WorkflowFile[];
  }>;
}

export interface WorkflowPackageMetadata {
  id: string;
  name: string;
  version: string;
  projectType: WorkflowProjectType;
  projectCard: ProjectCardMetadata;
  projectInfo: WorkflowProjectInfo;
  requiredCoreVersion: string;
}

interface StoredWorkflowProjectInfoMetadata {
  name: string;
  projectInfo: WorkflowProjectInfo;
}

export interface WorkflowUserProfileSummary {
  userId: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

export type {
  WorkflowProjectRole,
  WorkflowVisibility,
};

export interface WorkflowProjectMember extends WorkflowProjectMemberRecord {
  profile?: WorkflowUserProfileSummary;
  createdByProfile?: WorkflowUserProfileSummary;
}

export interface WorkflowProjectInvitation extends WorkflowProjectInvitationRecord {
  createdByProfile?: WorkflowUserProfileSummary;
  acceptedByProfile?: WorkflowUserProfileSummary;
}

export interface WorkflowProjectAccessSummary {
  workflowId: string;
  workflowName: string;
  ownerUserId?: string;
  visibility: WorkflowVisibility;
  createdByUserId?: string;
  member?: WorkflowProjectMember;
}

export interface WorkflowProjectCreateResult {
  workflowId: string;
  workflowName: string;
  projectType: WorkflowProjectType;
  projectInfo: DeclaredWorkflowProjectInfo;
  visibility: WorkflowVisibility;
}

export interface WorkflowRelatedProjectStatus {
  relation: WorkflowRelatedProject;
  projectName?: string;
  reciprocalAlias?: string;
  grantFromRelatedProject?: WorkflowRelatedProjectKVGrant;
  confirmed: boolean;
}

export interface WorkflowRelatedProjectListResult {
  projectId: string;
  relatedProjects: WorkflowRelatedProjectStatus[];
}

export interface WorkflowKanbanWorkspaceState {
  workflowId: string;
  workflowName: string;
  target: string;
  resolvedTarget: string;
  artifactDir: string;
  entry: string;
  relatedProjects: WorkflowRelatedProject[];
  manifest?: KanbanManifest;
  configurations: KanbanConfiguration[];
  activeConfigurationId?: string;
}

export interface WorkflowKanbanAsset {
  content: Buffer | string;
  contentType: string;
  contentLength: number;
  contentSecurityPolicy: string;
}

export interface WorkflowKanbanPreviewCapability {
  token: string;
  resolvedTarget: string;
  expiresAt: string;
}

interface StoredKanbanPreviewCapability {
  version: 1;
  workflowName: string;
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
export class WorkflowStorage {
  readonly serverRoot: string;
  readonly repoRoot: string;
  readonly dataRoot: string;
  private readonly db?: DatabaseRepository;
  private readonly artifacts?: ArtifactStorage;
  readonly objectStorage?: WorkflowObjectStorage;
  private readonly publishLocks = new Map<string, Promise<void>>();
  private readonly deploymentLocks = new Map<string, Promise<void>>();
  private readonly preparationLocks = new Map<string, Promise<void>>();
  private readonly activePreparationJobs = new Set<string>();
  private readonly activeDeploymentPreparations = new Set<string>();
  private readonly kanbanConfigurationLocks = new Map<string, Promise<void>>();
  // HTML and its subresources can resolve the same database-backed
  // source concurrently; share materialization instead of deleting one directory twice.
  private readonly sourceMaterializationTasks = new Map<string, Promise<void>>();
  private readonly materializedDraftSourceRevisions = new Map<string, string>();
  private readonly projectStorageRevisionListeners = new Set<(
    event: WorkflowProjectStorageRevisionEvent,
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
    objectStorage?: WorkflowObjectStorage;
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
      console.warn("[workflow-server] artifact storage initialization failed; continuing with degraded artifact availability.");
    });
  }

  getBuildInfo(): ServerBuildInfo {
    return { ...this.requireBuildInfo() };
  }

  async createProject(options: {
    workflowId: string;
    workflowName: string;
    projectType: WorkflowProjectType;
    projectInfo: DeclaredWorkflowProjectInfo;
    ownerUserId?: string;
    visibility?: WorkflowVisibility;
    createdByUserId?: string;
    projectCard?: ProjectCardMetadata;
  }): Promise<WorkflowProjectCreateResult> {
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project creation API requires PostgreSQL storage.");
    }

    const workflowName = options.workflowName.trim();
    if (workflowName === "") {
      throw new HttpError(400, 400, "workflowName must not be empty.");
    }
    const workflowId = options.workflowId.trim();
    this.assertWorkflowId(workflowId);
    const projectInfo = this.normalizeDeclaredProjectInfo(options.projectInfo);

    const existing = await this.db.getWorkflow(workflowId);
    if (existing) {
      if (existing.name !== workflowName) {
        throw new HttpError(409, 409, `Workflow "${workflowId}" is already bound to "${existing.name}".`);
      }
      if (existing.projectType !== options.projectType) {
        throw new HttpError(
          409,
          409,
          `Workflow "${workflowId}" was created as projectType "${existing.projectType}", not "${options.projectType}".`,
        );
      }
      if (options.ownerUserId) {
        const existingMember = await this.db.getWorkflowMember(workflowId, options.ownerUserId);
        const ownsExisting = existing.ownerUserId === options.ownerUserId ||
          existing.createdByUserId === options.ownerUserId ||
          existingMember?.role === "owner" ||
          existingMember?.role === "manager";
        if (!ownsExisting) {
          throw new HttpError(409, 409, `Workflow "${workflowId}" already exists and is owned by another account.`);
        }
      }
      const updated = await this.db.updateWorkflowProjectInfo(
        workflowId,
        workflowName,
        projectInfo,
      );
      if (updated === undefined) {
        throw new HttpError(404, 404, `Workflow "${workflowId}" does not exist.`);
      }
      if (options.projectCard !== undefined) {
        await this.db.updateWorkflowProjectCard(workflowId, options.projectCard);
      }
      await this.updateMaterializedDraftProjectInfo(workflowId, workflowName, projectInfo);
      return {
        workflowId: updated.id,
        workflowName: updated.name,
        projectType: updated.projectType,
        projectInfo,
        visibility: updated.visibility,
      };
    }

    let created: WorkflowDbRecord;
    try {
      created = await this.db.createWorkflowProject({
        workflowId,
        workflowName,
        projectType: options.projectType,
        projectCard: options.projectCard ?? createDefaultProjectCardMetadata(options.projectType),
        projectInfo,
        packageVersion: "0.0.0",
        ownerUserId: options.ownerUserId,
        visibility: options.visibility ?? "private",
        createdByUserId: options.createdByUserId,
      });
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        throw new HttpError(409, 409, `Workflow "${workflowName}" already exists.`);
      }
      throw error;
    }

    if (options.ownerUserId) {
      await this.db.upsertWorkflowMember({
        workflowId,
        userId: options.ownerUserId,
        role: "owner",
        createdBy: options.createdByUserId ?? options.ownerUserId,
      });
    }

    return {
      workflowId: created.id,
      workflowName: created.name,
      projectType: created.projectType,
      projectInfo,
      visibility: created.visibility,
    };
  }

  async saveProjectCardImage(options: {
    workflowName: string;
    buffer: Buffer;
    origin: string;
  }): Promise<WorkflowProjectCardImage> {
    this.assertWorkflowId(options.workflowName);
    assertProjectCardImage(options.buffer);

    const hash = createHash("sha256").update(options.buffer).digest("hex");
    const imageDir = this.projectCardImageDir(options.workflowName);
    const imagePath = this.projectCardImagePath(options.workflowName, hash);
    const tempPath = path.join(imageDir, `.${hash}-${randomUUID()}.tmp`);

    await mkdir(imageDir, { recursive: true });
    if (!(await exists(imagePath))) {
      await writeFile(tempPath, options.buffer);
      await rename(tempPath, imagePath);
    }

    return {
      workflowId: options.workflowName,
      url: `${options.origin.replace(/\/+$/, "")}/project-card-images/${options.workflowName}/${hash}.webp`,
      mimeType: "image/webp",
      size: options.buffer.byteLength,
      hash,
    };
  }

  async getProjectCardImage(workflowName: string, hash: string): Promise<{
    filePath: string;
    size: number;
    hash: string;
  }> {
    this.assertWorkflowId(workflowName);
    assertProjectCardImageHash(hash);
    const filePath = this.projectCardImagePath(workflowName, hash);
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
    workflowName: string;
    projectCard: ProjectCardMetadata;
  }): Promise<ProjectCardMetadata> {
    this.assertWorkflowId(options.workflowName);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project card updates require PostgreSQL storage.");
    }

    const updated = await this.db.updateWorkflowProjectCard(
      options.workflowName,
      options.projectCard,
    );
    if (updated === undefined) {
      throw new HttpError(404, 404, `Workflow "${options.workflowName}" does not exist.`);
    }

    return updated.projectCard;
  }

  async updateProjectInfoMetadata(options: {
    workflowName: string;
    name: string;
    projectInfo: DeclaredWorkflowProjectInfo;
  }): Promise<{ name: string; projectInfo: DeclaredWorkflowProjectInfo }> {
    this.assertWorkflowId(options.workflowName);
    const name = options.name.trim();
    if (name === "") throw new HttpError(400, 400, "name must not be empty.");
    const projectInfo = this.normalizeDeclaredProjectInfo(options.projectInfo);
    if (this.db !== undefined) {
      const updated = await this.db.updateWorkflowProjectInfo(
        options.workflowName,
        name,
        projectInfo,
      );
      if (updated === undefined) {
        throw new HttpError(404, 404, `Workflow "${options.workflowName}" does not exist.`);
      }
      await this.updateMaterializedDraftProjectInfo(options.workflowName, name, projectInfo);
      return { name: updated.name, projectInfo };
    }

    if (
      !(await exists(this.draftSourceDir(options.workflowName))) &&
      (await this.readLatest(options.workflowName)) === null
    ) {
      throw new HttpError(404, 404, `Workflow "${options.workflowName}" does not exist.`);
    }
    await this.updateMaterializedDraftProjectInfo(options.workflowName, name, projectInfo);
    await writeJson(this.workflowProjectInfoMetadataPath(options.workflowName), { name, projectInfo });
    return { name, projectInfo };
  }

  async listRelatedProjects(projectId: string): Promise<WorkflowRelatedProjectListResult> {
    this.assertWorkflowId(projectId);
    const db = this.requireProjectDependencyDatabase();
    const project = await db.getWorkflow(projectId);
    if (project === undefined) {
      throw new HttpError(404, 404, `Workflow "${projectId}" does not exist.`);
    }
    const relatedProjects = await Promise.all(project.projectInfo.relatedProjects.map(async (relation) => {
      const target = await db.getWorkflow(relation.projectId);
      const reciprocal = target?.projectInfo.relatedProjects.find(
        (item) => item.projectId.toLowerCase() === projectId.toLowerCase(),
      );
      const confirmed = target !== undefined && resolveWorkflowRelatedProjectAccess({
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
      } satisfies WorkflowRelatedProjectStatus;
    }));
    return { projectId, relatedProjects };
  }

  async setRelatedProject(options: {
    projectId: string;
    alias: string;
    targetProjectId: string;
    grantToRelatedProject?: WorkflowRelatedProject["grantToRelatedProject"];
    updateTarget: boolean;
    targetAlias?: string;
    targetGrantToRelatedProject?: WorkflowRelatedProject["grantToRelatedProject"];
  }): Promise<WorkflowRelatedProjectListResult> {
    this.assertWorkflowId(options.projectId);
    this.assertWorkflowId(options.targetProjectId);
    const db = this.requireProjectDependencyDatabase();
    const [project, target] = await Promise.all([
      db.getWorkflow(options.projectId),
      db.getWorkflow(options.targetProjectId),
    ]);
    if (project === undefined || target === undefined) {
      throw new HttpError(404, 404, "Related project does not exist.");
    }
    const projectInfo = this.normalizeDeclaredProjectInfo(upsertRelatedProject(
      project.projectInfo,
      {
        alias: options.alias,
        projectId: target.id,
        grantToRelatedProject: options.grantToRelatedProject ?? createDefaultWorkflowRelatedProjectGrant(),
      },
    ));
    const updates = [{ workflowId: project.id, workflowName: project.name, projectInfo }];
    let targetInfo: DeclaredWorkflowProjectInfo | undefined;
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
          grantToRelatedProject: options.targetGrantToRelatedProject ?? createDefaultWorkflowRelatedProjectGrant(),
        },
      ));
      updates.push({ workflowId: target.id, workflowName: target.name, projectInfo: targetInfo });
    }
    await db.updateWorkflowProjectInfos(updates);
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
  }): Promise<{ removed: boolean; relatedProjects: WorkflowRelatedProjectStatus[] }> {
    this.assertWorkflowId(options.projectId);
    const db = this.requireProjectDependencyDatabase();
    const project = await db.getWorkflow(options.projectId);
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
    const updates = [{ workflowId: project.id, workflowName: project.name, projectInfo }];
    let target: WorkflowDbRecord | undefined;
    let targetInfo: DeclaredWorkflowProjectInfo | undefined;
    if (options.updateTarget) {
      target = await db.getWorkflow(relation.projectId);
      if (target !== undefined) {
        targetInfo = this.normalizeDeclaredProjectInfo(removeRelatedProjectByProjectId(
          target.projectInfo,
          project.id,
        ));
        updates.push({ workflowId: target.id, workflowName: target.name, projectInfo: targetInfo });
      }
    }
    await db.updateWorkflowProjectInfos(updates);
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
    const readAllowed = isWorkflowProjectKVAccessAllowed(access.grant.read, options.key);
    const writeAllowed = isWorkflowProjectKVAccessAllowed(access.grant.write, options.key);
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
    if (!isKnowledgeDocumentStorageKey(options.key) || !isWorkflowProjectAccessAllowed(rule, options.key)) {
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
    mutation: WorkflowPersistentValueKnowledgeMutation;
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
  ): Promise<{ targetProjectId: string; grant: WorkflowRelatedProjectKVGrant }> {
    this.assertWorkflowId(consumerProjectId);
    const db = this.requireProjectDependencyDatabase();
    const consumer = await db.getWorkflow(consumerProjectId);
    if (consumer === undefined) {
      throw new HttpError(404, 404, "Related project is unavailable or awaiting confirmation.");
    }
    const declared = consumer.projectInfo.relatedProjects.find((item) => item.alias === alias);
    if (declared === undefined) {
      throw new HttpError(404, 404, "Related project is unavailable or awaiting confirmation.");
    }
    const target = await db.getWorkflow(declared.projectId);
    if (target === undefined) {
      throw new HttpError(404, 404, "Related project is unavailable or awaiting confirmation.");
    }
    await this.assertServerProjectDataAccess(target.id);
    const access = resolveWorkflowRelatedProjectAccess({
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

  async assertServerProjectDataAccess(workflowId: string): Promise<WorkflowProjectInfo> {
    return this.assertServerProjectStorageMode(workflowId, "access server data");
  }

  async listProjectMembers(workflowId: string): Promise<WorkflowProjectMember[]> {
    this.assertWorkflowId(workflowId);
    if (this.db === undefined) {
      return [];
    }
    return await this.db.listWorkflowMembers(workflowId);
  }

  async setProjectMember(options: {
    workflowId: string;
    userId: string;
    role: WorkflowProjectRole;
    createdBy?: string;
  }): Promise<WorkflowProjectMember> {
    this.assertWorkflowId(options.workflowId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project member management requires PostgreSQL storage.");
    }
    return this.db.upsertWorkflowMember(options);
  }

  async removeProjectMember(workflowId: string, userId: string): Promise<{ removed: boolean }> {
    this.assertWorkflowId(workflowId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project member management requires PostgreSQL storage.");
    }
    return { removed: await this.db.deleteWorkflowMember(workflowId, userId) };
  }

  async createProjectInvitation(options: {
    workflowId: string;
    role: WorkflowProjectRole;
    createdBy?: string;
    ttlMs?: number;
  }): Promise<{ invitation: WorkflowProjectInvitation; token: string }> {
    this.assertWorkflowId(options.workflowId);
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
    const invitation = await this.db.createWorkflowProjectInvitation({
      id,
      workflowId: options.workflowId,
      token,
      role: options.role,
      createdBy: options.createdBy,
      expiresAt,
    });
    return { invitation, token };
  }

  async listProjectInvitations(workflowId: string): Promise<WorkflowProjectInvitation[]> {
    this.assertWorkflowId(workflowId);
    if (this.db === undefined) {
      return [];
    }
    return await this.db.listWorkflowProjectInvitations(workflowId);
  }

  async getInvitationByToken(token: string): Promise<WorkflowProjectInvitation | undefined> {
    if (this.db === undefined) {
      return undefined;
    }
    return await this.db.getWorkflowProjectInvitationByToken(token);
  }

  async revokeProjectInvitation(
    workflowId: string,
    invitationId: string,
  ): Promise<{ revoked: boolean }> {
    this.assertWorkflowId(workflowId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project invitations require PostgreSQL storage.");
    }
    return { revoked: await this.db.revokeWorkflowProjectInvitation(workflowId, invitationId) };
  }

  async acceptInvitation(input: {
    token: string;
    acceptedBy: string;
  }): Promise<{ invitation: WorkflowProjectInvitation; member: WorkflowProjectMember }> {
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project invitations require PostgreSQL storage.");
    }
    const pending = await this.db.getWorkflowProjectInvitationByToken(input.token);
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
    const accepted = await this.db.acceptWorkflowProjectInvitation({
      id: pending.id,
      acceptedBy: input.acceptedBy,
    });
    if (!accepted) {
      throw new HttpError(409, 409, "Invitation could not be accepted.");
    }
    const member = await this.db.upsertWorkflowMember({
      workflowId: pending.workflowId,
      userId: input.acceptedBy,
      role: pending.role,
      createdBy: pending.createdBy ?? input.acceptedBy,
    });
    return { invitation: accepted, member };
  }

  async updateProjectVisibility(options: {
    workflowId: string;
    visibility: WorkflowVisibility;
  }): Promise<WorkflowSummary> {
    this.assertWorkflowId(options.workflowId);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "Project access management requires PostgreSQL storage.");
    }
    const updated = await this.db.updateWorkflowAccess({
      workflowId: options.workflowId,
      visibility: options.visibility,
    });
    if (updated === undefined) {
      throw new HttpError(404, 404, `Workflow "${options.workflowId}" does not exist.`);
    }
    return this.summarizeDbWorkflow(updated);
  }

  async getProjectAccessSummary(workflowId: string, userId?: string): Promise<WorkflowProjectAccessSummary> {
    this.assertWorkflowId(workflowId);
    const workflow = await this.readWorkflowRecordForAccess(workflowId);
    return this.createProjectAccessSummary(workflow, userId);
  }

  canReadProject(options: {
    access: WorkflowProjectAccessSummary;
    canReadAll?: boolean;
    canReadPublic?: boolean;
    userId?: string;
  }): boolean {
    if (options.canReadAll) return true;
    if (options.userId && options.access.member !== undefined) return true;
    return options.canReadPublic === true && options.access.visibility === "public";
  }

  canManageProject(options: {
    access: WorkflowProjectAccessSummary;
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
    access: WorkflowProjectAccessSummary;
    canDownloadSource?: boolean;
    userId?: string;
  }): boolean {
    if (options.canDownloadSource) return true;
    if (!options.userId) return false;
    return options.access.member?.role === "owner" ||
      options.access.member?.role === "manager";
  }

  assertReadableProject(options: {
    access: WorkflowProjectAccessSummary;
    canReadAll?: boolean;
    canReadPublic?: boolean;
    userId?: string;
  }): void {
    if (!this.canReadProject(options)) {
      throw new HttpError(403, 403, "Permission denied.");
    }
  }

  assertManageableProject(options: Parameters<WorkflowStorage["canManageProject"]>[0]): void {
    if (!this.canManageProject(options)) {
      throw new HttpError(403, 403, "Permission denied.");
    }
  }

  assertDataWritableProject(options: { access: WorkflowProjectAccessSummary; userId?: string; canWriteAll?: boolean }): void {
    if (this.canWriteProjectData(options)) return;
    throw new HttpError(403, 403, "Project data write access is required.");
  }

  canWriteProjectData(options: { access: WorkflowProjectAccessSummary; userId?: string; canWriteAll?: boolean }): boolean {
    const role = options.access.member?.role;
    return options.canWriteAll === true || Boolean(options.userId && (role === "owner" || role === "manager" || role === "writer"));
  }

  async listWorkflows(): Promise<WorkflowSummary[]> {
    if (this.db) {
      const workflows = await this.db.listWorkflows();
      const versions = await this.db.listVersionsForWorkflows(workflows.map(item => item.id));
      return Promise.all(workflows.map(item => this.summarizeDbWorkflow(item, versions.get(item.id))));
    }
    await mkdir(this.workflowsRoot(), { recursive: true });
    const entries = await readdir(this.workflowsRoot(), { withFileTypes: true });
    const summaries = await Promise.all(entries.filter(entry => entry.isDirectory() && isWorkflowUuid(entry.name)).map(async entry => {
      const record = await this.readWorkflowRecordForAccess(entry.name);
      return this.summarizeDbWorkflow(record, await Promise.all((await this.listVersionNames(entry.name)).map(async version => ({ version }))));
    }));
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listVersions(workflowId: string): Promise<WorkflowVersionSummary> {
    this.assertWorkflowId(workflowId);
    const metadata = await this.readWorkflowRecordForAccess(workflowId);
    const versions = this.db ? await this.db.listVersions(workflowId) : await Promise.all((await this.listVersionNames(workflowId)).map(version => this.readManifest(workflowId, version)));
    const downloadCounts = await this.readVersionDownloadCounts(workflowId);
    const publishedVersions = versions.filter(isDefined).map(version => ({
      version: version.version,
      downloadCount: downloadCounts[version.version] ?? 0,
      createdAt: version.createdAt,
      createdByUserId: version.createdByUserId,
      releaseLog: version.releaseLog,
      sourceHash: version.sourceHash,
      dependencies: (version.dependencies ?? []).map(cloneWorkflowProjectDependencyLock),
      latest: metadata.latest === version.version,
    }));
    return {
      id: workflowId,
      name: metadata.name,
      latest: metadata.latest,
      nextVersion: await this.resolveNextVersion(workflowId),
      totalDownloadCount: publishedVersions.reduce((total, version) => total + version.downloadCount, 0),
      versions: publishedVersions,
    };
  }

  async recordSourceDownloads(downloads: readonly { workflowId: string; version: string }[]): Promise<void> {
    const versionsByWorkflow = new Map<string, Set<string>>();
    for (const item of downloads) {
      this.assertWorkflowId(item.workflowId);
      assertVersion(item.version);
      const versions = versionsByWorkflow.get(item.workflowId) ?? new Set<string>();
      versions.add(item.version);
      versionsByWorkflow.set(item.workflowId, versions);
    }
    if (this.db !== undefined) {
      await this.db.recordSourceDownloads(downloads);
      return;
    }
    for (const [workflowId, versions] of versionsByWorkflow) {
      await this.withLocalWorkflowPublishLock(workflowId, async () => {
        const counts = await this.readVersionDownloadCounts(workflowId);
        for (const version of versions) {
          await this.assertVersionExists(workflowId, version);
          counts[version] = (counts[version] ?? 0) + 1;
        }
        const target = path.join(this.workflowRoot(workflowId), "download-counts.json");
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

  private async readVersionDownloadCounts(workflowId: string): Promise<Record<string, number>> {
    if (this.db !== undefined) {
      return Object.fromEntries(await this.db.listVersionDownloadCounts(workflowId));
    }
    try {
      return JSON.parse(await readFile(path.join(this.workflowRoot(workflowId), "download-counts.json"), "utf8")) as Record<string, number>;
    } catch (error) {
      if (isMissingFileError(error)) return {};
      throw error;
    }
  }

  async uploadPackage(options: {
    workflowName: string;
    archiveName: string;
    archiveBuffer: Buffer;
    createOnly?: boolean;
    onStage?: (stage: WorkflowPreparationStage) => Promise<void>;
  }): Promise<UploadPackageResult> {
    this.assertWorkflowId(options.workflowName);
    assertArchiveName(options.archiveName);

    if (options.createOnly === true) {
      await this.assertWorkflowDoesNotExist(options.workflowName);
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
      const packageRoot = await resolvePackageRoot(extractDir, options.workflowName);
      const metadata = await validateWorkflowPackage(
        packageRoot,
        options.workflowName,
      );
      await this.assertUploadedProjectType(options.workflowName, metadata.projectType);

      await copyUploadedWorkflowSource(packageRoot, stagedSourceDir);
      await copyWorkspaceDependencySources(packageRoot, stagedSourceDir);
      await options.onStage?.("validating");
      await validateWorkflowPackage(
        stagedSourceDir,
        options.workflowName,
      );

      const sourceHash = await hashDirectory(stagedSourceDir);
      await options.onStage?.("committing");
      await this.commitStagedDraft(options.workflowName, stagedDraftDir);

      return {
        workflowId: metadata.id,
        workflowName: metadata.name,
        archiveName: options.archiveName,
        sourceHash,
        nextVersion: await this.resolveNextVersion(options.workflowName),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async enqueuePackagePreparation(options: {
    workflowName: string;
    archiveName: string;
    archiveBuffer: Buffer;
    createOnly?: boolean;
  }): Promise<WorkflowPreparationJob> {
    this.assertWorkflowId(options.workflowName);
    assertArchiveName(options.archiveName);
    return this.withLocalPreparationLock(options.workflowName, async () => {
      return this.enqueuePackagePreparationLocked(options);
    });
  }

  private async enqueuePackagePreparationLocked(options: {
    workflowName: string;
    archiveName: string;
    archiveBuffer: Buffer;
    createOnly?: boolean;
  }): Promise<WorkflowPreparationJob> {
    if (options.createOnly === true) {
      await this.assertWorkflowDoesNotExist(options.workflowName);
    }

    const latest = await this.getLatestPreparationJob(options.workflowName);
    if (latest?.status === "queued" || latest?.status === "preparing") {
      throw new HttpError(409, 409, `Workflow "${options.workflowName}" already has an active preparation job.`, {
        jobId: latest.jobId,
        status: latest.status,
        stage: latest.stage,
      });
    }

    const createdAt = new Date().toISOString();
    const job: WorkflowPreparationJob = {
      jobId: randomUUID(),
      workflowId: options.workflowName,
      archiveName: options.archiveName,
      createOnly: options.createOnly === true,
      status: "queued",
      stage: "queued",
      createdAt,
    };
    await mkdir(this.preparationJobDir(job.workflowId, job.jobId), { recursive: true });
    await writeFile(this.preparationArchivePath(job), options.archiveBuffer);
    await this.writePreparationJob(job);
    this.schedulePreparationJob(job.jobId, job.workflowId, options.createOnly === true);
    return job;
  }

  private async withLocalPreparationLock<T>(workflowName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.preparationLocks.get(workflowName) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const next = previous.catch(() => undefined).then(() => current);
    this.preparationLocks.set(workflowName, next);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.preparationLocks.get(workflowName) === next) {
        this.preparationLocks.delete(workflowName);
      }
    }
  }

  async getPreparationJob(workflowName: string, jobId: string): Promise<WorkflowPreparationJob> {
    this.assertWorkflowId(workflowName);
    if (!isWorkflowUuid(jobId)) {
      throw new HttpError(400, 400, createInvalidWorkflowUuidMessage(jobId, "preparation job id"));
    }
    const job = await readJson<WorkflowPreparationJob>(this.preparationJobPath(workflowName, jobId));
    if (job === undefined || job.workflowId !== workflowName || job.jobId !== jobId) {
      throw new HttpError(404, 404, `Preparation job "${jobId}" does not exist for workflow "${workflowName}".`);
    }
    return job;
  }

  async getLatestPreparationJob(workflowName: string): Promise<WorkflowPreparationJob | undefined> {
    this.assertWorkflowId(workflowName);
    const root = this.preparationWorkflowRoot(workflowName);
    if (!(await exists(root))) return undefined;
    const entries = await readdir(root, { withFileTypes: true });
    const jobs = (await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJson<WorkflowPreparationJob>(this.preparationJobPath(workflowName, entry.name)))))
      .filter(isDefined);
    return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  private schedulePreparationJob(jobId: string, workflowId: string, createOnly: boolean): void {
    if (this.activePreparationJobs.has(jobId)) return;
    this.activePreparationJobs.add(jobId);
    setImmediate(() => {
      void this.runPreparationJob(workflowId, jobId, createOnly).finally(() => {
        this.activePreparationJobs.delete(jobId);
      });
    });
  }

  private async runPreparationJob(workflowId: string, jobId: string, createOnly: boolean): Promise<void> {
    let job = await this.getPreparationJob(workflowId, jobId);
    const updateStage = async (stage: WorkflowPreparationStage): Promise<void> => {
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
        workflowName: workflowId,
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
    const workflowEntries = await readdir(root, { withFileTypes: true });
    for (const workflowEntry of workflowEntries) {
      if (!workflowEntry.isDirectory() || !isWorkflowUuid(workflowEntry.name)) continue;
      const latest = await this.getLatestPreparationJob(workflowEntry.name);
      if (latest?.status === "queued" || latest?.status === "preparing") {
        if (await exists(this.preparationArchivePath(latest))) {
          this.schedulePreparationJob(latest.jobId, latest.workflowId, latest.createOnly);
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

  private async writePreparationJob(job: WorkflowPreparationJob): Promise<void> {
    const target = this.preparationJobPath(job.workflowId, job.jobId);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeJson(temp, job);
    await rename(temp, target);
  }

  async createWorkflow(options: {
    workflowName: string;
    files: WorkflowFileInput[];
  }): Promise<UploadPackageResult> {
    this.assertWorkflowId(options.workflowName);

    await this.assertWorkflowDoesNotExist(options.workflowName);

    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const stagedDraftDir = path.join(tempDir, "draft");
    const rawSourceDir = path.join(tempDir, "raw-source");
    const stagedSourceDir = path.join(stagedDraftDir, "source");

    try {
      await mkdir(rawSourceDir, { recursive: true });

      for (const file of options.files) {
        const safePath = normalizeWorkflowFilePath(file.path);
        const targetPath = path.join(rawSourceDir, safePath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, decodeWorkflowFileContent(file));
      }

      await copyUploadedWorkflowSource(rawSourceDir, stagedSourceDir);
      const metadata = await validateWorkflowPackage(
        stagedSourceDir,
        options.workflowName,
      );
      await this.commitStagedDraft(options.workflowName, stagedDraftDir);

      return {
        workflowId: metadata.id,
        workflowName: metadata.name,
        archiveName: "",
        sourceHash: await hashDirectory(this.draftSourceDir(options.workflowName)),
        nextVersion: await this.resolveNextVersion(options.workflowName),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async getFiles(options: {
    workflowName: string;
    target: string;
    includeBinary?: boolean;
  }): Promise<{
    workflowId: string;
    workflowName: string;
    target: string;
    resolvedTarget: string;
    files: WorkflowFile[];
  }> {
    this.assertWorkflowId(options.workflowName);
    const resolved = await this.resolveSourceTarget(
      options.workflowName,
      options.target,
    );
    const metadata = await this.readWorkflowMetadataForEditing(options.workflowName);

    return {
      workflowId: options.workflowName,
      workflowName: metadata.name,
      target: options.target,
      resolvedTarget: resolved.resolvedTarget,
      files: await readProjectFiles(
        resolved.sourceDir,
        options.includeBinary === true,
      ),
    };
  }

  async getSourceDownloadAvailability(workflowName: string): Promise<Omit<WorkflowSourceDownloadAvailability, "allowed">> {
    const latest = await this.readLatest(workflowName);
    return { available: latest !== null, target: latest };
  }

  async getDownloadableSourceFiles(options: { workflowName: string; target?: string }): Promise<{ workflowId: string; workflowName: string; target: string; resolvedTarget: string; files: WorkflowFile[] }> {
    this.assertWorkflowId(options.workflowName);
    const target = options.target?.trim() || "latest";
    if (target === "draft") throw new HttpError(400, 400, "Download a published project version.");
    const resolved = await this.resolveSourceTarget(options.workflowName, target);
    const metadata = await this.readPackageMetadataForTarget(options.workflowName, resolved.resolvedTarget);
    return { workflowId: options.workflowName, workflowName: metadata.name, target, resolvedTarget: resolved.resolvedTarget,
      files: await readProjectFiles(resolved.sourceDir, true) };
  }

  async createProjectGroupDeployment(options: {
    manifest: WorkflowProjectGroupManifestV1;
    releaseLog?: string;
    createdByUserId: string;
  }): Promise<WorkflowDeploymentRecord> {
    const db = this.requireProjectDependencyDatabase();
    let manifest: WorkflowProjectGroupManifestV1;
    try {
      manifest = parseWorkflowProjectGroupManifest(options.manifest);
    } catch (error) {
      throw toHttpErrorWithStatus(error, 400, 400, "Project group manifest is invalid.");
    }

    const root = await db.getWorkflow(manifest.rootProjectId);
    if (root === undefined || root.projectType !== "kanban") {
      throw new HttpError(409, 409, "A project group root must be an existing Kanban project.");
    }
    for (const project of manifest.projects) {
      const record = await db.getWorkflow(project.projectId);
      if (record === undefined) {
        throw new HttpError(409, 409, `Included project "${project.projectId}" does not exist on this Server.`);
      }
      if (project.role === "dependency" && record.projectType !== "workflow") {
        throw new HttpError(409, 409, `Included dependency "${project.projectId}" must be a Workflow project.`);
      }
    }

    const deployment = await db.createWorkflowDeployment({
      id: randomUUID(),
      rootProjectId: manifest.rootProjectId,
      manifest,
      releaseLog: normalizeReleaseLog(options.releaseLog),
      createdByUserId: options.createdByUserId,
    });
    try {
      return await this.reserveProjectGroupDeploymentVersions(deployment, false);
    } catch (error) {
      await db.releaseWorkflowDeploymentVersionReservations(deployment.id).catch(() => undefined);
      await db.updateWorkflowDeployment({
        id: deployment.id,
        status: "failed",
        error: readErrorMessage(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  async getProjectGroupDeployment(deploymentId: string): Promise<WorkflowDeploymentRecord> {
    if (!isWorkflowUuid(deploymentId)) {
      throw new HttpError(400, 400, createInvalidWorkflowUuidMessage(deploymentId, "deployment id"));
    }
    const deployment = await this.requireProjectDependencyDatabase().getWorkflowDeployment(deploymentId);
    if (deployment === undefined) {
      throw new HttpError(404, 404, `Deployment "${deploymentId}" does not exist.`);
    }
    return deployment;
  }

  async prepareProjectGroupDeployment(options: {
    deploymentId: string;
    archiveName: string;
    archiveBuffer: Buffer;
  }): Promise<WorkflowDeploymentRecord> {
    return this.withProjectGroupDeploymentLock(options.deploymentId, () =>
      this.prepareProjectGroupDeploymentLocked(options));
  }

  async enqueueProjectGroupPreparation(options: {
    deploymentId: string;
    archiveName: string;
    archiveBuffer: Buffer;
  }): Promise<WorkflowDeploymentRecord> {
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

      const preparation: WorkflowDeploymentPreparation = {
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
        const transitioned = await db.transitionWorkflowDeploymentStatus({
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

  private scheduleProjectGroupPreparation(preparation: WorkflowDeploymentPreparation): void {
    if (this.activeDeploymentPreparations.has(preparation.deploymentId)) return;
    this.activeDeploymentPreparations.add(preparation.deploymentId);
    setImmediate(() => {
      void this.runProjectGroupPreparation(preparation).finally(() => {
        this.activeDeploymentPreparations.delete(preparation.deploymentId);
      });
    });
  }

  private async runProjectGroupPreparation(preparation: WorkflowDeploymentPreparation): Promise<void> {
    try {
      const archiveBuffer = await readFile(this.deploymentPreparationArchivePath(preparation));
      await this.prepareProjectGroupDeployment({
        deploymentId: preparation.deploymentId,
        archiveName: preparation.archiveName,
        archiveBuffer,
      });
    } catch (error) {
      await this.requireProjectDependencyDatabase().updateWorkflowDeployment({
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
      if (!entry.isDirectory() || !isWorkflowUuid(entry.name)) continue;
      const deployment = await this.requireProjectDependencyDatabase().getWorkflowDeployment(entry.name);
      if (deployment === undefined) continue;
      if (deployment.status !== "planned" && deployment.status !== "preparing") continue;

      const preparation = await readJson<WorkflowDeploymentPreparation>(
        this.deploymentPreparationMetadataPath(entry.name),
      );
      const valid = preparation !== undefined &&
        preparation.deploymentId === entry.name &&
        isTarGzipName(preparation.archiveName) &&
        await exists(this.deploymentPreparationArchivePath(preparation));
      if (!valid) {
        await this.requireProjectDependencyDatabase().updateWorkflowDeployment({
          id: entry.name,
          status: "failed",
          error: "Project-group preparation archive is missing after server restart.",
        });
        continue;
      }

      if (deployment.status === "planned") {
        const transitioned = await this.requireProjectDependencyDatabase().transitionWorkflowDeploymentStatus({
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
  }): Promise<WorkflowDeploymentRecord> {
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
    if (!await db.transitionWorkflowDeploymentStatus({
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
      await db.updateWorkflowDeployment({
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
      let uploadedManifest: WorkflowProjectGroupManifestV1;
      try {
        uploadedManifest = parseWorkflowProjectGroupManifest(
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
        await db.updateWorkflowDeploymentItem({
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
        const metadata = await validateWorkflowPackage(
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
          workflowName: project.projectId,
          archiveName: path.basename(project.archivePath),
          archiveBuffer: await readFile(projectArchivePath),
          onStage: async (stage) => db.updateWorkflowDeploymentItem({
            deploymentId: deployment.id,
            projectId: project.projectId,
            status: "preparing",
            stage,
          }),
        });
        await db.updateWorkflowDeploymentItem({
          deploymentId: deployment.id,
          projectId: project.projectId,
          status: "prepared",
          stage: "prepared",
          plannedVersion,
          preparedSourceHash: result.sourceHash,
        });
      }
      await db.updateWorkflowDeployment({ id: deployment.id, status: "prepared" });
    } catch (error) {
      await db.updateWorkflowDeployment({
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

  async publishProjectGroupDeployment(deploymentId: string): Promise<WorkflowDeploymentRecord> {
    return this.withProjectGroupDeploymentLock(deploymentId, () =>
      this.publishProjectGroupDeploymentLocked(deploymentId));
  }

  private async publishProjectGroupDeploymentLocked(
    deploymentId: string,
  ): Promise<WorkflowDeploymentRecord> {
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

    if (!await db.transitionWorkflowDeploymentStatus({
      id: deployment.id,
      from: ["prepared", "failed", "publishing"],
      status: "publishing",
    })) {
      throw new HttpError(409, 409, `Deployment "${deployment.id}" is already being prepared or published.`);
    }
    try {
      await this.assertProjectGroupPublishReady(deployment);
      await this.withWorkflowPublishLocks(projectIds, async () => {
        const publishedDependencies = new Map<string, { version: string; sourceHash: string }>();
        const dependencyProjects = deployment.manifest.projects.filter((project) => project.role === "dependency");
        for (const project of dependencyProjects) {
          const item = deployment.items.find((candidate) => candidate.projectId === project.projectId)!;
          const existing = await this.resolvePublishedDeploymentItem(item);
          if (existing !== undefined) {
            publishedDependencies.set(project.projectId, existing);
            await db.updateWorkflowDeploymentItem({
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
          await db.updateWorkflowDeploymentItem({
            deploymentId: deployment.id,
            projectId: project.projectId,
            status: "publishing",
            stage: "publishing",
          });
          const result = await this.publishLocked({
            workflowName: project.projectId,
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
          await db.updateWorkflowDeploymentItem({
            deploymentId: deployment.id,
            projectId: project.projectId,
            status: "published",
            stage: "published",
            publishedVersion: result.version,
            publishedSourceHash: publishedManifest.sourceHash,
          });
        }

        const dependencies = deployment.manifest.dependencies.map((dependency) => (
          finalizeWorkflowProjectDependencyLock(dependency, publishedDependencies.get(dependency.projectId))
        ));
        const rootProject = deployment.manifest.projects.find((project) => project.role === "root")!;
        const rootItem = deployment.items.find((item) => item.projectId === rootProject.projectId)!;
        const existingRoot = await this.resolvePublishedDeploymentItem(rootItem);
        let rootVersion: string;
        let rootManifest: WorkflowManifest | undefined;
        if (existingRoot !== undefined) {
          if (JSON.stringify(existingRoot.manifest.dependencies ?? []) !== JSON.stringify(dependencies)) {
            throw new HttpError(409, 409, "The previously published Kanban root has a different dependency lock.");
          }
          rootVersion = existingRoot.version;
          rootManifest = existingRoot.manifest;
        } else {
          await this.assertReservedDeploymentVersion(rootItem);
          await db.updateWorkflowDeploymentItem({
            deploymentId: deployment.id,
            projectId: rootProject.projectId,
            status: "publishing",
            stage: "activating_root",
          });
          const rootResult = await this.publishLocked({
            workflowName: rootProject.projectId,
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
        await db.updateWorkflowDeploymentItem({
          deploymentId: deployment.id,
          projectId: rootProject.projectId,
          status: "published",
          stage: "published",
          publishedVersion: rootVersion,
          publishedSourceHash: rootManifest?.sourceHash,
        });
      });
      await db.updateWorkflowDeployment({
        id: deployment.id,
        status: "published",
        publishedAt: new Date().toISOString(),
      });
    } catch (error) {
      await db.updateWorkflowDeployment({
        id: deployment.id,
        status: "failed",
        error: readErrorMessage(error),
      });
      throw error;
    }
    return this.getProjectGroupDeployment(deployment.id);
  }

  async getProjectDependencyStatus(options: {
    workflowName: string;
    target?: string;
    canDownloadProject: (projectId: string) => Promise<boolean>;
    requestUrlForProject?: (projectId: string) => string;
  }): Promise<WorkflowProjectDependencyStatusResult> {
    const target = options.target?.trim() || "latest";
    const resolved = await this.resolveSourceTarget(options.workflowName, target);
    const dependencies = resolved.resolvedTarget === "draft"
      ? createExternalWorkflowProjectDependencyLocks(
          (await this.readPackageMetadataForTarget(options.workflowName, "draft"))
            .projectInfo.relatedProjects,
        )
      : await this.readVersionDependencyLocks(options.workflowName, resolved.resolvedTarget);
    const db = this.requireProjectDependencyDatabase();
    const statuses = await Promise.all(dependencies.map(async (dependency) => {
      const project = await db.getWorkflow(dependency.projectId);
      const sourceAvailable = dependency.delivery === "included"
        ? await this.isPinnedProjectSourceAvailable(dependency)
        : project !== undefined;
      const sourceDownloadAllowed = project !== undefined && await options.canDownloadProject(dependency.projectId);
      const root = await db.getWorkflow(options.workflowName);
      const relationshipConfirmed = project !== undefined && root !== undefined &&
        resolveWorkflowRelatedProjectAccess({
          consumerProjectId: root.id,
          consumerProjectInfo: root.projectInfo,
          targetProjectId: project.id,
          targetProjectInfo: project.projectInfo,
          alias: dependency.alias,
        }) !== undefined;
      const dataInitialized = project !== undefined && await db.hasProjectKV(dependency.projectId);
      return {
        dependency: cloneWorkflowProjectDependencyLock(dependency),
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
      rootProjectId: options.workflowName,
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
    workflowName: string;
    target?: string;
    canDownloadProject: (projectId: string) => Promise<boolean>;
    requestUrlForProject?: (projectId: string) => string;
  }): Promise<WorkflowProjectGroupDownloadResult> {
    const target = options.target?.trim() || "latest";
    if (target === "draft") throw new HttpError(400, 400, "Project groups can only download immutable published versions.");
    const resolved = await this.resolveSourceTarget(options.workflowName, target);
    const rootManifest = (await this.readManifest(options.workflowName, resolved.resolvedTarget))!;
    const dependencies = await this.readVersionDependencyLocks(options.workflowName, resolved.resolvedTarget, rootManifest);
    const downloads: WorkflowProjectDownloadPlan["downloads"] = [];
    const skippedDependencies: WorkflowProjectDownloadPlan["skippedDependencies"] = [];
    downloads.push({
      projectId: options.workflowName,
      version: resolved.resolvedTarget,
      sourceHash: rootManifest.sourceHash,
      projectName: rootManifest.workflowName,
      role: "root",
    });
    const downloadsByProject = new Map<string, WorkflowProjectDownloadPlan["downloads"][number]>([
      [`${options.workflowName}\0${resolved.resolvedTarget}\0${rootManifest.sourceHash}`, downloads[0]!],
    ]);
    for (const dependency of dependencies) {
      if (dependency.delivery === "external") {
        skippedDependencies.push({ dependency: cloneWorkflowProjectDependencyLock(dependency), reason: "external" });
        continue;
      }
      if (!await this.isPinnedProjectSourceAvailable(dependency)) {
        skippedDependencies.push({ dependency: cloneWorkflowProjectDependencyLock(dependency), reason: "source_unavailable" });
        continue;
      }
      if (!await options.canDownloadProject(dependency.projectId)) {
        skippedDependencies.push({
          dependency: cloneWorkflowProjectDependencyLock(dependency),
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
      } satisfies WorkflowProjectDownloadPlan["downloads"][number];
      downloads.push(download);
      downloadsByProject.set(downloadKey, download);
    }
    const missingIncluded = skippedDependencies.some((item) => item.dependency.delivery === "included");
    const plan: WorkflowProjectDownloadPlan = {
      rootProjectId: options.workflowName,
      rootVersion: resolved.resolvedTarget,
      dependencies: dependencies.map(cloneWorkflowProjectDependencyLock),
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
        projectName: source.workflowName,
        version: item.version,
        sourceHash: item.sourceHash,
        role: item.role,
        files: source.files,
      };
    }));
    return { ...plan, projects };
  }

  async hasProjectSourceCapability(projectId: string, userId: string): Promise<boolean> {
    return this.requireProjectDependencyDatabase().hasWorkflowProjectCapabilityGrant({
      projectId,
      userId,
      capability: "download_source",
    });
  }

  async listProjectSourceCapabilities(projectId: string): Promise<WorkflowProjectCapabilityGrant[]> {
    this.assertWorkflowId(projectId);
    return this.requireProjectDependencyDatabase().listWorkflowProjectCapabilityGrants(projectId);
  }

  async listProjectAccessRequests(projectId: string): Promise<WorkflowProjectAccessRequest[]> {
    this.assertWorkflowId(projectId);
    return this.requireProjectDependencyDatabase().listWorkflowProjectAccessRequests(projectId);
  }

  async createProjectAccessRequest(options: {
    projectId: string;
    requesterUserId: string;
    reason: string;
  }): Promise<WorkflowProjectAccessRequest> {
    this.assertWorkflowId(options.projectId);
    const reason = options.reason.trim();
    if (reason.length < 2 || reason.length > 1000) {
      throw new HttpError(400, 400, "Access request reason must contain 2 to 1000 characters.");
    }
    const db = this.requireProjectDependencyDatabase();
    const project = await db.getWorkflow(options.projectId);
    if (project === undefined) {
      throw new HttpError(404, 404, `Workflow "${options.projectId}" does not exist.`);
    }
    return db.createWorkflowProjectAccessRequest({
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
  }): Promise<WorkflowProjectAccessRequest> {
    const resolved = await this.requireProjectDependencyDatabase().resolveWorkflowProjectAccessRequest({
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
      revoked: await this.requireProjectDependencyDatabase().revokeWorkflowProjectCapabilityGrant({
        ...options,
        capability: "download_source",
      }),
    };
  }

  createProjectAccessRequestUrl(origin: string, projectId: string): string {
    this.assertWorkflowId(projectId);
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

  private async isPinnedProjectSourceAvailable(dependency: WorkflowProjectDependencyLock): Promise<boolean> {
    if (dependency.delivery !== "included" || !dependency.version || !dependency.sourceHash) return false;
    try {
      const manifest = await this.readManifest(dependency.projectId, dependency.version);
      return manifest?.sourceHash === dependency.sourceHash;
    } catch {
      return false;
    }
  }

  private async resolvePublishedDeploymentItem(
    item: WorkflowDeploymentRecord["items"][number],
  ): Promise<{ version: string; sourceHash: string; manifest: WorkflowManifest } | undefined> {
    const version = item.publishedVersion ?? item.plannedVersion;
    const sourceHash = item.publishedSourceHash ?? item.preparedSourceHash;
    if (!version || !sourceHash) return undefined;
    const manifest = await this.readManifest(item.projectId, version);
    if (!manifest || manifest.sourceHash !== sourceHash) return undefined;
    return { version, sourceHash, manifest };
  }

  private async assertReservedDeploymentVersion(
    item: WorkflowDeploymentRecord["items"][number],
  ): Promise<void> {
    if (!item.plannedVersion || !await this.requireProjectDependencyDatabase().hasWorkflowVersionReservation({
      deploymentId: item.deploymentId,
      workflowId: item.projectId,
      version: item.plannedVersion,
    })) {
      throw new HttpError(409, 409, `Reserved version for project "${item.projectId}" changed.`, {
        expectedVersion: item.plannedVersion,
      });
    }
  }

  private async reserveProjectGroupDeploymentVersions(
    deployment: WorkflowDeploymentRecord,
    reset: boolean,
  ): Promise<WorkflowDeploymentRecord> {
    const db = this.requireProjectDependencyDatabase();
    const projectIds = deployment.items.map((item) => item.projectId).sort();
    return this.withWorkflowPublishLocks(projectIds, async () => {
      if (reset) {
        await db.resetWorkflowDeploymentItemsForPreparation(deployment.id);
      }
      let current = (await db.getWorkflowDeployment(deployment.id)) ?? deployment;
      for (const item of current.items) {
        if (item.plannedVersion !== undefined) continue;
        const requestedVersion = current.manifest.projects.find(
          (project) => project.projectId === item.projectId,
        )?.version;
        const plannedVersion = requestedVersion ?? await this.resolveNextVersion(item.projectId);
        await this.assertVersionPublishable(item.projectId, plannedVersion, deployment.id);
        await db.updateWorkflowDeploymentItem({
          deploymentId: deployment.id,
          projectId: item.projectId,
          status: "planned",
          stage: "version_reserved",
          plannedVersion,
        });
      }
      current = (await db.getWorkflowDeployment(deployment.id)) ?? current;
      if (current.items.some((item) => item.plannedVersion === undefined)) {
        throw new HttpError(409, 409, `Deployment "${deployment.id}" could not reserve every project version.`);
      }
      return current;
    });
  }

  private async assertProjectGroupPublishReady(deployment: WorkflowDeploymentRecord): Promise<void> {
    const rootProject = deployment.manifest.projects.find((project) => project.role === "root");
    if (rootProject === undefined) {
      throw new HttpError(409, 409, "Project-group root is missing.");
    }
    const packageJson = await readPackageJson(this.draftSourceDir(rootProject.projectId));
    const rootProjectInfo = readWorkflowProjectInfo(packageJson);
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
      const target = await db.getWorkflow(actual.projectId);
      if (target === undefined || resolveWorkflowRelatedProjectAccess({
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
    workflowName: string;
    files: Array<{
      name: string;
      mimeType?: string;
      buffer: Buffer;
      conversationId?: string;
    }>;
  }): Promise<WorkflowManagedFileReference[]> {
    // Keep uploaded run attachments outside workflow source/runtime
    // trees; workflows receive opaque references and resolve them at run time.
    this.assertWorkflowId(options.workflowName);
    const now = new Date().toISOString();
    const entries = options.files.map((file) => {
      assertManagedFileSize(file.buffer.byteLength);
      const id = createManagedFileId();
      const mimeType = normalizeMimeType(file.mimeType, file.name);
      const ref: WorkflowManagedFileReference = {
        id,
        name: normalizeManagedFileName(file.name),
        mimeType,
        size: file.buffer.byteLength,
        kind: mimeType.startsWith("image/") ? "image" : "file",
        storage: "server",
        workflowId: options.workflowName,
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
    metadata: WorkflowManagedFileReference;
    filePath: string;
  }> {
    assertManagedFileId(fileId);
    const metadata = await readJson<WorkflowManagedFileReference>(
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
    workflowName: string;
    target?: string;
    actorId: string;
  }): Promise<WorkflowKanbanWorkspaceState> {
    return this.withKanbanConfigurationLock(options.workflowName, options.actorId, () =>
      this.getKanbanWorkspaceUnlocked(options));
  }

  async resolveKanbanRelatedProject(options: {
    workflowName: string;
    target?: string;
    alias: string;
  }): Promise<WorkflowRelatedProject> {
    const project = await this.resolveKanbanProject(options.workflowName, options.target);
    const relation = project.relatedProjects.find((item) => item.alias === options.alias);
    if (relation === undefined) {
      throw new HttpError(404, 404, "Kanban related project is unavailable.");
    }
    return relation;
  }

  async getKanbanRelatedProjectBindings(options: {
    workflowName: string;
    target?: string;
  }): Promise<{
    resolvedTarget: string;
    relatedProjects: WorkflowRelatedProject[];
  }> {
    this.assertWorkflowId(options.workflowName);
    await this.assertServerProjectDataAccess(options.workflowName);
    const target = options.target?.trim() || "draft";
    const resolved = await this.resolveSourceTarget(options.workflowName, target);
    const metadata = await this.readPackageMetadataForTarget(
      options.workflowName,
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
    this.assertWorkflowId(projectId);
    await this.assertServerProjectDataAccess(projectId);
    return this.db?.getProjectStorageRevision(projectId) ?? "0";
  }

  async subscribeProjectStorageRevisions(
    listener: (event: WorkflowProjectStorageRevisionEvent) => void,
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

  private async getKanbanWorkspaceUnlocked(options: {
    workflowName: string;
    target?: string;
    actorId: string;
  }): Promise<WorkflowKanbanWorkspaceState> {
    const project = await this.resolveKanbanProject(options.workflowName, options.target);
    const actorId = requireKanbanActorId(options.actorId);
    const params = project.manifest?.params ?? [];
    if (params.length === 0) {
      return { ...project, configurations: [], activeConfigurationId: undefined };
    }
    let state = await this.readStoredKanbanConfigurationState(options.workflowName, actorId);
    if (state.configurations.length === 0) {
      const now = new Date().toISOString();
      const configuration: KanbanConfiguration = {
        id: randomUUID(),
        name: "默认配置",
        values: createDefaultKanbanValues(params),
        createdAt: now,
        updatedAt: now,
      };
      await this.ensureStoredKanbanConfiguration(options.workflowName, actorId, configuration);
      state = await this.readStoredKanbanConfigurationState(options.workflowName, actorId);
    }
    const configurations = state.configurations.map((configuration) => ({
      ...configuration,
      values: sanitizeKanbanValues(params, configuration.values),
    }));
    for (let index = 0; index < configurations.length; index += 1) {
      const configuration = configurations[index]!;
      if (!areKanbanValuesEqual(configuration.values, state.configurations[index]!.values)) {
        await this.saveStoredKanbanConfiguration(options.workflowName, actorId, configuration);
      }
    }
    state = { ...state, configurations };
    return { ...project, ...state };
  }

  async issueKanbanPreviewCapability(options: {
    workflowName: string;
    target?: string;
    actorId: string;
  }): Promise<WorkflowKanbanPreviewCapability> {
    const project = await this.resolveKanbanProject(options.workflowName, options.target);
    const actorId = requireKanbanActorId(options.actorId);
    const now = Date.now();
    const expiresAtMs = now + KANBAN_PREVIEW_CAPABILITY_TTL_MS;
    const token = createKanbanPreviewCapabilityToken({
      version: 1,
      workflowName: options.workflowName,
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
    workflowName: string;
    target?: string;
    actorId?: string;
    previewCapabilityToken?: string;
    assetPath: string;
    nonce: string;
  }): Promise<WorkflowKanbanAsset> {
    const actorId = options.previewCapabilityToken
      ? this.requireKanbanPreviewCapability(
          options.previewCapabilityToken,
          options.workflowName,
          options.target,
        )
      : requireKanbanActorId(options.actorId ?? "");
    const project = await this.resolveKanbanProject(
      options.workflowName,
      options.target,
    ).catch(() => {
      throw new HttpError(404, 404, "Kanban asset does not exist.");
    });
    const assetPath = options.assetPath.replaceAll("\\", "/");
    if (!isSafeKanbanPublicAssetPath(assetPath, project.entry)) {
      throw new HttpError(404, 404, "Kanban asset does not exist.");
    }
    const nonce = normalizeKanbanNonce(options.nonce);
    const source = await this.resolveSourceTarget(options.workflowName, project.resolvedTarget);
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
        workflowName: options.workflowName,
        target: project.resolvedTarget,
        actorId,
      });
      const active = workspace.configurations.find((item) => item.id === workspace.activeConfigurationId)
        ?? workspace.configurations[0];
      const configuration = active
        ? {
            id: active.id,
            name: active.name,
            params: createInjectedKanbanParams(workspace.manifest?.params ?? [], active.values),
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
    workflowName: string,
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
      capability.workflowName !== workflowName ||
      capability.resolvedTarget !== target
    ) {
      throw new HttpError(404, 404, "Kanban preview does not exist or has expired.");
    }
    return capability.actorId;
  }

  async createKanbanConfiguration(options: {
    workflowName: string;
    target?: string;
    actorId: string;
    sourceConfigurationId?: string;
  }): Promise<WorkflowKanbanWorkspaceState> {
    return this.withKanbanConfigurationLock(options.workflowName, options.actorId, async () => {
      const workspace = await this.getKanbanWorkspaceUnlocked(options);
      const params = workspace.manifest?.params ?? [];
      if (params.length === 0) {
        throw new HttpError(409, 409, "Kanban project has no configurable parameters.");
      }
      const source = options.sourceConfigurationId
        ? requireKanbanConfiguration(workspace.configurations, options.sourceConfigurationId)
        : undefined;
      const now = new Date().toISOString();
      const configuration: KanbanConfiguration = {
        id: randomUUID(),
        name: source
          ? `${source.name} 副本`
          : `配置 ${workspace.configurations.length + 1}`,
        values: source
          ? sanitizeKanbanValues(params, source.values)
          : createDefaultKanbanValues(params),
        createdAt: now,
        updatedAt: now,
      };
      await this.saveStoredKanbanConfiguration(options.workflowName, options.actorId, configuration);
      await this.setStoredActiveKanbanConfiguration(options.workflowName, options.actorId, configuration.id);
      return this.getKanbanWorkspaceUnlocked(options);
    });
  }

  async renameKanbanConfiguration(options: {
    workflowName: string;
    target?: string;
    actorId: string;
    configurationId: string;
    name: string;
  }): Promise<WorkflowKanbanWorkspaceState> {
    return this.withKanbanConfigurationLock(options.workflowName, options.actorId, async () => {
      const workspace = await this.getKanbanWorkspaceUnlocked(options);
      const current = requireKanbanConfiguration(workspace.configurations, options.configurationId);
      const name = options.name.trim();
      if (name === "") throw new HttpError(400, 400, "Kanban configuration name must not be empty.");
      await this.saveStoredKanbanConfiguration(options.workflowName, options.actorId, {
        ...current,
        name,
        updatedAt: new Date().toISOString(),
      });
      return this.getKanbanWorkspaceUnlocked(options);
    });
  }

  async saveKanbanConfigurationValues(options: {
    workflowName: string;
    target?: string;
    actorId: string;
    configurationId: string;
    values: Record<string, unknown>;
  }): Promise<WorkflowKanbanWorkspaceState> {
    return this.withKanbanConfigurationLock(options.workflowName, options.actorId, async () => {
      const workspace = await this.getKanbanWorkspaceUnlocked(options);
      const current = requireKanbanConfiguration(workspace.configurations, options.configurationId);
      await this.saveStoredKanbanConfiguration(options.workflowName, options.actorId, {
        ...current,
        values: sanitizeKanbanValues(workspace.manifest?.params ?? [], options.values),
        updatedAt: new Date().toISOString(),
      });
      return this.getKanbanWorkspaceUnlocked(options);
    });
  }

  async selectKanbanConfiguration(options: {
    workflowName: string;
    target?: string;
    actorId: string;
    configurationId: string;
  }): Promise<WorkflowKanbanWorkspaceState> {
    return this.withKanbanConfigurationLock(options.workflowName, options.actorId, async () => {
      const workspace = await this.getKanbanWorkspaceUnlocked(options);
      requireKanbanConfiguration(workspace.configurations, options.configurationId);
      await this.setStoredActiveKanbanConfiguration(options.workflowName, options.actorId, options.configurationId);
      return this.getKanbanWorkspaceUnlocked(options);
    });
  }

  async deleteKanbanConfiguration(options: {
    workflowName: string;
    target?: string;
    actorId: string;
    configurationId: string;
  }): Promise<WorkflowKanbanWorkspaceState> {
    return this.withKanbanConfigurationLock(options.workflowName, options.actorId, async () => {
      const workspace = await this.getKanbanWorkspaceUnlocked(options);
      requireKanbanConfiguration(workspace.configurations, options.configurationId);
      if (workspace.configurations.length <= 1) {
        throw new HttpError(409, 409, "The last Kanban configuration cannot be deleted.");
      }
      await this.deleteStoredKanbanConfiguration(options.workflowName, options.actorId, options.configurationId);
      const nextId = workspace.configurations.find((item) => item.id !== options.configurationId)?.id;
      if (nextId) await this.setStoredActiveKanbanConfiguration(options.workflowName, options.actorId, nextId);
      return this.getKanbanWorkspaceUnlocked(options);
    });
  }

  async saveDraftFiles(options: {
    workflowName: string;
    files: WorkflowFileInput[];
    removePaths?: string[];
  }): Promise<SaveDraftFilesResult> {
    this.assertWorkflowId(options.workflowName);

    const updatedFiles: string[] = [];
    const removedFiles: string[] = [];
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const stagedDraftDir = path.join(tempDir, "draft");
    const stagedSourceDir = path.join(stagedDraftDir, "source");

    try {
      await this.materializeDbDraftSource(options.workflowName);
      if (await exists(this.draftSourceDir(options.workflowName))) {
        await copyWorkflowSource(this.draftSourceDir(options.workflowName), stagedSourceDir);
      } else {
        await mkdir(stagedSourceDir, { recursive: true });
      }

      for (const removePath of options.removePaths ?? []) {
        const safePath = normalizeWorkflowFilePath(removePath);
        await rm(path.join(stagedSourceDir, safePath), {
          recursive: true,
          force: true,
        });
        removedFiles.push(safePath);
      }

      for (const file of options.files) {
        const safePath = normalizeWorkflowFilePath(file.path);
        const targetPath = path.join(stagedSourceDir, safePath);

        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, decodeWorkflowFileContent(file));
        updatedFiles.push(safePath);
      }

      const metadata = await validateWorkflowPackage(
        stagedSourceDir,
        options.workflowName,
      );
      await this.commitStagedDraft(
        options.workflowName,
        stagedDraftDir,
      );

      return {
        workflowId: metadata.id,
        workflowName: metadata.name,
        updatedFiles,
        removedFiles,
        nextVersion: await this.resolveNextVersion(options.workflowName),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async cloneWorkflow(options: {
    workflowName: string;
    sourceTarget?: string;
    targetWorkflowName: string;
    displayName?: string;
    ownerUserId?: string;
  }): Promise<CloneWorkflowResult> {
    this.assertWorkflowId(options.workflowName);
    this.assertWorkflowId(options.targetWorkflowName);

    if (options.workflowName === options.targetWorkflowName) {
      throw new HttpError(409, 409, "Clone target id must be different from source workflow id.");
    }

    const existingWorkflow = this.db === undefined
      ? undefined
      : await this.db.getWorkflow(options.targetWorkflowName);
    if (
      existingWorkflow !== undefined ||
      await exists(this.draftSourceDir(options.targetWorkflowName)) ||
      await exists(this.workflowRoot(options.targetWorkflowName))
    ) {
      throw new HttpError(
        409,
        409,
        `Workflow "${options.targetWorkflowName}" already exists. Delete it first or choose a different name.`,
      );
    }

    const sourceTarget = options.sourceTarget?.trim() || "latest";
    const resolved = await this.resolveSourceTarget(options.workflowName, sourceTarget);
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const stagedDraftDir = path.join(tempDir, "draft");
    const stagedSourceDir = path.join(stagedDraftDir, "source");

    try {
      await copyWorkflowSource(resolved.sourceDir, stagedSourceDir);

      if (options.displayName?.trim()) {
        await this.updatePackageMetadataName(
          stagedSourceDir,
          options.targetWorkflowName,
          options.displayName.trim(),
        );
      } else {
        const packageJson = await this.readPackageMetadata(options.workflowName);
        await this.updatePackageMetadataName(
          stagedSourceDir,
          options.targetWorkflowName,
          packageJson.name,
        );
      }

      const metadata = await validateWorkflowPackage(
        stagedSourceDir,
        options.targetWorkflowName,
      );
      if (this.db) await this.createProject({
        workflowId: metadata.id,
        workflowName: metadata.name,
        projectType: metadata.projectType,
        projectInfo: this.normalizeDeclaredProjectInfo(metadata.projectInfo),
        projectCard: metadata.projectCard,
        ownerUserId: options.ownerUserId,
        createdByUserId: options.ownerUserId,
      });
      await this.commitStagedDraft(
        options.targetWorkflowName,
        stagedDraftDir,
      );

      return {
        workflowId: metadata.id,
        workflowName: metadata.name,
        sourceTarget,
        resolvedSourceTarget: resolved.resolvedTarget,
        nextVersion: await this.resolveNextVersion(options.targetWorkflowName),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async updateWorkflowInfo(options: {
    workflowName: string;
    target?: string;
    displayName: string;
  }): Promise<UpdateWorkflowInfoResult> {
    this.assertWorkflowId(options.workflowName);
    const displayName = options.displayName.trim();
    if (displayName === "") {
      throw new HttpError(400, 400, "displayName must not be empty.");
    }

    const target = options.target?.trim() || "draft";
    const resolvedTarget = await this.resolveWorkflowConfigTarget(
      options.workflowName,
      target,
    );

    if (resolvedTarget === "draft") {
      await this.ensureEditableDraft(options.workflowName, target);
      await this.stageDraftEdit(options.workflowName, async (sourceDir) => {
        await this.updatePackageMetadataName(
          sourceDir,
          options.workflowName,
          displayName,
        );
      });
      if (this.db !== undefined) {
        await this.db.updateWorkflowName(options.workflowName, displayName);
      }

      return {
        workflowId: options.workflowName,
        workflowName: displayName,
        target,
        resolvedTarget: "draft",
      };
    }

    await this.stageDraftFromVersionSource(
      options.workflowName,
      resolvedTarget,
      async (sourceDir) => {
        await this.updatePackageMetadataName(
          sourceDir,
          options.workflowName,
          displayName,
        );
      },
    );
    if (this.db !== undefined) {
      await this.db.updateWorkflowName(options.workflowName, displayName);
    }

    return {
      workflowId: options.workflowName,
      workflowName: displayName,
      target,
      resolvedTarget,
    };
  }

  async deleteWorkflow(workflowName: string): Promise<DeleteWorkflowResult> {
    this.assertWorkflowId(workflowName);
    const hasDbWorkflow = this.db !== undefined
      ? (await this.db.getWorkflow(workflowName)) !== undefined
      : false;
    const hasFileWorkflow = await exists(this.workflowRoot(workflowName));

    if (!hasDbWorkflow && !hasFileWorkflow) {
      throw new HttpError(404, 404, `Workflow "${workflowName}" does not exist.`);
    }

    if (this.db !== undefined) {
      await this.db.deleteWorkflow(workflowName);
    }
    await rm(this.workflowRoot(workflowName), {
      recursive: true,
      force: true,
    });
    return {
      workflowId: workflowName,
    };
  }

  async publish(options: {
    workflowName: string;
    releaseLog?: string;
    createdByUserId?: string;
    dependencies?: WorkflowProjectDependencyLock[];
    expectedVersion?: string;
    expectedSourceHash?: string;
  }): Promise<PublishResult> {
    this.assertWorkflowId(options.workflowName);

    // Publish must reserve versions serially per workflow so
    // concurrent requests cannot compute and mutate the same next version.
    return this.withWorkflowPublishLock(options.workflowName, () => this.publishLocked(options));
  }

  private async publishLocked(options: {
    workflowName: string; releaseLog?: string; createdByUserId?: string; dependencies?: WorkflowProjectDependencyLock[];
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
        await writeWorkflowFiles(sourceDir, await this.db.readDraftFiles(options.workflowName));
      } else {
        await copyWorkflowSource(this.draftSourceDir(options.workflowName), sourceDir);
      }
      const metadata = await validateWorkflowPackage(sourceDir, options.workflowName);
      version = metadata.version;
      assertVersion(version);
      if (options.expectedVersion !== undefined && options.expectedVersion !== version) {
        throw new HttpError(409, 409, "Project version differs from its reservation.");
      }
      if (options.reservationDeploymentId && !await this.requireProjectDependencyDatabase().hasWorkflowVersionReservation({
        deploymentId: options.reservationDeploymentId, workflowId: options.workflowName, version })) {
        throw new HttpError(409, 409, "Project version reservation is unavailable.");
      }
      await this.assertVersionPublishable(options.workflowName, version, options.reservationDeploymentId);
      const releaseLog = normalizeReleaseLog(options.releaseLog);
      const dependencies = await this.resolvePublishDependencyLocks({ workflowName: options.workflowName, sourceDir, projectType: metadata.projectType, dependencies: options.dependencies });
      const sourceHash = await hashDirectory(sourceDir);
      if (options.expectedSourceHash !== undefined && sourceHash !== options.expectedSourceHash) {
        throw new HttpError(409, 409, "Project draft changed after preparation.");
      }
      const artifacts = await this.uploadVersionArtifacts({ workflowName: options.workflowName, version, sourceHash, sourceDir });
      const manifest: WorkflowManifest = { workflowId: options.workflowName, workflowName: metadata.name, version,
        createdAt: new Date().toISOString(), createdByUserId: options.createdByUserId, releaseLog, sourceHash,
        sourceObjectPath: artifacts?.sourceObjectPath, projectType: metadata.projectType, dependencies };
      await writeJson(path.join(stagedVersionDir, "manifest.json"), manifest);
      await moveDirectoryIfAbsent(stagedVersionDir, this.versionDir(options.workflowName, version), "Project version already exists.");
      versionDirCreated = true;
      if (this.db) {
        await this.db.saveVersion({ ...manifest, sourceObjectPath: manifest.sourceObjectPath ?? "", releaseLog, dependencies, updateLatest: false });
        dbVersionCreated = true;
      }
      await this.activatePublishedVersion({ workflowId: options.workflowName, workflowName: metadata.name, version });
      committed = true;
      return { workflowId: options.workflowName, workflowName: metadata.name, version, latest: version,
        nextVersion: formatNextManagedVersion(parseSemver(version)), releaseLog, dependencies };
    } catch (error) {
      if (!committed && dbVersionCreated && version) await this.db?.deleteVersion(options.workflowName, version);
      if (!committed && versionDirCreated && version) await rm(this.versionDir(options.workflowName, version), { recursive: true, force: true });
      throw error;
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }

  private async resolvePublishDependencyLocks(options: {
    workflowName: string;
    sourceDir: string;
    projectType: WorkflowProjectType;
    dependencies?: WorkflowProjectDependencyLock[];
  }): Promise<WorkflowProjectDependencyLock[]> {
    const packageJson = await readPackageJson(options.sourceDir);
    const projectInfo = readWorkflowProjectInfo(packageJson);
    const confirmed: WorkflowRelatedProject[] = [];
    if (this.db !== undefined) {
      for (const relation of projectInfo.relatedProjects) {
        const target = await this.db.getWorkflow(relation.projectId);
        if (target !== undefined && resolveWorkflowRelatedProjectAccess({
          consumerProjectId: options.workflowName,
          consumerProjectInfo: projectInfo,
          targetProjectId: target.id,
          targetProjectInfo: target.projectInfo,
          alias: relation.alias,
        }) !== undefined) confirmed.push(relation);
      }
    }
    const declared = createExternalWorkflowProjectDependencyLocks(confirmed);
    if (options.dependencies === undefined) {
      return declared;
    }

    let dependencies: WorkflowProjectDependencyLock[];
    try {
      dependencies = parseWorkflowProjectDependencyLocks(options.dependencies, { published: true });
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
    return dependencies.map(cloneWorkflowProjectDependencyLock);
  }

  async close(): Promise<void> {
    if (this.projectStorageRevisionSubscription) await (await this.projectStorageRevisionSubscription)();
    await this.db?.close();
  }

  async getProjectDataSummary(projectId: string): Promise<WorkflowProjectDataSummary> {
    this.assertWorkflowId(projectId);
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
    valueType?: WorkflowKVEntryValueType;
    conversationId?: string;
    runId?: string;
  }): Promise<WorkflowKVEntryPage> {
    this.assertWorkflowId(options.projectId);
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
  }): Promise<WorkflowKVEntryDetail> {
    this.assertWorkflowId(options.projectId);
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
    this.assertWorkflowId(options.projectId);
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
    storageKind: WorkflowStorageKind;
    scope: WorkflowKVScope;
    projectId: string;
    key: string;
    conversationId?: string;
  }): Promise<WorkflowPersistentValueGetResult> {
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
    storageKind: WorkflowStorageKind;
    scope: WorkflowKVScope;
    projectId: string;
    key: string;
    conversationId?: string;
    value: unknown;
    source?: WorkflowKVWriteSource;
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
    storageKind: WorkflowStorageKind;
    scope: WorkflowKVScope;
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
    storageKind: WorkflowStorageKind;
    scope: WorkflowKVScope;
    projectId: string;
    key: string;
    conversationId?: string;
    value: unknown;
    expectedRevision: string | null;
    source?: WorkflowKVWriteSource;
  }): Promise<WorkflowPersistentValueCompareAndSetResult> {
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
    mutation: WorkflowPersistentValueKnowledgeMutation;
  }): Promise<WorkflowKnowledgeDocumentRecord | { id: string; deleted: boolean }> {
    return this.withPersistentValueKnowledgeMutationContext<
      WorkflowKnowledgeDocumentRecord | { id: string; deleted: boolean }
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
    workflowName: string,
    options: { pageSize?: number; cursor?: string } = {},
  ): Promise<WorkflowKnowledgeDocumentPage> {
    this.assertWorkflowId(workflowName);
    return this.withKnowledgeContext(workflowName, (context) =>
      listKnowledgeDocumentPage(context, options));
  }

  async getKnowledgeDocument(options: {
    workflowName: string;
    documentId: string;
  }): Promise<WorkflowKnowledgeDocumentRecord> {
    this.assertWorkflowId(options.workflowName);
    const document = await this.withKnowledgeContext(options.workflowName, (context) =>
      getKnowledgeDocument(context, options.documentId));
    if (document === undefined) {
      throw new HttpError(404, 404, `Knowledge document "${options.documentId}" does not exist.`);
    }
    return document;
  }

  async createKnowledgeDocument(options: {
    workflowName: string;
    id?: string;
    title: string;
    markdown: string;
  }): Promise<WorkflowKnowledgeDocumentRecord> {
    this.assertWorkflowId(options.workflowName);
    return this.withPersistentValueKnowledgeMutationContext(options.workflowName, (context) =>
      createKnowledgeDocument(context, {
        id: options.id,
        title: options.title,
        markdown: options.markdown,
      }), { conflictAs: 409 });
  }

  async editKnowledgeDocument(options: {
    workflowName: string;
    documentId: string;
    title?: string;
    markdown?: string;
  }): Promise<WorkflowKnowledgeDocumentRecord> {
    this.assertWorkflowId(options.workflowName);
    return this.withPersistentValueKnowledgeMutationContext(options.workflowName, (context) =>
      editKnowledgeDocument(context, {
        id: options.documentId,
        title: options.title,
        markdown: options.markdown,
      }), { notFoundAs: 404 });
  }

  async deleteKnowledgeDocument(options: {
    workflowName: string;
    documentId: string;
  }): Promise<{ id: string; deleted: boolean }> {
    this.assertWorkflowId(options.workflowName);
    return this.withPersistentValueKnowledgeMutationContext(options.workflowName, (context) =>
      deleteKnowledgeDocument(context, options.documentId));
  }

  async searchKnowledgeDocuments(options: {
    workflowName: string;
    query: string;
    documentId?: string;
    beforeLines?: number;
    afterLines?: number;
    maxMatches?: number;
    pageSize?: number;
    cursor?: string;
  }): Promise<WorkflowKnowledgeDocumentSearchResult> {
    this.assertWorkflowId(options.workflowName);
    return this.withKnowledgeContext(options.workflowName, (context) =>
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
    workflowName: string;
    documentId: string;
    startLine: number;
    endLine: number;
  }): Promise<WorkflowKnowledgeDocumentLinesRecord> {
    this.assertWorkflowId(options.workflowName);
    return this.withKnowledgeContext(options.workflowName, (context) =>
      readKnowledgeDocumentLines(context, {
        documentId: options.documentId,
        startLine: options.startLine,
        endLine: options.endLine,
      }), { notFoundAs: 404 });
  }

  async getSystemTokenUsage(options: {
    pageSize?: number;
    cursor?: string;
  } = {}): Promise<WorkflowTokenUsagePage> {
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
  }): Promise<WorkflowTokenUsageDetail> {
    this.assertWorkflowId(options.projectId);
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

  private async withKanbanConfigurationLock<T>(
    workflowName: string,
    actorId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${workflowName}:${requireKanbanActorId(actorId)}`;
    const previous = this.kanbanConfigurationLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => current);
    this.kanbanConfigurationLocks.set(key, chained);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.kanbanConfigurationLocks.get(key) === chained) {
        this.kanbanConfigurationLocks.delete(key);
      }
    }
  }

  private async ensureEditableDraft(
    workflowName: string,
    requestedTarget: string,
  ): Promise<void> {
    await this.materializeDbDraftSource(workflowName);
    if (await exists(this.draftSourceDir(workflowName))) {
      return;
    }

    const sourceTarget = requestedTarget.trim() || "latest";
    if (sourceTarget === "draft") {
      throw new HttpError(404, 404, `Workflow "${workflowName}" has no draft.`);
    }

    const resolved = await this.resolveSourceTarget(workflowName, sourceTarget);
    await rm(this.draftSourceDir(workflowName), {
      recursive: true,
      force: true,
    });
    await copyWorkflowSource(resolved.sourceDir, this.draftSourceDir(workflowName));
  }

  private async stageDraftEdit(workflowName: string, editSourceDir: (sourceDir: string) => Promise<void>): Promise<void> {
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const draft = path.join(tempDir, "draft");
    try {
      await this.materializeDbDraftSource(workflowName);
      await copyWorkflowSource(this.draftSourceDir(workflowName), path.join(draft, "source"));
      await editSourceDir(path.join(draft, "source"));
      await this.commitStagedDraft(workflowName, draft);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }

  private async stageDraftFromVersionSource(workflowName: string, sourceVersion: string, editSourceDir?: (sourceDir: string) => Promise<void>): Promise<void> {
    await this.ensureDbVersionSourceMaterializedIfNeeded(workflowName, sourceVersion);
    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const draft = path.join(tempDir, "draft");
    try {
      await copyWorkflowSource(this.versionSourceDir(workflowName, sourceVersion), path.join(draft, "source"));
      await editSourceDir?.(path.join(draft, "source"));
      await this.commitStagedDraft(workflowName, draft);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }

  private async ensureDbVersionSourceMaterializedIfNeeded(
    workflowName: string,
    version: string,
  ): Promise<void> {
    if (this.db !== undefined) {
      await this.materializeDbVersionSource(workflowName, version);
    }
  }

  private async updatePackageMetadataName(
    sourceDir: string,
    workflowId: string,
    displayName: string,
  ): Promise<void> {
    const packageJsonPath = path.join(sourceDir, "package.json");
    const current = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
    if (!isRecord(current)) {
      throw new HttpError(500, 500, `Workflow "${workflowId}" package.json root must be an object.`);
    }

    const nextPackageJson = {
      ...current,
      id: workflowId,
      name: displayName,
    };
    await writeFile(packageJsonPath, `${JSON.stringify(nextPackageJson, null, 2)}\n`);
  }

  private async assertWorkflowDoesNotExist(workflowName: string): Promise<void> {
    const existingWorkflow = this.db === undefined
      ? undefined
      : await this.db.getWorkflow(workflowName);
    if (
      existingWorkflow !== undefined ||
      await exists(this.draftSourceDir(workflowName)) ||
      await exists(this.workflowRoot(workflowName))
    ) {
      throw new HttpError(
        409,
        409,
        `Workflow "${workflowName}" already exists. Delete it first or choose a different name.`,
      );
    }
  }

  private async commitStagedDraft(workflowName: string, stagedDraftDir: string): Promise<void> {
    await this.withWorkflowPublishLock(workflowName, async () => {
      const sourceDir = path.join(stagedDraftDir, "source");
      const metadata = await validateWorkflowPackage(sourceDir, workflowName);
      await this.persistDraftFromSourceDir(workflowName, sourceDir);
      await replaceDirectory(stagedDraftDir, this.draftDir(workflowName));
      this.materializedDraftSourceRevisions.delete(workflowName);
      if (!this.db) await writeJson(this.workflowProjectInfoMetadataPath(workflowName), {
        name: metadata.name, projectInfo: this.normalizeDeclaredProjectInfo(metadata.projectInfo) });
    });
  }

  private async updateMaterializedDraftProjectInfo(
    workflowName: string,
    name: string,
    projectInfo: DeclaredWorkflowProjectInfo,
  ): Promise<void> {
    const sourceDir = this.draftSourceDir(workflowName);
    if (!(await exists(sourceDir))) return;
    const packageJson = await readPackageJson(sourceDir);
    await writeJson(
      path.join(sourceDir, "package.json"),
      writeWorkflowProjectInfo({
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
    workflowName: string,
    target: string,
  ): Promise<{ resolvedTarget: string; sourceDir: string }> {
    const normalizedTarget = target.trim() || "draft";

    if (normalizedTarget === "draft") {
      await this.materializeDbDraftSource(workflowName);
      const sourceDir = this.draftSourceDir(workflowName);
      if (!(await exists(sourceDir))) {
        throw new HttpError(404, 404, `Workflow "${workflowName}" has no draft.`);
      }
      return { resolvedTarget: "draft", sourceDir };
    }

    const version =
      normalizedTarget === "latest"
        ? await this.requireLatest(workflowName)
        : normalizedTarget;

    assertVersion(version);
    await this.assertVersionReadable(workflowName, version);
    if (this.db !== undefined) {
      await this.materializeDbVersionSource(workflowName, version);
    }

    const sourceDir = this.versionSourceDir(workflowName, version);
    if (!(await exists(sourceDir))) {
      throw new HttpError(404, 404, `Workflow "${workflowName}" version "${version}" does not exist.`);
    }

    return { resolvedTarget: version, sourceDir };
  }

  private async readRetainedSourceFiles(workflowName: string, version: string): Promise<{ workflowName: string; files: WorkflowFile[] }> {
    const resolved = await this.resolveSourceTarget(workflowName, version);
    const metadata = await this.readPackageMetadataForTarget(workflowName, version);
    return { workflowName: metadata.name, files: await readProjectFiles(resolved.sourceDir, true) };
  }

  async getSourceShare(workflowId: string, version: string): Promise<WorkflowSourceShare> {
    this.assertWorkflowId(workflowId);
    assertVersion(version);
    await this.assertVersionReadable(workflowId, version);
    const manifest = await this.readManifest(workflowId, version);
    if (!manifest) throw new HttpError(404, 404, `Workflow "${workflowId}" version "${version}" does not exist.`);
    return {
      id: workflowId,
      name: manifest.workflowName,
      version: manifest.version,
      createdAt: manifest.createdAt,
      releaseLog: manifest.releaseLog,
      sourceHash: manifest.sourceHash,
    };
  }

  async getSourceArchive(workflowName: string, target = "latest"): Promise<{ version: string; archive: Buffer }> {
    this.assertWorkflowId(workflowName);
    if (target === "draft") throw new HttpError(400, 400, "Download a published project version.");
    const source = await this.resolveSourceTarget(workflowName, target);
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
      throw new Error("WorkflowStorage.init() must complete before runtime versions are used.");
    }
    return this.buildInfo;
  }

  private async requireDbVersion(
    workflowName: string,
    version: string,
  ): Promise<WorkflowDbVersionRecord> {
    const record = this.db === undefined
      ? undefined
      : await this.db.getVersion(workflowName, version);
    if (record === undefined) {
      throw new HttpError(404, 404, `Workflow "${workflowName}" version "${version}" does not exist.`);
    }
    return record;
  }

  private assertWorkflowId(workflowId: string): void {
    if (!isSafeWorkflowId(workflowId)) {
      throw new HttpError(400, 400, createUnsafeWorkflowIdMessage(workflowId));
    }
    if (!isWorkflowUuid(workflowId)) {
      throw new HttpError(400, 400, createInvalidWorkflowUuidMessage(workflowId));
    }
  }

  private normalizeDeclaredProjectInfo(value: unknown): DeclaredWorkflowProjectInfo {
    try {
      return normalizeDeclaredWorkflowProjectInfo(value);
    } catch (error) {
      throw new HttpError(400, 400, readErrorMessage(error));
    }
  }

  private async assertServerProjectStorageMode(
    workflowId: string,
    action: "access server data",
  ): Promise<WorkflowProjectInfo> {
    this.assertWorkflowId(workflowId);
    const stored = await this.db?.getWorkflow(workflowId);
    const projectInfo = stored?.projectInfo ?? (await this.readPackageMetadata(workflowId)).projectInfo;
    try {
      assertWorkflowProjectDataStorageLocationAllowed(projectInfo, "server");
      return projectInfo;
    } catch {
      const mode = projectInfo.dataStorage?.mode ?? null;
      const data = {
        workflowId,
        dataStorageMode: mode,
        requiredLocation: "server" as const,
        allowedModes: ["server", "both"] as const,
      };
      if (mode === null) {
        throw new HttpError(
          409,
          409,
          `Project "${workflowId}" cannot ${action} because steamHarness.projectInfo.dataStorage.mode is not declared. Open the project in Desktop and save Project Info before retrying.`,
          data,
          {
            messageKey: "server:projectDataStorageDeclarationRequired",
            params: { workflowId, action },
          },
        );
      }
      throw new HttpError(
        409,
        409,
        `Project "${workflowId}" cannot ${action} because data storage mode "${mode}" does not allow server storage.`,
        data,
        {
          messageKey: "server:projectDataStorageServerForbidden",
          params: { workflowId, action, mode },
        },
      );
    }
  }

  private async readPackageMetadata(workflowId: string): Promise<WorkflowPackageMetadata> {
    const sourceDir = this.draftSourceDir(workflowId);
    if (await exists(sourceDir)) {
      const metadata = await validateWorkflowPackage(sourceDir, workflowId);
      return this.db === undefined
        ? this.applyStoredProjectInfoMetadata(workflowId, metadata)
        : metadata;
    }
    if (this.db !== undefined) {
      const workflow = await this.db.getWorkflow(workflowId);
      if (workflow !== undefined) {
        return {
          id: workflow.id,
          name: workflow.name,
          version: workflow.packageVersion,
          projectType: workflow.projectType,
          projectCard: workflow.projectCard,
          projectInfo: workflow.projectInfo,
          requiredCoreVersion: "unknown",
        };
      }
    }

    const latest = await this.readLatest(workflowId);
    if (latest !== null) {
      const metadata = await validateWorkflowPackage(
        this.versionSourceDir(workflowId, latest),
        workflowId,
      );
      return this.db === undefined
        ? this.applyStoredProjectInfoMetadata(workflowId, metadata)
        : metadata;
    }

    throw new HttpError(404, 404, `Workflow "${workflowId}" does not exist.`);
  }

  private async applyStoredProjectInfoMetadata(
    workflowId: string,
    metadata: WorkflowPackageMetadata,
  ): Promise<WorkflowPackageMetadata> {
    const stored = await readJson<StoredWorkflowProjectInfoMetadata>(
      this.workflowProjectInfoMetadataPath(workflowId),
    );
    if (stored === undefined) return metadata;
    const name = typeof stored.name === "string" ? stored.name.trim() : "";
    if (name === "") return metadata;
    try {
      return {
        ...metadata,
        name,
        projectInfo: normalizeWorkflowProjectInfo(stored.projectInfo),
      };
    } catch {
      return metadata;
    }
  }

  private async readPackageMetadataForTarget(workflowName: string, target: string): Promise<WorkflowPackageMetadata> {
    const resolved = await this.resolveSourceTarget(workflowName, target);
    return this.applyStoredProjectInfoMetadata(workflowName, await validateWorkflowPackage(resolved.sourceDir, workflowName));
  }

  private async readWorkflowMetadataForEditing(
    workflowId: string,
  ): Promise<WorkflowPackageMetadata> {
    try {
      return await this.readPackageMetadata(workflowId);
    } catch (error) {
      const workflow = await this.db?.getWorkflow(workflowId);
      if (workflow !== undefined) {
        return {
          id: workflow.id,
          name: workflow.name,
          version: workflow.packageVersion,
          projectType: workflow.projectType,
          projectCard: workflow.projectCard,
          projectInfo: workflow.projectInfo,
          requiredCoreVersion: "unknown",
        };
      }
      throw error;
    }
  }

  private async resolveWorkflowConfigTarget(
    workflowName: string,
    target: string,
  ): Promise<string> {
    const normalizedTarget = target.trim() || "draft";

    if (normalizedTarget === "draft") {
      if (this.db !== undefined) {
        const workflow = await this.db.getWorkflow(workflowName);
        if (workflow?.hasDraft) {
          return "draft";
        }
      }
      if (!(await exists(this.draftSourceDir(workflowName)))) {
        throw new HttpError(404, 404, `Workflow "${workflowName}" has no draft.`);
      }

      return "draft";
    }

    if (normalizedTarget === "latest") {
      return await this.requireLatest(workflowName);
    }

    assertVersion(normalizedTarget);
    await this.assertVersionReadable(workflowName, normalizedTarget);
    if (this.db !== undefined) {
      if ((await this.db.getVersion(workflowName, normalizedTarget)) !== undefined) {
        return normalizedTarget;
      }
    }
    if (!(await exists(this.versionDir(workflowName, normalizedTarget)))) {
      throw new HttpError(
        404,
        404,
        `Workflow "${workflowName}" version "${normalizedTarget}" does not exist.`,
      );
    }

    return normalizedTarget;
  }

  private async readLatest(workflowName: string): Promise<string | null> {
    if (this.db !== undefined) {
      return (await this.db.getWorkflow(workflowName))?.latest ?? null;
    }

    const latest = await readJson<{ version?: unknown }>(this.latestPath(workflowName));

    return typeof latest?.version === "string" && SEMVER_PATTERN.test(latest.version)
      ? latest.version
      : null;
  }

  private async requireLatest(workflowName: string): Promise<string> {
    const latest = await this.readLatest(workflowName);

    if (latest === null) {
      throw new HttpError(404, 404, `Workflow "${workflowName}" has no latest version.`);
    }

    return latest;
  }

  private async listVersionNames(workflowName: string): Promise<string[]> {
    if (this.db !== undefined) {
      return (await this.db.listVersions(workflowName))
        .map((version) => version.version)
        .sort(compareSemverVersions);
    }

    const versionsRoot = this.versionsRoot(workflowName);

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

  private async resolveNextVersion(workflowName: string): Promise<string> {
    // A checked-in draft carries the version the user intends to publish. Do
    // not silently rewrite it to a server-generated number: doing so would
    // make the package and the immutable source snapshot disagree.
    try {
      const draftMetadata = await this.readPackageMetadata(workflowName);
      if (SEMVER_PATTERN.test(draftMetadata.version)) return draftMetadata.version;
    } catch {
      // Projects created without uploaded source use the published version list.
    }
    const versions = await this.listVersionNames(workflowName);
    const latest = await this.readLatest(workflowName);
    const reservations = this.db === undefined
      ? []
      : await this.db.listWorkflowVersionReservations(workflowName);
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
    workflowName: string,
    version: string,
    reservationDeploymentId?: string,
  ): Promise<void> {
    assertVersion(version);
    const existing = await this.listVersionNames(workflowName);
    if (existing.includes(version)) {
      throw new HttpError(
        409,
        409,
        `Workflow "${workflowName}" version "${version}" already exists.`,
        { workflowId: workflowName, version, reason: "version_exists" },
      );
    }

    const reservations = this.db === undefined
      ? []
      : await this.db.listWorkflowVersionReservations(workflowName, reservationDeploymentId);
    const conflictingReservation = reservations.find((candidate) => candidate === version);
    if (conflictingReservation !== undefined) {
      throw new HttpError(
        409,
        409,
        `Workflow "${workflowName}" version "${version}" is reserved by another deployment.`,
        { workflowId: workflowName, version, reason: "version_reserved" },
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
        `Workflow "${workflowName}" version "${version}" must be higher than existing version "${higherVersion}".`,
        {
          workflowId: workflowName,
          version,
          highestVersion: higherVersion,
          reason: "version_not_increasing",
        },
      );
    }
  }

  private async readManifest(
    workflowName: string,
    version: string,
  ): Promise<WorkflowManifest | undefined> {
    if (this.db !== undefined) {
      const record = await this.db.getVersion(workflowName, version);
      if (record !== undefined) {
        return {
          workflowId: record.workflowId,
          workflowName: record.workflowName,
          version: record.version,
          createdAt: record.createdAt,
          releaseLog: record.releaseLog,
          sourceHash: record.sourceHash,
          sourceObjectPath: record.sourceObjectPath,
          dependencies: record.dependencies.map(cloneWorkflowProjectDependencyLock),
        };
      }
    }

    return readJson<WorkflowManifest>(this.versionManifestPath(workflowName, version));
  }

  private async readVersionDependencyLocks(workflowName: string, version: string, manifest?: WorkflowManifest): Promise<WorkflowProjectDependencyLock[]> {
    const stored = manifest ?? await this.readManifest(workflowName, version);
    if (!stored) throw new HttpError(404, 404, "Published version does not exist.");
    try { return parseWorkflowProjectDependencyLocks(stored.dependencies, { published: true }); }
    catch (error) { throw new HttpError(409, 409, "Invalid project dependency lock.", { reason: readErrorMessage(error) }); }
  }

  private async assertVersionExists(
    workflowName: string,
    version: string,
  ): Promise<void> {
    if (this.db !== undefined) {
      if ((await this.db.getVersion(workflowName, version)) !== undefined) {
        return;
      }
    } else if (await exists(this.versionDir(workflowName, version))) {
      return;
    }

    throw new HttpError(404, 404, `Workflow "${workflowName}" version "${version}" does not exist.`);
  }

  private async assertVersionReadable(workflowName: string, version: string): Promise<void> { await this.assertVersionExists(workflowName, version); }

  private async withWorkflowPublishLock<T>(
    workflowName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.db !== undefined) {
      return this.withLocalWorkflowPublishLock(workflowName, () =>
        this.db?.withWorkflowPublishLock(workflowName, operation) ?? operation(),
      );
    }

    return this.withLocalWorkflowPublishLock(workflowName, operation);
  }

  private async withWorkflowPublishLocks<T>(
    workflowNames: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const names = [...new Set(workflowNames)].sort();
    const acquire = (index: number): Promise<T> => {
      const workflowName = names[index];
      if (workflowName === undefined) return operation();
      return this.withWorkflowPublishLock(workflowName, () => acquire(index + 1));
    };
    return acquire(0);
  }

  private async withProjectGroupDeploymentLock<T>(
    deploymentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withLocalProjectGroupDeploymentLock(deploymentId, () =>
      this.db?.withWorkflowDeploymentLock(deploymentId, operation) ?? operation());
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

  private async withLocalWorkflowPublishLock<T>(
    workflowName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.publishLocks.get(workflowName) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.publishLocks.set(workflowName, next);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.publishLocks.get(workflowName) === next) {
        this.publishLocks.delete(workflowName);
      }
    }
  }

  private async activatePublishedVersion(options: { workflowId: string; workflowName: string; version: string }): Promise<void> {
    if (this.db) {
      await this.db.markVersionLatest(options);
      return;
    }
    const target = this.latestPath(options.workflowId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeJson(temporary, { version: options.version });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async summarizeDbWorkflow(workflow: WorkflowDbRecord, records?: Array<{ version: string }>): Promise<WorkflowSummary> {
    const versions = (records ?? await this.db?.listVersions(workflow.id) ?? []).map(item => item.version).sort(compareSemverVersions);
    return { id: workflow.id, name: workflow.name, projectType: workflow.projectType, projectCard: workflow.projectCard,
      projectInfo: workflow.projectInfo, ownerUserId: workflow.ownerUserId, visibility: workflow.visibility,
      createdByUserId: workflow.createdByUserId, createdAt: workflow.createdAt, updatedAt: workflow.updatedAt,
      hasDraft: workflow.hasDraft, latest: workflow.latest, versions, nextVersion: resolveNextManagedVersionFromRecords(workflow.latest, versions) };
  }

  private async readWorkflowRecordForAccess(
    workflowId: string,
  ): Promise<WorkflowDbRecord> {
    if (this.db !== undefined) {
      const workflow = await this.db.getWorkflow(workflowId);
      if (workflow === undefined) {
        throw new HttpError(404, 404, `Workflow "${workflowId}" does not exist.`);
      }
      return workflow;
    }

    const metadata = await this.readPackageMetadata(workflowId);
    const versions = await this.listVersionNames(workflowId);
    const timestamps = await this.readFileWorkflowTimestamps(workflowId, versions);
    return {
      id: metadata.id,
      name: metadata.name,
      projectType: metadata.projectType,
      projectCard: metadata.projectCard,
      projectInfo: metadata.projectInfo,
      packageVersion: metadata.version,
      hasDraft: await exists(this.draftSourceDir(workflowId)),
      latest: await this.readLatest(workflowId),
      visibility: "private",
      createdAt: timestamps.createdAt ?? new Date().toISOString(),
      updatedAt: timestamps.updatedAt ?? timestamps.createdAt ?? new Date().toISOString(),
    };
  }

  private async createProjectAccessSummary(workflow: WorkflowDbRecord, userId?: string): Promise<WorkflowProjectAccessSummary> {
    return { workflowId: workflow.id, workflowName: workflow.name, ownerUserId: workflow.ownerUserId, visibility: workflow.visibility,
      createdByUserId: workflow.createdByUserId, member: this.db && userId ? await this.db.getWorkflowMember(workflow.id, userId) : undefined };
  }

  private async readFileWorkflowTimestamps(
    workflowName: string,
    versions: string[],
  ): Promise<{ createdAt?: string; updatedAt?: string }> {
    const candidates = [
      await statIfExists(this.workflowRoot(workflowName)),
      await statIfExists(this.draftSourceDir(workflowName)),
      ...(await Promise.all(
        versions.map((version) => statIfExists(this.versionDir(workflowName, version))),
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

  private async persistDraftFromSourceDir(workflowName: string, sourceDir = this.draftSourceDir(workflowName)): Promise<void> {
    if (!this.db) return;
    const metadata = await validateWorkflowPackage(sourceDir, workflowName);
    await this.assertUploadedProjectType(workflowName, metadata.projectType);
    await this.db.saveDraft({ workflowId: metadata.id, workflowName: metadata.name, projectType: metadata.projectType,
      packageVersion: metadata.version, projectCard: metadata.projectCard, projectInfo: this.normalizeDeclaredProjectInfo(metadata.projectInfo),
      files: await readProjectFiles(sourceDir, true) });
  }

  private async assertUploadedProjectType(
    workflowId: string,
    sourceProjectType: WorkflowProjectType,
  ): Promise<void> {
    if (this.db === undefined) {
      return;
    }
    const existing = await this.db.getWorkflow(workflowId);
    if (existing === undefined || existing.projectType === sourceProjectType) return;
    if (existing.hasDraft) return;
    if ((await this.db.listVersions(workflowId)).length > 0) return;

    throw new HttpError(
      409,
      409,
      `Workflow "${workflowId}" was created as projectType "${existing.projectType}", but package.json declares "${sourceProjectType}". Create a project with the matching type or update steamHarness.projectType before uploading.`,
    );
  }

  private async materializeDbDraftSource(workflowName: string): Promise<void> {
    const db = this.db;
    if (db === undefined) {
      return;
    }

    await this.materializeSourceOnce(`draft\0${workflowName}`, async () => {
      const workflow = await db.getWorkflow(workflowName);
      if (!workflow?.hasDraft) {
        this.materializedDraftSourceRevisions.delete(workflowName);
        return;
      }

      const sourceDir = this.draftSourceDir(workflowName);
      if (
        this.materializedDraftSourceRevisions.get(workflowName) === workflow.updatedAt &&
        await exists(sourceDir)
      ) {
        return;
      }

      await writeWorkflowFiles(sourceDir, await db.readDraftFiles(workflowName));
      this.materializedDraftSourceRevisions.set(workflowName, workflow.updatedAt);
    });
  }

  private async materializeDbVersionSource(
    workflowName: string,
    version: string,
  ): Promise<void> {
    const db = this.db;
    if (db === undefined) {
      return;
    }

    await this.materializeSourceOnce(`version\0${workflowName}\0${version}`, async () => {
      const record = await db.getVersion(workflowName, version);
      if (record === undefined || await exists(this.versionSourceDir(workflowName, version))) {
        return;
      }

      if (this.artifacts === undefined) {
        return;
      }

      try {
        await this.downloadAndExtractArtifact(
          record.sourceObjectPath,
          this.versionSourceDir(workflowName, version),
          record.sourceHash,
        );
      } catch (error) {
        throw this.createArtifactReadError({
          workflowId: workflowName,
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
    workflowId: string;
    version: string;
    artifact: "source";
    objectPath: string;
    error: unknown;
  }): HttpError {
    const isMissing = isWorkflowStorageNotFoundError(options.error);
    const reason = readErrorMessage(options.error);
    const message = isMissing
      ? `Workflow "${options.workflowId}" version "${options.version}" ${options.artifact} artifact is missing from storage.`
      : `Failed to read workflow "${options.workflowId}" version "${options.version}" ${options.artifact} artifact. ${reason}`;
    return new HttpError(
      isMissing ? 404 : 500,
      isMissing ? 404 : 500,
      message,
      {
        workflowId: options.workflowId,
        version: options.version,
        artifact: options.artifact,
        objectPath: options.objectPath,
        reason,
      },
    );
  }

  private async uploadVersionArtifacts(options: {
    workflowName: string;
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
          "Workflow object storage is required to publish database-backed workflow versions.",
        );
      }
      return undefined;
    }

    const tempDir = path.join(this.dataRoot, "tmp", randomUUID());
    const sourceArchive = path.join(tempDir, "source.tar.gz");
    const sourceObjectPath = createObjectPath({
      workflowId: options.workflowName,
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
        `Failed to upload workflow ${artifactName} artifact ${objectPath} (${formatBytes(archiveSize)}). ${readErrorMessage(error)}`,
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
    workflowName: string,
    requestedTarget?: string,
  ): Promise<Omit<WorkflowKanbanWorkspaceState, "configurations" | "activeConfigurationId">> {
    this.assertWorkflowId(workflowName);
    await this.assertServerProjectDataAccess(workflowName);
    const target = requestedTarget?.trim() || "draft";
    const resolved = await this.resolveSourceTarget(workflowName, target);
    const metadata = await this.readPackageMetadataForTarget(workflowName, resolved.resolvedTarget);
    if (metadata.projectType !== "kanban") {
      throw new HttpError(409, 409, `Project "${metadata.name}" is not a Kanban project.`);
    }
    const manifestPath = path.join(resolved.sourceDir, KANBAN_MANIFEST_FILE);
    const manifest = await exists(manifestPath)
      ? parseKanbanManifestText(await readFile(manifestPath, "utf8"))
      : undefined;
    return {
      workflowId: workflowName,
      workflowName: metadata.name,
      target,
      resolvedTarget: resolved.resolvedTarget,
      ...readKanbanArtifactConfig(await readPackageJson(resolved.sourceDir)),
      relatedProjects: metadata.projectInfo.relatedProjects.map(cloneRelatedProject),
      manifest,
    };
  }

  private async readStoredKanbanConfigurationState(
    workflowName: string,
    actorId: string,
  ): Promise<WorkflowKanbanConfigurationStateRecord> {
    const normalizedActorId = requireKanbanActorId(actorId);
    if (this.db) {
      return this.db.readKanbanConfigurationState(workflowName, normalizedActorId);
    }
    return normalizeStoredKanbanConfigurationState(
      await readJson<unknown>(this.kanbanConfigurationStatePath(workflowName, normalizedActorId)),
    );
  }

  private async ensureStoredKanbanConfiguration(
    workflowName: string,
    actorId: string,
    configuration: KanbanConfiguration,
  ): Promise<void> {
    const normalizedActorId = requireKanbanActorId(actorId);
    if (this.db) {
      await this.db.ensureKanbanConfiguration(workflowName, normalizedActorId, configuration);
      return;
    }
    const state = await this.readStoredKanbanConfigurationState(workflowName, normalizedActorId);
    if (state.configurations.length > 0) return;
    await this.writeLocalKanbanConfigurationState(workflowName, normalizedActorId, {
      configurations: [configuration],
      activeConfigurationId: configuration.id,
    });
  }

  private async saveStoredKanbanConfiguration(
    workflowName: string,
    actorId: string,
    configuration: KanbanConfiguration,
  ): Promise<void> {
    const normalizedActorId = requireKanbanActorId(actorId);
    if (this.db) {
      await this.db.saveKanbanConfiguration(workflowName, normalizedActorId, configuration);
      return;
    }
    const state = await this.readStoredKanbanConfigurationState(workflowName, normalizedActorId);
    const existingIndex = state.configurations.findIndex((item) => item.id === configuration.id);
    const configurations = [...state.configurations];
    if (existingIndex === -1) configurations.push(configuration);
    else configurations[existingIndex] = configuration;
    await this.writeLocalKanbanConfigurationState(workflowName, normalizedActorId, {
      configurations,
      activeConfigurationId: state.activeConfigurationId ?? configuration.id,
    });
  }

  private async setStoredActiveKanbanConfiguration(
    workflowName: string,
    actorId: string,
    configurationId: string,
  ): Promise<void> {
    const normalizedActorId = requireKanbanActorId(actorId);
    if (this.db) {
      await this.db.setActiveKanbanConfiguration(workflowName, normalizedActorId, configurationId);
      return;
    }
    const state = await this.readStoredKanbanConfigurationState(workflowName, normalizedActorId);
    await this.writeLocalKanbanConfigurationState(workflowName, normalizedActorId, {
      ...state,
      activeConfigurationId: configurationId,
    });
  }

  private async deleteStoredKanbanConfiguration(
    workflowName: string,
    actorId: string,
    configurationId: string,
  ): Promise<void> {
    const normalizedActorId = requireKanbanActorId(actorId);
    if (this.db) {
      await this.db.deleteKanbanConfiguration(workflowName, normalizedActorId, configurationId);
      return;
    }
    const state = await this.readStoredKanbanConfigurationState(workflowName, normalizedActorId);
    await this.writeLocalKanbanConfigurationState(workflowName, normalizedActorId, {
      configurations: state.configurations.filter((item) => item.id !== configurationId),
      activeConfigurationId: state.activeConfigurationId === configurationId
        ? undefined
        : state.activeConfigurationId,
    });
  }

  private async writeLocalKanbanConfigurationState(
    workflowName: string,
    actorId: string,
    state: WorkflowKanbanConfigurationStateRecord,
  ): Promise<void> {
    const target = this.kanbanConfigurationStatePath(workflowName, actorId);
    await mkdir(path.dirname(target), { recursive: true });
    await writeJson(target, state);
  }

  private kanbanConfigurationStatePath(workflowName: string, actorId: string): string {
    const actorKey = createHash("sha256").update(actorId).digest("hex");
    return path.join(this.workflowRoot(workflowName), "kanban-configurations", `${actorKey}.json`);
  }

  private async withKnowledgeContext<T>(
    workflowName: string,
    run: (context: WorkflowStorageLocationContext) => Promise<T>,
    options: { conflictAs?: number; notFoundAs?: number } = {},
  ): Promise<T> {
    this.assertWorkflowId(workflowName);
    return this.withPersistentValueKnowledgeContext(workflowName, run, options);
  }

  private async withPersistentValueKnowledgeContext<T>(
    workflowName: string,
    run: (context: WorkflowStorageLocationContext) => Promise<T>,
    options: { conflictAs?: number; notFoundAs?: number } = {},
  ): Promise<T> {
    await this.assertServerProjectDataAccess(workflowName);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "PersistentValue knowledge base requires PostgreSQL storage.");
    }

    const context = this.createKnowledgeWorkflowContext(
      workflowName,
    );
    try {
      return await run(context);
    } catch (error) {
      throw mapKnowledgeError(error, options);
    }
  }

  private async withPersistentValueKnowledgeMutationContext<T>(
    workflowName: string,
    run: (context: WorkflowStorageLocationContext) => Promise<T>,
    options: { conflictAs?: number; notFoundAs?: number } = {},
  ): Promise<T> {
    await this.assertServerProjectDataAccess(workflowName);
    if (this.db === undefined) {
      throw new HttpError(501, 501, "PersistentValue knowledge base requires PostgreSQL storage.");
    }

    this.assertWorkflowId(workflowName);
    try {
      return await this.db.withNamespaceTransaction(
        { storageKind: "persistent_value", scope: "project", projectId: workflowName },
        (store) => run(this.createKnowledgeWorkflowContext(workflowName, store)),
      );
    } catch (error) {
      throw mapKnowledgeError(error, options);
    }
  }

  private createKnowledgeWorkflowContext(
    projectId: string,
    store?: WorkflowKVStore,
  ): WorkflowStorageLocationContext {
    const persistentStore = store ?? this.db;
    if (persistentStore === undefined) {
      throw new HttpError(501, 501, "Project knowledge base requires PostgreSQL storage.");
    }

    // The management knowledge base uses the same PersistentValue project
    // domain as local client writes, without introducing a new table.
    const source = { projectId };
    return {
      kv: createWorkflowKVContext({
        store: persistentStore,
        projectId,
        source,
      }),
      persistentValue: createWorkflowPersistentValueContext({
        store: persistentStore,
        projectId,
        source,
      }),
      relatedProjects: createWorkflowRelatedProjectsContext(),
    };
  }

  private workflowsRoot(): string {
    return path.join(this.dataRoot, "workflows");
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
    preparation: Pick<WorkflowDeploymentPreparation, "deploymentId" | "archiveName">,
  ): string {
    return path.join(this.deploymentPreparationDir(preparation.deploymentId), preparation.archiveName);
  }

  private preparationWorkflowRoot(workflowName: string): string {
    return path.join(this.preparationsRoot(), workflowName);
  }

  private preparationJobDir(workflowName: string, jobId: string): string {
    return path.join(this.preparationWorkflowRoot(workflowName), jobId);
  }

  private preparationJobPath(workflowName: string, jobId: string): string {
    return path.join(this.preparationJobDir(workflowName, jobId), "job.json");
  }

  private preparationArchivePath(job: Pick<WorkflowPreparationJob, "workflowId" | "jobId" | "archiveName">): string {
    return path.join(this.preparationJobDir(job.workflowId, job.jobId), job.archiveName);
  }

  private workflowRoot(workflowName: string): string {
    try {
      return resolveWorkflowRoot(this.workflowsRoot(), workflowName);
    } catch (error) {
      throw new HttpError(400, 400, error instanceof Error ? error.message : String(error));
    }
  }

  private draftDir(workflowName: string): string {
    return path.join(this.workflowRoot(workflowName), "draft");
  }

  private draftSourceDir(workflowName: string): string {
    return path.join(this.draftDir(workflowName), "source");
  }

  private versionsRoot(workflowName: string): string {
    return path.join(this.workflowRoot(workflowName), "versions");
  }

  private versionDir(workflowName: string, version: string): string {
    return path.join(this.versionsRoot(workflowName), version);
  }

  private versionSourceDir(workflowName: string, version: string): string {
    return path.join(this.versionDir(workflowName, version), "source");
  }

  private versionManifestPath(workflowName: string, version: string): string {
    return path.join(this.versionDir(workflowName, version), "manifest.json");
  }

  private latestPath(workflowName: string): string {
    return path.join(this.workflowRoot(workflowName), "latest.json");
  }

  private workflowProjectInfoMetadataPath(workflowName: string): string {
    return path.join(this.workflowRoot(workflowName), "project-info.json");
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

  private projectCardImageDir(workflowName: string): string {
    return path.join(this.projectCardImagesRoot(), workflowName);
  }

  private projectCardImagePath(workflowName: string, hash: string): string {
    assertProjectCardImageHash(hash);
    return path.join(this.projectCardImageDir(workflowName), `${hash}.webp`);
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
  if (!(error instanceof WorkflowError)) {
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
  storageKind: WorkflowStorageKind;
  scope: WorkflowKVScope;
  projectId: string;
  key: string;
  conversationId?: string;
}): WorkflowKVStoreGetInput {
  const key = normalizeExactFilter(input.key);
  if (key === "") {
    throw new HttpError(400, 400, "Project storage key must be a non-empty string.");
  }
  const projectId = normalizeExactFilter(input.projectId);
  if (!isWorkflowUuid(projectId)) {
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
  source: WorkflowKVWriteSource | undefined,
): WorkflowKVWriteSource | undefined {
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

function cloneRelatedProject(relation: WorkflowRelatedProject): WorkflowRelatedProject {
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
  grant: WorkflowRelatedProjectKVGrant,
): WorkflowRelatedProjectKVGrant {
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
  projectInfo: WorkflowProjectInfo,
  relation: WorkflowRelatedProject,
): WorkflowProjectInfo {
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
  projectInfo: WorkflowProjectInfo,
  alias: string,
): WorkflowProjectInfo {
  return {
    ...projectInfo,
    relatedProjects: projectInfo.relatedProjects
      .filter((item) => item.alias !== alias)
      .map(cloneRelatedProject),
  };
}

function removeRelatedProjectByProjectId(
  projectInfo: WorkflowProjectInfo,
  projectId: string,
): WorkflowProjectInfo {
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
export function createWorkflowObjectStorageFromEnv(options: {
  dataRoot: string;
  env?: NodeJS.ProcessEnv;
}): WorkflowObjectStorage {
  const env = options.env ?? process.env;
  resolveWorkflowStorageDriver(env);
  return createWorkflowLocalStorageFromEnv({ env, dataRoot: options.dataRoot });
}
export async function createStorageFromEnv(): Promise<WorkflowStorage> {
  const { repoRoot, serverRoot } = resolveServerPathRoots();
  const dataRoot = resolveServerDataRootFromEnv({ serverRoot });
  const connectionString = process.env.STEAMHARNESS_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("STEAMHARNESS_DATABASE_URL is required for project storage.");
  const objectStorage = createWorkflowObjectStorageFromEnv({ dataRoot });
  const storage = new WorkflowStorage({ repoRoot, serverRoot, dataRoot, db: new DatabaseRepository(connectionString),
    objectStorage, artifacts: new ArtifactStorage(objectStorage) });
  await storage.init();
  return storage;
}

async function validateWorkflowPackage(
  sourceDir: string,
  expectedId?: string,
  hostCoreVersion?: string,
): Promise<WorkflowPackageMetadata> {
  if (!(await exists(path.join(sourceDir, "package.json")))) {
    throw new HttpError(400, 400, "Workflow package must contain package.json.");
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
    const manifestPath = path.join(sourceDir, KANBAN_MANIFEST_FILE);
    if (await exists(manifestPath)) {
      try {
        parseKanbanManifestText(await readFile(manifestPath, "utf8"));
      } catch (error) {
        throw new HttpError(
          400,
          400,
          error instanceof Error ? error.message : `Invalid ${KANBAN_MANIFEST_FILE}.`,
        );
      }
    }
    // Static Kanban projects follow the same Core compatibility contract.
    return readWorkflowPackageMetadata(
      sourceDir,
      expectedId,
      undefined,
      hostCoreVersion,
    );
  }

  if (!(await exists(path.join(sourceDir, "index.ts")))) {
    throw new HttpError(400, 400, "Workflow package must contain index.ts.");
  }
  return readWorkflowPackageMetadata(
    sourceDir,
    expectedId,
    undefined,
    hostCoreVersion,
  );
}

async function readWorkflowPackageMetadata(
  sourceDir: string,
  expectedId?: string,
  persistedProjectType?: WorkflowProjectType,
  hostCoreVersion?: string,
): Promise<WorkflowPackageMetadata> {
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

  if (!isWorkflowUuid(id)) {
    throw new HttpError(400, 400, createInvalidWorkflowUuidMessage(id, "workflow package id"));
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
  if (!isWorkflowProjectType(projectType)) {
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
    projectInfo: readWorkflowProjectInfo(packageJson),
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

function createDefaultProjectCardMetadata(projectType: WorkflowProjectType): ProjectCardMetadata {
  return readProjectCardMetadataFromPackageJson(
    {},
    projectType,
  );
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
      : `Package root must contain package.json and the configured entry for workflow "${expectedId}".`,
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

async function copyWorkflowSource(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
}

async function copyUploadedWorkflowSource(sourceDir: string, targetDir: string): Promise<void> {
  try {
    await copyWorkflowUploadFiles(sourceDir, targetDir);
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
    await copyUploadedWorkflowSource(
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
      await validateWorkflowPackage(candidate);
      dependencyRoots.push(candidate);
    } catch {
      // Ignore sibling directories that are not valid workflow packages.
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

async function writeWorkflowFiles(
  targetDir: string,
  files: WorkflowFile[],
): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  for (const file of files) {
    const safePath = normalizeWorkflowFilePath(file.path);
    const targetPath = path.join(targetDir, safePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, decodeWorkflowFileContent(file));
  }
}

function decodeWorkflowFileContent(file: WorkflowFileInput): string | Buffer {
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
      `Failed to create portable workflow artifact archive. ${readErrorMessage(error)}`,
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
    throw new HttpError(400, 400, "Failed to extract workflow artifact archive.", {
      error: readErrorMessage(error),
    });
  }
  return expandedSize;
}

async function readProjectFiles(
  rootDir: string,
  includeBinaryFiles: boolean,
): Promise<WorkflowFile[]> {
  const files: WorkflowFile[] = [];

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
    baseName !== ".workflowignore"
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

function normalizeWorkflowFilePath(filePath: string): string {
  const normalized = normalizeSlash(filePath).replace(/^\.\/+/, "");

  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new HttpError(400, 400, `Invalid workflow file path "${filePath}".`);
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
      const portablePath = createWorkflowUploadPortablePathKey(candidate);
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
    const portableEntryPath = createWorkflowUploadPortablePathKey(normalized);
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
    throw new HttpError(400, 400, `Invalid workflow version "${version}". Use x.y.z format.`);
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
    throw new HttpError(400, 400, `Invalid workflow file id "${value}".`);
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
  if (normalized === "") throw new HttpError(401, 401, "Login is required to use Kanban configurations.");
  return normalized;
}

function requireKanbanConfiguration(
  configurations: KanbanConfiguration[],
  configurationId: string,
): KanbanConfiguration {
  const configuration = configurations.find((item) => item.id === configurationId);
  if (!configuration) {
    throw new HttpError(404, 404, `Kanban configuration "${configurationId}" does not exist.`);
  }
  return configuration;
}

function normalizeStoredKanbanConfigurationState(
  value: unknown,
): WorkflowKanbanConfigurationStateRecord {
  if (!isRecord(value) || !Array.isArray(value["configurations"])) {
    return { configurations: [] };
  }
  const configurations = value["configurations"].flatMap((item): KanbanConfiguration[] => {
    if (
      !isRecord(item) ||
      typeof item["id"] !== "string" ||
      typeof item["name"] !== "string" ||
      typeof item["createdAt"] !== "string" ||
      typeof item["updatedAt"] !== "string"
    ) {
      return [];
    }
    return [{
      id: item["id"],
      name: item["name"],
      values: sanitizeKanbanStoredValues(item["values"]),
      createdAt: item["createdAt"],
      updatedAt: item["updatedAt"],
    }];
  });
  const activeConfigurationId = typeof value["activeConfigurationId"] === "string" &&
    configurations.some((item) => item.id === value["activeConfigurationId"])
    ? value["activeConfigurationId"]
    : configurations[0]?.id;
  return { configurations, activeConfigurationId };
}

function sanitizeKanbanStoredValues(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ));
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

function cloneWorkflowProjectDependencyLock(
  dependency: WorkflowProjectDependencyLock,
): WorkflowProjectDependencyLock {
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
      typeof parsed.workflowName !== "string" ||
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
      !isWorkflowUuid(parsed.projectId) ||
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
