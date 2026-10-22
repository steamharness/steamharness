import type { ResourceAccess, AccessPage, ProjectRole as FixedProjectRole } from "@steamharness/project-access";
export type { ResourceAccess, AccessPage };

import type { ProjectKind as SharedProjectKind } from "@steamharness/project-types";
import type { ProjectInfoContract, RelatedProject, RelatedProjectKVGrant } from "@steamharness/project-info";
import type { ProjectAccessRequest, ProjectDependencyLock, ProjectDependencyStatusResult } from "@steamharness/project-dependencies";

export type {
  ProjectAccessRequest,

  ProjectDependencyLock,
  ProjectDependencyStatusResult,
};

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

export interface ServerHealthRelease {
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

export interface ServerHealthData {
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
    server: ServerHealthRelease | null;
    serverWeb: ServerHealthRelease | null;
  };
}

export type UserProfileStatus = "invited" | "active" | "disabled";

export type AuthPrincipalKind =
  | "admin_key"
  | "admin_session"
  | "user_session"
  | "api_key";

export interface AuthPrincipal {
  kind: AuthPrincipalKind;
  sessionId?: string;
  userId?: string;
  displayName?: string;
  email?: string;
  // surface avatarUrl on the session so the header avatar renders on
  // every page without waiting for the settings-page profile fetch.
  avatarUrl?: string;
  apiKeyId?: string;
  isSystemAdmin?: boolean;
}

export interface AuthSessionState {
  authenticated: boolean;
  principal?: AuthPrincipal;
}

export interface UserProfileRecord {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  status: UserProfileStatus;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  isSystemAdmin: boolean;
}

export interface MeResult {
  principal?: AuthPrincipal;
  profile: UserProfileRecord | null;
}

export interface ApiKeyRecord {
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

export interface ApiKeyCreateResult {
  apiKey: ApiKeyRecord;
  token: string;
}

export interface DeviceCodeResult {
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

export interface AdminUserSummary {
  userId: string;
  email: string;
  displayName: string;
  status: UserProfileStatus;
  lastSignInAt?: string;
  createdAt?: string;
  isSystemAdmin: boolean;
  avatarUrl?: string;
}

export interface UserInvitationResult {
  profile: UserProfileRecord;
  invitationLink?: string;
  temporaryPassword?: string;
}

export interface AccountInvitation {
  email: string;
  displayName: string;
  expiresAt: string;
  acceptedAt?: string;
}

export interface AccountInvitationLookupResult {
  invitation: AccountInvitation;
}
export type ProjectKind = SharedProjectKind;
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

export interface UserProfileSummary {
  userId: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

export interface Summary {
  access?: ResourceAccess;
  groupId?: string | null;
  sourceDownload?: {allowed: boolean; available: boolean; target: string | null};
  id: string;
  name: string;
  projectType: ProjectKind;
  projectCard: ProjectCardMetadata;
  projectInfo: ProjectInfoContract;
  visibility?: "private" | "public";
  ownerUserId?: string;
  createdByUserId?: string;
  createdByProfile?: UserProfileSummary;
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
  createdByProfile?: UserProfileSummary;
  releaseLog?: string;
  sourceHash?: string;
  dependencies: ProjectDependencyLock[];
  latest: boolean;
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
  versions: VersionEntry[];
}

export interface ProjectSourceAccessSummary {
  requests: ProjectAccessRequest[];
}

export interface ProjectAccessLinkInfo {
  projectId: string;
  projectName: string;
}


export type KVEntryScope = "project" | "conversation";
export type KVEntryValueType = "null" | "array" | "object" | "string" | "number" | "boolean";

export interface KVEntrySummary {
  storageKind: "kv" | "persistent_value";
  scope: KVEntryScope;
  key: string;
  // KV list APIs omit full values; row expansion fetches details.
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

export type AuditOutcome = "success" | "failed" | "denied";

export interface AuditEventRecord {
  id: string;
  actorUserId?: string;
  actorProfileId?: string;
  actorProfile?: UserProfileSummary;
  actorDisplayName?: string;
  principalKind: string;
  eventType: string;
  resourceType?: string;
  resourceId?: string;
  outcome: AuditOutcome;
  requestIp?: string;
  userAgent?: string;
  context: Record<string, unknown>;
  createdAt: string;
}

export interface AuditEventPage {
  items: AuditEventRecord[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface KVEntryPage {
  items: KVEntrySummary[];
  nextCursor?: string;
  hasMore: boolean;
  // Keys displays the server-side filtered total instead of visible rows.
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

export interface KnowledgeDocumentSummaryRecord {
  id: string;
  title: string;
  markdownPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocumentPageRecord {
  items: KnowledgeDocumentSummaryRecord[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSearchLine {
  lineNumber: number;
  content: string;
}

export interface KnowledgeSearchMatch {
  documentId: string;
  title: string;
  lineNumber: number;
  line: string;
  before: KnowledgeSearchLine[];
  after: KnowledgeSearchLine[];
}

export interface KnowledgeSearchResultRecord {
  query: string;
  documentsSearched: number;
  totalMatches: number;
  matchesTruncated: boolean;
  maxMatches: number;
  pageSize: number;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  matches: KnowledgeSearchMatch[];
}

export interface KnowledgeDocumentLinesResult {
  documentId: string;
  title: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: KnowledgeSearchLine[];
}




export type ProjectRole = FixedProjectRole;
export type InvitationRole = FixedProjectRole;

export interface ProjectMember {
  directRole?: ProjectRole;
  access: ResourceAccess;
  projectId: string;
  userId: string;
  profile?: UserProfileSummary;
  role: ProjectRole;
  createdBy?: string;
  createdByProfile?: UserProfileSummary;
  createdAt: string;
}

export interface ProjectInvitation {
  id: string;
  projectId: string;
  resourceType?: "project" | "group";
  resourceId?: string;
  token: string;
  role: InvitationRole;
  createdBy?: string;
  createdByProfile?: UserProfileSummary;
  createdAt: string;
  expiresAt: string;
  acceptedBy?: string;
  acceptedByProfile?: UserProfileSummary;
  acceptedAt?: string;
  revokedAt?: string;
}

export interface InvitationLookupResult {
  invitation: ProjectInvitation;
  project: { id: string; name: string };
}

export interface InvitationAcceptResult {
  invitation: ProjectInvitation;
  member?: ProjectMember;
}

export interface ProjectGroup { id:string; name:string; description:string; parentId:string|null; createdAt:string; access:ResourceAccess }
