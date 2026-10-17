import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { createPostgresPool } from "./postgres";
import { resolveStorageAvatarBaseUrlOrigin } from "./storage-driver";
import {
  DEFAULT_AUTHENTICATED_PERMISSION_KEYS,
  listBuiltinWorkflowRoles,
  normalizeWorkflowPermissionKeys,
  type WorkflowPermissionKey,
} from "./permissions";

export type WorkflowUserProfileStatus = "invited" | "active" | "disabled";
export type WorkflowDeviceCodeState = "pending" | "approved" | "denied" | "expired" | "consumed";
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

export interface WorkflowApiKeyLookupRecord extends WorkflowApiKeyRecord {
  secretHash: string;
  user: WorkflowUserProfileRecord;
}

export interface WorkflowDeviceCodeRecord {
  id: string;
  userCode: string;
  clientName: string;
  source: string;
  requestedScopes: string[];
  state: WorkflowDeviceCodeState;
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

export interface WorkflowDeviceCodeSecretRecord extends WorkflowDeviceCodeRecord {
  deviceCodeHash: string;
}

export interface WorkflowAuditEventInput {
  actorUserId?: string;
  actorProfileId?: string;
  actorDisplayName?: string;
  principalKind: string;
  eventType: string;
  resourceType?: string;
  resourceId?: string;
  outcome: "success" | "failed" | "denied";
  requestIp?: string;
  userAgent?: string;
  context?: Record<string, unknown>;
}

export interface WorkflowAuditEventRecord extends WorkflowAuditEventInput {
  id: string;
  actorProfile?: {
    userId: string;
    displayName: string;
    email?: string;
    avatarUrl?: string;
  };
  createdAt: string;
}

export interface WorkflowAuditEventPage {
  items: WorkflowAuditEventRecord[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface WorkflowAuthUserRecord {
  userId: string;
  email: string;
  displayName: string;
  createdAt: string;
  lastSignInAt?: string;
}

export interface WorkflowAuditEventListOptions {
  pageSize?: number;
  cursor?: string;
  from?: string;
  to?: string;
  actorUserId?: string;
  principalKind?: string;
  eventType?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: WorkflowAuditEventInput["outcome"];
}

interface WorkflowUserProfileRow {
  user_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  status: string;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

interface WorkflowRoleRow {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  protected: boolean;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowRolePermissionRow {
  role_id: string;
  permission_key: string;
}

interface WorkflowUserRoleRow {
  user_id: string;
  role_id: string;
  role_name: string;
}

interface WorkflowApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  source: string;
  scopes: unknown;
  created_by_user_id: string | null;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  last_used_ip: string | null;
  user_agent: string | null;
}

interface WorkflowDeviceCodeRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  client_name: string;
  source: string;
  requested_scopes: unknown;
  state: string;
  requested_by_ip: string | null;
  user_agent: string | null;
  expires_at: Date;
  interval_seconds: number;
  approved_at: Date | null;
  approved_by_user_id: string | null;
  denied_at: Date | null;
  consumed_at: Date | null;
  result: unknown;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowAuditEventRow {
  id: string;
  actor_user_id: string | null;
  actor_profile_id: string | null;
  actor_display_name: string | null;
  principal_kind: string;
  event_type: string;
  resource_type: string | null;
  resource_id: string | null;
  outcome: string;
  request_ip: string | null;
  user_agent: string | null;
  context: unknown;
  created_at: Date;
}

interface WorkflowAuthUserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
  last_sign_in_at: Date | null;
}


export class AccountRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPostgresPool({
      connectionString,
      label: "workflow account",
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async init(): Promise<void> {
    await this.pool.query(`
      create table if not exists workflow_user_profiles (
        user_id text primary key,
        email text not null,
        display_name text not null default '',
        avatar_url text,
        status text not null default 'invited',
        created_by_user_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        last_login_at timestamptz
      );

      alter table workflow_user_profiles
        add column if not exists avatar_url text;

      create unique index if not exists workflow_user_profiles_email_idx
        on workflow_user_profiles (lower(email));

      create table if not exists workflow_api_keys (
        id text primary key,
        user_id text not null references workflow_user_profiles(user_id) on delete cascade,
        name text not null,
        prefix text not null,
        secret_hash text not null,
        source text not null default 'manual',
        scopes jsonb not null default '[]'::jsonb,
        created_by_user_id text,
        created_at timestamptz not null default now(),
        expires_at timestamptz,
        revoked_at timestamptz,
        last_used_at timestamptz,
        last_used_ip text,
        user_agent text
      );

      create index if not exists workflow_api_keys_user_idx
        on workflow_api_keys(user_id, created_at desc);
      create index if not exists workflow_api_keys_prefix_idx
        on workflow_api_keys(prefix);

      create table if not exists workflow_auth_device_codes (
        id text primary key,
        device_code_hash text not null unique,
        user_code text not null unique,
        client_name text not null,
        source text not null default 'cli',
        requested_scopes jsonb not null default '[]'::jsonb,
        state text not null default 'pending',
        requested_by_ip text,
        user_agent text,
        expires_at timestamptz not null,
        interval_seconds integer not null default 5,
        approved_at timestamptz,
        approved_by_user_id text,
        denied_at timestamptz,
        consumed_at timestamptz,
        result jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists workflow_auth_device_codes_state_idx
        on workflow_auth_device_codes(state, expires_at desc);

      create table if not exists workflow_audit_events (
        id text primary key,
        actor_user_id text,
        actor_profile_id text,
        actor_display_name text,
        principal_kind text not null,
        event_type text not null,
        resource_type text,
        resource_id text,
        outcome text not null,
        request_ip text,
        user_agent text,
        context jsonb,
        created_at timestamptz not null default now()
      );

      create index if not exists workflow_audit_events_created_at_idx
        on workflow_audit_events(created_at desc);

      create table if not exists workflow_roles (
        id text primary key,
        name text not null unique,
        description text not null default '',
        builtin boolean not null default false,
        protected boolean not null default false,
        created_by_user_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists workflow_role_permissions (
        role_id text not null references workflow_roles(id) on delete cascade,
        permission_key text not null,
        primary key (role_id, permission_key)
      );

      create table if not exists workflow_user_roles (
        user_id text not null references workflow_user_profiles(user_id) on delete cascade,
        role_id text not null references workflow_roles(id) on delete cascade,
        primary key (user_id, role_id)
      );

    `);

    await this.ensureBuiltinRoles();
  }

  async upsertUserProfile(input: {
    userId: string;
    email: string;
    displayName?: string;
    status?: WorkflowUserProfileStatus;
    createdByUserId?: string;
    lastLoginAt?: string;
  }): Promise<WorkflowUserProfileRecord> {
    const displayName = normalizeDisplayName(input.displayName, input.email);
    await this.pool.query(
      `insert into workflow_user_profiles (
         user_id, email, display_name, status, created_by_user_id, created_at, updated_at, last_login_at
       )
       values ($1, $2, $3, $4, $5, now(), now(), $6)
       on conflict (user_id) do update set
         email = excluded.email,
         display_name = excluded.display_name,
         status = excluded.status,
         updated_at = now(),
         last_login_at = coalesce(excluded.last_login_at, workflow_user_profiles.last_login_at)`,
      [
        input.userId,
        input.email.trim().toLowerCase(),
        displayName,
        input.status ?? "active",
        input.createdByUserId ?? null,
        input.lastLoginAt ?? null,
      ],
    );
    return this.getUserProfileOrThrow(input.userId);
  }

  async getUserProfile(userId: string): Promise<WorkflowUserProfileRecord | undefined> {
    const row = await this.readProfileRow(userId);
    if (row === undefined) {
      return undefined;
    }
    return this.inflateProfiles([row]).then((profiles) => profiles[0]);
  }

  async getUserProfilesByIds(userIds: string[]): Promise<Map<string, WorkflowUserProfileRecord>> {
    // project tables need uploader summaries without issuing one query per row.
    const normalizedUserIds = [...new Set(userIds.filter((userId) => typeof userId === "string" && userId.trim() !== ""))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }
    const result = await this.pool.query<WorkflowUserProfileRow>(
      `select user_id, email, display_name, status, created_by_user_id, created_at, updated_at, last_login_at
      , avatar_url
       from workflow_user_profiles
       where user_id = any($1::text[])
       order by user_id asc`,
      [normalizedUserIds],
    );
    const profiles = await this.inflateProfiles(result.rows);
    return new Map(profiles.map((profile) => [profile.userId, profile]));
  }

  async getUserProfileOrThrow(userId: string): Promise<WorkflowUserProfileRecord> {
    const profile = await this.getUserProfile(userId);
    if (profile === undefined) {
      throw new Error(`User profile "${userId}" not found.`);
    }
    return profile;
  }

  async listUserProfiles(options?: {
    query?: string;
    status?: WorkflowUserProfileStatus;
  }): Promise<WorkflowUserProfileRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];

    if (options?.query) {
      params.push(`%${options.query.trim().toLowerCase()}%`);
      where.push(`(lower(email) like $${params.length} or lower(display_name) like $${params.length})`);
    }
    if (options?.status) {
      params.push(options.status);
      where.push(`status = $${params.length}`);
    }

    const result = await this.pool.query<WorkflowUserProfileRow>(
      `select user_id, email, display_name, status, created_by_user_id, created_at, updated_at, last_login_at
      , avatar_url
       from workflow_user_profiles
       ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
       order by created_at desc, user_id asc`,
      params,
    );
    return this.inflateProfiles(result.rows);
  }

  async updateUserProfile(
    userId: string,
    patch: {
      displayName?: string;
      avatarUrl?: string | null;
      status?: WorkflowUserProfileStatus;
      lastLoginAt?: string | null;
    },
  ): Promise<WorkflowUserProfileRecord> {
    const updates: string[] = [];
    const params: unknown[] = [userId];

    if (patch.displayName !== undefined) {
      params.push(normalizeDisplayName(patch.displayName, userId));
      updates.push(`display_name = $${params.length}`);
    }
    if (patch.avatarUrl !== undefined) {
      params.push(normalizeAvatarUrl(patch.avatarUrl));
      updates.push(`avatar_url = $${params.length}`);
    }
    if (patch.status !== undefined) {
      params.push(patch.status);
      updates.push(`status = $${params.length}`);
    }
    if (patch.lastLoginAt !== undefined) {
      params.push(patch.lastLoginAt);
      updates.push(`last_login_at = $${params.length}`);
    }

    if (updates.length > 0) {
      await this.pool.query(
        `update workflow_user_profiles
         set ${updates.join(", ")}, updated_at = now()
         where user_id = $1`,
        params,
      );
    }

    return this.getUserProfileOrThrow(userId);
  }

  async listRoles(): Promise<WorkflowRoleRecord[]> {
    const roles = await this.readRoleRows();
    const permissions = await this.readRolePermissions();
    return roles.map((row) => toRoleRecord(row, permissions.get(row.id) ?? []));
  }

  async getRole(roleId: string): Promise<WorkflowRoleRecord | undefined> {
    const result = await this.pool.query<WorkflowRoleRow>(
      `select id, name, description, builtin, protected, created_by_user_id, created_at, updated_at
       from workflow_roles
       where id = $1`,
      [roleId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const permissions = await this.readRolePermissions([roleId]);
    return toRoleRecord(row, permissions.get(roleId) ?? []);
  }

  async createRole(input: {
    name: string;
    description?: string;
    permissions: WorkflowPermissionKey[];
    createdByUserId?: string;
  }): Promise<WorkflowRoleRecord> {
    const roleId = randomUUID();
    const permissions = normalizeWorkflowPermissionKeys(input.permissions);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into workflow_roles (
           id, name, description, builtin, protected, created_by_user_id, created_at, updated_at
         )
         values ($1, $2, $3, false, false, $4, now(), now())`,
        [
          roleId,
          input.name.trim(),
          input.description?.trim() ?? "",
          input.createdByUserId ?? null,
        ],
      );
      for (const permission of permissions) {
        await client.query(
          `insert into workflow_role_permissions (role_id, permission_key)
           values ($1, $2)`,
          [roleId, permission],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return (await this.getRole(roleId))!;
  }

  async updateRole(
    roleId: string,
    input: {
      name?: string;
      description?: string;
      permissions?: WorkflowPermissionKey[];
    },
  ): Promise<WorkflowRoleRecord> {
    const existing = await this.getRole(roleId);
    if (existing === undefined) {
      throw new Error(`Role "${roleId}" not found.`);
    }
    if (existing.builtin || existing.protected) {
      throw new Error(`Built-in role "${existing.name}" is read-only.`);
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (input.name !== undefined || input.description !== undefined) {
        await client.query(
          `update workflow_roles
           set name = coalesce($2, name),
             description = coalesce($3, description),
             updated_at = now()
           where id = $1`,
          [
            roleId,
            input.name?.trim() || null,
            input.description?.trim() || null,
          ],
        );
      }
      if (input.permissions !== undefined) {
        const permissions = normalizeWorkflowPermissionKeys(input.permissions);
        await client.query(`delete from workflow_role_permissions where role_id = $1`, [roleId]);
        for (const permission of permissions) {
          await client.query(
            `insert into workflow_role_permissions (role_id, permission_key)
             values ($1, $2)`,
            [roleId, permission],
          );
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return (await this.getRole(roleId))!;
  }

  async deleteRole(roleId: string): Promise<void> {
    const existing = await this.getRole(roleId);
    if (existing === undefined) {
      return;
    }
    if (existing.builtin || existing.protected) {
      throw new Error(`Built-in role "${existing.name}" cannot be deleted.`);
    }
    await this.pool.query(`delete from workflow_roles where id = $1`, [roleId]);
  }

  async setUserRoles(userId: string, roleIds: string[]): Promise<WorkflowUserProfileRecord> {
    const normalizedRoleIds = [...new Set(roleIds)];
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from workflow_user_roles where user_id = $1`, [userId]);
      for (const roleId of normalizedRoleIds) {
        await client.query(
          `insert into workflow_user_roles (user_id, role_id)
           values ($1, $2)
           on conflict (user_id, role_id) do nothing`,
          [userId, roleId],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.getUserProfileOrThrow(userId);
  }


  async createApiKey(input: {
    userId: string;
    name: string;
    source: string;
    scopes?: string[];
    createdByUserId?: string;
    expiresAt?: string;
  }): Promise<{ record: WorkflowApiKeyRecord; token: string }> {
    const { token, prefix } = createWorkflowApiKeyToken();
    const id = randomUUID();
    await this.pool.query(
      `insert into workflow_api_keys (
         id, user_id, name, prefix, secret_hash, source, scopes, created_by_user_id, created_at, expires_at
       )
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), $9)`,
      [
        id,
        input.userId,
        input.name.trim(),
        prefix,
        sha256Text(token),
        input.source.trim() || "manual",
        JSON.stringify(input.scopes ?? []),
        input.createdByUserId ?? null,
        input.expiresAt ?? null,
      ],
    );
    return {
      record: (await this.getApiKeyOrThrow(id)),
      token,
    };
  }

  async listApiKeys(options?: {
    userId?: string;
    includeRevoked?: boolean;
  }): Promise<WorkflowApiKeyRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (options?.userId) {
      params.push(options.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (options?.includeRevoked !== true) {
      where.push(`revoked_at is null`);
    }
    const result = await this.pool.query<WorkflowApiKeyRow>(
      `select
         id, user_id, name, prefix, secret_hash, source, scopes, created_by_user_id,
         created_at, expires_at, revoked_at, last_used_at, last_used_ip, user_agent
       from workflow_api_keys
       ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
       order by created_at desc, id desc`,
      params,
    );
    return result.rows.map(toApiKeyRecord);
  }

  async getApiKey(apiKeyId: string): Promise<WorkflowApiKeyRecord | undefined> {
    const result = await this.pool.query<WorkflowApiKeyRow>(
      `select
         id, user_id, name, prefix, secret_hash, source, scopes, created_by_user_id,
         created_at, expires_at, revoked_at, last_used_at, last_used_ip, user_agent
       from workflow_api_keys
       where id = $1`,
      [apiKeyId],
    );
    const row = result.rows[0];
    return row ? toApiKeyRecord(row) : undefined;
  }

  async getApiKeyOrThrow(apiKeyId: string): Promise<WorkflowApiKeyRecord> {
    const apiKey = await this.getApiKey(apiKeyId);
    if (apiKey === undefined) {
      throw new Error(`API key "${apiKeyId}" not found.`);
    }
    return apiKey;
  }

  async findApiKeyByToken(token: string): Promise<WorkflowApiKeyLookupRecord | undefined> {
    const prefix = parseWorkflowApiKeyPrefix(token);
    if (prefix === undefined) {
      return undefined;
    }

    const result = await this.pool.query<WorkflowApiKeyRow>(
      `select
         id, user_id, name, prefix, secret_hash, source, scopes, created_by_user_id,
         created_at, expires_at, revoked_at, last_used_at, last_used_ip, user_agent
       from workflow_api_keys
       where prefix = $1
       order by created_at desc`,
      [prefix],
    );

    for (const row of result.rows) {
      if (row.revoked_at !== null) {
        continue;
      }
      if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
        continue;
      }
      if (row.secret_hash !== sha256Text(token)) {
        continue;
      }
      const user = await this.getUserProfile(row.user_id);
      if (user === undefined) {
        continue;
      }
      return {
        ...toApiKeyRecord(row),
        secretHash: row.secret_hash,
        user,
      };
    }

    return undefined;
  }

  async revokeApiKey(apiKeyId: string): Promise<void> {
    await this.pool.query(
      `update workflow_api_keys
       set revoked_at = coalesce(revoked_at, now())
       where id = $1`,
      [apiKeyId],
    );
  }

  async touchApiKey(
    apiKeyId: string,
    input?: { ip?: string; userAgent?: string; expiresAt?: string },
  ): Promise<{ expiresAt?: string } | undefined> {
    const result = await this.pool.query<{ expires_at: Date | null }>(
      `update workflow_api_keys
       set last_used_at = now(),
         last_used_ip = coalesce($2, last_used_ip),
         user_agent = coalesce($3, user_agent),
         expires_at = case
           when $4::timestamptz is null then expires_at
           when expires_at is null then $4::timestamptz
           else greatest(expires_at, $4::timestamptz)
         end
       where id = $1
         and revoked_at is null
         and (expires_at is null or expires_at > now())
       returning expires_at`,
      [apiKeyId, input?.ip ?? null, input?.userAgent ?? null, input?.expiresAt ?? null],
    );
    const row = result.rows[0];
    return row ? { expiresAt: row.expires_at?.toISOString() } : undefined;
  }

  async createDeviceCode(input: {
    clientName: string;
    source: string;
    requestedScopes?: string[];
    expiresAt: string;
    intervalSeconds: number;
    requestedByIp?: string;
    userAgent?: string;
  }): Promise<{ record: WorkflowDeviceCodeRecord; deviceCode: string }> {
    const id = randomUUID();
    const deviceCode = `wfdev_${randomBytes(24).toString("hex")}`;
    const userCode = createWorkflowUserCode();
    await this.pool.query(
      `insert into workflow_auth_device_codes (
         id, device_code_hash, user_code, client_name, source, requested_scopes, state,
         requested_by_ip, user_agent, expires_at, interval_seconds, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, $6::jsonb, 'pending', $7, $8, $9, $10, now(), now())`,
      [
        id,
        sha256Text(deviceCode),
        userCode,
        input.clientName.trim(),
        input.source.trim() || "cli",
        JSON.stringify(input.requestedScopes ?? []),
        input.requestedByIp ?? null,
        input.userAgent ?? null,
        input.expiresAt,
        input.intervalSeconds,
      ],
    );
    return {
      record: (await this.getDeviceCodeById(id))!,
      deviceCode,
    };
  }

  async getDeviceCodeById(deviceCodeId: string): Promise<WorkflowDeviceCodeRecord | undefined> {
    const result = await this.pool.query<WorkflowDeviceCodeRow>(
      `select
         id, device_code_hash, user_code, client_name, source, requested_scopes, state,
         requested_by_ip, user_agent, expires_at, interval_seconds, approved_at,
         approved_by_user_id, denied_at, consumed_at, result, created_at, updated_at
       from workflow_auth_device_codes
       where id = $1`,
      [deviceCodeId],
    );
    const row = result.rows[0];
    return row ? toDeviceCodeRecord(row) : undefined;
  }

  async getDeviceCodeByUserCode(userCode: string): Promise<WorkflowDeviceCodeRecord | undefined> {
    const result = await this.pool.query<WorkflowDeviceCodeRow>(
      `select
         id, device_code_hash, user_code, client_name, source, requested_scopes, state,
         requested_by_ip, user_agent, expires_at, interval_seconds, approved_at,
         approved_by_user_id, denied_at, consumed_at, result, created_at, updated_at
       from workflow_auth_device_codes
       where user_code = $1`,
      [userCode.trim().toUpperCase()],
    );
    const row = result.rows[0];
    return row ? toDeviceCodeRecord(row) : undefined;
  }

  async getDeviceCodeBySecret(deviceCode: string): Promise<WorkflowDeviceCodeSecretRecord | undefined> {
    const result = await this.pool.query<WorkflowDeviceCodeRow>(
      `select
         id, device_code_hash, user_code, client_name, source, requested_scopes, state,
         requested_by_ip, user_agent, expires_at, interval_seconds, approved_at,
         approved_by_user_id, denied_at, consumed_at, result, created_at, updated_at
       from workflow_auth_device_codes
       where device_code_hash = $1`,
      [sha256Text(deviceCode)],
    );
    const row = result.rows[0];
    return row ? toDeviceCodeSecretRecord(row) : undefined;
  }

  async updateDeviceCodeState(
    deviceCodeId: string,
    input: {
      state: WorkflowDeviceCodeState;
      approvedAt?: string | null;
      approvedByUserId?: string | null;
      deniedAt?: string | null;
      consumedAt?: string | null;
      result?: WorkflowDeviceCodeRecord["result"] | null;
    },
  ): Promise<WorkflowDeviceCodeRecord> {
    await this.pool.query(
      `update workflow_auth_device_codes
       set state = $2,
         approved_at = coalesce($3, approved_at),
         approved_by_user_id = coalesce($4, approved_by_user_id),
         denied_at = coalesce($5, denied_at),
         consumed_at = coalesce($6, consumed_at),
         result = coalesce($7::jsonb, result),
         updated_at = now()
       where id = $1`,
      [
        deviceCodeId,
        input.state,
        input.approvedAt ?? null,
        input.approvedByUserId ?? null,
        input.deniedAt ?? null,
        input.consumedAt ?? null,
        input.result === undefined ? null : JSON.stringify(input.result),
      ],
    );
    return (await this.getDeviceCodeById(deviceCodeId))!;
  }

  async consumeApprovedDeviceCodeWithApiKey(
    deviceCodeId: string,
    input: {
      userId: string;
      name: string;
      source: string;
      createdByUserId?: string;
      expiresAt?: string;
      consumedAt: string;
      result: WorkflowDeviceCodeRecord["result"];
    },
  ): Promise<{ deviceCode: WorkflowDeviceCodeRecord; apiKey: { record: WorkflowApiKeyRecord; token: string } } | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // exchanges approved device codes exactly once and creates the
      // API key in the same transaction so concurrent polls cannot mint extras.
      const consumed = await client.query<WorkflowDeviceCodeRow>(
        `update workflow_auth_device_codes
         set state = 'consumed',
           consumed_at = $2,
           result = $3::jsonb,
           updated_at = now()
         where id = $1
           and state = 'approved'
         returning
           id, device_code_hash, user_code, client_name, source, requested_scopes, state,
           requested_by_ip, user_agent, expires_at, interval_seconds, approved_at,
           approved_by_user_id, denied_at, consumed_at, result, created_at, updated_at`,
        [
          deviceCodeId,
          input.consumedAt,
          JSON.stringify(input.result),
        ],
      );
      const consumedRow = consumed.rows[0];
      if (!consumedRow) {
        await client.query("rollback");
        return undefined;
      }

      const { token, prefix } = createWorkflowApiKeyToken();
      const apiKeyId = randomUUID();
      const apiKey = await client.query<WorkflowApiKeyRow>(
        `insert into workflow_api_keys (
           id, user_id, name, prefix, secret_hash, source, scopes, created_by_user_id, created_at, expires_at
         )
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), $9)
         returning
           id, user_id, name, prefix, secret_hash, source, scopes, created_by_user_id,
           created_at, expires_at, revoked_at, last_used_at, last_used_ip, user_agent`,
        [
          apiKeyId,
          input.userId,
          input.name.trim(),
          prefix,
          sha256Text(token),
          input.source.trim() || "manual",
          JSON.stringify([]),
          input.createdByUserId ?? null,
          input.expiresAt ?? null,
        ],
      );

      const updatedDeviceCode = await client.query<WorkflowDeviceCodeRow>(
        `update workflow_auth_device_codes
         set result = $2::jsonb,
           updated_at = now()
         where id = $1
         returning
           id, device_code_hash, user_code, client_name, source, requested_scopes, state,
           requested_by_ip, user_agent, expires_at, interval_seconds, approved_at,
           approved_by_user_id, denied_at, consumed_at, result, created_at, updated_at`,
        [
          deviceCodeId,
          JSON.stringify({
            ...input.result,
            apiKeyId,
          }),
        ],
      );

      await client.query("commit");
      return {
        deviceCode: toDeviceCodeRecord(updatedDeviceCode.rows[0] ?? consumedRow),
        apiKey: {
          record: toApiKeyRecord(apiKey.rows[0]!),
          token,
        },
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createAuditEvent(event: WorkflowAuditEventInput): Promise<void> {
    await this.pool.query(
      `insert into workflow_audit_events (
         id, actor_user_id, actor_profile_id, actor_display_name, principal_kind, event_type,
         resource_type, resource_id, outcome, request_ip, user_agent, context, created_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now())`,
      [
        randomUUID(),
        event.actorUserId ?? null,
        event.actorProfileId ?? null,
        event.actorDisplayName ?? null,
        event.principalKind,
        event.eventType,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.outcome,
        event.requestIp ?? null,
        event.userAgent ?? null,
        JSON.stringify(event.context ?? {}),
      ],
    );
  }

  async listAuditEvents(options: WorkflowAuditEventListOptions = {}): Promise<WorkflowAuditEventPage> {
    const pageSize = clampAuditPageSize(options.pageSize);
    const params: unknown[] = [];
    const filterWhere: string[] = [];
    const cursor = parseAuditCursor(options.cursor);

    if (options.from) {
      params.push(options.from);
      filterWhere.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (options.to) {
      params.push(options.to);
      filterWhere.push(`created_at <= $${params.length}::timestamptz`);
    }
    if (options.actorUserId) {
      params.push(options.actorUserId);
      filterWhere.push(`actor_user_id = $${params.length}`);
    }
    if (options.principalKind) {
      params.push(options.principalKind);
      filterWhere.push(`principal_kind = $${params.length}`);
    }
    if (options.eventType) {
      params.push(options.eventType);
      filterWhere.push(`event_type = $${params.length}`);
    }
    if (options.resourceType) {
      params.push(options.resourceType);
      filterWhere.push(`resource_type = $${params.length}`);
    }
    if (options.resourceId) {
      params.push(options.resourceId);
      filterWhere.push(`resource_id = $${params.length}`);
    }
    if (options.outcome) {
      params.push(options.outcome);
      filterWhere.push(`outcome = $${params.length}`);
    }

    const pageParams = [...params];
    const pageWhere = [...filterWhere];
    if (cursor) {
      pageParams.push(cursor.createdAt, cursor.id);
      pageWhere.push(`(created_at, id) < ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::text)`);
    }
    const pageWhereClause = pageWhere.length > 0 ? `where ${pageWhere.join(" and ")}` : "";
    const totalWhereClause = filterWhere.length > 0 ? `where ${filterWhere.join(" and ")}` : "";
    const rows = await this.pool.query<WorkflowAuditEventRow>(
      `select
         id,
         actor_user_id,
         actor_profile_id,
         actor_display_name,
         principal_kind,
         event_type,
         resource_type,
         resource_id,
         outcome,
         request_ip,
         user_agent,
         context,
         created_at
       from workflow_audit_events
       ${pageWhereClause}
       order by created_at desc, id desc
       limit ${pageSize + 1}`,
      pageParams,
    );
    const totalResult = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from workflow_audit_events ${totalWhereClause}`,
      params,
    );
    const hasMore = rows.rows.length > pageSize;
    const items = rows.rows.slice(0, pageSize).map(toAuditEventRecord);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      total: Number(totalResult.rows[0]?.count ?? "0"),
      nextCursor: hasMore && last ? encodeAuditCursor(last) : undefined,
    };
  }

  async findAuthUserByEmail(email: string): Promise<WorkflowAuthUserRecord | undefined> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      return undefined;
    }
    const result = await this.pool.query<WorkflowAuthUserRow>(
      `select id, email, display_name, created_at, last_sign_in_at
       from workflow_auth_users
       where lower(email) = $1
       order by created_at desc, id asc
       limit 1`,
      [normalizedEmail],
    );
    return result.rows[0] ? toAuthUserRecord(result.rows[0]) : undefined;
  }

  async listAuthUsers(): Promise<WorkflowAuthUserRecord[]> {
    const result = await this.pool.query<WorkflowAuthUserRow>(
      `select id, email, display_name, created_at, last_sign_in_at
       from workflow_auth_users
       order by created_at desc, id asc`,
    );
    return result.rows.map(toAuthUserRecord);
  }

  private async ensureBuiltinRoles(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const role of listBuiltinWorkflowRoles()) {
        await client.query(
          `insert into workflow_roles (
             id, name, description, builtin, protected, created_at, updated_at
           )
           values ($1, $2, $3, true, $4, now(), now())
           on conflict (id) do update set
             name = excluded.name,
             description = excluded.description,
             builtin = true,
             protected = excluded.protected,
             updated_at = now()`,
          [role.id, role.name, role.description, role.protected],
        );
        await client.query(`delete from workflow_role_permissions where role_id = $1`, [role.id]);
        for (const permission of role.permissions) {
          await client.query(
            `insert into workflow_role_permissions (role_id, permission_key)
             values ($1, $2)
             on conflict (role_id, permission_key) do nothing`,
            [role.id, permission],
          );
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async readProfileRow(userId: string): Promise<WorkflowUserProfileRow | undefined> {
    const result = await this.pool.query<WorkflowUserProfileRow>(
      `select user_id, email, display_name, status, created_by_user_id, created_at, updated_at, last_login_at
      , avatar_url
       from workflow_user_profiles
       where user_id = $1`,
      [userId],
    );
    return result.rows[0];
  }

  private async inflateProfiles(rows: WorkflowUserProfileRow[]): Promise<WorkflowUserProfileRecord[]> {
    if (rows.length === 0) {
      return [];
    }
    const userIds = rows.map((row) => row.user_id);
    const [roles, permissions] = await Promise.all([
      this.readUserRoles(userIds),
      this.readUserPermissions(userIds),
    ]);
    return rows.map((row) => {
      const userRoles = roles.get(row.user_id) ?? [];
      return {
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url ?? undefined,
        status: isUserProfileStatus(row.status) ? row.status : "active",
        createdByUserId: row.created_by_user_id ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        lastLoginAt: row.last_login_at?.toISOString(),
        roleIds: userRoles.map((role) => role.roleId),
        roleNames: userRoles.map((role) => role.name),
        permissions: permissions.get(row.user_id) ?? [...DEFAULT_AUTHENTICATED_PERMISSION_KEYS],
      };
    });
  }

  private async readRoleRows(): Promise<WorkflowRoleRow[]> {
    const result = await this.pool.query<WorkflowRoleRow>(
      `select id, name, description, builtin, protected, created_by_user_id, created_at, updated_at
       from workflow_roles
       order by builtin desc, name asc, id asc`,
    );
    return result.rows;
  }

  private async readRolePermissions(roleIds?: string[]): Promise<Map<string, WorkflowPermissionKey[]>> {
    const result = await this.pool.query<WorkflowRolePermissionRow>(
      `select role_id, permission_key
       from workflow_role_permissions
       ${roleIds && roleIds.length > 0 ? `where role_id = any($1::text[])` : ""}
       order by role_id asc, permission_key asc`,
      roleIds && roleIds.length > 0 ? [roleIds] : [],
    );
    const grouped = new Map<string, WorkflowPermissionKey[]>();
    for (const row of result.rows) {
      const list = grouped.get(row.role_id) ?? [];
      list.push(row.permission_key as WorkflowPermissionKey);
      grouped.set(row.role_id, list);
    }
    return grouped;
  }

  private async readUserRoles(userIds: string[]): Promise<Map<string, Array<{ roleId: string; name: string }>>> {
    const result = await this.pool.query<WorkflowUserRoleRow>(
      `select ur.user_id, ur.role_id, r.name as role_name
       from workflow_user_roles ur
       join workflow_roles r on r.id = ur.role_id
       where ur.user_id = any($1::text[])
       order by r.builtin desc, r.name asc, ur.role_id asc`,
      [userIds],
    );
    const grouped = new Map<string, Array<{ roleId: string; name: string }>>();
    for (const row of result.rows) {
      const list = grouped.get(row.user_id) ?? [];
      list.push({ roleId: row.role_id, name: row.role_name });
      grouped.set(row.user_id, list);
    }
    return grouped;
  }

  private async readUserPermissions(userIds: string[]): Promise<Map<string, WorkflowPermissionKey[]>> {
    const result = await this.pool.query<WorkflowUserRoleRow & { permission_key: string }>(
      `select ur.user_id, ur.role_id, r.name as role_name, rp.permission_key
       from workflow_user_roles ur
       join workflow_roles r on r.id = ur.role_id
       join workflow_role_permissions rp on rp.role_id = ur.role_id
       where ur.user_id = any($1::text[])`,
      [userIds],
    );
    const grouped = new Map<string, Set<WorkflowPermissionKey>>();
    for (const userId of userIds) {
      grouped.set(userId, new Set(DEFAULT_AUTHENTICATED_PERMISSION_KEYS));
    }
    for (const row of result.rows) {
      const set = grouped.get(row.user_id) ?? new Set<WorkflowPermissionKey>(DEFAULT_AUTHENTICATED_PERMISSION_KEYS);
      set.add(row.permission_key as WorkflowPermissionKey);
      grouped.set(row.user_id, set);
    }
    return new Map([...grouped.entries()].map(([userId, permissions]) => [userId, [...permissions].sort()]));
  }
}

export function createWorkflowApiKeyToken(): { token: string; prefix: string } {
  const prefixSeed = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("hex");
  return {
    prefix: `wfk_${prefixSeed}`,
    token: `wfk_${prefixSeed}_${secret}`,
  };
}

export function parseWorkflowApiKeyPrefix(token: string): string | undefined {
  const match = /^(wfk_[a-f0-9]{12})_[a-f0-9]{48}$/i.exec(token.trim());
  return match?.[1];
}

function createWorkflowUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    chars.push(alphabet[randomBytes(1)[0]! % alphabet.length]!);
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function toRoleRecord(row: WorkflowRoleRow, permissions: WorkflowPermissionKey[]): WorkflowRoleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    builtin: row.builtin,
    protected: row.protected,
    permissions: normalizeWorkflowPermissionKeys(permissions),
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toApiKeyRecord(row: WorkflowApiKeyRow): WorkflowApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    prefix: row.prefix,
    source: row.source,
    scopes: normalizeStringArray(row.scopes),
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString(),
    lastUsedIp: row.last_used_ip ?? undefined,
    userAgent: row.user_agent ?? undefined,
  };
}

function toDeviceCodeRecord(row: WorkflowDeviceCodeRow): WorkflowDeviceCodeRecord {
  return {
    id: row.id,
    userCode: row.user_code,
    clientName: row.client_name,
    source: row.source,
    requestedScopes: normalizeStringArray(row.requested_scopes),
    state: isDeviceCodeState(row.state) ? row.state : "pending",
    requestedByIp: row.requested_by_ip ?? undefined,
    userAgent: row.user_agent ?? undefined,
    expiresAt: row.expires_at.toISOString(),
    intervalSeconds: row.interval_seconds,
    approvedAt: row.approved_at?.toISOString(),
    approvedByUserId: row.approved_by_user_id ?? undefined,
    deniedAt: row.denied_at?.toISOString(),
    consumedAt: row.consumed_at?.toISOString(),
    result: normalizeDeviceCodeResult(row.result),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toDeviceCodeSecretRecord(row: WorkflowDeviceCodeRow): WorkflowDeviceCodeSecretRecord {
  return {
    ...toDeviceCodeRecord(row),
    deviceCodeHash: row.device_code_hash,
  };
}

function normalizeDeviceCodeResult(value: unknown): WorkflowDeviceCodeRecord["result"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const user = isRecord(value.user) &&
    typeof value.user.userId === "string" &&
    typeof value.user.email === "string" &&
    typeof value.user.displayName === "string"
    ? {
        userId: value.user.userId,
        email: value.user.email,
        displayName: value.user.displayName,
      }
    : undefined;
  return {
    apiKeyId: typeof value.apiKeyId === "string" ? value.apiKeyId : undefined,
    user,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : undefined,
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeDisplayName(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback.trim();
}

export function normalizeAvatarUrl(
  value: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(normalized)) {
    if (normalized.length > 1024 * 1024) {
      throw new Error("avatarUrl is too large.");
    }
    return normalized;
  }
  try {
    const url = new URL(normalized);
    // Follows the Server's configured public origin, which is where local object
    // storage lives.
    const configuredOrigin = resolveStorageAvatarBaseUrlOrigin(env);
    if (
      (url.protocol === "https:" || url.protocol === "http:")
      && url.origin === configuredOrigin
      && /^\/storage\/avatars\/[a-f0-9-]{1,64}\/[a-f0-9]{64}\.(png|jpe?g|gif|webp)$/i.test(url.pathname)
    ) {
      return normalized;
    }
  } catch {
    // Report the common validation error below.
  }
  throw new Error("avatarUrl must be a supported image data URL or Workflow storage avatar URL.");
}

function clampAuditPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 20;
  }
  return Math.max(1, Math.min(100, Math.trunc(value ?? 20)));
}

function encodeAuditCursor(record: Pick<WorkflowAuditEventRecord, "id" | "createdAt">): string {
  return Buffer.from(JSON.stringify({ id: record.id, createdAt: record.createdAt }), "utf8").toString("base64url");
}

function parseAuditCursor(cursor: string | undefined): { id: string; createdAt: string } | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: unknown; createdAt?: unknown };
    if (typeof parsed.id === "string" && typeof parsed.createdAt === "string") {
      return { id: parsed.id, createdAt: parsed.createdAt };
    }
  } catch {
    return undefined;
  }
  throw new Error("Invalid audit cursor.");
}

function toAuditEventRecord(row: WorkflowAuditEventRow): WorkflowAuditEventRecord {
  return {
    id: row.id,
    actorUserId: row.actor_user_id ?? undefined,
    actorProfileId: row.actor_profile_id ?? undefined,
    actorDisplayName: row.actor_display_name ?? undefined,
    principalKind: row.principal_kind,
    eventType: row.event_type,
    resourceType: row.resource_type ?? undefined,
    resourceId: row.resource_id ?? undefined,
    outcome: row.outcome === "failed" || row.outcome === "denied" ? row.outcome : "success",
    requestIp: row.request_ip ?? undefined,
    userAgent: row.user_agent ?? undefined,
    context: isRecord(row.context) ? row.context : {},
    createdAt: row.created_at.toISOString(),
  };
}

function toAuthUserRecord(row: WorkflowAuthUserRow): WorkflowAuthUserRecord {
  const email = row.email.trim().toLowerCase();
  return {
    userId: row.id,
    email,
    displayName: row.display_name.trim() || email || row.id,
    createdAt: row.created_at.toISOString(),
    lastSignInAt: row.last_sign_in_at?.toISOString(),
  };
}


function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUserProfileStatus(value: string): value is WorkflowUserProfileStatus {
  return value === "invited" || value === "active" || value === "disabled";
}

function isDeviceCodeState(value: string): value is WorkflowDeviceCodeState {
  return value === "pending" || value === "approved" || value === "denied" || value === "expired" || value === "consumed";
}
