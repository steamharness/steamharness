import type { Request } from "express";
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import {
  AccountRepository,
  type ApiKeyLookupRecord,
  type AuthUserRecord,
  type AuditEventInput,
  type DeviceCodeRecord,
  type UserProfileRecord,
} from "./account-db";
import { createSlidingApiKeyExpiresAt } from "./api-key-lifetime";
import type { PermissionKey } from "./permissions";
import { createPostgresPool } from "./postgres";
import { HttpError } from "./protocol";

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  user: {
    userId: string;
    email: string;
    displayName: string;
  };
}

export type AuthCookieSession =
  | { kind: "refresh"; refreshToken: string }
  | { kind: "admin_key" };

interface AuthCookieEnvelope {
  v: 1;
  payload: AuthCookieSession;
  sig: string;
}

export type AuthenticatedPrincipal =
  | {
      kind: "admin_key";
      tokenSource: "bearer" | "query" | "cookie";
      isSystemAdmin: true;
    }
  | {
      kind: "admin_session";
      tokenSource: "cookie";
      userId: string;
      profile: UserProfileRecord;
      isSystemAdmin: true;
      accessToken: string;
      refreshToken: string;
      expiresAt?: string;
    }
  | {
      kind: "user_session";
      tokenSource: "cookie";
      userId: string;
      profile: UserProfileRecord;
      isSystemAdmin: boolean;
      accessToken: string;
      refreshToken: string;
      expiresAt?: string;
    }
  | {
      kind: "api_key";
      tokenSource: "bearer";
      userId: string;
      profile: UserProfileRecord;
      isSystemAdmin: boolean;
      apiKey: ApiKeyLookupRecord;
    };

interface NativeAuthUserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string;
  disabled: boolean;
  created_at: Date;
  last_sign_in_at: Date | null;
}

interface NativeAuthSessionRow extends NativeAuthUserRow {
  session_id: string;
  expires_at: Date;
  access_expires_at: Date;
}

interface NativeInvitationRow {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  disabled: boolean;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

const STEAMHARNESS_AUTH_COOKIE = "steamharness_auth_session";
const STEAMHARNESS_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = STEAMHARNESS_AUTH_COOKIE_MAX_AGE_SECONDS * 1000;
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_SCRYPT_N = 16_384;
const PASSWORD_SCRYPT_R = 8;
const PASSWORD_SCRYPT_P = 1;

export class AuthService {
  private readonly pool: pg.Pool;
  private readonly accountDb: AccountRepository;
  private readonly ready: Promise<void>;

