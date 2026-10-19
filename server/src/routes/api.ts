
import { randomBytes } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import express from "express";
import { createKnowledgeMarkdownPreview } from "steamharness";
import { getRequestPrincipal, hasPermission, requireAuthenticatedPrincipal, type AuthenticatedPrincipal } from "../auth";
import { getProjectAuthContext } from "../auth";
import { createAuditActor, listAuditEvents, recordPermissionDeniedForRequest, recordAuditEventForRequest } from "../audit";
import { HttpError, fail, ok, toHttpError, toHttpErrorWithStatus } from "../protocol";
import { getRequestT, localizeHttpErrorMessage, localizeServerMessage, resolveRequestLocale } from "../i18n";
import { PROJECT_CARD_IMAGE_MAX_BYTES } from "../storage";
import type { KnowledgeDocumentListItem, KnowledgeDocumentRecord, ManagedFileReference, ProjectInvitation, ProjectCardImage, ProjectMember, ProjectRole, UserProfileSummary, VersionSummary, Visibility, PersistentValueKnowledgeMutation, Storage } from "../storage";
import type { AuditEventPage, AuditEventRecord, UserProfileRecord } from "../account-db";
import type { PermissionKey } from "../permissions";
import { isProjectUuid } from "../workflow-ids";
import { validateProjectCardMetadata, type ProjectCardMetadata } from "@steamharness/project-card-metadata";
import { isProjectKind, STEAMHARNESS_PROJECT_TYPES, type ProjectKind } from "@steamharness/project-types";
import { encodeKanbanAssetUrlPath } from "@steamharness/kanban-project";
import { invokeServerKanbanBridge, readKanbanBridgeCall } from "../kanban-bridge";
import { createKanbanRevisionBatcher } from "../kanban-revision-batcher";
import { parseProjectGroupManifest, type ProjectGroupManifestV1 } from "@steamharness/project-dependencies";
import { normalizeDeclaredProjectInfoInput, type DeclaredProjectInfo, type RelatedProject } from "@steamharness/project-info";

const DEFAULT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const PERSISTENT_VALUE_REVISION_PATTERN = /^\d+$/;
const MAX_PERSISTENT_VALUE_REVISION = 4_294_967_295;

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function recordSourceDownloadsOnFinish(
  req: Request,
  res: Response,
  storage: Storage,
  downloads: readonly { projectId: string; version: string }[],
): void {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return;
  if (typeof storage.recordSourceDownloads !== "function") return;
  // A flushed response does not confirm that the client saved the files.
  res.once("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    void storage.recordSourceDownloads(downloads).catch(() => {
      console.warn("[steamharness-server] failed to record source download counts.");
    });
  });
}

function requireRequestPrincipal(req: Request): AuthenticatedPrincipal {
  const principal = getRequestPrincipal(req);
  if (!principal) {
    throw new HttpError(401, 401, "Unauthorized.");
  }
  return principal;
}

function requireRequestPermission(req: Request, permission: PermissionKey): AuthenticatedPrincipal {
  const principal = requireRequestPrincipal(req);
  if (!hasPermission(principal, permission)) {
    recordPermissionDeniedForRequest(req, {
      eventType: "permission.denied",
      permission,
    });
    throw new HttpError(403, 403, "Permission denied.");
  }
  return principal;
}

function requireKanbanConfigurationActorId(principal: AuthenticatedPrincipal): string {
  if (!("userId" in principal) || principal.userId.trim() === "") {
    throw new HttpError(401, 401, "Account login is required to use Kanban configurations.");
  }
  return principal.userId;
}

function readOptionalProjectCardMetadata(value: unknown): ProjectCardMetadata | undefined {
  if (value === undefined) return undefined;
  try {
    return validateProjectCardMetadata(value);
  } catch (error) {
    throw new HttpError(
      400,
      400,
      error instanceof Error ? error.message : "Project card metadata is invalid.",
    );
  }
}

function readDeclaredProjectInfo(value: unknown): DeclaredProjectInfo {
  try {
    return normalizeDeclaredProjectInfoInput(value);
  } catch (error) {
    throw new HttpError(
      400,
      400,
      error instanceof Error ? error.message : "projectInfo.dataStorage.mode is invalid.",
    );
  }
}

function readRelatedProjectGrant(
  value: unknown,
  alias: string,
  projectId: string,
): DeclaredProjectInfo["relatedProjects"][number]["grantToRelatedProject"] {
  try {
    const projectInfo = normalizeDeclaredProjectInfoInput({
      localizedNames: {},
      declarations: [],
      platformSupport: { mode: "agnostic" },
      dataStorage: { mode: "server" },
      relatedProjects: [{ alias, projectId, grantToRelatedProject: value }],
    });
    return projectInfo.relatedProjects[0]!.grantToRelatedProject;
  } catch (error) {
    throw new HttpError(
      400,
      400,
      error instanceof Error ? error.message : "Related project grant is invalid.",
    );
  }
}

function requireProjectKind(value: unknown): ProjectKind {
  if (!isProjectKind(value)) {
    throw new HttpError(
      400,
      400,
      `projectType is required and must be one of: ${STEAMHARNESS_PROJECT_TYPES.map((projectType) => JSON.stringify(projectType)).join(", ")}.`,
    );
  }
  return value;
}

function toUserProfileSummary(profile: UserProfileRecord): UserProfileSummary {
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
  };
}

async function loadUserProfileSummaries(
  userIds: Iterable<string | null | undefined>,
): Promise<Map<string, UserProfileSummary>> {
  const normalized = [...new Set(
    [...userIds]
      .filter((userId): userId is string => typeof userId === "string" && userId.trim() !== "")
      .map((userId) => userId.trim()),
  )];
  if (normalized.length === 0) return new Map();
  const accountDb = getProjectAuthContext().accountDb;
  if (!accountDb) return new Map();
  const profiles = await accountDb.getUserProfilesByIds(normalized);
  return new Map([...profiles.entries()].map(([userId, profile]) => [userId, toUserProfileSummary(profile)]));
}

function pickProfile(
  profiles: Map<string, UserProfileSummary>,
  ...userIds: Array<string | null | undefined>
): UserProfileSummary | undefined {
  for (const userId of userIds) {
    if (!userId) continue;
    const profile = profiles.get(userId);
    if (profile) return profile;
  }
  return undefined;
}

async function enrichVersionSummary(summary: VersionSummary): Promise<VersionSummary> {
  const profiles = await loadUserProfileSummaries(summary.versions.map((version) => version.createdByUserId));
  if (profiles.size === 0) return summary;
  return {
    ...summary,
    versions: summary.versions.map((version) => ({
      ...version,
      createdByProfile: pickProfile(profiles, version.createdByUserId),
    })),
  };
}

async function enrichProjectMembers(members: ProjectMember[]): Promise<ProjectMember[]> {
  const profiles = await loadUserProfileSummaries(members.flatMap((member) => [member.userId, member.createdBy]));
  if (profiles.size === 0) return members;
  return members.map((member) => ({
    ...member,
    profile: pickProfile(profiles, member.userId),
    createdByProfile: pickProfile(profiles, member.createdBy),
  }));
}

async function enrichProjectInvitations(invitations: ProjectInvitation[]): Promise<ProjectInvitation[]> {
  const profiles = await loadUserProfileSummaries(
    invitations.flatMap((invitation) => [invitation.createdBy, invitation.acceptedBy]),
  );
  if (profiles.size === 0) return invitations;
  return invitations.map((invitation) => ({
    ...invitation,
    createdByProfile: pickProfile(profiles, invitation.createdBy),
    acceptedByProfile: pickProfile(profiles, invitation.acceptedBy),
  }));
}

async function enrichAuditPage(page: AuditEventPage): Promise<AuditEventPage> {
  const profiles = await loadUserProfileSummaries(page.items.flatMap((event) => [event.actorProfileId, event.actorUserId]));
  if (profiles.size === 0) return page;
  return {
    ...page,
    items: page.items.map((event): AuditEventRecord => {
      const profile = pickProfile(profiles, event.actorProfileId, event.actorUserId);
      if (!profile) return event;
      return {
        ...event,
        actorUserId: event.actorUserId ?? profile.userId,
        actorProfileId: event.actorProfileId ?? profile.userId,
        actorDisplayName: event.actorDisplayName ?? profile.displayName,
        actorProfile: profile,
      };
    }),
  };
}

async function requireProjectReadAccess(
  req: Request,
  storage: Storage,
): Promise<{ principal: AuthenticatedPrincipal; access: Awaited<ReturnType<Storage["getProjectAccessSummary"]>> }> {
  const principal = requireRequestPrincipal(req);
  const userId = "userId" in principal ? principal.userId : undefined;
  const access = await storage.getProjectAccessSummary(req.params["name"], userId);
  storage.assertReadableProject({
    access,
    canReadAll: hasPermission(principal, "projects.read_all"),
    canReadPublic: hasPermission(principal, "projects.read_public"),
    userId,
  });
  return { principal, access };
}

async function assertProjectReadableForPrincipal(
  storage: Storage,
  principal: AuthenticatedPrincipal,
  projectName: string,
): Promise<void> {
  const userId = "userId" in principal ? principal.userId : undefined;
  const access = await storage.getProjectAccessSummary(projectName, userId);
  storage.assertReadableProject({
    access,
    canReadAll: hasPermission(principal, "projects.read_all"),
    canReadPublic: hasPermission(principal, "projects.read_public"),
    userId,
  });
}
async function assertProjectStorageAccessForPrincipal(storage: Storage, principal: AuthenticatedPrincipal, projectId: string, write: boolean): Promise<void> {
  const userId = "userId" in principal ? principal.userId : undefined;
  const access = await storage.getProjectAccessSummary(projectId, userId);
  storage.assertReadableProject({ access, canReadAll: hasPermission(principal, "projects.read_all"), canReadPublic: hasPermission(principal, "projects.read_public"), userId });
  if (write) storage.assertDataWritableProject({ access, userId, canWriteAll: hasPermission(principal, "storage.write") });
}
async function requireProjectStorageWriteAccess(req: Request, storage: Storage): Promise<void> {
  await assertProjectStorageAccessForPrincipal(storage, requireRequestPrincipal(req), req.params["name"], true);
}


