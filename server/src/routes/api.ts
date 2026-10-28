import { readProjectManifest } from "@steamharness/project-manifest";
import { createDatabaseSpaceRouter } from './database-spaces';
import { createGroupRouter, requestActor, pageQuery } from "./groups";
import { resolveResourceAccess, type AccessCapability } from "@steamharness/project-access";
import type { ProjectConfigurationAction, ProjectConfigurationState } from "@steamharness/project-configuration";

import {readFile} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import express from "express";
import { getRequestPrincipal, hasPermission, requireAuthenticatedPrincipal, type AuthenticatedPrincipal } from "../auth";
import { getProjectAuthContext } from "../auth";
import { createAuditActor, listAuditEvents, recordPermissionDeniedForRequest, recordAuditEventForRequest } from "../audit";
import { HttpError, fail, ok, toHttpError, toHttpErrorWithStatus } from "../protocol";
import { getRequestT, localizeHttpErrorMessage, localizeServerMessage, resolveRequestLocale } from "../i18n";
import { PROJECT_CARD_IMAGE_MAX_BYTES } from "../storage";
import type { ManagedFileReference, ProjectInvitation, ProjectCardImage, ProjectMember, ProjectRole, UserProfileSummary, VersionSummary, Visibility, Storage } from "../storage";
import type { AuditEventPage, AuditEventRecord, UserProfileRecord } from "../account-db";
import type { PermissionKey } from "../permissions";
import { isProjectUuid } from "../workflow-ids";
import { validateProjectCardMetadata, type ProjectCardMetadata } from "@steamharness/project-card-metadata";
import { isProjectKind, STEAMHARNESS_PROJECT_TYPES, type ProjectKind } from "@steamharness/project-types";
import { encodeKanbanAssetUrlPath } from "@steamharness/kanban-project";
import { invokeServerKanbanBridge, readKanbanBridgeCall } from "../kanban-bridge";
import { createKanbanRevisionBatcher } from "../kanban-revision-batcher";
import { normalizeDeclaredProjectInfoInput, type DeclaredProjectInfo } from "@steamharness/project-info";

const DEFAULT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

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