  constructor(options: { databaseUrl?: string; accountDb: AccountRepository; pool?: pg.Pool }) {
    if (!options.pool && !options.databaseUrl?.trim()) {
      throw new Error("AuthService requires a PostgreSQL connection.");
    }
    this.pool = options.pool ?? createPostgresPool({
      connectionString: options.databaseUrl,
      label: "workflow auth",
    });
    this.accountDb = options.accountDb;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      create table if not exists steamharness_auth_users (
        id text primary key,
        email text not null,
        password_hash text,
        display_name text not null default '',
        disabled boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        last_sign_in_at timestamptz
      );

      create unique index if not exists steamharness_auth_users_email_idx
        on steamharness_auth_users (lower(email));

      create table if not exists steamharness_auth_sessions (
        id text primary key,
        user_id text not null references steamharness_auth_users(id) on delete cascade,
        access_token_hash text not null unique,
        refresh_token_hash text not null unique,
        access_expires_at timestamptz not null,
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        last_used_at timestamptz not null default now(),
        revoked_at timestamptz
      );

      create index if not exists steamharness_auth_sessions_user_idx
        on steamharness_auth_sessions (user_id, created_at desc);

      create table if not exists steamharness_auth_invitations (
        id text primary key,
        user_id text not null references steamharness_auth_users(id) on delete cascade,
        token_hash text not null unique,
        created_by_user_id text,
        expires_at timestamptz not null,
        accepted_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz not null default now()
      );

      alter table steamharness_auth_invitations
        add column if not exists revoked_at timestamptz;
    `);
  }

  async signInWithPassword(input: { email: string; password: string }): Promise<AuthSession> {
    await this.ready;
    const user = await this.findUserByEmail(input.email);
    if (!user || !user.password_hash || user.disabled || !(await verifyPassword(input.password, user.password_hash))) {
      throw new HttpError(401, 401, "Email or password is invalid.");
    }
    const existingProfile = await this.accountDb.getUserProfile(user.id);
    if (existingProfile?.status === "disabled") throw new HttpError(403, 403, "Account is disabled.");
    await this.pool.query(
      "update steamharness_auth_users set last_sign_in_at = now(), updated_at = now() where id = $1",
      [user.id],
    );
    const profile = await this.accountDb.upsertUserProfile({
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      status: "active",
      lastLoginAt: new Date().toISOString(),
    });
    return this.createSession({ ...user, last_sign_in_at: new Date() });
  }

  async signInBootstrapAdmin(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<AuthSession> {
    await this.ready;
    const email = normalizeEmail(input.email);
    const displayName = input.displayName?.trim() || email;
    const client = await this.pool.connect();
    let user: NativeAuthUserRow;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(86081702512026::bigint)");
      const existing = (await client.query<NativeAuthUserRow>(
        `select id, email, password_hash, display_name, disabled, created_at, last_sign_in_at
         from steamharness_auth_users where lower(email) = $1 limit 1 for update`,
        [email],
      )).rows[0];
      if (existing) {
        if (existing.disabled || !existing.password_hash || !(await verifyPassword(input.password, existing.password_hash))) {
          throw new HttpError(401, 401, "Email or password is invalid.");
        }
        await client.query(
          "update steamharness_auth_users set last_sign_in_at = now(), updated_at = now() where id = $1",
          [existing.id],
        );
        user = { ...existing, last_sign_in_at: new Date() };
      } else {
        const hasUsers = (await client.query<{ has_users: boolean }>(
          "select exists(select 1 from steamharness_auth_users) as has_users",
        )).rows[0]?.has_users;
        if (hasUsers) throw new HttpError(401, 401, "Email or password is invalid.");
        const id = randomUUID();
        await client.query(
          `insert into steamharness_auth_users (
             id, email, password_hash, display_name, disabled, created_at, updated_at, last_sign_in_at
           ) values ($1, $2, $3, $4, false, now(), now(), now())`,
          [id, email, await hashPassword(input.password), displayName],
        );
        user = (await client.query<NativeAuthUserRow>(
          `select id, email, password_hash, display_name, disabled, created_at, last_sign_in_at
           from steamharness_auth_users where id = $1`,
          [id],
        )).rows[0]!;
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await this.ensureAdminProfile(user.id, { email, displayName });
    return this.createSession(user);
  }

  async refreshSession(refreshToken: string): Promise<AuthSession> {
    await this.ready;
    const result = await this.pool.query<NativeAuthSessionRow>(
      `select
         u.id, u.email, u.password_hash, u.display_name, u.disabled, u.created_at, u.last_sign_in_at,
         s.id as session_id, s.expires_at, s.access_expires_at
       from steamharness_auth_sessions s
       join steamharness_auth_users u on u.id = s.user_id
       where s.refresh_token_hash = $1 and s.revoked_at is null and s.expires_at > now()
       limit 1`,
      [sha256Text(refreshToken)],
    );
    const row = result.rows[0];
    if (!row || row.disabled) throw new HttpError(401, 401, "Session has expired.");
    const profile = await this.accountDb.getUserProfileOrThrow(row.id);
    if (profile.status === "disabled") throw new HttpError(403, 403, "Account is disabled.");
    const accessToken = createOpaqueToken("wf_access");
    const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    await this.pool.query(
      `update steamharness_auth_sessions
       set access_token_hash = $2, access_expires_at = $3, last_used_at = now()
       where id = $1`,
      [row.session_id, sha256Text(accessToken), accessExpiresAt.toISOString()],
    );
    return toAuthSession(row, accessToken, refreshToken, accessExpiresAt);
  }

  async getUserByAccessToken(accessToken: string): Promise<AuthSession> {
    await this.ready;
    const result = await this.pool.query<NativeAuthSessionRow>(
      `select
         u.id, u.email, u.password_hash, u.display_name, u.disabled, u.created_at, u.last_sign_in_at,
         s.id as session_id, s.expires_at, s.access_expires_at
       from steamharness_auth_sessions s
       join steamharness_auth_users u on u.id = s.user_id
       where s.access_token_hash = $1 and s.revoked_at is null
         and s.expires_at > now() and s.access_expires_at > now()
       limit 1`,
      [sha256Text(accessToken)],
    );
    const row = result.rows[0];
    if (!row || row.disabled) throw new HttpError(401, 401, "Session is invalid.");
    const profile = await this.accountDb.getUserProfileOrThrow(row.id);
    if (profile.status === "disabled") throw new HttpError(403, 403, "Account is disabled.");
    return toAuthSession(row, accessToken, "", row.access_expires_at);
  }

  async inviteUser(input: {
    email: string;
    displayName?: string;
    password?: string;
    redirectTo?: string;
    createdByUserId?: string;
  }): Promise<{
    profile: UserProfileRecord;
    invitationLink?: string;
    temporaryPassword?: string;
  }> {
    await this.ready;
    const email = normalizeEmail(input.email);
    if (await this.findUserByEmail(email)) throw new HttpError(409, 409, "User already exists.");
    const displayName = input.displayName?.trim() || email;
    const userId = randomUUID();
    const password = input.password?.trim() ? input.password : undefined;
    await this.pool.query(
      `insert into steamharness_auth_users (id, email, password_hash, display_name, disabled, created_at, updated_at)
       values ($1, $2, $3, $4, false, now(), now())`,
      [userId, email, password ? await hashPassword(password) : null, displayName],
    );
    const profile = await this.accountDb.upsertUserProfile({
      userId,
      email,
      displayName,
      status: "invited",
      createdByUserId: input.createdByUserId,
    });
    if (password) return { profile, temporaryPassword: password };
    const invitation = await this.createInvitation(userId, input.createdByUserId, input.redirectTo);
    return { profile, invitationLink: invitation.invitationLink };
  }

  async generateInviteLink(email: string, redirectTo?: string): Promise<{ invitationLink: string }> {
    await this.ready;
    const user = await this.findUserByEmail(email);
    if (!user) throw new HttpError(404, 404, "User not found.");
    return this.createInvitation(user.id, undefined, redirectTo);
  }

  async getInvitation(token: string): Promise<{
    email: string;
    displayName: string;
    expiresAt: string;
    acceptedAt?: string;
  }> {
    const invitation = await this.readInvitation(token);
    return {
      email: invitation.email,
      displayName: invitation.display_name,
      expiresAt: invitation.expires_at.toISOString(),
      acceptedAt: invitation.accepted_at?.toISOString(),
    };
  }

  async acceptInvitation(input: { token: string; password: string; displayName?: string }): Promise<AuthSession> {
    if (input.password.length < 8) throw new HttpError(400, 400, "Password must contain at least 8 characters.");
    await this.ready;
    const passwordHash = await hashPassword(input.password);
    const client = await this.pool.connect();
    let invitation: NativeInvitationRow;
    let displayName: string;
    try {
      await client.query("begin");
      invitation = await this.readInvitation(input.token, client, true);
      if (invitation.accepted_at) throw new HttpError(409, 409, "Invitation has already been accepted.");
      if (invitation.expires_at.getTime() <= Date.now()) throw new HttpError(410, 410, "Invitation has expired.");
      if (invitation.disabled) throw new HttpError(403, 403, "Account is disabled.");
      displayName = input.displayName?.trim() || invitation.display_name;
      await client.query(
        `update steamharness_auth_users
         set password_hash = $2, display_name = $3, updated_at = now()
         where id = $1`,
        [invitation.user_id, passwordHash, displayName],
      );
      await client.query(
        "update steamharness_auth_invitations set accepted_at = now() where id = $1 and accepted_at is null",
        [invitation.id],
      );
      await this.revokeUserSessions(invitation.user_id, client);
      await client.query(
        `update steamharness_auth_invitations
         set revoked_at = now()
         where user_id = $1 and id <> $2 and accepted_at is null and revoked_at is null`,
        [invitation.user_id, invitation.id],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const profile = await this.accountDb.upsertUserProfile({
      userId: invitation.user_id,
      email: invitation.email,
      displayName,
      status: "active",
      lastLoginAt: new Date().toISOString(),
    });
    return this.createSession(await this.getUserById(invitation.user_id));
  }

  async listUsers(): Promise<Array<{ user: AuthUserRecord; profile?: UserProfileRecord }>> {
    await this.ready;
    const result = await this.pool.query<NativeAuthUserRow>(
      `select id, email, password_hash, display_name, disabled, created_at, last_sign_in_at
       from steamharness_auth_users order by created_at desc, id asc`,
    );
    const profiles = await this.accountDb.listUserProfiles();
    const profileById = new Map(profiles.map((profile) => [profile.userId, profile]));
    return result.rows.map((row) => ({ user: toAuthUserRecord(row), profile: profileById.get(row.id) }));
  }

  async getUserById(userId: string): Promise<NativeAuthUserRow> {
    await this.ready;
    const result = await this.pool.query<NativeAuthUserRow>(
      `select id, email, password_hash, display_name, disabled, created_at, last_sign_in_at
       from steamharness_auth_users where id = $1`,
      [userId],
    );
    const user = result.rows[0];
    if (!user) throw new HttpError(404, 404, "User not found.");
    return user;
  }

  async updateAuthUser(input: {
    userId: string;
    email?: string;
    password?: string;
    displayName?: string;
    disabled?: boolean;
  }): Promise<NativeAuthUserRow> {
    await this.ready;
    const current = await this.getUserById(input.userId);
    const email = input.email === undefined ? current.email : normalizeEmail(input.email);
    const displayName = input.displayName === undefined ? current.display_name : input.displayName.trim() || email;
    const passwordHash = input.password?.trim() ? await hashPassword(input.password) : current.password_hash;
    const disabled = input.disabled ?? current.disabled;
    const passwordChanged = Boolean(input.password?.trim());
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('steamharness-resource-access'))");
      await client.query("select pg_advisory_xact_lock(hashtext('steamharness-account-admin'))");
      if (input.disabled === true) await this.accountDb.assertCanDisableAccount(input.userId,client);
      await client.query(
        `update steamharness_auth_users
         set email = $2, password_hash = $3, display_name = $4, disabled = $5, updated_at = now()
         where id = $1`,
        [input.userId, email, passwordHash, displayName, disabled],
      );
      await client.query(`update user_profiles set email=$2,display_name=$3,
        status=case when $4::boolean is null then status when $4 then 'disabled' when status='invited' then 'invited' else 'active' end,
        updated_at=now() where user_id=$1`,[input.userId,email,displayName,input.disabled??null]);
      if (passwordChanged || input.disabled === true) await this.revokeUserSessions(input.userId, client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.getUserById(input.userId);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.ready;
    await this.pool.query("delete from steamharness_auth_users where id = $1", [userId]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async resolvePrincipal(req: Request): Promise<AuthenticatedPrincipal | undefined> {
    const bearer = readBearerToken(req);
    if (bearer) {
      const adminKey = getConfiguredAdminKey();
      if (adminKey && bearer === adminKey) {
        return { kind: "admin_key", tokenSource: "bearer", isSystemAdmin: true };
      }
      const apiKey = await this.accountDb.findApiKeyByToken(bearer);
      if (apiKey) {
        if (apiKey.user.status === "disabled") throw new HttpError(403, 403, "Account is disabled.");
        const touchedApiKey = await this.accountDb.touchApiKey(apiKey.id, {
          ip: readRequestIp(req),
          userAgent: req.get("user-agent") ?? undefined,
          expiresAt: createSlidingApiKeyExpiresAt(apiKey.source),
        });
        if (!touchedApiKey) throw new HttpError(401, 401, "Unauthorized.");
        const refreshedApiKey = { ...apiKey, expiresAt: touchedApiKey.expiresAt ?? apiKey.expiresAt };
        return {
          kind: "api_key",
          tokenSource: "bearer",
          userId: apiKey.user.userId,
          profile: apiKey.user,
          isSystemAdmin: apiKey.user.isSystemAdmin,
          apiKey: refreshedApiKey,
        };
      }
      throw new HttpError(401, 401, "Unauthorized.");
    }
    const cookieValue = parseCookieHeader(req.headers.cookie)[STEAMHARNESS_AUTH_COOKIE];
    if (!cookieValue) return undefined;
    const cookie = readCookieSession(cookieValue);
    if (!cookie) throw new HttpError(401, 401, "Unauthorized.");
    if (cookie.kind === "admin_key") {
      return { kind: "admin_key", tokenSource: "cookie", isSystemAdmin: true };
    }
    const session = await this.refreshSession(cookie.refreshToken);
    const profile = await this.accountDb.getUserProfileOrThrow(session.user.userId);
    const principalBase = {
      tokenSource: "cookie" as const,
      userId: profile.userId,
      profile,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
    };
    return profile.isSystemAdmin
      ? { kind: "admin_session", ...principalBase, isSystemAdmin: true }
      : { kind: "user_session", ...principalBase, isSystemAdmin: false };
  }

  async createDeviceCode(input: {
    clientName: string;
    source: string;
    requestedScopes?: string[];
    requestedByIp?: string;
    userAgent?: string;
  }): Promise<{ record: DeviceCodeRecord; deviceCode: string }> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    return this.accountDb.createDeviceCode({
      clientName: input.clientName,
      source: input.source,
      requestedScopes: input.requestedScopes,
      expiresAt,
      intervalSeconds: 5,
      requestedByIp: input.requestedByIp,
      userAgent: input.userAgent,
    });
  }

  async recordAudit(event: AuditEventInput): Promise<void> {
    await this.accountDb.createAuditEvent(event);
  }

  async revokeSession(refreshToken: string): Promise<void> {
    await this.ready;
    await this.pool.query(
      "update steamharness_auth_sessions set revoked_at = coalesce(revoked_at, now()) where refresh_token_hash = $1",
      [sha256Text(refreshToken)],
    );
  }

  setAuthCookie(res: { append(name: string, value: string): void }, session: AuthSession): void {
    const encoded = encodeCookieSession({ kind: "refresh", refreshToken: session.refreshToken });
    res.append(
      "Set-Cookie",
      `${STEAMHARNESS_AUTH_COOKIE}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STEAMHARNESS_AUTH_COOKIE_MAX_AGE_SECONDS}`,
    );
  }

  setAdminKeyCookie(res: { append(name: string, value: string): void }): void {
    const encoded = encodeCookieSession({ kind: "admin_key" });
    res.append(
      "Set-Cookie",
      `${STEAMHARNESS_AUTH_COOKIE}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STEAMHARNESS_AUTH_COOKIE_MAX_AGE_SECONDS}`,
    );
  }

  clearAuthCookie(res: { append(name: string, value: string): void }): void {
    res.append("Set-Cookie", `${STEAMHARNESS_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  private async createSession(user: NativeAuthUserRow): Promise<AuthSession> {
    const accessToken = createOpaqueToken("wf_access");
    const refreshToken = createOpaqueToken("wf_refresh");
    const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.pool.query(
      `insert into steamharness_auth_sessions (
         id, user_id, access_token_hash, refresh_token_hash, access_expires_at, expires_at,
         created_at, last_used_at
       ) values ($1, $2, $3, $4, $5, $6, now(), now())`,
      [
        randomUUID(),
        user.id,
        sha256Text(accessToken),
        sha256Text(refreshToken),
        accessExpiresAt.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    return toAuthSession(user, accessToken, refreshToken, accessExpiresAt);
  }

  private async createInvitation(
    userId: string,
    createdByUserId?: string,
    redirectTo?: string,
  ): Promise<{ invitationLink: string }> {
    const token = createOpaqueToken("wf_invite");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from steamharness_auth_users where id = $1 for update", [userId]);
      await client.query(
        `update steamharness_auth_invitations
         set revoked_at = now()
         where user_id = $1 and accepted_at is null and revoked_at is null`,
        [userId],
      );
      await client.query(
        `insert into steamharness_auth_invitations (
           id, user_id, token_hash, created_by_user_id, expires_at, created_at
         ) values ($1, $2, $3, $4, $5, now())`,
        [randomUUID(), userId, sha256Text(token), createdByUserId ?? null, new Date(Date.now() + INVITATION_TTL_MS)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return { invitationLink: `${readAuthPublicBaseUrl(redirectTo)}/account/invite/${encodeURIComponent(token)}` };
  }

  private async readInvitation(
    token: string,
    queryable: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query"> = this.pool,
    forUpdate = false,
  ): Promise<NativeInvitationRow> {
    await this.ready;
    const result = await queryable.query<NativeInvitationRow>(
      `select i.id, i.user_id, u.email, u.display_name, u.disabled,
              i.expires_at, i.accepted_at, i.revoked_at
       from steamharness_auth_invitations i
       join steamharness_auth_users u on u.id = i.user_id
       where i.token_hash = $1 and i.revoked_at is null
       limit 1${forUpdate ? " for update of i" : ""}`,
      [sha256Text(token)],
    );
    const invitation = result.rows[0];
    if (!invitation) throw new HttpError(404, 404, "Invitation not found.");
    return invitation;
  }

  private async findUserByEmail(email: string): Promise<NativeAuthUserRow | undefined> {
    const result = await this.pool.query<NativeAuthUserRow>(
      `select id, email, password_hash, display_name, disabled, created_at, last_sign_in_at
       from steamharness_auth_users where lower(email) = $1 limit 1`,
      [normalizeEmail(email)],
    );
    return result.rows[0];
  }

  private async revokeUserSessions(
    userId: string,
    queryable: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query"> = this.pool,
  ): Promise<void> {
    await queryable.query(
      "update steamharness_auth_sessions set revoked_at = coalesce(revoked_at, now()) where user_id = $1",
      [userId],
    );
  }

  private async ensureAdminProfile(
    userId: string,
    input: { email: string; displayName?: string },
  ): Promise<UserProfileRecord> {
    const profile = await this.accountDb.upsertUserProfile({
      userId,
      email: normalizeEmail(input.email),
      displayName: input.displayName?.trim() || normalizeEmail(input.email),
      status: "active",
      lastLoginAt: new Date().toISOString(),
    });
    if (profile.isSystemAdmin) return profile;
    return this.accountDb.setSystemAdministrator(profile.userId, true);
  }
}

export function hasConfiguredAdminKey(): boolean {
  return getConfiguredAdminKey() !== "";
}

export function getConfiguredAdminKey(): string {
  return process.env.STEAMHARNESS_SERVER_ADMIN_KEY?.trim() ?? "";
}

export function createProjectAuthServiceFromEnv(accountDb: AccountRepository): AuthService | undefined {
  const databaseUrl = process.env.STEAMHARNESS_DATABASE_URL?.trim();
  return databaseUrl ? new AuthService({ databaseUrl, accountDb }) : undefined;
}

export function getRequestPrincipal(req: Request): AuthenticatedPrincipal | undefined {
  return req.res?.locals?.principal as AuthenticatedPrincipal | undefined;
}

export function hasPermission(
  principal: AuthenticatedPrincipal | undefined,
  permission: PermissionKey,
): boolean {
  return Boolean(principal?.isSystemAdmin);
}

export function encodeCookieSession(session: AuthCookieSession): string {
  const secret = getAuthCookieSecret();
  if (!secret) {
    throw new Error("STEAMHARNESS_AUTH_COOKIE_SECRET or STEAMHARNESS_SERVER_ADMIN_KEY is required to issue auth cookies.");
  }
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const envelope: AuthCookieEnvelope = { v: 1, payload: session, sig: signCookiePayload(payload, secret) };
  return encodeURIComponent(JSON.stringify(envelope));
}

export function readCookieSession(value: string): AuthCookieSession | undefined {
  try {
    const decodedValue = value.trim().startsWith("{") ? value : decodeURIComponent(value);
    const parsed = JSON.parse(decodedValue) as { v?: unknown; payload?: unknown; sig?: unknown };
    if (parsed.v !== 1 || !isProjectAuthCookieSession(parsed.payload) || typeof parsed.sig !== "string") {
      return undefined;
    }
    const secret = getAuthCookieSecret();
    if (!secret) return undefined;
    const payload = Buffer.from(JSON.stringify(parsed.payload), "utf8").toString("base64url");
    if (!verifyCookieSignature(payload, parsed.sig, secret)) return undefined;
    return parsed.payload;
  } catch {
    return undefined;
  }
}

export function getAuthCookieSecret(): string {
  return process.env.STEAMHARNESS_AUTH_COOKIE_SECRET?.trim() || getConfiguredAdminKey();
}

export function parseCookieHeader(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const output: Record<string, string> = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim();
    if (key) output[key] = decodeURIComponent(rest.join("=").trim());
  }
  return output;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new HttpError(400, 400, "Password must contain at least 8 characters.");
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, PASSWORD_SCRYPT_N, PASSWORD_SCRYPT_R, PASSWORD_SCRYPT_P);
  return [
    "scrypt",
    PASSWORD_SCRYPT_N,
    PASSWORD_SCRYPT_R,
    PASSWORD_SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, rawN, rawR, rawP, rawSalt, rawHash] = encoded.split("$");
  if (algorithm !== "scrypt" || !rawN || !rawR || !rawP || !rawSalt || !rawHash) return false;
  const expected = Buffer.from(rawHash, "base64url");
  const actual = await derivePassword(password, Buffer.from(rawSalt, "base64url"), Number(rawN), Number(rawR), Number(rawP));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function derivePassword(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new HttpError(400, 400, "Email is invalid.");
  }
  return email;
}

function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toAuthSession(
  user: Pick<NativeAuthUserRow, "id" | "email" | "display_name">,
  accessToken: string,
  refreshToken: string,
  accessExpiresAt: Date,
): AuthSession {
  return {
    accessToken,
    refreshToken,
    expiresAt: accessExpiresAt.toISOString(),
    user: { userId: user.id, email: user.email, displayName: user.display_name || user.email },
  };
}

function toAuthUserRecord(user: NativeAuthUserRow): AuthUserRecord {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name || user.email,
    createdAt: user.created_at.toISOString(),
    lastSignInAt: user.last_sign_in_at?.toISOString(),
  };
}

function readAuthPublicBaseUrl(redirectTo?: string): string {
  const configuredBase = process.env.STEAMHARNESS_AUTH_PUBLIC_BASE_URL?.trim()
    || process.env.STEAMHARNESS_API_PUBLIC_BASE_URL?.trim();
  for (const value of [configuredBase, configuredBase ? undefined : redirectTo]) {
    if (!value?.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Continue to the local fallback.
    }
  }
  return `http://127.0.0.1:${process.env.STEAMHARNESS_SERVER_PORT?.trim() || "7130"}`;
}

function isProjectAuthCookieSession(value: unknown): value is AuthCookieSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as { kind?: unknown; refreshToken?: unknown };
  return record.kind === "admin_key"
    || (record.kind === "refresh" && typeof record.refreshToken === "string" && record.refreshToken.trim() !== "");
}

function signCookiePayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function verifyCookieSignature(payload: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signCookiePayload(payload, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return readBearerTokenFromValue(Array.isArray(header) ? header[0] : header);
}

function readBearerTokenFromValue(value: string | undefined): string | undefined {
  return /^Bearer\s+(.+)$/iu.exec(value?.trim() ?? "")?.[1]?.trim();
}

function readRequestIp(req: Request): string | undefined {
  const forwarded = req.header("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.ip || undefined;
}