async function canDownloadProjectSourceForPrincipal(
  storage: Storage,
  principal: AuthenticatedPrincipal,
  projectId: string,
): Promise<boolean> {
  const userId = "userId" in principal ? principal.userId : undefined;
  try {
    const access = await storage.getProjectAccessSummary(projectId, userId);
    const canReadProject = storage.canReadProject({
      access,
      canReadAll: hasPermission(principal, "projects.read_all"),
      canReadPublic: hasPermission(principal, "projects.read_public"),
      userId,
    });
    if (canReadProject && storage.canDownloadProjectSource({
      access,
      canDownloadSource: hasPermission(principal, "projects.download_source"),
      userId,
    })) return true;
  } catch {}
  return userId !== undefined && storage.hasProjectSourceCapability(projectId, userId);
}

async function canManageProjectForPrincipal(
  storage: Storage,
  principal: AuthenticatedPrincipal,
  projectId: string,
): Promise<boolean> {
  const userId = "userId" in principal ? principal.userId : undefined;
  try {
    const access = await storage.getProjectAccessSummary(projectId, userId);
    return storage.canManageProject({
      access,
      canManageAll: hasPermission(principal, "projects.manage_all"),
      canManageOwn: hasPermission(principal, "projects.manage_own"),
      canUpload: hasPermission(principal, "projects.upload"),
      canPublish: hasPermission(principal, "projects.publish"),
      userId,
    });
  } catch {
    return false;
  }
}

function requirePrincipalUserId(principal: AuthenticatedPrincipal, action: string): string {
  if (!("userId" in principal) || principal.userId.trim() === "") {
    throw new HttpError(400, 400, `A user account is required to ${action}.`);
  }
  return principal.userId;
}

function readProjectGroupManifest(value: unknown): ProjectGroupManifestV1 {
  try {
    return parseProjectGroupManifest(value);
  } catch (error) {
    throw toHttpErrorWithStatus(error, 400, 400, "Project group manifest is invalid.");
  }
}

async function requireProjectManageAccess(
  req: Request,
  storage: Storage,
): Promise<{ principal: AuthenticatedPrincipal; access: Awaited<ReturnType<Storage["getProjectAccessSummary"]>> }> {
  return requireManageAccess(req, storage, req.params["name"]);
}

async function requireManageAccess(
  req: Request,
  storage: Storage,
  projectName: string,
): Promise<{ principal: AuthenticatedPrincipal; access: Awaited<ReturnType<Storage["getProjectAccessSummary"]>> }> {
  const principal = requireRequestPrincipal(req);
  const userId = "userId" in principal ? principal.userId : undefined;
  const access = await storage.getProjectAccessSummary(projectName, userId);
  storage.assertManageableProject({
    access,
    canManageAll: hasPermission(principal, "projects.manage_all"),
    canManageOwn: hasPermission(principal, "projects.manage_own"),
    canUpload: hasPermission(principal, "projects.upload"),
    canPublish: hasPermission(principal, "projects.publish"),
    userId,
  });
  return { principal, access };
}

async function requireProjectMemberManageAccess(
  req: Request,
  storage: Storage,
): Promise<{ principal: AuthenticatedPrincipal; access: Awaited<ReturnType<Storage["getProjectAccessSummary"]>> }> {
  const principal = requireRequestPrincipal(req);
  const userId = "userId" in principal ? principal.userId : undefined;
  const access = await storage.getProjectAccessSummary(req.params["name"], userId);
  const isProjectCreator = userId !== undefined && access.createdByUserId === userId;
  storage.assertManageableProject({
    access,
    canManageAll: hasPermission(principal, "projects.manage_all"),
    canManageOwn: hasPermission(principal, "projects.manage_own") || isProjectCreator,
    canUpload: hasPermission(principal, "projects.upload"),
    canPublish: hasPermission(principal, "projects.publish"),
    userId,
  });
  return { principal, access };
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, 400, `${fieldName} must be a string array.`);
  }
  return value as string[];
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, 400, `${fieldName} must be a string.`);
  }

  return value;
}

function readProjectFileInputs(value: unknown): Array<{
  path: string;
  content: string;
  encoding?: "base64";
}> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, 400, "files must be an array.");
  }
  return value.map(readProjectFileInput);
}

function readProjectFileInput(file: unknown): { path: string; content: string; encoding?: "base64" } {
  if (!isRecord(file) || typeof file["path"] !== "string" || typeof file["content"] !== "string") {
    throw new HttpError(400, 400, "Each file must include string path and content.");
  }
  if (file["encoding"] !== undefined && file["encoding"] !== "base64") {
    throw new HttpError(400, 400, "File encoding must be base64 when provided.");
  }
  return {
    path: file["path"],
    content: file["content"],
    ...(file["encoding"] === "base64" ? { encoding: "base64" as const } : {}),
  };
}

function readOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, 400, `${fieldName} must be a string.`);
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function readRequiredRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HttpError(400, 400, `${fieldName} must be an object.`);
  }

  return value;
}

function readOptionalQueryBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, 400, `${fieldName} must be a boolean.`);
  }

  if (value === "true") return true;
  if (value === "false") return false;
  throw new HttpError(400, 400, `${fieldName} must be a boolean.`);
}

function readOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, 400, `${fieldName} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, 400, `${fieldName} must be a positive integer.`);
  }

  return parsed;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  const parsed = readOptionalPositiveInteger(value, fieldName);
  if (parsed === undefined) {
    throw new HttpError(400, 400, `${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function readOptionalNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, 400, `${fieldName} must be a non-negative integer.`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, 400, `${fieldName} must be a non-negative integer.`);
  }

  return parsed;
}

function readOptionalIntegerInRange(
  value: unknown,
  fieldName: string,
  options: { min: number; max: number },
): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, 400, `${fieldName} must be an integer between ${options.min} and ${options.max}.`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new HttpError(400, 400, `${fieldName} must be an integer between ${options.min} and ${options.max}.`);
  }

  return parsed;
}

function readOptionalKVScope(value: unknown): "project" | "conversation" | undefined {
  const scope = readOptionalString(value, "scope");
  if (scope === undefined || scope === "all") {
    return undefined;
  }
  if (scope === "project" || scope === "conversation") {
    return scope;
  }

  throw new HttpError(400, 400, `Invalid KV scope "${scope}".`);
}

function readRequiredProjectKVScope(value: unknown): "project" | "conversation" {
  const scope = readOptionalKVScope(value);
  if (scope === undefined) {
    throw new HttpError(400, 400, "scope must be project or conversation.");
  }
  return scope;
}

