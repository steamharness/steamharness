
import type { WorkflowProjectType as SharedWorkflowProjectType } from "@steamharness/project-types";
import type { WorkflowProjectInfo, WorkflowRelatedProject, WorkflowRelatedProjectKVGrant } from "@steamharness/project-info";
import type { WorkflowProjectAccessRequest, WorkflowProjectCapabilityGrant, WorkflowProjectDependencyLock, WorkflowProjectDependencyStatusResult } from "@steamharness/project-dependencies";

export type {
  WorkflowProjectAccessRequest,
  WorkflowProjectCapabilityGrant,
  WorkflowProjectDependencyLock,
  WorkflowProjectDependencyStatusResult,
};

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

export interface ApiSuccess<T> {
  errCode: 0;
  errMessage: "";
  data: T;
}

export interface ApiFailure {
  errCode: number;
  errMessage: string;
  data?: unknown;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function isApiSuccess<T>(response: ApiResponse<T>): response is ApiSuccess<T> {
  return response.errCode === 0;
}

export interface WorkflowServerHealthRelease {
  unit: "server" | "server-web";
  tag: string | null;
  version: string | null;
  versionLabel: string | null;
  publishedAt: string | null;
  commitSha: string | null;
  components: Record<string, string>;
  releaseNotes: { format: "markdown"; body: string } | null;
  source: "release-metadata" | "package-manifest";
}

export interface WorkflowServerHealthData {
  status: "ok";
  versions: {
    serverVersion: string | null;
    coreVersion: string | null;
  };
  currentRelease: {
    summary: string;
    body: string;
    docsUrl: string;
  } | null;
  deployment: {
    server: WorkflowServerHealthRelease | null;
    serverWeb: WorkflowServerHealthRelease | null;
  };
}

export type WorkflowPermissionKey =
  | "system.admin"
  | "users.read"
  | "users.manage"
  | "roles.read"
  | "roles.manage"
  | "api_keys.manage_self"
  | "api_keys.manage_all"
  | "projects.create"
  | "projects.read_public"
  | "projects.read_all"
  | "projects.manage_own"
  | "projects.manage_all"
  | "projects.delete"
  | "projects.upload"
  | "projects.publish"
  | "projects.download_source"
  | "storage.write"
  | "kv.read"
  | "kv.manage"
  | "knowledge.manage"
  | "audit.read"
  | "audit.export";

export type WorkflowUserProfileStatus = "invited" | "active" | "disabled";

export type WorkflowAuthPrincipalKind =
  | "admin_key"
  | "admin_session"
  | "user_session"
  | "api_key";

export interface WorkflowAuthPrincipal {
  kind: WorkflowAuthPrincipalKind;
  sessionId?: string;
  userId?: string;
  displayName?: string;
  email?: string;
  // surface avatarUrl on the session so the header avatar renders on
  // every page without waiting for the settings-page profile fetch.
  avatarUrl?: string;
  permissions?: WorkflowPermissionKey[];
  apiKeyId?: string;
  roleNames?: string[];
}

export interface AuthSessionState {
  authenticated: boolean;
  principal?: WorkflowAuthPrincipal;
}

export interface WorkflowUserProfileRecord {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  status: WorkflowUserProfileStatus;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  roleIds: string[];
  roleNames: string[];
  permissions: WorkflowPermissionKey[];
}

export interface WorkflowMeResult {
  principal?: WorkflowAuthPrincipal;
  profile: WorkflowUserProfileRecord | null;
}

export interface WorkflowApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  source: string;
  scopes: string[];
  createdByUserId?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
  lastUsedIp?: string;
  userAgent?: string;
}

export interface WorkflowApiKeyCreateResult {
  apiKey: WorkflowApiKeyRecord;
  token: string;
}

