import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { getAuthCookieSecret, hashPassword, verifyPassword } from "./account-auth";
import { mailConfigured, sendAuthEmail, type EmailPurpose } from "./auth-mail";
import { HttpError } from "./protocol";

export interface AccountSecurity {
  username: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  hasPassword: boolean;
}
export interface IdentityProof { password?: string; reauthChallengeId?: string; reauthCode?: string }
interface IdentityRow {
  id: string; username: string | null; email: string | null; email_verified_at: Date | null;
  password_hash: string | null; disabled: boolean; identity_version: number;
}
interface ChallengeRow {
  id: string; email: string; purpose: EmailPurpose; user_id: string | null; code_hash: string;
  identity_version: number; attempts: number; expires_at: Date; consumed_at: Date | null;
}
const invalidCode = () => new HttpError(400, 400, "Verification code is invalid or expired.");

export function registrationEnabled(): boolean {
  return ["true", "1"].includes(process.env.STEAMHARNESS_SERVER_REGISTRATION_ENABLED?.trim() || "");
}
export function normalizeUsername(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(name)) throw new HttpError(400, 400, "Username must contain 3–32 letters, numbers, underscores or hyphens.");
  return name;
}
function emailAddress(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new HttpError(400, 400, "Email is invalid.");
  return email;
}
function digest(value: string): string { return createHmac("sha256", getAuthCookieSecret()).update(`account-code:${value}`).digest("hex"); }

/** Verification challenges share the account database, so multiple Server processes enforce the same limits. */
export class AccountIdentityService {
  readonly ready: Promise<void>;
  constructor(private readonly options: {
    pool: pg.Pool; baseReady: Promise<void>;
    revokeSessions(userId: string, client: pg.PoolClient): Promise<void>;
    sendMail?: typeof sendAuthEmail;
  }) { this.ready = this.init(); }

