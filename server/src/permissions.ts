export type UserProfileStatus = "invited" | "active" | "disabled";

export type PermissionKey =
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

export interface PermissionDefinition {
  key: PermissionKey;
  label: string;
  description: string;
  group: string;
}

export interface PermissionGroup {
  id: string;
  label: string;
  permissions: PermissionDefinition[];
}

export interface BuiltinRoleDefinition {
  id: string;
  name: string;
  description: string;
  builtin: true;
  protected: boolean;
  permissions: PermissionKey[];
}

const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { key: "system.admin", label: "系统管理员", description: "拥有系统全部权限并用于恢复兜底。", group: "system" },
  { key: "users.read", label: "查看用户", description: "读取用户列表与用户状态。", group: "identity" },
  { key: "users.manage", label: "管理用户", description: "邀请、启用、禁用用户并分配角色。", group: "identity" },
  { key: "roles.read", label: "查看角色", description: "读取角色与权限配置。", group: "identity" },
  { key: "roles.manage", label: "管理角色", description: "创建、编辑、删除自定义角色。", group: "identity" },
  { key: "api_keys.manage_self", label: "管理自己的 API Key", description: "创建和撤销自己的 API Key。", group: "identity" },
  { key: "api_keys.manage_all", label: "管理全部 API Key", description: "查看和管理所有用户的 API Key。", group: "identity" },
  { key: "projects.create", label: "创建项目", description: "初始化新 workflow 项目。", group: "projects" },
  { key: "projects.read_public", label: "读取公开项目", description: "读取公开项目或公开信息。", group: "projects" },
  { key: "projects.read_all", label: "读取全部项目", description: "查看项目列表、详情和版本。", group: "projects" },
  { key: "projects.manage_own", label: "管理自己的项目", description: "管理自己拥有的项目。", group: "projects" },
  { key: "projects.manage_all", label: "管理全部项目", description: "编辑项目信息、草稿和配置。", group: "projects" },
  { key: "projects.delete", label: "删除项目", description: "删除 workflow 项目。", group: "projects" },
  { key: "projects.upload", label: "上传项目", description: "上传或覆盖 workflow 包。", group: "projects" },
  { key: "projects.publish", label: "发布项目", description: "发布并切换项目版本。", group: "projects" },
  { key: "projects.download_source", label: "下载项目源码", description: "下载保留原始源码的已发布项目版本。", group: "projects" },
  { key: "storage.write", label: "写入项目数据", description: "写入获授权项目的 KV、知识库与文件。", group: "configuration" },
  { key: "kv.read", label: "读取 KV", description: "查看全局或项目 KV 数据。", group: "configuration" },
  { key: "kv.manage", label: "管理 KV", description: "删除项目或会话的 KV 数据。", group: "configuration" },
  { key: "knowledge.manage", label: "管理知识库", description: "管理项目知识库文档与 PersistentValue 写入。", group: "configuration" },
  { key: "audit.read", label: "查看审计日志", description: "读取审计事件。", group: "operations" },
  { key: "audit.export", label: "导出审计日志", description: "导出审计事件，预留给后续阶段。", group: "operations" },
];

const PERMISSION_GROUP_LABELS: Record<string, string> = {
  system: "系统",
  identity: "用户与角色",
  projects: "项目",
  configuration: "配置",
  operations: "运维与审计",
};

export const ALL_STEAMHARNESS_PERMISSION_KEYS: PermissionKey[] = PERMISSION_DEFINITIONS.map(
  (definition) => definition.key,
);

export const BUILTIN_STEAMHARNESS_ROLES: BuiltinRoleDefinition[] = [
  {
    id: "builtin_admin",
    name: "Admin",
    description: "系统管理员，拥有全部权限。",
    builtin: true,
    protected: true,
    permissions: [...ALL_STEAMHARNESS_PERMISSION_KEYS],
  },
  {
    id: "builtin_developer",
    name: "Developer",
    description: "面向开发者的全局角色，可创建、上传、发布项目和管理数据。",
    builtin: true,
    protected: true,
    permissions: [
      "projects.create",
      "projects.read_all",
      "projects.manage_all",
      "projects.upload",
      "projects.publish",
      "projects.download_source",
      "storage.write",
      "knowledge.manage",
      "kv.read",
      "kv.manage",
    ],
  },
  {
    id: "builtin_operator",
    name: "Operator",
    description: "面向数据管理的角色，可读取项目并管理数据。",
    builtin: true,
    protected: true,
    permissions: [
      "projects.read_all",
      "storage.write",
      "kv.read",
    ],
  },
  {
    id: "builtin_viewer",
    name: "Viewer",
    description: "基础登录角色，可创建项目并读取公开项目。",
    builtin: true,
    protected: true,
    permissions: [
      "projects.create",
      "projects.read_public",
      "api_keys.manage_self",
    ],
  },
];

// 私有项目访问与数据写入由项目成员关系决定。
export const DEFAULT_AUTHENTICATED_PERMISSION_KEYS: PermissionKey[] = [
  "api_keys.manage_self",
  "projects.create",
  "projects.read_public",
];

const PERMISSION_KEY_SET = new Set<PermissionKey>(ALL_STEAMHARNESS_PERMISSION_KEYS);

export function isWorkflowPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value as PermissionKey);
}

export function listWorkflowPermissions(): PermissionDefinition[] {
  return [...PERMISSION_DEFINITIONS];
}

export function listWorkflowPermissionGroups(): PermissionGroup[] {
  return Object.entries(
    PERMISSION_DEFINITIONS.reduce<Record<string, PermissionDefinition[]>>((groups, definition) => {
      const items = groups[definition.group] ?? [];
      items.push(definition);
      groups[definition.group] = items;
      return groups;
    }, {}),
  ).map(([id, permissions]) => ({
    id,
    label: PERMISSION_GROUP_LABELS[id] ?? id,
    permissions,
  }));
}

export function normalizeWorkflowPermissionKeys(
  values: Iterable<string>,
): PermissionKey[] {
  const normalized = new Set<PermissionKey>();
  for (const value of values) {
    if (!isWorkflowPermissionKey(value)) {
      throw new Error(`Unknown workflow permission "${value}".`);
    }
    normalized.add(value);
  }
  return [...normalized].sort();
}

export function permissionImpliesAdmin(permission: PermissionKey): boolean {
  return permission === "system.admin";
}

export function listBuiltinWorkflowRoles(): BuiltinRoleDefinition[] {
  return BUILTIN_STEAMHARNESS_ROLES.map((role) => ({
    ...role,
    permissions: [...role.permissions],
  }));
}
