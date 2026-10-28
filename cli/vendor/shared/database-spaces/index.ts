/** Portable database contracts. Credentials never belong in a project manifest. */
export type DatabaseHost = "local" | "server";
export type DatabaseAccessRule =
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "prefixes"; prefixes: string[] };

export interface DatabasePermissions {
  kv: { read: DatabaseAccessRule; write: DatabaseAccessRule };
  knowledge: { read: DatabaseAccessRule; write: DatabaseAccessRule };
}

export interface DatabaseConsumer { projectId: string; entryId: string }

export interface DatabaseRequirement {
  alias: string;
  host: DatabaseHost;
  description?: string;
  permissions: DatabasePermissions;
  bindingRef?: string;
}

export interface DatabaseSpace {
  spaceId: string;
  name: string;
  host: DatabaseHost;
  ownerId: string;
  createdAt: string;
}

export interface DatabaseRequest extends DatabaseConsumer {
  requestId: string;
  host: DatabaseHost;
  alias: string;
  applicantId: string;
  target: { kind: "create"; name: string } | { kind: "access"; spaceId: string };
  permissions: DatabasePermissions;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt?: string;
  reviewerId?: string;
  reason?: string;
  bindingRef?: string;
}

export interface DatabaseGrant extends DatabaseConsumer {
  grantId: string;
  spaceId: string;
  permissions: DatabasePermissions;
  credentialVersion: number;
  createdAt: string;
  revokedAt?: string;
}

export interface DatabaseBinding extends DatabaseConsumer {
  bindingRef: string;
  alias: string;
  host: DatabaseHost;
  spaceId: string;
  grantId: string;
}

export interface DatabaseActor { userId: string; isSystemAdmin: boolean }
export interface DatabaseAuthorization {
  space: DatabaseSpace;
  grant: DatabaseGrant;
  binding: DatabaseBinding;
}

export const DATABASE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DatabaseAccessError extends Error {
  constructor(public readonly code: "DATABASE_UNBOUND" | "DATABASE_ACCESS_DENIED" | "DATABASE_GRANT_REVOKED" | "DATABASE_BINDING_MISMATCH", message: string) {
    super(message);
    this.name = "DatabaseAccessError";
  }
}

export function emptyDatabasePermissions(): DatabasePermissions {
  return { kv: { read: { mode: "none" }, write: { mode: "none" } }, knowledge: { read: { mode: "none" }, write: { mode: "none" } } };
}

export function normalizeDatabasePermissions(value: unknown, field = "permissions"): DatabasePermissions {
  const input = object(value, field);
  exact(input, ["kv", "knowledge"], field);
  const resource = (name: "kv" | "knowledge") => {
    const item = object(input[name], `${field}.${name}`);
    exact(item, ["read", "write"], `${field}.${name}`);
    return { read: normalizeDatabaseAccessRule(item.read, `${field}.${name}.read`), write: normalizeDatabaseAccessRule(item.write, `${field}.${name}.write`) };
  };
  return { kv: resource("kv"), knowledge: resource("knowledge") };
}

export function normalizeDatabaseAccessRule(value: unknown, field = "access"): DatabaseAccessRule {
  const input = object(value, field);
  if (input.mode === "none" || input.mode === "all") {
    exact(input, ["mode"], field);
    return { mode: input.mode };
  }
  exact(input, ["mode", "prefixes"], field);
  if (input.mode !== "prefixes" || !Array.isArray(input.prefixes) || !input.prefixes.length || input.prefixes.length > 32) throw new Error(`${field} must declare none, all, or 1–32 prefixes.`);
  const prefixes = input.prefixes.map((prefix) => {
    if (typeof prefix !== "string" || !prefix.length || prefix.length > 1024 || prefix.includes("\0")) throw new Error(`${field} contains an invalid prefix.`);
    return prefix;
  });
  if (new Set(prefixes).size !== prefixes.length) throw new Error(`${field} contains duplicate prefixes.`);
  return { mode: "prefixes", prefixes };
}

export function normalizeDatabaseRequirement(value: unknown, field = "database"): DatabaseRequirement {
  const input = object(value, field);
  exact(input, ["alias", "host", "description", "permissions", "bindingRef"], field);
  if (typeof input.alias !== "string" || !DATABASE_IDENTIFIER_PATTERN.test(input.alias)) throw new Error(`${field}.alias must be an identifier.`);
  if (input.host !== "local" && input.host !== "server") throw new Error(`${field}.host must explicitly be local or server.`);
  if (input.bindingRef !== undefined && (typeof input.bindingRef !== "string" || !DATABASE_UUID_PATTERN.test(input.bindingRef))) throw new Error(`${field}.bindingRef must be a UUID.`);
  if (input.description !== undefined && (typeof input.description !== "string" || !input.description.trim() || input.description.length > 4096)) throw new Error(`${field}.description is invalid.`);
  return { alias: input.alias, host: input.host, permissions: normalizeDatabasePermissions(input.permissions, `${field}.permissions`), ...(input.description === undefined ? {} : { description: input.description as string }), ...(input.bindingRef === undefined ? {} : { bindingRef: input.bindingRef as string }) };
}

export function databaseRuleAllows(rule: DatabaseAccessRule, key: string): boolean {
  return rule.mode === "all" || (rule.mode === "prefixes" && rule.prefixes.some((prefix) => key.startsWith(prefix)));
}

/** Approval may only remove capabilities; prefixes may become more specific. */
export function isDatabasePermissionSubset(approved: DatabasePermissions, requested: DatabasePermissions): boolean {
  const subset = (a: DatabaseAccessRule, b: DatabaseAccessRule) => a.mode === "none" || b.mode === "all" || (a.mode === "prefixes" && b.mode === "prefixes" && a.prefixes.every((prefix) => b.prefixes.some((parent) => prefix.startsWith(parent))));
  return (["kv", "knowledge"] as const).every((resource) => (["read", "write"] as const).every((operation) => subset(approved[resource][operation], requested[resource][operation])));
}

export function assertDatabaseAuthorization(authorization: DatabaseAuthorization | undefined, consumer: DatabaseConsumer & { host: DatabaseHost; alias: string; bindingRef?: string }, resource: "kv" | "knowledge", operation: "read" | "write", key: string, credentialVersion?: number): asserts authorization is DatabaseAuthorization {
  if (!consumer.bindingRef || !authorization) throw new DatabaseAccessError("DATABASE_UNBOUND", `Database "${consumer.alias}" requires an approved binding.`);
  const { binding, grant, space } = authorization;
  if (binding.bindingRef !== consumer.bindingRef || binding.projectId !== consumer.projectId || binding.entryId !== consumer.entryId || binding.alias !== consumer.alias || binding.host !== consumer.host || space.host !== consumer.host || binding.grantId !== grant.grantId || binding.spaceId !== space.spaceId || grant.spaceId !== space.spaceId || grant.projectId !== consumer.projectId || grant.entryId !== consumer.entryId) throw new DatabaseAccessError("DATABASE_BINDING_MISMATCH", `Database "${consumer.alias}" is bound to a different consumer or host.`);
  if (grant.revokedAt || (credentialVersion !== undefined && credentialVersion !== grant.credentialVersion)) throw new DatabaseAccessError("DATABASE_GRANT_REVOKED", `Database "${consumer.alias}" authorization is no longer valid.`);
  if (!databaseRuleAllows(grant.permissions[resource][operation], key)) throw new DatabaseAccessError("DATABASE_ACCESS_DENIED", `Database "${consumer.alias}" does not allow ${resource} ${operation} for "${key}".`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[], field: string): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error(`${field} contains unsupported fields.`);
}
