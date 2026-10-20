
import type { AdminUserSummary, AuditEventPage, ApiKeyRecord, KVEntryPage, MeResult, PermissionGroup, ProjectDataSummary, ProjectMember, ProjectInvitation, RoleRecord, VersionSummary } from "./types";

export type SessionState =
  | { status: "checking" }
  | { status: "anonymous"; message?: string }
  | {
      status: "ready";
      principal: {
        kind: "admin_key" | "admin_session" | "user_session" | "api_key";
        sessionId?: string;
        userId?: string;
        displayName?: string;
        email?: string;
        // surface avatarUrl on the session so the header avatar
        // renders on every page without waiting for the settings-page fetch.
        avatarUrl?: string;
        permissions?: string[];
        apiKeyId?: string;
        roleNames?: string[];
      };
    };

export type DetailTab = "configurations" | "project" | "settings" | "members" | "invitations" | "dependencies" | "knowledge" | "versions" | "kv";

export type AdminTab = "users" | "roles" | "audit";
export type SettingsTab = "profile" | "appearance" | "api-keys";
export type Page = "login" | "device" | "projects" | "settings" | "admin" | "detail" | "invite" | "account-invite" | "access-request" | "source-share";
export type ThemeMode = "light" | "dark" | "system";

export type AppRoute =
  | { page: "login" }
  | { page: "device"; userCode?: string }
  | { page: "projects" }
  | { page: "settings"; tab: SettingsTab }
  | { page: "admin"; tab: AdminTab }
  | { page: "detail"; id: string; tab: DetailTab; }
  | { page: "invite"; token: string }
  | { page: "account-invite"; token: string }
  | { page: "access-request"; token: string }
  | { page: "source-share"; id: string; version: string }

export type AsyncState = {
  global?: string;
  project?: string;
  kv?: string;
  version?: string;
  account?: string;
  apiKeys?: string;
  audit?: string;
  device?: string;
  users?: string;
  inviteUser?: string;
  updateUser?: string;
  roles?: string;
  saveRole?: string;
  saveProfile?: string;
  createKeyBusy?: string;
  revokeKeyId?: string;
  updateBusyUserId?: string;
  deleteRoleId?: string;
  invitation?: string;
  revokeInvitationId?: string;
};

export type DetailState = {
  versions: VersionSummary | null;
  members: ProjectMember[] | null;
  invitations: ProjectInvitation[] | null;
  kv: KVEntryPage | null;
  dataSummary?: ProjectDataSummary | null;
  loadErrors?: Partial<Record<"versions" | "members" | "invitations" | "dataSummary", string>>;
};

export const THEME_STORAGE_KEY = "steamharness-server-admin:theme";

export const LOCALE_STORAGE_KEY = "steamharness-server-admin:locale";

export const DEFAULT_DETAIL: DetailState = {
  versions: null,
  members: null,
  invitations: null,
  kv: null,
  dataSummary: null,
  loadErrors: {},
};

export interface AccountViewState {
  me: MeResult | null;
  apiKeys: ApiKeyRecord[] | null;
}

export interface AdminUsersState {
  items: AdminUserSummary[] | null;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
  status: string;
}

export interface AdminRolesState {
  items: RoleRecord[] | null;
  groups: PermissionGroup[] | null;
}

export interface AuditFilters {
  from: string;
  to: string;
  actorUserId: string;
  principalKind: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  outcome: "all" | "success" | "failed" | "denied";
}

export interface AuditViewState {
  page: AuditEventPage | null;
  selectedEventId: string | null;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  from: "",
  to: "",
  actorUserId: "",
  principalKind: "",
  eventType: "",
  resourceType: "",
  resourceId: "",
  outcome: "all",
};