function requireProjectConfigurationActorId(principal: AuthenticatedPrincipal): string {
  if (!("userId" in principal) || principal.userId.trim() === "") {
    throw new HttpError(401, 401, "Account login is required to use project configurations.");
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
      error instanceof Error ? error.message : "Project information is invalid.",
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

async function requireProjectAction(req:Request,storage:Storage,capability:AccessCapability,projectId=req.params["name"]) {
  const principal=requireRequestPrincipal(req);
  let authorization;
  try {authorization=await storage.requireProjectCapability(projectId,requestActor(req),capability);}
  catch(error) {
    if(error instanceof HttpError && error.statusCode===403) await recordRouteAudit(req,{principal,eventType:"project.access.denied",outcome:"denied",resourceType:"project",resourceId:projectId,context:{capability}});
    throw error;
  }
  const access=await storage.getProjectAccessSummary(projectId,'userId' in principal?principal.userId:undefined);
  return {principal,access:{...access,access:authorization}};
}
async function requireProjectReadAccess(req:Request,storage:Storage) {return requireProjectAction(req,storage,'read');}
async function assertProjectReadableForPrincipal(storage:Storage,principal:AuthenticatedPrincipal,id:string):Promise<void> {await storage.requireProjectCapability(id,{userId:'userId' in principal?principal.userId:undefined,isSystemAdmin:principal.isSystemAdmin},'read');}
async function assertProjectStorageAccessForPrincipal(storage:Storage,principal:AuthenticatedPrincipal,id:string,write:boolean):Promise<void> {await storage.requireProjectCapability(id,{userId:'userId' in principal?principal.userId:undefined,isSystemAdmin:principal.isSystemAdmin},write?'writeData':'read');}
async function requireProjectStorageWriteAccess(req:Request,storage:Storage):Promise<void> {await requireProjectAction(req,storage,'writeData');}
async function canDownloadProjectSourceForPrincipal(storage:Storage,principal:AuthenticatedPrincipal,id:string):Promise<boolean> {try{await storage.requireProjectCapability(id,{userId:'userId' in principal?principal.userId:undefined,isSystemAdmin:principal.isSystemAdmin},'downloadSource');return true;}catch(error){if(error instanceof HttpError&&(error.statusCode===403||error.statusCode===404))return false;throw error;}}
function parseJsonBodyField(value:unknown):unknown {if(typeof value!=='string'||value.length>8192)throw new HttpError(400,400,'Invalid configuration field.');try{return JSON.parse(value);}catch{throw new HttpError(400,400,'Invalid configuration field.');}}
async function requireConfigurationAccess(req:Request,storage:Storage):Promise<AuthenticatedPrincipal> {return (await requireProjectReadAccess(req,storage)).principal;}
async function canManageProjectForPrincipal(storage:Storage,principal:AuthenticatedPrincipal,id:string):Promise<boolean> {try{await storage.requireProjectCapability(id,{userId:'userId' in principal?principal.userId:undefined,isSystemAdmin:principal.isSystemAdmin},'manageSettings');return true;}catch(error){if(error instanceof HttpError&&(error.statusCode===403||error.statusCode===404))return false;throw error;}}
async function readableTarget(req:Request,storage:Storage,value:unknown):Promise<string> {
  const {access}=await requireProjectReadAccess(req,storage);
  const target=readOptionalString(value,"target")?.trim() || (access.access.capabilities.includes("readDraft")?"draft":"latest");
  if(target==="draft")await requireProjectAction(req,storage,"readDraft");
  return target;
}
function requirePrincipalUserId(principal:AuthenticatedPrincipal,action:string):string {if(!('userId' in principal))throw new HttpError(401,401,`Account login is required to ${action}.`);return principal.userId;}
async function requireProjectManageAccess(req:Request,storage:Storage){return requireProjectAction(req,storage,'manageSettings');}
async function requireManageAccess(req:Request,storage:Storage,id:string){return requireProjectAction(req,storage,'upload',id);}
async function requireProjectMemberManageAccess(req:Request,storage:Storage){return requireProjectAction(req,storage,'manageMembers');}

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
  router.use(createGroupRouter(storage));
  router.use(createDatabaseSpaceRouter(storage));
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
      await storage.assertManagedFileAccountAccess(req.params.fileId,userId);
      await assertProjectReadableForPrincipal(storage,principal,metadata.projectId);
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
      await storage.assertManagedFileAccountAccess(req.params.fileId,userId);
      await assertProjectStorageAccessForPrincipal(storage, principal, metadata.projectId, true);
      res.json(ok(await storage.deleteManagedFile(req.params.fileId)));
    }),
  );

  // GET /api/projects
  router.get(
    "/projects",
    authenticate,
    asyncHandler(async (req, res) => {
      const page=await storage.accessRepository.listProjectIds(requestActor(req),pageQuery(req));
      const items=await Promise.all(page.items.map(id=>storage.getProjectSummary(id)));
      const profiles = await loadUserProfileSummaries(items.map(item => item.createdByUserId));
      const filtered=await Promise.all(items.map(async item=>({
        ...item,access:await storage.accessRepository.resolve('project',item.id,requestActor(req)),
        createdByProfile: pickProfile(profiles, item.createdByUserId),
        sourceDownload:{...await storage.getSourceDownloadAvailability(item.id),allowed:true}
      })));
      res.json(ok({...page,items:filtered}));
    }),
  );

  router.post('/projects/:name/entries/:entryId/resources/read', authenticate, json, asyncHandler(async(req,res)=>{
    await requireProjectReadAccess(req,storage);
    const body=readRequiredRecord(req.body,'body');
    if(Object.keys(body).some(key=>!['kind','database','key','scope','conversationId','documentId'].includes(key)))throw new HttpError(400,400,'Unsupported database resource fields.');
    const kind=requireString(body['kind'],'kind');
    if(!['kv','knowledge'].includes(kind))throw new HttpError(400,400,'Unsupported database resource kind.');
    const conversationId=readOptionalString(body['conversationId'],'conversationId');
    const databases=await storage.entryDatabases(req.params.name,req.params.entryId,requestActor(req),'draft',conversationId);
    const database=databases.get(requireString(body['database'],'database'));
    let data:unknown;
    if(kind==='knowledge')data=body['documentId']?await database.knowledge.getDocument(requireString(body['documentId'],'documentId')):await database.knowledge.listDocuments({pageSize:100});
    else {
      if(body['scope']!==undefined&&!['project','conversation'].includes(String(body['scope'])))throw new HttpError(400,400,'Invalid database resource scope.');
      data=await(body['scope']==='conversation'?database.kv.conversation:database.kv).getValue(requireString(body['key'],'key'));
    }
    res.json(ok(data??null));
  }));

  router.post(
    "/projects/:name/kanban/bridge",
    authenticate,
    kanbanJson,
    asyncHandler(async (req, res) => {
      const body = isRecord(req.body) ? req.body : {};
      const call = readKanbanBridgeCall(body["call"]);
      const readOperation = ["runtime.getLocale", "files.readFile", "kv.getValue", "database.revision", "knowledge.listDocuments", "knowledge.getDocument", "knowledge.searchDocuments", "knowledge.readDocumentLines"].includes(call.operation);
      await requireProjectReadAccess(req, storage);
      if (!readOperation) await requireProjectStorageWriteAccess(req, storage);
      const target = body["target"] === undefined ? "draft" : await readableTarget(req, storage, body["target"]);
      res.json(ok(await invokeServerKanbanBridge(storage, req.params.name, call, { target, entryId: requireString(body["entryId"], "entryId"), actor: requestActor(req), runtimeLocale: resolveRequestLocale(req) })));
    }),
  );

  router.get("/projects/:name",authenticate,asyncHandler(async(req,res)=>{
    const {access}=await requireProjectReadAccess(req,storage);
    const summary = await storage.getProjectSummary(req.params.name);
    const profiles = await loadUserProfileSummaries([summary.createdByUserId]);
    res.json(ok({...summary,access:access.access,
      createdByProfile:pickProfile(profiles,summary.createdByUserId),
      sourceDownload:{...await storage.getSourceDownloadAvailability(summary.id),allowed:true},
    }));
  }));

  router.post(
    "/projects",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      const principal = requireRequestPrincipal(req);
      const body = isRecord(req.body) ? req.body : {};
      if (Object.hasOwn(body, "projectId")) {
        throw new HttpError(400, 400, "Project IDs are assigned by the Server. Create a new application to obtain a new ID.");
      }
      const projectName = requireString(body["name"], "name");
      if ("projectType" in body) throw new HttpError(400,400,"Register project entries instead of projectType.");
      const projectId = randomUUID();
      let manifest;
      try { manifest = readProjectManifest({ id: projectId, name: projectName, steamHarness: { entries: body["entries"], defaultEntry: body["defaultEntry"] } }); }
      catch(error) { throw toHttpErrorWithStatus(error,400,400,"Invalid aggregate project declaration."); }
      const projectInfo = readDeclaredProjectInfo(body["projectInfo"]);
      const visibility = readOptionalString(body["visibility"], "visibility");
      const projectCard = readOptionalProjectCardMetadata(body["projectCard"]);
      const created = await storage.createProject({
        projectId,
        projectName,
        entries: manifest.entries, defaultEntry: manifest.defaultEntry,
        projectInfo,
        ownerUserId: "userId" in principal ? principal.userId : undefined,
        groupId: readOptionalString(body["groupId"],"groupId"),
        isSystemAdmin: principal.isSystemAdmin,
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

  // GET /api/token-usage
  router.get(
    "/token-usage",
    authenticate,
    asyncHandler(async (req, res) => {
      requireRequestPermission(req, "system.admin");
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
      const principal = requireRequestPermission(req, "system.admin");
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

  // POST /api/projects/:name/init  (create from template files)
  router.post(
    "/projects/:name/init",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      await requireProjectAction(req, storage, "upload");
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
      const { principal } = await requireProjectAction(req, storage, "upload");
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
      await requireProjectAction(req, storage, "readDraft");
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
      await requireProjectAction(req, storage, "readDraft");
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
      const target = readOptionalString(req.query["target"], "target")?.trim() || "latest";
      if (target === "draft" && !((await storage.requireProjectCapability(name,requestActor(req),"readDraft")).capabilities.includes("readDraft"))) {
        throw new HttpError(403, 403, "Source download access only includes published project versions.");
      }
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
      const version = readOptionalString(req.query["target"], "target") ?? "";
      const share = await storage.getSourceShare(req.params.name, version);
      res.setHeader("Cache-Control", "no-store");
      if (!await canDownloadProjectSourceForPrincipal(storage, principal, req.params.name)) {
        throw new HttpError(403, 403, "Permission denied.", {
          requestUrl: storage.createProjectAccessRequestUrl(getRequestOrigin(req), req.params.name),
        });
      }
      res.json(ok(share));
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
    "/projects/:name/kanban",
    authenticate,
    asyncHandler(async (req, res) => {
      const { principal } = await requireProjectReadAccess(req, storage);
      const workspace = await storage.getKanbanWorkspace({
        projectName: req.params.name,
        target: await readableTarget(req,storage,req.query["target"]),
        entryId: readOptionalString(req.query["entryId"],"entryId"),
        actorId: requireProjectConfigurationActorId(principal),
      });
      const previewCapability = await storage.issueKanbanPreviewCapability({
        projectName: req.params.name,
        target: workspace.resolvedTarget,
        entryId: workspace.entryId,
        actorId: requireProjectConfigurationActorId(principal),
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

  router.get('/projects/:name/configurations/template',authenticate,asyncHandler(async(req,res)=>{
    const principal=await requireConfigurationAccess(req,storage);
    const target=readOptionalString(req.query['target'],'target')??'latest';
    if(target==='draft') throw new HttpError(400,400,'Select a published configuration version.');
    res.setHeader('Cache-Control','private, no-store');
    const state=await storage.projectConfigurations({projectName:req.params.name,entryId:readOptionalString(req.query["entryId"],"entryId"),actorId:requireProjectConfigurationActorId(principal),administrator:principal.isSystemAdmin,actor:requestActor(req),target},{action:'get'}) as ProjectConfigurationState;
    res.json(ok(state.template??(state.canManagePublication?await storage.configurationTemplate(req.params.name,target,readOptionalString(req.query["entryId"],"entryId")):undefined)??null));
  }));
  router.post('/projects/:name/configurations/files',authenticate,raw,asyncHandler(async(req,res)=>{
    const principal=await requireConfigurationAccess(req,storage);
    res.json(ok(await storage.uploadConfigurationFile({projectName:req.params.name,entryId:readOptionalString(req.query["entryId"],"entryId"),actorId:requireProjectConfigurationActorId(principal),
      administrator:principal.isSystemAdmin,actor:requestActor(req),key:requireString(req.query['key'],'key'),
      target:readOptionalString(req.query['target'],'target'),field:req.query['field']===undefined?undefined:parseJsonBodyField(req.query['field']),name:requireString(req.query['fileName'],'fileName'),
      mimeType:requireString(req.query['mimeType'],'mimeType'),buffer:Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body as Uint8Array)})));
  }));
  router.get('/projects/:name/configurations/files/:fileId',authenticate,asyncHandler(async(req,res)=>{
    const principal=await requireConfigurationAccess(req,storage);
    const file=await storage.configurationAttachment({projectName:req.params.name,entryId:readOptionalString(req.query["entryId"],"entryId"),actorId:requireProjectConfigurationActorId(principal),administrator:principal.isSystemAdmin,actor:requestActor(req),target:readOptionalString(req.query['target'],'target')},req.params.fileId);
    res.setHeader('Cache-Control','private, no-store');sendManagedFile(res,file.metadata,file.filePath,req.query['download']==='1');
  }));

  router.get("/projects/:name/configurations", authenticate, asyncHandler(async (req,res) => {
    const principal = await requireConfigurationAccess(req,storage);
    res.setHeader("Cache-Control", "no-store");
    res.json(ok(await storage.projectConfigurations({projectName:req.params.name,entryId:readOptionalString(req.query["entryId"],"entryId"),actorId:requireProjectConfigurationActorId(principal),administrator:principal.isSystemAdmin,actor:requestActor(req),target:readOptionalString(req.query["target"],"target")},{action:"get"})));
  }));
  router.post("/projects/:name/configurations", authenticate, json, asyncHandler(async (req,res) => {
    const principal = await requireConfigurationAccess(req,storage);
    const body = readRequiredRecord(req.body,"body");
    const call = readRequiredRecord(body["call"],"call") as unknown as ProjectConfigurationAction;
    res.setHeader("Cache-Control", "no-store");
    res.json(ok(await storage.projectConfigurations({projectName:req.params.name,entryId:readOptionalString(body["entryId"],"entryId"),actorId:requireProjectConfigurationActorId(principal),administrator:principal.isSystemAdmin,actor:requestActor(req),target:readOptionalString(body["target"],"target")},call)));
  }));

  router.get('/invitations/:token',authenticate,asyncHandler(async(req,res)=>{
    const invitation=await storage.accessRepository.getInvitation(req.params.token);
    if(!invitation)throw new HttpError(404,404,'Invitation not found.');
    res.json(ok({invitation,project:{id:invitation.resourceId,name:invitation.resourceName??invitation.resourceId}}));
  }));
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
      const invitation=await storage.accessRepository.acceptInvitation(req.params.token,principal.userId);
      const access=await storage.accessRepository.resolve(invitation.resourceType,invitation.resourceId,requestActor(req));
      const result={invitation,member:{projectId:invitation.resourceId,resourceId:invitation.resourceId,userId:principal.userId,role:access.effectiveRole!,access,createdAt:invitation.acceptedAt!}};
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
      const { principal } = await requireProjectAction(req, storage, "upload");
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
      const principal = requireRequestPrincipal(req);
      const { name } = req.params;
      if (!await canDownloadProjectSourceForPrincipal(storage, principal, name)) {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const body = isRecord(req.body) ? req.body : {};
      if (Object.hasOwn(body, "targetProjectName") || Object.hasOwn(body, "projectId")) {
        throw new HttpError(400, 400, "Project IDs are assigned by the Server. Create a new application to obtain a new ID.");
      }
      const targetProjectName = randomUUID();
      const sourceTarget = readOptionalString(body.sourceTarget, "sourceTarget")?.trim() || "latest";
      if (sourceTarget === "draft" && !((await storage.requireProjectCapability(name,requestActor(req),"readDraft")).capabilities.includes("readDraft"))) {
        throw new HttpError(403, 403, "Source download access only includes published project versions.");
      }
      const result = await storage.cloneProject({
        projectName: name,
        targetProjectName,
        ownerUserId: "userId" in principal ? principal.userId : undefined,
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        sourceTarget,
        groupId: readOptionalString(body.groupId,"groupId"),
        isSystemAdmin: principal.isSystemAdmin,
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
      const { principal } = await requireProjectAction(req, storage, "delete");
      const { name } = req.params;
      const result = await storage.deleteProject(name,requestActor(req));
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
      const { principal } = await requireProjectAction(req, storage, "publish");
      const { name } = req.params;
      const body = isRecord(req.body) ? req.body : {};
      if ("expectedConfigurationRevision" in body) throw new HttpError(400, 400, "Use expectedConfigurationRevisions keyed by entryId.");
      const result = await storage.publish({
        projectName: name,
        releaseLog: typeof body["releaseLog"] === "string" ? body["releaseLog"] : undefined,
        expectedVersion: readOptionalString(body["expectedVersion"], "expectedVersion"),
        expectedSourceHash: readOptionalString(body["expectedSourceHash"], "expectedSourceHash"),
        expectedConfigurationRevisions: readConfigurationRevisions(body["expectedConfigurationRevisions"]),
        administrator: principal.isSystemAdmin,
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
    "/projects/:name/access-requests",
    authenticate,
    asyncHandler(async (req, res) => {
      await requireProjectManageAccess(req, storage);
      res.json(ok({
        requests: await storage.listProjectAccessRequests(req.params.name),
      }));
    }),
  );

  router.patch(
    "/projects/:name/access-requests/:requestId",
    authenticate,
    json,
    asyncHandler(async (req, res) => {
      await requireProjectManageAccess(req, storage);
      const body = isRecord(req.body) ? req.body : {};
      const status = body["status"];
      if (status !== "approved" && status !== "rejected") {
        throw new HttpError(400, 400, 'status must be "approved" or "rejected".');
      }
      res.json(ok(await storage.resolveProjectAccessRequest({
        projectId: req.params.name,
        requestId: req.params.requestId,
        status,
        actor: requestActor(req),
      })));
    }),
  );


  router.get(
    "/project-access/:token",
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
    "/project-access/:token/requests",
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

function readConfigurationRevisions(input: unknown): Record<string, number> | undefined {
  if (input === undefined) return undefined;
  const value = readRequiredRecord(input, "expectedConfigurationRevisions");
  return Object.fromEntries(Object.entries(value).map(([entryId, revision]) => {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entryId)) throw new HttpError(400, 400, "Invalid entryId.");
    const parsed = readOptionalNonNegativeInteger(revision, `expectedConfigurationRevisions.${entryId}`);
    if (parsed === undefined) throw new HttpError(400, 400, "Configuration revisions must be non-negative integers.");
    return [entryId, parsed];
  }));
}
