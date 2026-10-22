export const PROJECT_ROLES = [
  "guest",
  "developer",
  "maintainer",
  "owner",
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export type ResourceType = "project" | "group";
export type AccessCapability =
  | "read"
  | "downloadSource"
  | "readDraft"
  | "upload"
  | "publish"
  | "writeData"
  | "manageSettings"
  | "manageMembers"
  | "manageOwners"
  | "transfer"
  | "delete"
  | "createProject"
  | "createSubgroup";
export interface AccessSource {
  type: ResourceType | "public" | "system";
  id: string;
  name?: string;
  role: ProjectRole;
}
export interface ResourceAccess {
  effectiveRole: ProjectRole | null;
  sources: AccessSource[];
  capabilities: AccessCapability[];
}
export interface AccessActor {
  userId?: string;
  isSystemAdmin: boolean;
}
export interface AccessPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export const ROLE_RANK: Readonly<Record<ProjectRole, number>> = {
  guest: 10,
  developer: 20,
  maintainer: 30,
  owner: 40,
};
export const CAPABILITY_ROLE: Readonly<Record<AccessCapability, ProjectRole>> =
  {
    read: "guest",
    downloadSource: "guest",
    readDraft: "developer",
    upload: "developer",
    publish: "developer",
    writeData: "developer",
    manageSettings: "maintainer",
    manageMembers: "maintainer",
    manageOwners: "owner",
    transfer: "owner",
    delete: "owner",
    createProject: "developer",
    createSubgroup: "maintainer",
  };
export function isProjectRole(value: unknown): value is ProjectRole {
  return (
    typeof value === "string" && PROJECT_ROLES.includes(value as ProjectRole)
  );
}
export function roleAtLeast(
  role: ProjectRole | null | undefined,
  minimum: ProjectRole,
): boolean {
  return role != null && ROLE_RANK[role] >= ROLE_RANK[minimum];
}
export function resolveResourceAccess(
  sources: readonly AccessSource[],
  actor?: AccessActor,
): ResourceAccess {
  const all = actor?.isSystemAdmin
    ? [
        ...sources,
        { type: "system" as const, id: "system", role: "owner" as const },
      ]
    : [...sources];
  const role = all.reduce<ProjectRole | null>(
    (highest, source) =>
      !highest || ROLE_RANK[source.role] > ROLE_RANK[highest]
        ? source.role
        : highest,
    null,
  );
  return {
    effectiveRole: role,
    sources: all,
    capabilities: (Object.keys(CAPABILITY_ROLE) as AccessCapability[]).filter(
      (capability) => roleAtLeast(role, CAPABILITY_ROLE[capability]),
    ),
  };
}
export function canManageMember(
  actor: ResourceAccess,
  target: ResourceAccess,
  desiredRole?: ProjectRole,
): boolean {
  if (actor.capabilities.includes("manageOwners")) return true;
  return (
    actor.capabilities.includes("manageMembers") &&
    !roleAtLeast(target.effectiveRole, "maintainer") &&
    (desiredRole === undefined || !roleAtLeast(desiredRole, "maintainer"))
  );
}