function readOptionalKVValueType(value: unknown) {
  const valueType = readOptionalString(value, "valueType");
  if (valueType === undefined || valueType === "all") {
    return undefined;
  }
  if (
    valueType === "null" ||
    valueType === "array" ||
    valueType === "object" ||
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean"
  ) {
    return valueType;
  }

  throw new HttpError(400, 400, `Invalid KV valueType "${valueType}".`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readKnowledgeCreateBody(value: unknown): { id?: string; title: string; markdown: string } {
  if (!isRecord(value)) {
    throw new HttpError(400, 400, "Request body must be an object.");
  }
  return {
    id: readOptionalString(value["id"], "id"),
    title: requireString(value["title"], "title"),
    markdown: requireString(value["markdown"], "markdown"),
  };
}

function readKnowledgeEditBody(value: unknown): { title?: string; markdown?: string } {
  if (!isRecord(value)) {
    throw new HttpError(400, 400, "Request body must be an object.");
  }
  const title = value["title"] === undefined ? undefined : requireString(value["title"], "title");
  const markdown = value["markdown"] === undefined ? undefined : requireString(value["markdown"], "markdown");
  if (title === undefined && markdown === undefined) {
    throw new HttpError(400, 400, "At least one of title or markdown must be provided.");
  }
  return { title, markdown };
}

function readKnowledgeWriteResponseMode(value: unknown): "document" | "summary" {
  const response = readOptionalString(value, "response");
  if (response === undefined || response === "document") return "document";
  if (response === "summary") return "summary";
  throw new HttpError(400, 400, "response must be document or summary.");
}

function summarizeKnowledgeDocument(
  document: KnowledgeDocumentRecord,
): KnowledgeDocumentListItem {
  return {
    id: document.id,
    title: document.title,
    markdownPreview: createKnowledgeMarkdownPreview(document.markdown),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

type ProjectStorageEntry =
  | { scope: "project"; key: string; projectId?: string }
  | { scope: "conversation"; key: string; projectId?: string; conversationId: string };

type ProjectStorageAddress =
  | { kind: "current"; projectId: string }
  | { kind: "related"; consumerProjectId: string; alias: string };

function readProjectStorageBody(value: unknown):
  | {
      address: ProjectStorageAddress;
      storageKind: "kv" | "persistent_value";
      operation: "get" | "set" | "compare-and-set" | "delete";
      entry: ProjectStorageEntry;
      value?: unknown;
      expectedRevision?: string | null;
      source?: {
        projectId?: string;
        runId?: string;
        conversationId?: string;
      };
    }
  | {
      address: Extract<ProjectStorageAddress, { kind: "current" }>;
      storageKind: "persistent_value";
      operation: "knowledge-mutation";
      namespace: { scope: "project"; projectId: string };
      mutation: PersistentValueKnowledgeMutation;
    } {
  if (!isRecord(value)) {
    throw new HttpError(400, 400, "Request body must be an object.");
  }

  const address = readProjectStorageAddress(value);
  const storageKind = readProjectStorageKind(value["storageKind"]);
  const operation = requireString(value["operation"], "operation");
  if (operation === "knowledge-mutation") {
    if (address.kind !== "current" || storageKind !== "persistent_value") {
      throw new HttpError(400, 400, "Knowledge mutations require current-project persistent_value storage.");
    }
    const namespace = readProjectStorageKnowledgeNamespace(value["namespace"]);
    assertProjectStorageBinding(address.projectId, namespace.projectId, "namespace.projectId");
    return {
      address,
      storageKind,
      operation,
      namespace,
      mutation: readPersistentValueKnowledgeMutation(value["mutation"]),
    };
  }
  if (operation !== "get" && operation !== "set" && operation !== "compare-and-set" &&
    operation !== "delete") {
    throw new HttpError(400, 400, "operation must be get, set, compare-and-set, delete, or knowledge-mutation.");
  }

  if (address.kind === "related" && storageKind !== "kv") {
    throw new HttpError(400, 400, "Related-project storage only supports KV.");
  }
  const entry = readProjectStorageEntry(value["entry"]);
  if (address.kind === "current") {
    assertProjectStorageBinding(address.projectId, entry.projectId, "entry.projectId");
  } else if (entry.projectId !== undefined) {
    throw new HttpError(400, 400, "Related-project requests must not specify a target projectId.");
  }
  if ((operation === "set" || operation === "compare-and-set") && value["value"] === undefined) {
    throw new HttpError(400, 400, `value is required for project storage ${operation}.`);
  }
  const expectedRevision = operation === "compare-and-set"
    ? readProjectStorageExpectedRevision(value)
    : undefined;

  const source = readProjectStorageSource(value["source"]);
  if (source?.projectId !== undefined && address.kind === "current") {
    assertProjectStorageBinding(address.projectId, source.projectId, "source.projectId");
  }
  return {
    address,
    storageKind,
    operation,
    entry,
    value: value["value"],
    expectedRevision,
    source,
  };
}

function readProjectStorageAddress(value: Record<string, unknown>): ProjectStorageAddress {
  const projectId = readOptionalString(value["projectId"], "projectId");
  const consumerProjectId = readOptionalString(value["consumerProjectId"], "consumerProjectId");
  const alias = readOptionalString(value["alias"], "alias");
  if (projectId !== undefined && consumerProjectId === undefined && alias === undefined) {
    return { kind: "current", projectId };
  }
  if (projectId === undefined && consumerProjectId !== undefined && alias !== undefined) {
    return { kind: "related", consumerProjectId, alias };
  }
  throw new HttpError(
    400,
    400,
    "Project storage requires either projectId or consumerProjectId with alias.",
  );
}

function readProjectStorageKind(value: unknown): "kv" | "persistent_value" {
  if (value === "kv" || value === "persistent_value") return value;
  throw new HttpError(400, 400, "storageKind must be kv or persistent_value.");
}

function assertProjectStorageBinding(
  projectId: string,
  boundProjectId: string | undefined,
  field: string,
): void {
  if (boundProjectId !== projectId) {
    throw new HttpError(
      400,
      400,
      `${field} must match the request projectId.`,
      { projectId, boundProjectId, field },
    );
  }
}

function readProjectStorageExpectedRevision(value: Record<string, unknown>): string | null {
  if (!Object.hasOwn(value, "expectedRevision")) {
    throw new HttpError(400, 400, "expectedRevision is required for project storage compare-and-set.");
  }
  const revision = value["expectedRevision"];
  if (revision === null) {
    return null;
  }
  if (
    typeof revision !== "string" ||
    !PERSISTENT_VALUE_REVISION_PATTERN.test(revision) ||
    revision.length > 10 ||
    Number(revision) > MAX_PERSISTENT_VALUE_REVISION
  ) {
    throw new HttpError(400, 400, "expectedRevision must be a project storage revision or null.");
  }
  return revision;
}

function readProjectStorageKnowledgeNamespace(value: unknown): {
  scope: "project";
  projectId: string;
} {
  if (!isRecord(value)) {
    throw new HttpError(400, 400, "namespace must be an object.");
  }
  if (requireString(value["scope"], "namespace.scope") !== "project") {
    throw new HttpError(400, 400, "knowledge-mutation namespace scope must be project.");
  }
  return {
    scope: "project",
    projectId: requireString(value["projectId"], "namespace.projectId"),
  };
}

function readPersistentValueKnowledgeMutation(
  value: unknown,
): PersistentValueKnowledgeMutation {
  if (!isRecord(value)) {
    throw new HttpError(400, 400, "mutation must be an object.");
  }

  const type = requireString(value["type"], "mutation.type");
  if (type === "create") {
    return { type, input: readKnowledgeCreateBody(value["input"]) };
  }
  if (type === "edit") {
    if (!isRecord(value["input"])) {
      throw new HttpError(400, 400, "mutation.input must be an object.");
    }
    const input = readKnowledgeEditBody(value["input"]);
    return {
      type,
      input: {
        documentId: requireString(value["input"]["documentId"], "mutation.input.documentId"),
        title: input.title,
        markdown: input.markdown,
      },
    };
  }
  if (type === "delete") {
    if (!isRecord(value["input"])) {
      throw new HttpError(400, 400, "mutation.input must be an object.");
    }
    return {
      type,
      input: {
        documentId: requireString(value["input"]["documentId"], "mutation.input.documentId"),
      },
    };
  }

  throw new HttpError(400, 400, "mutation.type must be create, edit, or delete.");
}

function readProjectStorageEntry(value: unknown): ProjectStorageEntry {
  if (!isRecord(value)) {
    throw new HttpError(400, 400, "entry must be an object.");
  }

  const scope = requireString(value["scope"], "scope");
  if (scope !== "project" && scope !== "conversation") {
    throw new HttpError(400, 400, "scope must be project or conversation.");
  }

  const key = requireString(value["key"], "key");
  const projectId = readOptionalString(value["projectId"], "entry.projectId");
  if (scope === "project") {
    return { scope, key, projectId };
  }
  const conversationId = readOptionalString(value["conversationId"], "conversationId");
  if (conversationId === undefined) {
    throw new HttpError(400, 400, "conversationId is required for conversation storage.");
  }
  return {
    scope,
    key,
    projectId,
    conversationId,
  };
}

function readProjectStorageSource(value: unknown): {
  projectId?: string;
  runId?: string;
  conversationId?: string;
} | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new HttpError(400, 400, "source must be an object.");
  }

  return {
    projectId: readOptionalString(value["projectId"], "source.projectId"),
    runId: readOptionalString(value["runId"], "source.runId"),
    conversationId: readOptionalString(value["conversationId"], "source.conversationId"),
  };
}

function getRequestOrigin(req: Request): string {
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
  const host = forwardedHost ?? req.headers.host;
  const proto = forwardedProto ?? req.protocol;

  if (typeof host === "string" && host.trim() !== "") {
    return `${proto}://${host}`;
  }

  return `${proto}://localhost`;
}

function readAuditCursor(value: unknown): string | undefined {
  return readOptionalString(value, "cursor");
}

function readOptionalIsoDate(value: unknown, fieldName: string): string | undefined {
  const normalized = readOptionalString(value, fieldName);
  if (normalized === undefined) {
    return undefined;
  }
  if (Number.isNaN(Date.parse(normalized))) {
    throw new HttpError(400, 400, `${fieldName} must be a valid ISO date string.`);
  }
  return normalized;
}

function readOptionalAuditOutcome(value: unknown): "success" | "failed" | "denied" | undefined {
  const normalized = readOptionalString(value, "outcome");
  if (normalized === undefined) {
    return undefined;
  }
  if (normalized === "success" || normalized === "failed" || normalized === "denied") {
    return normalized;
  }
  throw new HttpError(400, 400, `Invalid outcome "${normalized}".`);
}

async function recordRouteAudit(
  req: Request,
  event: {
    principal?: AuthenticatedPrincipal;
    eventType: string;
    outcome: "success" | "failed" | "denied";
    resourceType?: string;
    resourceId?: string;
    context?: Record<string, unknown>;
  },
): Promise<void> {
  await recordAuditEventForRequest(req, {
    ...createAuditActor(event.principal ?? getRequestPrincipal(req)),
    eventType: event.eventType,
    outcome: event.outcome,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    context: event.context,
  });
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function sendManagedFile(
  res: Response,
  metadata: ManagedFileReference,
  filePath: string,
  download: boolean,
): void {
  res.setHeader("Content-Type", metadata.mimeType || "application/octet-stream");
  res.setHeader("Content-Length", String(metadata.size));
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeHeaderFileName(metadata.name)}"`,
  );
  res.sendFile(filePath);
}

function encodeHeaderFileName(value: string): string {
  return value.replace(/["\\\r\n]/g, "_");
}

export function createApiRouter(
  storage: Storage,
): Router {
  const router = Router();
  const authenticateRequest = requireAuthenticatedPrincipal();
  const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    if (getRequestPrincipal(req)) next();
    else void authenticateRequest(req, res, next);
  };

  const json = express.json({ limit: "10mb" });
  const kanbanJson = express.json({ limit: "70mb" });
  const raw = express.raw({ type: "*/*", limit: DEFAULT_UPLOAD_LIMIT_BYTES });
  const projectCardImage = express.raw({ type: "image/webp", limit: PROJECT_CARD_IMAGE_MAX_BYTES });

  // POST /api/projects/:name/files
  router.post(
    "/projects/:name/files",
    authenticate,
    raw,
    asyncHandler(async (req, res) => {
      await requireProjectStorageWriteAccess(req, storage);
      const { name } = req.params;
      const body = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body as Uint8Array);
      const fileName =
        readOptionalString(req.query["fileName"], "fileName") ??
        readOptionalString(req.headers["x-steamharness-file-name"], "x-steamharness-file-name") ??
        "file";
      const mimeType =
        readOptionalString(req.query["mimeType"], "mimeType") ??
        readOptionalString(req.headers["content-type"], "content-type");
      const conversationId = readOptionalString(
        req.query["conversationId"] ?? req.query["conversation_id"],
        "conversationId",
      );

      res.json(ok(await storage.saveManagedFiles({
        projectName: name,
        files: [{
          name: fileName,
          mimeType,
          buffer: body,
          conversationId,
        }],
      })));
    }),
  );

  // POST /api/projects/:name/project-card-image
  router.post(
    "/projects/:name/project-card-image",
    authenticate,
    projectCardImage,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      if (firstHeaderValue(req.headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase() !== "image/webp") {
        throw new HttpError(415, 415, "Project card image content type must be image/webp.");
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result: ProjectCardImage = await storage.saveProjectCardImage({
        projectName: req.params.name,
        buffer: body,
        origin: getRequestOrigin(req),
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.project_card.image.upload",
        outcome: "success",
        resourceType: "project",
        resourceId: req.params.name,
        context: { hash: result.hash, size: result.size, mimeType: result.mimeType },
      });
      res.status(201).json(ok(result));
    }),
  );

  // PUT /api/projects/:name/project-card
  router.put(
    "/projects/:name/project-card",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      const card = readOptionalProjectCardMetadata(body["projectCard"]);
      if (card === undefined) {
        throw new HttpError(400, 400, "projectCard is required.");
      }
      const updated = await storage.updateProjectCardMetadata({
        projectName: req.params.name,
        projectCard: card,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.project_card.update",
        outcome: "success",
        resourceType: "project",
        resourceId: req.params.name,
        context: { icon: updated.icon, hasImage: updated.iconUrl !== undefined },
      });
      res.json(ok(updated));
    }),
  );

  // PUT /api/projects/:name/project-info
  router.put(
    "/projects/:name/project-info",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      const name = requireString(body["name"], "name");
      const projectInfo = readDeclaredProjectInfo(body["projectInfo"]);
      const updated = await storage.updateProjectInfoMetadata({
        projectName: req.params.name,
        name,
        projectInfo,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.project_info.update",
        outcome: "success",
        resourceType: "project",
        resourceId: req.params.name,
        context: {
          name: updated.name,
          declarations: updated.projectInfo.declarations,
          platformSupport: updated.projectInfo.platformSupport,
        },
      });
      res.json(ok(updated));
    }),
  );

  router.get(
    "/projects/:name/related-projects",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      res.json(ok(await storage.listRelatedProjects(req.params.name)));
    }),
  );

  router.put(
    "/projects/:name/related-projects/:alias",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      const targetProjectId = requireString(body["targetProjectId"], "targetProjectId");
      const alias = req.params.alias;
      const updateTarget = await canManageProjectForPrincipal(storage, principal, targetProjectId);
      const targetAlias = readOptionalString(body["targetAlias"], "targetAlias");
      const grantToRelatedProject = body["grantToRelatedProject"] === undefined
        ? undefined
        : readRelatedProjectGrant(body["grantToRelatedProject"], alias, targetProjectId);
      const targetGrantToRelatedProject = body["targetGrantToRelatedProject"] === undefined
        ? undefined
        : readRelatedProjectGrant(
            body["targetGrantToRelatedProject"],
            targetAlias ?? "related",
            req.params.name,
          );
      res.json(ok(await storage.setRelatedProject({
        projectId: req.params.name,
        alias,
        targetProjectId,
        grantToRelatedProject,
        updateTarget,
        targetAlias,
        targetGrantToRelatedProject,
      })));
    }),
  );

  router.delete(
    "/projects/:name/related-projects/:alias",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const current = await storage.listRelatedProjects(req.params.name);
      const relation = current.relatedProjects.find(
        (item) => item.relation.alias === req.params.alias,
      );
      const updateTarget = relation !== undefined && await canManageProjectForPrincipal(
        storage,
        principal,
        relation.relation.projectId,
      );
      res.json(ok(await storage.removeRelatedProject({
        projectId: req.params.name,
        alias: req.params.alias,
        updateTarget,
      })));
    }),
  );

  // GET /api/projects/files/:fileId
  router.get(
    "/projects/files/:fileId",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      const { metadata, filePath } = await storage.getManagedFile(req.params.fileId);
      if (!metadata.projectId) {
        throw new HttpError(404, 404, `Workflow file "${req.params.fileId}" does not exist.`);
      }
      const userId = "userId" in principal ? principal.userId : undefined;
      const access = await storage.getProjectAccessSummary(metadata.projectId, userId);
      storage.assertReadableProject({
        access,
        canReadAll: hasPermission(principal, "projects.read_all"),
        canReadPublic: hasPermission(principal, "projects.read_public"),
        userId,
      });
      sendManagedFile(res, metadata, filePath, req.query["download"] === "1");
    }),
  );

  // DELETE /api/projects/files/:fileId
  router.delete(
    "/projects/files/:fileId",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      const { metadata } = await storage.getManagedFile(req.params.fileId);
      if (!metadata.projectId) {
        throw new HttpError(404, 404, `Workflow file "${req.params.fileId}" does not exist.`);
      }
      const userId = "userId" in principal ? principal.userId : undefined;
      const access = await storage.getProjectAccessSummary(metadata.projectId, userId);
      await assertProjectStorageAccessForPrincipal(storage, principal, metadata.projectId, true);
      res.json(ok(await storage.deleteManagedFile(req.params.fileId)));
    }),
  );

  // GET /api/projects
  router.get(
    "/projects",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      const userId = "userId" in principal ? principal.userId : undefined;
      const items = await storage.listProjects();
      const accountDb = getProjectAuthContext().accountDb;
      // enriches the project workbench with uploader profile summaries.
      const createdByProfiles = accountDb
        ? await accountDb.getUserProfilesByIds(
            items
              .map((item) => item.createdByUserId)
              .filter((createdByUserId): createdByUserId is string => typeof createdByUserId === "string" && createdByUserId.length > 0),
          )
        : new Map();
      const filtered = [];
      for (const item of items) {
        if (!isProjectUuid(item.id)) {
          // Legacy non-UUID projects are migration leftovers and are
          // intentionally hidden from the API once UUID-only sync is in place.
          continue;
        }
        const access = await storage.getProjectAccessSummary(item.id, userId);
        if (storage.canReadProject({
          access,
          canReadAll: hasPermission(principal, "projects.read_all"),
          canReadPublic: hasPermission(principal, "projects.read_public"),
          userId,
        })) {
          const sourceAvailability = await storage.getSourceDownloadAvailability(item.id);
          filtered.push({
            ...item,
            canManage: await canManageProjectForPrincipal(storage, principal, item.id),
            canWriteData: storage.canWriteProjectData({ access, userId, canWriteAll: hasPermission(principal, "storage.write") }),
            sourceDownload: {
              ...sourceAvailability,
              allowed: await canDownloadProjectSourceForPrincipal(storage, principal, item.id),
            },
            createdByProfile: item.createdByUserId
              ? (() => {
                  const profile = createdByProfiles.get(item.createdByUserId);
                  if (!profile) {
                    return undefined;
                  }
                  return {
                    userId: profile.userId,
                    displayName: profile.displayName,
                    email: profile.email,
                    avatarUrl: profile.avatarUrl,
                  };
                })()
              : undefined,
          });
        }
      }
      res.json(ok(filtered));
    }),
  );

  router.post(
    "/projects/:name/kanban/bridge",
    authenticate,
    kanbanJson,
    asyncHandler(async (req, res) => {
      const body = isRecord(req.body) ? req.body : {};
      const call = readKanbanBridgeCall(body["call"]);
      const readOperation = [
        "runtime.getLocale",
        "files.readFile",
        "kv.getValue",
        "relatedProject.kv.getValue",
        "knowledge.listDocuments",
        "knowledge.getDocument",
        "knowledge.searchDocuments",
        "knowledge.readDocumentLines",
      ].includes(call.operation);
      const { principal } = await requireProjectReadAccess(req, storage);
      if (!readOperation) await requireProjectStorageWriteAccess(req, storage);
      // Managed files belong to the project, independently of its preview version.
      if (call.operation.startsWith("files.")) {
        res.json(ok(await invokeServerKanbanBridge(storage, req.params.name, call)));
        return;
      }
      const target = readOptionalString(body["target"], "target");
      const workspace = await storage.getKanbanWorkspace({
        projectName: req.params.name,
        target,
        actorId: requireKanbanConfigurationActorId(principal),
      });
      res.json(ok(await invokeServerKanbanBridge(
        storage,
        req.params.name,
        call,
        {
          target: workspace.resolvedTarget,
          runtimeLocale: resolveRequestLocale(req),
        },
      )));
    }),
  );

  router.get(
    "/projects/:name/kanban/related-project-revisions",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectReadAccess(req, storage);
      const target = readOptionalString(req.query["target"], "target");
      const bindings = await storage.getKanbanRelatedProjectBindings({
        projectName: req.params.name,
        target,
      });
      const authorizedRelations: RelatedProject[] = [];
      for (const relation of bindings.relatedProjects) {
        try {
          const access = await storage.resolveConfirmedRelatedProject(req.params.name, relation.alias);
          if (access.targetProjectId === relation.projectId && access.grant.read.mode !== "none") {
            authorizedRelations.push(relation);
          }
        } catch {}
      }

      const aliasesByProject = new Map<string, string[]>();
      for (const relation of authorizedRelations) {
        aliasesByProject.set(relation.projectId, [
          ...(aliasesByProject.get(relation.projectId) ?? []),
          relation.alias,
        ]);
      }

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      let closed = false;
      let snapshotSent = false;
      const buffered = new Map<string, string>();
      let unsubscribe: (() => Promise<void>) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const send = (event: string, value: unknown) => {
        if (closed || res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        const release = unsubscribe;
        unsubscribe = undefined;
        void release?.().catch(() => undefined);
      };
      res.once("close", close);
      const closeUnavailable = async () => {
        if (closed) return;
        send("unavailable", { message: "Kanban related project is unavailable." });
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        const release = unsubscribe;
        unsubscribe = undefined;
        await release?.().catch(() => undefined);
        res.end();
      };
      const validateBindings = async () => {
        await assertProjectReadableForPrincipal(storage, principal, req.params.name);
        const current = await storage.getKanbanRelatedProjectBindings({
          projectName: req.params.name,
          target: bindings.resolvedTarget,
        });
        if (
          current.resolvedTarget !== bindings.resolvedTarget ||
          JSON.stringify(current.relatedProjects) !== JSON.stringify(bindings.relatedProjects)
        ) throw new Error("Kanban related-project binding changed.");
        for (const relation of authorizedRelations) {
          const access = await storage.resolveConfirmedRelatedProject(req.params.name, relation.alias);
          if (access.targetProjectId !== relation.projectId || access.grant.read.mode === "none") {
            throw new Error("Kanban related-project access changed.");
          }
        }
      };
      heartbeat = setInterval(() => {
        void validateBindings()
          .then(() => send("heartbeat", { timestamp: new Date().toISOString() }))
          .catch(() => closeUnavailable());
      }, 20_000);
      heartbeat.unref?.();

      const revisionBatcher = createKanbanRevisionBatcher({
        isClosed: () => closed,
        validate: validateBindings,
        publish: (projectId, revision) => {
          for (const alias of aliasesByProject.get(projectId) ?? []) {
            send("revision", { alias, revision });
          }
        },
        onUnavailable: closeUnavailable,
      });
      try {
        const releaseSubscription = await storage.subscribeProjectStorageRevisions((event) => {
          if (!aliasesByProject.has(event.projectId)) return;
          if (!snapshotSent) {
            buffered.set(event.projectId, event.revision);
            return;
          }
          revisionBatcher.enqueue(event.projectId, event.revision);
        });
        if (closed) {
          await releaseSubscription();
          return;
        }
        unsubscribe = releaseSubscription;

        const revisions = await Promise.all(authorizedRelations.map(async (relation) => {
          const revision = buffered.get(relation.projectId) ??
            await storage.getProjectStorageRevision(relation.projectId);
          revisionBatcher.remember(relation.projectId, revision);
          return { alias: relation.alias, revision };
        }));
        send("snapshot", { resolvedTarget: bindings.resolvedTarget, revisions });
        snapshotSent = true;
        for (const [projectId, revision] of buffered) {
          revisionBatcher.enqueue(projectId, revision);
        }
        buffered.clear();
      } catch {
        await closeUnavailable();
      }
    }),
  );

  router.post(
    "/projects",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPermission(req, "projects.create");
      const body = isRecord(req.body) ? req.body : {};
      const projectName = requireString(body["name"], "name");
      const projectId = requireString(body["projectId"], "projectId");
      const projectType = requireProjectKind(body["projectType"]);
      const projectInfo = readDeclaredProjectInfo(body["projectInfo"]);
      const visibility = readOptionalString(body["visibility"], "visibility");
      const projectCard = readOptionalProjectCardMetadata(body["projectCard"]);
      const created = await storage.createProject({
        projectId,
        projectName,
        projectType,
        projectInfo,
        ownerUserId: "userId" in principal ? principal.userId : undefined,
        createdByUserId: "userId" in principal ? principal.userId : undefined,
        visibility: visibility === "public" ? "public" : "private",
        ...(projectCard === undefined ? {} : { projectCard }),
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.project.create",
        outcome: "success",
        resourceType: "project",
        resourceId: created.projectId,
        context: {
          projectId: created.projectId,
          projectName,
          visibility: created.visibility,
        },
      });
      res.status(201).json(ok(created));
    }),
  );

  // POST /api/project-storage
  router.post(
    "/project-storage",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      const body = readProjectStorageBody(req.body);
      const consumerProjectId = body.address.kind === "current"
        ? body.address.projectId
        : body.address.consumerProjectId;
      const write = body.operation !== "get";
      await assertProjectStorageAccessForPrincipal(
        storage,
        principal,
        consumerProjectId,
        write,
      );
      if (body.operation === "knowledge-mutation") {
        res.json(ok(await storage.mutateProjectStorageKnowledgeDocument({
          projectId: body.namespace.projectId,
          mutation: body.mutation,
        })));
        return;
      }
      let targetProjectId: string;
      if (body.address.kind === "current") {
        targetProjectId = body.address.projectId;
      } else {
        const access = await storage.resolveRelatedProjectKVAccess({
          consumerProjectId: body.address.consumerProjectId,
          alias: body.address.alias,
          key: body.entry.key,
          operation: body.operation === "get"
            ? "read"
            : body.operation === "set" || body.operation === "delete"
              ? "write"
              : "update",
        });
        targetProjectId = access.targetProjectId;
        if (body.source?.projectId !== undefined && body.source.projectId !== consumerProjectId) {
          throw new HttpError(400, 400, "source.projectId must match consumerProjectId.");
        }
      }
      const entry = {
        ...body.entry,
        storageKind: body.storageKind,
        projectId: targetProjectId,
      };
      const source = body.source ?? { projectId: consumerProjectId };
      if (body.operation === "get") {
        res.json(ok(await storage.getProjectStorageValue(entry)));
        return;
      }
      if (body.operation === "compare-and-set") {
        res.json(ok(await storage.compareAndSetProjectStorageValue({
          ...entry,
          value: body.value,
          expectedRevision: body.expectedRevision!,
          source,
        })));
        return;
      }
      if (body.operation === "delete") {
        res.json(ok(await storage.deleteProjectStorageValue(entry)));
        return;
      }

      res.json(ok(await storage.setProjectStorageValue({
        ...entry,
        value: body.value,
        source,
      })));
    }),
  );

  // GET /api/token-usage
  router.get(
    "/token-usage",
    authenticate,
    asyncHandler(async (req, res) => {
      requireRequestPermission(req, "audit.read");
      res.json(ok(await storage.getSystemTokenUsage({
        pageSize: readOptionalPositiveInteger(req.query["pageSize"], "pageSize"),
        cursor: readOptionalString(req.query["cursor"], "cursor"),
      })));
    }),
  );

  // GET /api/audit-events
  router.get(
    "/audit-events",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPermission(req, "audit.read");
      const page = await listAuditEvents({
        pageSize: readOptionalPositiveInteger(req.query["pageSize"], "pageSize"),
        cursor: readAuditCursor(req.query["cursor"]),
        from: readOptionalIsoDate(req.query["from"], "from"),
        to: readOptionalIsoDate(req.query["to"], "to"),
        actorUserId: readOptionalString(req.query["userId"] ?? req.query["actorUserId"], "userId"),
        principalKind: readOptionalString(req.query["principalKind"], "principalKind"),
        eventType: readOptionalString(req.query["eventType"], "eventType"),
        resourceType: readOptionalString(req.query["resourceType"], "resourceType"),
        resourceId: readOptionalString(req.query["resourceId"], "resourceId"),
        outcome: readOptionalAuditOutcome(req.query["outcome"]),
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "audit.events.list",
        outcome: "success",
        resourceType: "audit_event",
        context: {
          pageSize: readOptionalPositiveInteger(req.query["pageSize"], "pageSize"),
          cursor: readAuditCursor(req.query["cursor"]),
          from: readOptionalIsoDate(req.query["from"], "from"),
          to: readOptionalIsoDate(req.query["to"], "to"),
          actorUserId: readOptionalString(req.query["userId"] ?? req.query["actorUserId"], "userId"),
          principalKind: readOptionalString(req.query["principalKind"], "principalKind"),
          eventType: readOptionalString(req.query["eventType"], "eventType"),
          resourceType: readOptionalString(req.query["resourceType"], "resourceType"),
          resourceId: readOptionalString(req.query["resourceId"], "resourceId"),
          outcome: readOptionalAuditOutcome(req.query["outcome"]),
        },
      });
      res.json(ok(await enrichAuditPage(page)));
    }),
  );

  router.post(
    "/deployments",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      const createdByUserId = requirePrincipalUserId(principal, "create a project deployment");
      const body = isRecord(req.body) ? req.body : {};
      const manifest = readProjectGroupManifest(body["manifest"]);
      for (const project of manifest.projects) {
        await requireManageAccess(req, storage, project.projectId);
      }
      const deployment = await storage.createProjectGroupDeployment({
        manifest,
        releaseLog: readOptionalString(body["releaseLog"], "releaseLog"),
        createdByUserId,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.deployment.create",
        outcome: "success",
        resourceType: "project_deployment",
        resourceId: deployment.id,
        context: { rootProjectId: deployment.rootProjectId },
      });
      res.status(201).json(ok(deployment));
    }),
  );

  router.get(
    "/deployments/:deploymentId",
    authenticate,
    asyncHandler(async (req, res) => {
      const deployment = await storage.getProjectGroupDeployment(req.params.deploymentId);
      for (const project of deployment.manifest.projects) {
        await requireManageAccess(req, storage, project.projectId);
      }
      res.json(ok(deployment));
    }),
  );

  router.post(
    "/deployments/:deploymentId/package",
    authenticate,
    raw,
    asyncHandler(async (req, res) => {
      const deployment = await storage.getProjectGroupDeployment(req.params.deploymentId);
      let principal: AuthenticatedPrincipal | undefined;
      for (const project of deployment.manifest.projects) {
        ({ principal } = await requireManageAccess(req, storage, project.projectId));
      }
      const archiveName =
        (req.query["fileName"] as string | undefined) ??
        (req.headers["x-steamharness-package-name"] as string | undefined) ??
        `project-group-${deployment.id}.tgz`;
      const archiveBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body as string);
      const result = await storage.enqueueProjectGroupPreparation({
        deploymentId: deployment.id,
        archiveName,
        archiveBuffer,
      });
      await recordRouteAudit(req, {
        principal: principal!,
        eventType: "project.deployment.upload",
        outcome: "success",
        resourceType: "project_deployment",
        resourceId: deployment.id,
        context: { archiveName, status: result.status },
      });
      res.status(202).json(ok(result));
    }),
  );

  router.post(
    "/deployments/:deploymentId/publish",
    authenticate,
    asyncHandler(async (req, res) => {
      const deployment = await storage.getProjectGroupDeployment(req.params.deploymentId);
      let principal: AuthenticatedPrincipal | undefined;
      for (const project of deployment.manifest.projects) {
        ({ principal } = await requireManageAccess(req, storage, project.projectId));
      }
      const result = await storage.publishProjectGroupDeployment(deployment.id);
      await recordRouteAudit(req, {
        principal: principal!,
        eventType: "project.deployment.publish",
        outcome: "success",
        resourceType: "project_deployment",
        resourceId: deployment.id,
        context: { rootProjectId: deployment.rootProjectId, status: result.status },
      });
      res.json(ok(result));
    }),
  );

  // POST /api/projects/:name/init  (create from template files)
  router.post(
    "/projects/:name/init",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      await requireProjectManageAccess(req, storage);
      const { name } = req.params;
      const body = isRecord(req.body) ? req.body : {};
      const files = readProjectFileInputs(body["files"]);
      res.json(ok(await storage.createProjectFromFiles({ projectName: name, files })));
    }),
  );

  // POST /api/projects/:name/package
  router.post(
    "/projects/:name/package",
    authenticate,
    raw,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const { name } = req.params;
      const archiveName =
        (req.query["fileName"] as string | undefined) ??
        (req.headers["x-steamharness-package-name"] as string | undefined) ??
        `${name}.tgz`;
      const createOnly = req.query["mode"] === "create";
      const archiveBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body as string);

      const result = await storage.enqueuePackagePreparation({
        projectName: name,
        archiveName,
        archiveBuffer,
        createOnly,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.package.upload",
        outcome: "success",
        resourceType: "project",
        resourceId: name,
        context: {
          archiveName,
          createOnly,
          jobId: result.jobId,
        },
      });
      res.status(202).json(ok(result));
    }),
  );

  // Preparation jobs remain queryable after clients disconnect.
  router.get(
    "/projects/:name/preparations/latest",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      const result = await storage.getLatestPreparationJob(req.params.name);
      if (result === undefined) {
        throw new HttpError(404, 404, `Workflow "${req.params.name}" has no preparation jobs.`);
      }
      res.json(ok(result));
    }),
  );

  router.get(
    "/projects/:name/preparations/:jobId",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      res.json(ok(await storage.getPreparationJob(req.params.name, req.params.jobId)));
    }),
  );

  // GET /api/projects/:name/files
  router.get(
    "/projects/:name/files",
    authenticate,
    asyncHandler(async (req, res) => {
      if (!await canDownloadProjectSourceForPrincipal(storage, requireRequestPrincipal(req), req.params.name)) {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const { name } = req.params;
      const target = (req.query["target"] as string | undefined) ?? "draft";
      const includeBinary = req.query["includeBinary"] === "true";
      res.json(ok(await storage.getFiles({ projectName: name, target, includeBinary })));
    }),
  );

  // Source localization has a dedicated permission boundary and
  // never falls back to the ordinary runtime/file-read response.
  router.get(
    "/projects/:name/source-files",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      if (!await canDownloadProjectSourceForPrincipal(storage, principal, req.params.name)) {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const target = (req.query["target"] as string | undefined) ?? "latest";
      const result = await storage.getDownloadableSourceFiles({
        projectName: req.params.name,
        target,
      });
      recordSourceDownloadsOnFinish(req, res, storage, [{ projectId: result.projectId, version: result.resolvedTarget }]);
      res.json(ok(result));
    }),
  );

  router.get(
    "/projects/:name/source-share",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      if (!await canDownloadProjectSourceForPrincipal(storage, principal, req.params.name)) {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const version = readOptionalString(req.query["target"], "target") ?? "";
      res.setHeader("Cache-Control", "no-store");
      res.json(ok(await storage.getSourceShare(req.params.name, version)));
    }),
  );

  router.get(
    "/projects/:name/source-archive",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      if (!await canDownloadProjectSourceForPrincipal(storage, principal, req.params.name)) {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const result = await storage.getSourceArchive(req.params.name, readOptionalString(req.query["target"], "target"));
      recordSourceDownloadsOnFinish(req, res, storage, [{ projectId: req.params.name, version: result.version }]);
      res.type("application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeHeaderFileName(`${req.params.name}-${result.version}.tar.gz`)}"`);
      res.send(result.archive);
    }),
  );

  router.get(
    "/projects/:name/dependencies",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectReadAccess(req, storage);
      const origin = getRequestOrigin(req);
      res.json(ok(await storage.getProjectDependencyStatus({
        projectName: req.params.name,
        target: readOptionalString(req.query["target"], "target"),
        canDownloadProject: (projectId) => canDownloadProjectSourceForPrincipal(storage, principal, projectId),
        requestUrlForProject: (projectId) => storage.createProjectAccessRequestUrl(origin, projectId),
      })));
    }),
  );

  router.get(
    "/projects/:name/project-group-download",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      if (!await canDownloadProjectSourceForPrincipal(storage, principal, req.params.name)) {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const origin = getRequestOrigin(req);
      const result = await storage.getProjectGroupDownload({
        projectName: req.params.name,
        target: readOptionalString(req.query["target"], "target"),
        canDownloadProject: (projectId) => canDownloadProjectSourceForPrincipal(storage, principal, projectId),
        requestUrlForProject: (projectId) => storage.createProjectAccessRequestUrl(origin, projectId),
      });
      recordSourceDownloadsOnFinish(req, res, storage, result.projects.map(project => ({ projectId: project.projectId, version: project.version })));
      res.json(ok(result));
    }),
  );

  router.get(
    "/projects/:name/source-access-requests",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectManageAccess(req, storage);
      res.json(ok({
        requests: await storage.listProjectAccessRequests(req.params.name),
        grants: await storage.listProjectSourceCapabilities(req.params.name),
      }));
    }),
  );

  router.patch(
    "/projects/:name/source-access-requests/:requestId",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      const status = body["status"];
      if (status !== "approved" && status !== "rejected") {
        throw new HttpError(400, 400, 'status must be "approved" or "rejected".');
      }
      res.json(ok(await storage.resolveProjectAccessRequest({
        projectId: req.params.name,
        requestId: req.params.requestId,
        status,
        resolvedByUserId: "userId" in principal ? principal.userId : undefined,
      })));
    }),
  );

  router.delete(
    "/projects/:name/source-capabilities/:userId",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      res.json(ok(await storage.revokeProjectSourceCapability({
        projectId: req.params.name,
        userId: req.params.userId,
        revokedByUserId: "userId" in principal ? principal.userId : undefined,
      })));
    }),
  );

  router.get(
    "/project-source-access/:token",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      requirePrincipalUserId(principal, "view a project source access request");
      const { projectId } = storage.readProjectAccessRequestToken(req.params.token);
      const access = await storage.getProjectAccessSummary(projectId);
      res.json(ok({ projectId, projectName: access.projectName }));
    }),
  );

  router.post(
    "/project-source-access/:token/requests",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      const requesterUserId = requirePrincipalUserId(principal, "request project source access");
      const { projectId } = storage.readProjectAccessRequestToken(req.params.token);
      const body = isRecord(req.body) ? req.body : {};
      res.status(201).json(ok(await storage.createProjectAccessRequest({
        projectId,
        requesterUserId,
        reason: requireString(body["reason"], "reason"),
      })));
    }),
  );

  router.get(
    "/projects/:name/kanban",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectReadAccess(req, storage);
      const workspace = await storage.getKanbanWorkspace({
        projectName: req.params.name,
        target: readOptionalString(req.query["target"], "target"),
        actorId: requireKanbanConfigurationActorId(principal),
      });
      const previewCapability = await storage.issueKanbanPreviewCapability({
        projectName: req.params.name,
        target: workspace.resolvedTarget,
        actorId: requireKanbanConfigurationActorId(principal),
      });
      const nonce = randomBytes(18).toString("base64url");
      res.json(ok({
        ...workspace,
        preview: {
          nonce,
          expiresAt: previewCapability.expiresAt,
          url: `/api/projects/${encodeURIComponent(req.params.name)}/kanban/previews/${encodeURIComponent(previewCapability.token)}/${nonce}/${encodeURIComponent(workspace.resolvedTarget)}/${encodeKanbanAssetUrlPath(workspace.entry)}`,
        },
      }));
    }),
  );

  router.post(
    "/projects/:name/kanban/configurations",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectReadAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      res.status(201).json(ok(await storage.createKanbanConfiguration({
        projectName: req.params.name,
        target: readOptionalString(body["target"], "target"),
        actorId: requireKanbanConfigurationActorId(principal),
        sourceConfigurationId: readOptionalString(body["sourceConfigurationId"], "sourceConfigurationId"),
      })));
    }),
  );

  router.patch(
    "/projects/:name/kanban/configurations/:configurationId",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectReadAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      const common = {
        projectName: req.params.name,
        target: readOptionalString(body["target"], "target"),
        actorId: requireKanbanConfigurationActorId(principal),
        configurationId: req.params.configurationId,
      };
      if (body["name"] !== undefined) {
        res.json(ok(await storage.renameKanbanConfiguration({
          ...common,
          name: requireString(body["name"], "name"),
        })));
        return;
      }
      if (body["values"] !== undefined) {
        res.json(ok(await storage.saveKanbanConfigurationValues({
          ...common,
          values: readRequiredRecord(body["values"], "values"),
        })));
        return;
      }
      throw new HttpError(400, 400, "Kanban configuration patch requires name or values.");
    }),
  );

  router.put(
    "/projects/:name/kanban/active-configuration",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectReadAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      res.json(ok(await storage.selectKanbanConfiguration({
        projectName: req.params.name,
        target: readOptionalString(body["target"], "target"),
        actorId: requireKanbanConfigurationActorId(principal),
        configurationId: requireString(body["configurationId"], "configurationId"),
      })));
    }),
  );

  router.delete(
    "/projects/:name/kanban/configurations/:configurationId",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectReadAccess(req, storage);
      res.json(ok(await storage.deleteKanbanConfiguration({
        projectName: req.params.name,
        target: readOptionalString(req.query["target"], "target"),
        actorId: requireKanbanConfigurationActorId(principal),
        configurationId: req.params.configurationId,
      })));
    }),
  );

  router.get(
    "/projects/:name/members",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      res.json(ok(await enrichProjectMembers(await storage.listProjectMembers(req.params["name"]))));
    }),
  );

  router.put(
    "/projects/:name/members/:userId",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal, access } = await requireProjectMemberManageAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      const role = requireString(body["role"], "role");
      if (role !== "owner" && role !== "manager" && role !== "writer" && role !== "viewer") {
        throw new HttpError(400, 400, `Invalid role "${role}".`);
      }
      if (req.params["userId"] === access.ownerUserId && role !== "owner") {
        throw new HttpError(409, 409, "issue #95 owner role cannot be changed through member management.");
      }
      if (role === "owner" && req.params["userId"] !== access.ownerUserId) {
        if (access.member?.role === "manager") {
          throw new HttpError(403, 403, "issue #95 managers cannot transfer project ownership.");
        }
        throw new HttpError(409, 409, "issue #95 owner transfer is not supported in phase three.");
      }
      const result = await storage.setProjectMember({
        projectId: req.params["name"],
        userId: req.params["userId"],
        role: role as ProjectRole,
        createdBy: "userId" in principal ? principal.userId : undefined,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.member.upsert",
        outcome: "success",
        resourceType: "project_member",
        resourceId: `${req.params["name"]}:${req.params["userId"]}`,
        context: {
          projectId: req.params["name"],
          userId: req.params["userId"],
          role: result.role,
          ownerUserId: access.ownerUserId,
        },
      });
      const [enrichedResult] = await enrichProjectMembers([result]);
      res.json(ok(enrichedResult ?? result));
    }),
  );

  router.delete(
    "/projects/:name/members/:userId",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal, access } = await requireProjectMemberManageAccess(req, storage);
      if (req.params["userId"] === access.ownerUserId) {
        throw new HttpError(409, 409, "issue #95 owner membership cannot be removed.");
      }
      const result = await storage.removeProjectMember(req.params["name"], req.params["userId"]);
      await recordRouteAudit(req, {
        principal,
        eventType: "project.member.remove",
        outcome: "success",
        resourceType: "project_member",
        resourceId: `${req.params["name"]}:${req.params["userId"]}`,
        context: {
          projectId: req.params["name"],
          userId: req.params["userId"],
          removed: result.removed,
        },
      });
      res.json(ok(result));
    }),
  );

  // Generate a single-use, time-boxed invitation that lets an existing
  // user join this project via a server-issued token. The API does not email
  // the link; the inviter copies it from the UI and shares it manually.
  router.post(
    "/projects/:name/invitations",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectMemberManageAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      const role = requireString(body["role"], "role");
      if (role !== "manager" && role !== "writer" && role !== "viewer") {
        throw new HttpError(400, 400, `Invalid role "${role}".`);
      }
      const { invitation, token } = await storage.createProjectInvitation({
        projectId: req.params["name"],
        role: role as ProjectRole,
        createdBy: "userId" in principal ? principal.userId : undefined,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.invitation.create",
        outcome: "success",
        resourceType: "project_invitation",
        resourceId: invitation.id,
        context: {
          projectId: invitation.projectId,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
        },
      });
      const [enrichedInvitation] = await enrichProjectInvitations([invitation]);
      res.status(201).json(ok({ invitation: enrichedInvitation ?? invitation, token }));
    }),
  );

  router.get(
    "/projects/:name/invitations",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectMemberManageAccess(req, storage);
      res.json(ok(await enrichProjectInvitations(await storage.listProjectInvitations(req.params["name"]))));
    }),
  );

  router.delete(
    "/projects/:name/invitations/:invitationId",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectMemberManageAccess(req, storage);
      const result = await storage.revokeProjectInvitation(
        req.params["name"],
        req.params["invitationId"],
      );
      if (!result.revoked) {
        throw new HttpError(409, 409, "Invitation cannot be revoked (already accepted or revoked).");
      }
      await recordRouteAudit(req, {
        principal,
        eventType: "project.invitation.revoke",
        outcome: "success",
        resourceType: "project_invitation",
        resourceId: req.params["invitationId"],
        context: {
          projectId: req.params["name"],
        },
      });
      res.json(ok(result));
    }),
  );

  // Public lookup: anyone holding the token can read its summary before
  // accepting. We intentionally do not require auth here so the accept page
  // can prompt anonymous visitors to log in first; the token itself is the
  // bearer credential and exposes no secret beyond what the inviter shares.
  router.get(
    "/invitations/:token",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = getRequestPrincipal(req);
      const invitation = await storage.getInvitationByToken(req.params["token"]);
      if (!invitation) {
        throw new HttpError(404, 404, "Invitation not found.");
      }
      const summary = await storage.getProjectAccessSummary(
        invitation.projectId,
        principal && "userId" in principal ? principal.userId : undefined,
      );
      const [enrichedInvitation] = await enrichProjectInvitations([invitation]);
      res.json(
        ok({
          invitation: enrichedInvitation ?? invitation,
          project: {
            id: summary.projectId,
            name: summary.projectName,
          },
        }),
      );
    }),
  );

  // Accept an invitation: requires an authenticated user. Joins them to the
  // project with the role specified by the invitation. Idempotent re-acceptance
  // is rejected via the storage layer (single-use).
  router.post(
    "/invitations/:token/accept",
    authenticate,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      if (!("userId" in principal)) {
        throw new HttpError(401, 401, "Account login is required to accept invitations.");
      }
      const result = await storage.acceptInvitation({
        token: req.params["token"],
        acceptedBy: principal.userId,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.invitation.accept",
        outcome: "success",
        resourceType: "project_invitation",
        resourceId: result.invitation.id,
        context: {
          projectId: result.invitation.projectId,
          role: result.invitation.role,
          acceptedBy: principal.userId,
        },
      });
      const [enrichedMember] = await enrichProjectMembers([result.member]);
      const [enrichedInvitation] = await enrichProjectInvitations([result.invitation]);
      res.json(ok({
        invitation: enrichedInvitation ?? result.invitation,
        member: enrichedMember ?? result.member,
      }));
    }),
  );

  router.patch(
    "/projects/:name/visibility",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      const visibility = requireString(body["visibility"], "visibility");
      if (visibility !== "private" && visibility !== "public") {
        throw new HttpError(400, 400, `Invalid visibility "${visibility}".`);
      }
      const result = await storage.updateProjectVisibility({
        projectId: req.params["name"],
        visibility: visibility as Visibility,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.visibility.update",
        outcome: "success",
        resourceType: "project",
        resourceId: req.params["name"],
        context: {
          visibility: result.visibility,
        },
      });
      res.json(ok(result));
    }),
  );

  // PUT /api/projects/:name/draft/files
  router.put(
    "/projects/:name/draft/files",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const { name } = req.params;
      const body = isRecord(req.body) ? req.body : {};
      const files = readProjectFileInputs(body["files"]);
      const removePaths =
        body["removePaths"] === undefined
          ? undefined
          : assertStringArray(body["removePaths"], "removePaths");

      const result = await storage.saveDraftFiles({ projectName: name, files, removePaths });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.draft.save_files",
        outcome: "success",
        resourceType: "project",
        resourceId: name,
        context: {
          updatedFiles: result.updatedFiles,
          removedFiles: result.removedFiles,
          nextVersion: result.nextVersion,
        },
      });
      res.json(ok(result));
    }),
  );

  // POST /api/projects/:name/clone
  router.post(
    "/projects/:name/clone",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPermission(req, "projects.create");
      const { name } = req.params;
      if (!await canDownloadProjectSourceForPrincipal(storage, principal, name)) {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const body = req.body as {
        targetProjectName?: unknown;
        displayName?: unknown;
        sourceTarget?: unknown;
      };
      const targetProjectName = requireString(body.targetProjectName, "targetProjectName");
      const result = await storage.cloneProject({
        projectName: name,
        targetProjectName,
        ownerUserId: "userId" in principal ? principal.userId : undefined,
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        sourceTarget: typeof body.sourceTarget === "string" ? body.sourceTarget : undefined,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.clone",
        outcome: "success",
        resourceType: "project",
        resourceId: result.projectId,
        context: {
          sourceProjectName: name,
          targetProjectName,
          displayName: result.projectName,
          sourceTarget: typeof body.sourceTarget === "string" ? body.sourceTarget : undefined,
        },
      });
      res.json(ok(result));
    }),
  );

  // PATCH /api/projects/:name/info
  router.patch(
    "/projects/:name/info",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const { name } = req.params;
      const body = req.body as {
        target?: unknown;
        displayName?: unknown;
      };

      const result = await storage.updateProjectInfo({
        projectName: name,
        target: typeof body.target === "string" ? body.target : undefined,
        displayName: requireString(body.displayName, "displayName"),
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.info.update",
        outcome: "success",
        resourceType: "project",
        resourceId: name,
        context: {
          displayName: result.projectName,
          target: result.target,
          resolvedTarget: result.resolvedTarget,
        },
      });
      res.json(ok(result));
    }),
  );

  // DELETE /api/projects/:name
  router.delete(
    "/projects/:name",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const { name } = req.params;
      const result = await storage.deleteProject(name);
      await recordRouteAudit(req, {
        principal,
        eventType: "project.delete",
        outcome: "success",
        resourceType: "project",
        resourceId: name,
      });
      res.json(ok(result));
    }),
  );

  // POST /api/projects/:name/publish
  router.post(
    "/projects/:name/publish",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectManageAccess(req, storage);
      const { name } = req.params;
      const body = isRecord(req.body) ? req.body : {};
      const result = await storage.publish({
        projectName: name,
        releaseLog: typeof body["releaseLog"] === "string" ? body["releaseLog"] : undefined,
        expectedVersion: readOptionalString(body["expectedVersion"], "expectedVersion"),
        expectedSourceHash: readOptionalString(body["expectedSourceHash"], "expectedSourceHash"),
        createdByUserId: "userId" in principal ? principal.userId : undefined,
      });
      await recordRouteAudit(req, {
        principal,
        eventType: "project.publish",
        outcome: "success",
        resourceType: "project_version",
        resourceId: `${name}:${result.version}`,
        context: {
          version: result.version,
          latest: result.latest,
          releaseLog: result.releaseLog,
        },
      });
      res.json(ok(result));
    }),
  );

  // GET /api/projects/:name/versions
  router.get(
    "/projects/:name/versions",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      const { name } = req.params;
      res.json(ok(await enrichVersionSummary(await storage.listVersions(name))));
    }),
  );

  router.get(
    "/projects/:name/data-summary",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      res.json(ok(await storage.getProjectDataSummary(req.params.name)));
    }),
  );

  // GET /api/projects/:name/kv
  router.get(
    "/projects/:name/kv",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      const { name } = req.params;
      res.json(ok(await storage.listProjectKVEntries({
        projectId: name,
        pageSize: readOptionalPositiveInteger(req.query["pageSize"], "pageSize"),
        cursor: readOptionalString(req.query["cursor"], "cursor"),
        scope: readOptionalKVScope(req.query["scope"]),
        query: readOptionalString(req.query["q"], "q"),
        valueType: readOptionalKVValueType(req.query["valueType"]),
        conversationId: readOptionalString(req.query["conversationId"] ?? req.query["conversation_id"], "conversationId"),
        runId: readOptionalString(req.query["runId"], "runId"),
      })));
    }),
  );

  // GET /api/projects/:name/kv/entry
  router.get(
    "/projects/:name/kv/entry",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      const { name } = req.params;
      // Project KV list rows are summary-only; row expansion uses
      // this detail endpoint for the single selected value.
      res.json(ok(await storage.getProjectKVEntry({
        projectId: name,
        scope: readRequiredProjectKVScope(req.query["scope"]),
        key: requireString(req.query["key"], "key"),
        conversationId: readOptionalString(req.query["conversationId"] ?? req.query["conversation_id"], "conversationId"),
      })));
    }),
  );

  // DELETE /api/projects/:name/kv/entry
  router.delete(
    "/projects/:name/kv/entry",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectStorageWriteAccess(req, storage);
      const { name } = req.params;
      res.json(ok(await storage.deleteProjectKVEntry({
        projectId: name,
        scope: readRequiredProjectKVScope(req.query["scope"]),
        key: requireString(req.query["key"], "key"),
        conversationId: readOptionalString(req.query["conversationId"] ?? req.query["conversation_id"], "conversationId"),
      })));
    }),
  );

  // GET /api/projects/:name/knowledge-documents
  router.get(
    "/projects/:name/knowledge-documents",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      const { name } = req.params;
      res.json(ok(await storage.listKnowledgeDocuments(name, {
        pageSize: readOptionalPositiveInteger(req.query["pageSize"], "pageSize"),
        cursor: readOptionalString(req.query["cursor"], "cursor"),
      })));
    }),
  );

  // POST /api/projects/:name/knowledge-documents
  router.post(
    "/projects/:name/knowledge-documents",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      await requireProjectStorageWriteAccess(req, storage);
      const { name } = req.params;
      const body = readKnowledgeCreateBody(req.body);
      const responseMode = readKnowledgeWriteResponseMode(req.query["response"]);
      // Project knowledge documents are backed by the workflow PersistentValue
      // namespace on the server.
      const document = await storage.createKnowledgeDocument({
        projectName: name,
        id: body.id,
        title: body.title,
        markdown: body.markdown,
      });
      res.status(201).json(ok(responseMode === "summary" ? summarizeKnowledgeDocument(document) : document));
    }),
  );

  // GET /api/projects/:name/knowledge-documents/search
  router.get(
    "/projects/:name/knowledge-documents/search",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      const { name } = req.params;
      res.json(ok(await storage.searchKnowledgeDocuments({
        projectName: name,
        query: requireString(req.query["q"], "q"),
        documentId: readOptionalString(req.query["documentId"], "documentId"),
        beforeLines: readOptionalNonNegativeInteger(req.query["beforeLines"], "beforeLines"),
        afterLines: readOptionalNonNegativeInteger(req.query["afterLines"], "afterLines"),
        maxMatches: readOptionalIntegerInRange(req.query["maxMatches"], "maxMatches", { min: 1, max: 1000 }),
        pageSize: readOptionalIntegerInRange(req.query["pageSize"], "pageSize", { min: 1, max: 1000 }),
        cursor: readOptionalString(req.query["cursor"], "cursor"),
      })));
    }),
  );

  // GET /api/projects/:name/knowledge-documents/:documentId/lines
  router.get(
    "/projects/:name/knowledge-documents/:documentId/lines",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      const { name, documentId } = req.params;
      res.json(ok(await storage.readKnowledgeDocumentLines({
        projectName: name,
        documentId,
        startLine: requirePositiveInteger(req.query["startLine"], "startLine"),
        endLine: requirePositiveInteger(req.query["endLine"], "endLine"),
      })));
    }),
  );

  // GET /api/projects/:name/knowledge-documents/:documentId
  router.get(
    "/projects/:name/knowledge-documents/:documentId",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectReadAccess(req, storage);
      const { name, documentId } = req.params;
      res.json(ok(await storage.getKnowledgeDocument({ projectName: name, documentId })));
    }),
  );

  // PUT /api/projects/:name/knowledge-documents/:documentId
  router.put(
    "/projects/:name/knowledge-documents/:documentId",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      await requireProjectStorageWriteAccess(req, storage);
      const { name, documentId } = req.params;
      const body = readKnowledgeEditBody(req.body);
      const responseMode = readKnowledgeWriteResponseMode(req.query["response"]);
      const document = await storage.editKnowledgeDocument({
        projectName: name,
        documentId,
        title: body.title,
        markdown: body.markdown,
      });
      res.json(ok(responseMode === "summary" ? summarizeKnowledgeDocument(document) : document));
    }),
  );

  // DELETE /api/projects/:name/knowledge-documents/:documentId
  router.delete(
    "/projects/:name/knowledge-documents/:documentId",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectStorageWriteAccess(req, storage);
      const { name, documentId } = req.params;
      res.json(ok(await storage.deleteKnowledgeDocument({ projectName: name, documentId })));
    }),
  );

  // GET /api/projects/:name/token-usage
  router.get(
    "/projects/:name/token-usage",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectManageAccess(req, storage);
      const { name } = req.params;
      res.json(ok(await storage.getProjectTokenUsage({
        projectId: name,
        conversationId: readOptionalString(req.query["conversationId"] ?? req.query["conversation_id"], "conversationId"),
        includeEntries: readOptionalQueryBoolean(req.query["includeEntries"], "includeEntries") === true,
      })));
    }),
  );

  // API 404
  router.use((req, res) => {
    res.status(404).json(fail(404, localizeServerMessage("API route not found.", getRequestT(req))));
  });

  // API error handler
  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const httpError = toHttpError(err);
    res.status(httpError.statusCode).json(
      fail(httpError.errCode, localizeHttpErrorMessage(httpError, getRequestT(req)), httpError.data),
    );
  });

  return router;
}