  private async init(): Promise<void> {
    await this.options.baseReady;
    await this.options.pool.query(`
      alter table steamharness_auth_users add column if not exists username text;
      alter table steamharness_auth_users add column if not exists identity_version integer not null default 0;
      alter table steamharness_auth_users add column if not exists email_verified_at timestamptz;
      alter table steamharness_auth_users alter column email drop not null;
      alter table user_profiles alter column email drop not null;
      create unique index if not exists steamharness_auth_users_username_idx on steamharness_auth_users(lower(username));
      create table if not exists steamharness_auth_email_challenges (
        id text primary key, email text not null, purpose text not null,
        user_id text references steamharness_auth_users(id) on delete cascade,
        code_hash text not null, identity_version integer not null default 0, attempts integer not null default 0,
        ip_hash text not null, expires_at timestamptz not null, consumed_at timestamptz,
        created_at timestamptz not null default now()
      );
      alter table steamharness_auth_email_challenges add column if not exists identity_version integer not null default 0;
      create index if not exists steamharness_auth_email_challenges_email_idx on steamharness_auth_email_challenges(email,created_at desc);
      create index if not exists steamharness_auth_email_challenges_ip_idx on steamharness_auth_email_challenges(ip_hash,created_at desc);
    `);
  }

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.options.pool.connect();
    try { await client.query("begin"); const value = await run(client); await client.query("commit"); return value; }
    catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") throw new HttpError(409, 409, "Username or email is already in use.");
      throw error;
    } finally { client.release(); }
  }

  private async user(userId: string, client: Pick<pg.Pool, "query"> = this.options.pool): Promise<IdentityRow> {
    const row = (await client.query<IdentityRow>("select id,username,email,email_verified_at,password_hash,disabled,identity_version from steamharness_auth_users where id=$1", [userId])).rows[0];
    if (!row || row.disabled) throw new HttpError(403, 403, "Account is disabled.");
    const profile = (await client.query<{ status: string }>("select status from user_profiles where user_id=$1", [userId])).rows[0];
    if (!profile || profile.status !== "active") throw new HttpError(403, 403, "Account is disabled.");
    return row;
  }

  async security(userId: string): Promise<AccountSecurity> {
    await this.ready;
    const user = await this.user(userId);
    return { username: user.username, email: user.email, emailVerifiedAt: user.email_verified_at?.toISOString() ?? null, hasPassword: Boolean(user.password_hash) };
  }

  async sendCode(input: { email: string; purpose: EmailPurpose; userId?: string; ip: string; locale?: string }): Promise<{ challengeId: string; expiresAt: string; retryAfterSeconds: number }> {
    await this.ready;
    if (input.purpose === "register" && !registrationEnabled()) throw new HttpError(403, 403, "Registration is closed.");
    if (!mailConfigured() && !this.options.sendMail) throw new HttpError(503, 503, "Email service is unavailable.");
    const email = emailAddress(input.email), id = randomUUID();
    const code = String(randomInt(1_000_000)).padStart(6, "0"), expiresAt = new Date(Date.now() + 600_000).toISOString();
    let targetUserId: string | null = null, deliver = true, identityVersion = 0;
    if (input.purpose === "reauth" || input.purpose === "bind-email") {
      if (!input.userId) throw new HttpError(401, 401, "Unauthorized.");
      const user = await this.user(input.userId);
      if (input.purpose === "reauth" && (user.email !== email || !user.email_verified_at)) throw new HttpError(400, 400, "Verify your bound email first.");
      targetUserId = user.id; identityVersion = user.identity_version;
    } else {
      const row = (await this.options.pool.query<IdentityRow>("select id,username,email,email_verified_at,password_hash,disabled,identity_version from steamharness_auth_users where lower(email)=$1", [email])).rows[0];
      if (input.purpose === "register") deliver = !row;
      else { targetUserId = row?.email_verified_at && !row.disabled ? row.id : null; deliver = Boolean(targetUserId); identityVersion = row?.identity_version ?? 0; }
    }
    const ipHash = digest(`ip:${input.ip}`);
    await this.transaction(async client => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`email-code:${email}`]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`email-code-ip:${ipHash}`]);
      const limits = (await client.query<{ cooldown: boolean; email_count: number; ip_count: number }>(`
        select exists(select 1 from steamharness_auth_email_challenges where email=$1 and created_at>now()-interval '60 seconds') as cooldown,
        (select count(*)::int from steamharness_auth_email_challenges where email=$1 and created_at>now()-interval '1 hour') as email_count,
        (select count(*)::int from steamharness_auth_email_challenges where ip_hash=$2 and created_at>now()-interval '1 hour') as ip_count`, [email,ipHash])).rows[0];
      if (limits.cooldown || limits.email_count >= 10 || limits.ip_count >= 30) throw new HttpError(429, 429, "Too many verification requests. Try again later.");
      await client.query("update steamharness_auth_email_challenges set consumed_at=now() where email=$1 and purpose=$2 and user_id is not distinct from $3 and consumed_at is null", [email,input.purpose,targetUserId]);
      await client.query("insert into steamharness_auth_email_challenges(id,email,purpose,user_id,code_hash,ip_hash,expires_at,identity_version) values($1,$2,$3,$4,$5,$6,$7,$8)", [id,email,input.purpose,targetUserId,digest(`${id}:${code}`),ipHash,expiresAt,identityVersion]);
      await client.query("delete from steamharness_auth_email_challenges where created_at<now()-interval '2 days'");
    });
    if (deliver) {
      try { await (this.options.sendMail ?? sendAuthEmail)({ email,code,purpose:input.purpose,locale:input.locale }); }
      catch { await this.options.pool.query("update steamharness_auth_email_challenges set consumed_at=now() where id=$1",[id]); throw new HttpError(503,503,"Email could not be sent. Try again later."); }
    }
    return { challengeId:id, expiresAt, retryAfterSeconds:60 };
  }

  private async consumeCode(challengeId: string, code: string, purpose: EmailPurpose, userId?: string): Promise<ChallengeRow> {
    const result = await this.transaction(async client => {
      const row = (await client.query<ChallengeRow>("select * from steamharness_auth_email_challenges where id=$1 for update",[challengeId])).rows[0];
      if (!row || row.purpose !== purpose || (userId !== undefined && row.user_id !== userId) || row.consumed_at || row.attempts >= 5 || row.expires_at.getTime() <= Date.now()) return undefined;
      await client.query("update steamharness_auth_email_challenges set attempts=attempts+1 where id=$1",[challengeId]);
      const expected=Buffer.from(row.code_hash,"hex"), actual=Buffer.from(digest(`${challengeId}:${code}`),"hex");
      if (!/^\d{6}$/.test(code) || expected.length !== actual.length || !timingSafeEqual(expected,actual)) return undefined;
      await client.query("update steamharness_auth_email_challenges set consumed_at=now() where id=$1",[challengeId]);
      return row;
    });
    if (!result) throw invalidCode();
    return result;
  }

  async register(input: { method: "username" | "email"; username?: string; password?: string; challengeId?: string; code?: string }): Promise<string> {
    if (!registrationEnabled()) throw new HttpError(403,403,"Registration is closed.");
    let email: string | null = null, username: string | null = null;
    if (input.method === "username") username=normalizeUsername(input.username ?? "");
    else { const challenge=await this.consumeCode(input.challengeId ?? "",input.code ?? "","register"); email=challenge.email; }
    const passwordHash=input.password ? await hashPassword(input.password) : null;
    if (input.method === "username" && !passwordHash) throw new HttpError(400,400,"Password is required.");
    const userId=randomUUID(), displayName=`SteamUser-${randomUUID().slice(0,8)}`;
    return this.transaction(async client => {
      if (!registrationEnabled()) throw new HttpError(403,403,"Registration is closed.");
      await client.query("insert into steamharness_auth_users(id,email,username,password_hash,display_name,email_verified_at) values($1,$2,$3,$4,$5,$6)",[userId,email,username,passwordHash,displayName,email ? new Date() : null]);
      await client.query("insert into user_profiles(user_id,email,display_name,status) values($1,$2,$3,'active')",[userId,email,displayName]);
      return userId;
    });
  }

  async loginWithCode(challengeId: string, code: string): Promise<{userId: string; identityVersion:number}> {
    const challenge=await this.consumeCode(challengeId,code,"login");
    if (!challenge.user_id) throw invalidCode();
    const user=await this.user(challenge.user_id);
    if (!user.email_verified_at || user.email !== challenge.email || user.identity_version !== challenge.identity_version) throw invalidCode();
    return {userId:user.id, identityVersion:user.identity_version};
  }

  private async prove(user: IdentityRow, proof: IdentityProof): Promise<void> {
    if (proof.password && user.password_hash && await verifyPassword(proof.password,user.password_hash)) return;
    if (user.email_verified_at && proof.reauthChallengeId && proof.reauthCode) {
      const challenge=await this.consumeCode(proof.reauthChallengeId,proof.reauthCode,"reauth",user.id);
      if (challenge.email === user.email && challenge.identity_version === user.identity_version) return;
    }
    throw new HttpError(401,401,"Verify your current password or email to continue.");
  }

  async setUsername(userId: string, username: string, proof: IdentityProof): Promise<void> {
    await this.ready;
    const user=await this.user(userId); await this.prove(user,proof);
    await this.transaction(async client => {
      await this.lockUser(client,userId);
      const current=await this.user(userId,client);
      if (current.identity_version !== user.identity_version) throw new HttpError(409,409,"Account changed. Try again.");
      if (current.username) throw new HttpError(409,409,"Username has already been set.");
      await client.query("update steamharness_auth_users set username=$2,updated_at=now() where id=$1",[userId,normalizeUsername(username)]);
    });
  }

  async updateEmail(userId: string, input: IdentityProof & { action: "bind" | "unbind"; challengeId?: string; code?: string }): Promise<void> {
    await this.ready;
    const user=await this.user(userId);
    const target=input.action === "bind" ? await this.consumeCode(input.challengeId ?? "",input.code ?? "","bind-email",userId) : undefined;
    // The signed-in account only needs the target code to add its first email
    // or verify the same unverified address. Replacing or removing one needs proof.
    if (!target || user.email && (user.email_verified_at || user.email !== target.email)) await this.prove(user,input);
    await this.transaction(async client => {
      await this.lockUser(client,userId);
      const current=await this.user(userId,client);
      if (current.identity_version !== user.identity_version || target && target.identity_version !== current.identity_version) throw new HttpError(409,409,"Account changed. Try again.");
      if (!target && (!current.username || !current.password_hash)) throw new HttpError(400,400,"Set a username and password before unbinding email.");
      await client.query("update steamharness_auth_users set email=$2,email_verified_at=$3,identity_version=identity_version+1,updated_at=now() where id=$1",[userId,target?.email ?? null,target ? new Date() : null]);
      await client.query("update user_profiles set email=$2,updated_at=now() where user_id=$1",[userId,target?.email ?? null]);
      await this.revokeLogins(client,userId);
    });
  }

  async setPassword(userId: string, password: string, proof: IdentityProof): Promise<void> {
    await this.ready;
    const user=await this.user(userId); await this.prove(user,proof);
    const passwordHash=await hashPassword(password);
    await this.transaction(async client => {
      await this.lockUser(client,userId);
      const current=await this.user(userId,client);
      if (current.identity_version !== user.identity_version) throw new HttpError(409,409,"Account changed. Try again.");
      await client.query("update steamharness_auth_users set password_hash=$2,identity_version=identity_version+1,updated_at=now() where id=$1",[userId,passwordHash]);
      await this.revokeLogins(client,userId);
    });
  }

  async resetPassword(challengeId: string, code: string, password: string): Promise<void> {
    const passwordHash=await hashPassword(password);
    const challenge=await this.consumeCode(challengeId,code,"password-reset");
    if (!challenge.user_id) throw invalidCode();
    await this.transaction(async client => {
      await this.lockUser(client,challenge.user_id!);
      const user=await this.user(challenge.user_id!,client);
      if (!user.email_verified_at || user.email !== challenge.email || user.identity_version !== challenge.identity_version) throw invalidCode();
      await client.query("update steamharness_auth_users set password_hash=$2,identity_version=identity_version+1,updated_at=now() where id=$1",[user.id,passwordHash]);
      await this.revokeLogins(client,user.id);
    });
  }

  private async lockUser(client: pg.PoolClient, userId: string): Promise<void> { await client.query("select id from steamharness_auth_users where id=$1 for update",[userId]); }
  async revokeLogins(client: pg.PoolClient, userId: string): Promise<void> {
    await this.options.revokeSessions(userId,client);
    await client.query("update steamharness_auth_invitations set revoked_at=coalesce(revoked_at,now()) where user_id=$1 and accepted_at is null",[userId]);
    await client.query("update api_keys set revoked_at=coalesce(revoked_at,now()) where user_id=$1 and source in ('desktop','cli')",[userId]);
    await client.query("update steamharness_auth_email_challenges set consumed_at=coalesce(consumed_at,now()) where user_id=$1",[userId]);
    await client.query("update steamharness_auth_device_codes set state='denied',updated_at=now() where approved_by_user_id=$1 and state='approved'",[userId]);
  }
}