export interface WorkflowDeviceCodeResult {
  id: string;
  userCode: string;
  clientName: string;
  source: string;
  requestedScopes: string[];
  state: "pending" | "approved" | "denied" | "expired" | "consumed";
  requestedByIp?: string;
  userAgent?: string;
  expiresAt: string;
  intervalSeconds: number;
  approvedAt?: string;
  approvedByUserId?: string;
  deniedAt?: string;
  consumedAt?: string;
  result?: {
    apiKeyId?: string;
    user?: {
      userId: string;
      email: string;
      displayName: string;
    };
    expiresAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowPermissionDefinition {
  key: WorkflowPermissionKey;
  label: string;
  description: string;
  group: string;
}

export interface WorkflowPermissionGroup {
  id: string;
  label: string;
  permissions: WorkflowPermissionDefinition[];
}

export interface WorkflowRoleRecord {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  protected: boolean;
  permissions: WorkflowPermissionKey[];
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowAdminUserSummary {
  userId: string;
  email: string;
  displayName: string;
  status: WorkflowUserProfileStatus;
  lastSignInAt?: string;
  createdAt?: string;
  roles: string[];
  permissions: WorkflowPermissionKey[];
  avatarUrl?: string;
}

export interface WorkflowUserInvitationResult {
  profile: WorkflowUserProfileRecord;
  invitationLink?: string;
  temporaryPassword?: string;
}

export interface WorkflowAccountInvitation {
  email: string;
  displayName: string;
  expiresAt: string;
  acceptedAt?: string;
}

export interface WorkflowAccountInvitationLookupResult {
  invitation: WorkflowAccountInvitation;
}
export type WorkflowProjectType = SharedWorkflowProjectType;
export type ProjectCardIconName =
  | "workflow"
  | "message-circle"
  | "bot"
  | "sparkles"
  | "code"
  | "git-branch"
  | "boxes"
  | "zap"
  | "database"
  | "file-text"
  | "cpu"
  | "brain";

export interface ProjectCardMetadata {
  icon: ProjectCardIconName;
  iconUrl?: string;
  iconColor?: string;
  iconBackgroundColor: string;
}

export interface WorkflowUserProfileSummary {
  userId: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

export interface WorkflowSummary {
  canManage?: boolean;
  canWriteData?: boolean;
  sourceDownload?: {allowed: boolean; available: boolean; target: string | null};
  id: string;
  name: string;
  projectType: WorkflowProjectType;
  projectCard: ProjectCardMetadata;
  projectInfo: WorkflowProjectInfo;
  visibility?: "private" | "public";
  ownerUserId?: string;
  createdByUserId?: string;
  createdByProfile?: WorkflowUserProfileSummary;
  createdAt?: string;
  updatedAt?: string;
  hasDraft: boolean;
  latest: string | null;
  versions: string[];
  nextVersion: string;
  invalid?: {
    message: string;
  };
}

export interface VersionEntry {
  version: string;
  downloadCount: number;
  createdAt?: string;
  createdByUserId?: string;
  createdByProfile?: WorkflowUserProfileSummary;
  releaseLog?: string;
  sourceHash?: string;
  dependencies: WorkflowProjectDependencyLock[];
  latest: boolean;
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
  versions: VersionEntry[];
}

export interface WorkflowProjectSourceAccessSummary {
  requests: WorkflowProjectAccessRequest[];
  grants: WorkflowProjectCapabilityGrant[];
}

export interface WorkflowProjectAccessLinkInfo {
  projectId: string;
  projectName: string;
}


export type WorkflowKVEntryScope = "project" | "conversation";
export type WorkflowKVEntryValueType = "null" | "array" | "object" | "string" | "number" | "boolean";

export interface WorkflowKVEntrySummary {
  storageKind: "kv" | "persistent_value";
  scope: WorkflowKVEntryScope;
  key: string;
  // KV list APIs omit full values; row expansion fetches details.
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

export type WorkflowAuditOutcome = "success" | "failed" | "denied";

export interface WorkflowAuditEventRecord {
  id: string;
  actorUserId?: string;
  actorProfileId?: string;
  actorProfile?: WorkflowUserProfileSummary;
  actorDisplayName?: string;
  principalKind: string;
  eventType: string;
  resourceType?: string;
  resourceId?: string;
  outcome: WorkflowAuditOutcome;
  requestIp?: string;
  userAgent?: string;
  context: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowAuditEventPage {
  items: WorkflowAuditEventRecord[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface WorkflowKVEntryPage {
  items: WorkflowKVEntrySummary[];
  nextCursor?: string;
  hasMore: boolean;
  // Keys displays the server-side filtered total instead of visible rows.
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

export interface WorkflowKnowledgeDocumentSummary {
  id: string;
  title: string;
  markdownPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowKnowledgeDocumentPage {
  items: WorkflowKnowledgeDocumentSummary[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface WorkflowKnowledgeDocument {
  id: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowKnowledgeSearchLine {
  lineNumber: number;
  content: string;
}

export interface WorkflowKnowledgeSearchMatch {
  documentId: string;
  title: string;
  lineNumber: number;
  line: string;
  before: WorkflowKnowledgeSearchLine[];
  after: WorkflowKnowledgeSearchLine[];
}

export interface WorkflowKnowledgeSearchResult {
  query: string;
  documentsSearched: number;
  totalMatches: number;
  matchesTruncated: boolean;
  maxMatches: number;
  pageSize: number;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  matches: WorkflowKnowledgeSearchMatch[];
}

export interface WorkflowKnowledgeDocumentLinesResult {
  documentId: string;
  title: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: WorkflowKnowledgeSearchLine[];
}




export type WorkflowProjectRole = "owner" | "manager" | "writer" | "viewer";
export type WorkflowInvitationRole = "manager" | "writer" | "viewer";

export interface WorkflowProjectMember {
  workflowId: string;
  userId: string;
  profile?: WorkflowUserProfileSummary;
  role: WorkflowProjectRole;
  createdBy?: string;
  createdByProfile?: WorkflowUserProfileSummary;
  createdAt: string;
}

export interface WorkflowProjectInvitation {
  id: string;
  workflowId: string;
  token: string;
  role: WorkflowInvitationRole;
  createdBy?: string;
  createdByProfile?: WorkflowUserProfileSummary;
  createdAt: string;
  expiresAt: string;
  acceptedBy?: string;
  acceptedByProfile?: WorkflowUserProfileSummary;
  acceptedAt?: string;
  revokedAt?: string;
}

export interface WorkflowInvitationLookupResult {
  invitation: WorkflowProjectInvitation;
  project: { id: string; name: string };
}

export interface WorkflowInvitationAcceptResult {
  invitation: WorkflowProjectInvitation;
  member: WorkflowProjectMember;
}
