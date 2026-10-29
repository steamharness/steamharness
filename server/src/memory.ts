import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { createPostgresPool } from "./postgres";
import { ProjectAccessRepository } from "./project-access";
import { HttpError } from "./protocol";
import type { AuthenticatedPrincipal } from "./auth";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export interface MemoryIdentity {
  userId: string;
  credential?: string;
  sessionHash?: string;
  scope?: string;
  readOnly: boolean;
  manager: boolean;
}
export class AccountMemory {
  private pool: pg.Pool;
  private access: ProjectAccessRepository;
  private instance = "";
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  constructor(
    databaseUrl: string,
    private url = process.env.STEAMHARNESS_SERVER_MEMORY_URL,
    private token = process.env.STEAMHARNESS_SERVER_MEMORY_TOKEN,
  ) {
    this.pool = createPostgresPool({
      connectionString: databaseUrl,
      label: "SteamHarness memory",
    });
    this.access = new ProjectAccessRepository(this.pool);
  }
  async init() {
    await this.pool.query(`
 CREATE TABLE IF NOT EXISTS memory_instance (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),id text NOT NULL);
 INSERT INTO memory_instance(singleton,id) VALUES(true,'${randomUUID()}') ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS memory_preferences (user_id text PRIMARY KEY REFERENCES user_profiles(user_id) ON DELETE CASCADE,enabled boolean NOT NULL DEFAULT true,automatic boolean NOT NULL DEFAULT true);
 CREATE TABLE IF NOT EXISTS memory_scopes (user_id text NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,scope text NOT NULL,label text NOT NULL DEFAULT '',PRIMARY KEY(user_id,scope));
 CREATE TABLE IF NOT EXISTS memory_credentials (hash text PRIMARY KEY,user_id text NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,parent_key text,parent_session text,parent_credential text,scope text,read_only boolean NOT NULL DEFAULT false,expires_at timestamptz NOT NULL,revoked_at timestamptz);
 CREATE INDEX IF NOT EXISTS memory_credentials_user ON memory_credentials(user_id);
 CREATE TABLE IF NOT EXISTS memory_jobs (id text PRIMARY KEY,user_id text NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,scope text NOT NULL,identity jsonb NOT NULL,payload jsonb NOT NULL,states jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS result jsonb;
 ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS payload_hash text;
 CREATE INDEX IF NOT EXISTS memory_jobs_pending ON memory_jobs(status,available_at);
 CREATE TABLE IF NOT EXISTS memory_operation_receipts(user_id text NOT NULL,operation_id text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,operation_id));`);
    this.instance = (
      await this.pool.query("SELECT id FROM memory_instance WHERE singleton")
    ).rows[0].id;
    this.schedule();
  }
  get configured() {
    return (
      !!this.url &&
      !!this.token &&
      process.env.STEAMHARNESS_SERVER_MEMORY_DISABLED !== "1"
    );
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    await this.pool.end();
  }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.work()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, 1000);
    this.timer.unref();
  }
  async issue(userId: string, parentKey: string, expiresAt?: string) {
    const token = "shma_" + randomBytes(32).toString("base64url");
    await this.pool.query(
      "INSERT INTO memory_credentials(hash,user_id,parent_key,expires_at) VALUES($1,$2,$3,$4)",
      [
        hash(token),
        userId,
        parentKey,
        expiresAt ?? new Date(Date.now() + 30 * 86400000).toISOString(),
      ],
    );
    return token;
  }
  async identify(
    token: string | undefined,
    principal?: AuthenticatedPrincipal,
  ): Promise<MemoryIdentity> {
    if (token?.startsWith("shm")) {
      const row = (
        await this.pool.query(
          "SELECT * FROM memory_credentials WHERE hash=$1 AND revoked_at IS NULL AND expires_at>now()",
          [hash(token)],
        )
      ).rows[0];
      if (!row) throw new HttpError(401, 401, "Memory authentication expired.");
      const identity = {
        userId: row.user_id,
        credential: hash(token),
        scope: row.scope ?? undefined,
        readOnly: row.read_only,
        manager: !row.scope,
      };
      await this.validate(identity);
      return identity;
    }
    if (
      principal &&
      (principal.kind === "user_session" || principal.kind === "admin_session")
    )
      return {
        userId: principal.userId,
        sessionHash: hash(principal.refreshToken),
        readOnly: false,
        manager: true,
      };
    throw new HttpError(401, 401, "Sign in again to authorize account memory.");
  }
  private async validate(
    identity: MemoryIdentity,
    db: Pick<pg.Pool, "query"> | pg.PoolClient = this.pool,
  ): Promise<void> {
    const user = (
      await db.query(
        "SELECT status FROM user_profiles WHERE user_id=$1 FOR SHARE",
        [identity.userId],
      )
    ).rows[0];
    if (user?.status !== "active")
      throw new HttpError(403, 403, "Account is not active.");
    if (identity.sessionHash) {
      const s = await db.query(
        "SELECT 1 FROM steamharness_auth_sessions WHERE refresh_token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE",
        [identity.sessionHash, identity.userId],
      );
      if (!s.rowCount) throw new HttpError(401, 401, "Session expired.");
    }
    if (identity.credential) {
      const row = (
        await db.query(
          "SELECT * FROM memory_credentials WHERE hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE",
          [identity.credential, identity.userId],
        )
      ).rows[0];
      if (!row) throw new HttpError(401, 401, "Memory authorization expired.");
      if (row.parent_key) {
        const key = await db.query(
          "SELECT 1 FROM api_keys WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) FOR SHARE",
          [row.parent_key, identity.userId],
        );
        if (!key.rowCount)
          throw new HttpError(401, 401, "Parent login revoked.");
      }
      if (row.parent_credential)
        await this.validate(
          {
            ...identity,
            credential: row.parent_credential,
            sessionHash: undefined,
          },
          db,
        );
      if (row.parent_session)
        await this.validate(
          {
            ...identity,
            credential: undefined,
            sessionHash: row.parent_session,
          },
          db,
        );
    }
    if (identity.scope)
      await this.authorizeScope(identity.userId, identity.scope, db);
  }
  private async locked<T>(
    identity: MemoryIdentity,
    fn: (db: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('steamharness-resource-access'))",
      );
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `memory:${identity.userId}`,
      ]);
      await this.validate(identity, db);
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  private async authorizeScope(
    userId: string,
    scope: string,
    db: Pick<pg.Pool, "query"> | pg.PoolClient = this.pool,
  ) {
    if (scope === "global") return;
    if (scope.startsWith("project:")) {
      const id = scope.slice(8);
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id))
        throw new HttpError(400, 400, "Invalid project identity.");
      const a = await this.access.resolve(
        "project",
        id,
        { userId, isSystemAdmin: false },
        db,
      );
      if (!a.capabilities.includes("read"))
        throw new HttpError(403, 403, "Project memory is locked.");
      return;
    }
    if (
      scope.startsWith("directory:") &&
      (
        await db.query(
          "SELECT 1 FROM memory_scopes WHERE user_id=$1 AND scope=$2",
          [userId, scope],
        )
      ).rowCount
    )
      return;
    throw new HttpError(403, 403, "Memory scope is not authorized.");
  }
  private selectScope(identity: MemoryIdentity, raw: unknown) {
    if (raw !== undefined && typeof raw !== "string")
      throw new HttpError(400, 400, "Invalid memory scope.");
    const scope = typeof raw === "string" ? raw : "global";
    if (identity.scope && scope !== "global" && scope !== identity.scope)
      throw new HttpError(403, 403, "Memory scope is not authorized.");
    return scope;
  }
  private async service(
    userId: string,
    body: Record<string, unknown>,
    timeout = 5000,
  ): Promise<any> {
    if (!this.configured)
      throw new HttpError(503, 503, "Memory service is not configured.");
    let response: Response;
    try {
      response = await fetch(`${this.url!.replace(/\/$/, "")}/v1/call`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          account: `${this.instance}:${userId}`,
          ...body,
        }),
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
      });
    } catch {
      throw new HttpError(
        503,
        503,
        "Memory service is temporarily unavailable.",
      );
    }
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      throw new HttpError(
        response.status,
        response.status,
        b.error ?? "Memory service is temporarily unavailable.",
      );
    }
    return (await response.json()).data;
  }
  async preferences(userId: string, db: Pick<pg.Pool, "query"> | pg.PoolClient = this.pool) {
    const r = await db.query(
      "SELECT enabled,automatic FROM memory_preferences WHERE user_id=$1",
      [userId],
    );
    return r.rows[0] ?? { enabled: true, automatic: true };
  }
  private async health(): Promise<{ automatic: boolean }> {
    if (!this.configured)
      throw new HttpError(503, 503, "Memory service is not configured.");
    try {
      const response = await fetch(`${this.url!.replace(/\/$/, "")}/health`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Memory health check failed.");
      const body = await response.json();
      if (body.fts !== true) throw new Error("Memory search is unavailable.");
      return { automatic: body.automatic === true };
    } catch {
      throw new HttpError(503, 503, "Memory service is temporarily unavailable.");
    }
  }
  async capabilities(identity: MemoryIdentity) {
    await this.validate(identity);
    const prefs = await this.preferences(identity.userId);
    let status = this.configured ? "unavailable" : "unconfigured",
      automatic = false;
    if (this.configured)
      try {
        const health = await this.health();
        status = "ready";
        automatic = health.automatic;
      } catch {}
    return {
      connected: this.configured,
      enabled: prefs.enabled,
      status,
      automatic: prefs.automatic && automatic,
      readOnly: identity.readOnly,
      currentScope: identity.scope,
      scopes: identity.scope ? ["global", identity.scope] : ["global"],
    };
  }
  async grant(identity: MemoryIdentity, body: any) {
    if (!identity.manager)
      throw new HttpError(403, 403, "Account memory credential required.");
    return this.locked(identity, async (db) => {
      let scope = body.scope;
      if (body.directory === true) {
        if (
          body.directoryId !== undefined &&
          (typeof body.directoryId !== "string" ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
              body.directoryId,
            ))
        )
          throw new HttpError(400, 400, "Invalid directory identity.");
        scope = `directory:${body.directoryId ?? randomUUID()}`;
        await db.query(
          "INSERT INTO memory_scopes(user_id,scope,label) VALUES($1,$2,$3) ON CONFLICT(user_id,scope) DO UPDATE SET label=$3",
          [identity.userId, scope, String(body.label ?? "").slice(0, 200)],
        );
      }
      if (typeof scope !== "string")
        throw new HttpError(400, 400, "Scope required.");
      await this.authorizeScope(identity.userId, scope, db);
      await db.query(
        "INSERT INTO memory_scopes(user_id,scope) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [identity.userId, scope],
      );
      const token = "shmu_" + randomBytes(32).toString("base64url"),
        expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
      await db.query(
        "INSERT INTO memory_credentials(hash,user_id,parent_credential,parent_session,scope,read_only,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          hash(token),
          identity.userId,
          identity.credential ?? null,
          identity.sessionHash ?? null,
          scope,
          body.readOnly === true,
          expiresAt,
        ],
      );
      return { token, scope, expiresAt };
    });
  }
  async revoke(identity: MemoryIdentity) {
    if (!identity.manager)
      throw new HttpError(403, 403, "Account memory credential required.");
    if (identity.credential)
      await this.pool.query(
        "UPDATE memory_credentials SET revoked_at=now() WHERE hash=$1",
        [identity.credential],
      );
    return {};
  }
  async execute(identity: MemoryIdentity, action: string, b: any = {}) {
    return this.locked(identity, async (db) => {
      const prefs = await this.preferences(identity.userId, db);
      if (action === "preferences") return prefs;
      if (action === "setPreferences") {
        if (!identity.manager)
          throw new HttpError(403, 403, "Account memory credential required.");
        if (typeof b.enabled !== "boolean" || typeof b.automatic !== "boolean")
          throw new HttpError(400, 400, "Invalid memory preferences.");
        await db.query(
          "INSERT INTO memory_preferences(user_id,enabled,automatic) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET enabled=$2,automatic=$3",
          [identity.userId, b.enabled, b.automatic],
        );
        return b;
      }
      if (!prefs.enabled && !identity.manager)
        throw new HttpError(403, 403, "Account memory is disabled.");
      let all = identity.scope
        ? ["global", identity.scope]
        : [
            "global",
            ...(
              await db.query(
                "SELECT scope FROM memory_scopes WHERE user_id=$1",
                [identity.userId],
              )
            ).rows.map((r) => r.scope),
          ];
      all = [...new Set(all)];
      const readable: string[] = [],
        locked: string[] = [];
      for (const s of all) {
        try {
          await this.authorizeScope(identity.userId, s, db);
          readable.push(s);
        } catch (e) {
          if (
            e instanceof HttpError &&
            (e.statusCode === 403 || e.statusCode === 404)
          )
            locked.push(s);
          else throw e;
        }
      }
      if (action === "scopes") {
        if (!identity.manager)
          throw new HttpError(403, 403, "Account memory credential required.");
        const registered = (
          await db.query(
            "SELECT scope,label FROM memory_scopes WHERE user_id=$1",
            [identity.userId],
          )
        ).rows;
        return registered.map((r) => ({
          scope: r.scope,
          label: locked.includes(r.scope) ? "" : r.label,
          locked: locked.includes(r.scope),
        }));
      }
      if (action === "jobs") {
        if (!identity.manager)
          throw new HttpError(403, 403, "Account memory credential required.");
        return (
          await db.query(
            "SELECT id,status,attempts,error,updated_at FROM memory_jobs WHERE user_id=$1 AND status IN ('pending','running','failed') ORDER BY created_at DESC LIMIT 30",
            [identity.userId],
          )
        ).rows;
      }
      if (action === "retry") {
        if (!identity.manager)
          throw new HttpError(403, 403, "Account memory credential required.");
        await db.query(
          "UPDATE memory_jobs SET status='pending',attempts=0,error=NULL,available_at=now() WHERE id=$1 AND user_id=$2 AND status='failed'",
          [b.id, identity.userId],
        );
        return {};
      }
      if (action === "list") {
        for (const key of ["scope", "query", "origin", "cursor"])
          if (b[key] !== undefined && typeof b[key] !== "string")
            throw new HttpError(400, 400, "Invalid memory filter.");
        const scopes = b.scope
          ? [this.selectScope(identity, b.scope)]
          : readable;
        if (scopes.some((s) => !readable.includes(s)))
          throw new HttpError(403, 403, "Memory scope is locked.");
        const page = await this.service(identity.userId, {
          method: "list",
          scopes,
          options: {
            query: b.query,
            origin: b.origin,
            cursor: b.cursor,
            pageSize: b.pageSize === undefined ? 20 : Number(b.pageSize),
          },
        });
        return {
          ...page,
          locked:
            identity.manager && !b.query
              ? await this.service(identity.userId, {
                  method: "counts",
                  scopes: locked,
                })
              : {},
        };
      }
      if (action === "get")
        return this.service(identity.userId, {
          method: "get",
          id: b.id,
          scopes: readable,
        });
      if (action === "recall")
        return this.service(
          identity.userId,
          { method: "recall", query: String(b.query ?? ""), scopes: readable },
          1800,
        );
      if (identity.readOnly)
        throw new HttpError(403, 403, "Memory authorization is read-only.");
      if (action === "turn") {
        if (!prefs.automatic) return { accepted: false };
        if (!identity.scope)
          throw new HttpError(
            403,
            403,
            "Scoped memory authorization required.",
          );
        if (
          typeof b.turnId !== "string" ||
          !b.turnId ||
          b.turnId.length > 160 ||
          !Array.isArray(b.messages) ||
          b.messages.length !== 2 ||
          b.messages[0]?.role !== "user" ||
          b.messages[1]?.role !== "assistant" ||
          b.messages.some(
            (m: any) =>
              typeof m.id !== "string" ||
              !m.id ||
              typeof m.content !== "string" ||
              m.content.length > 100000 ||
              !Number.isFinite(m.timestamp),
          )
        )
          throw new HttpError(400, 400, "Invalid persisted turn.");
        const id = hash(`${this.instance}:${identity.userId}:${b.turnId}`),
          payload = {
            turnId: b.turnId,
            messages: b.messages,
            scope: identity.scope,
          };
        const payloadHash = hash(
          JSON.stringify({
            scope: payload.scope,
            turnId: payload.turnId,
            messages: payload.messages.map((m: any) => ({
              id: m.id,
              role: m.role,
              content: m.content,
            })),
          }),
        );
        const existing = (
          await db.query("SELECT payload_hash FROM memory_jobs WHERE id=$1", [
            id,
          ])
        ).rows[0];
        if (existing && existing.payload_hash !== payloadHash)
          throw new HttpError(
            409,
            409,
            "Turn ID reused with different messages.",
          );
        if (existing) return { accepted: true, jobId: id };
        // Manual-only mode is healthy, but cannot process L0 turns. Do not enqueue
        // guaranteed failures; transient service errors still fail for host retry.
        if (!(await this.health()).automatic) return { accepted: false };
        const states = await this.service(identity.userId, {
          method: "stageTurn",
          turn: payload,
        });
        await db.query(
          "INSERT INTO memory_jobs(id,user_id,scope,identity,payload,states,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [
            id,
            identity.userId,
            identity.scope,
            JSON.stringify(identity),
            JSON.stringify({ turnId: payload.turnId }),
            JSON.stringify(states),
            payloadHash,
          ],
        );
        return { accepted: true, jobId: id };
      }
      if (!["remember", "update", "forget", "clear"].includes(action))
        throw new HttpError(400, 400, "Unknown memory operation.");
      if (
        typeof b.operationId !== "string" ||
        !b.operationId ||
        b.operationId.length > 200
      )
        throw new HttpError(400, 400, "A stable operation ID is required.");
      let scope = this.selectScope(identity, b.scope);
      if (action === "update" || action === "forget") {
        const old = await this.service(identity.userId, {
          method: "locate",
          id: b.id,
          scopes: action === "forget" && identity.manager ? all : readable,
        });
        scope = old.scope;
      }
      if (action === "clear" && identity.manager && !all.includes(scope))
        throw new HttpError(403, 403, "Memory scope is not authorized.");
      if (!(["forget", "clear"].includes(action) && identity.manager))
        await this.authorizeScope(identity.userId, scope, db);
      await db.query(
        "INSERT INTO memory_scopes(user_id,scope) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [identity.userId, scope],
      );
      const result = await this.service(identity.userId, {
        method: "apply",
        operation: {
          operationId: b.operationId,
          action,
          scope,
          id: b.id,
          version: b.version,
          content: b.content,
        },
      });
      await db.query(
        "INSERT INTO memory_operation_receipts VALUES($1,$2,$3,now()) ON CONFLICT DO NOTHING",
        [
          identity.userId,
          b.operationId,
          JSON.stringify({ action, scope, id: result.id }),
        ],
      );
      return result;
    });
  }
  private async work() {
    if (!this.configured) return;
    await this.pool.query(
      "UPDATE memory_jobs SET status='failed',error='Memory extraction interrupted.',lease_until=NULL WHERE status='running' AND lease_until<now() AND attempts>=3",
    );
    const job = (
      await this.pool.query(
        `UPDATE memory_jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=(SELECT id FROM memory_jobs WHERE (status='pending' AND available_at<=now() OR status='running' AND lease_until<now()) AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
      )
    ).rows[0];
    if (!job) return;
    try {
      const identity = job.identity as MemoryIdentity;
      // Job authorization is re-created from its parent login, rather than expiring with the short runtime grant.
      const grant = (
        await this.pool.query(
          "SELECT * FROM memory_credentials WHERE hash=$1",
          [identity.credential],
        )
      ).rows[0];
      if (!grant || grant.revoked_at)
        throw new HttpError(403, 403, "Memory authorization revoked.");
      const parent: MemoryIdentity = {
        ...identity,
        credential: grant.parent_credential ?? undefined,
        sessionHash: grant.parent_session ?? undefined,
      };
      await this.validate(parent);
      const prefs = await this.preferences(identity.userId);
      if (!prefs.enabled || !prefs.automatic)
        throw new HttpError(403, 403, "Automatic memory is disabled.");
      const candidates =
        job.result ??
        (await this.service(
          identity.userId,
          { method: "extract", turnId: job.payload.turnId },
          250000,
        ));
      await this.pool.query("UPDATE memory_jobs SET result=$2 WHERE id=$1", [
        job.id,
        JSON.stringify(candidates),
      ]);
      await this.locked(parent, async (db) => {
        const p = await this.preferences(identity.userId, db);
        if (!p.enabled || !p.automatic)
          throw new HttpError(403, 403, "Automatic memory is disabled.");
        for (const scope of new Set(["global", job.scope])) {
          await this.authorizeScope(identity.userId, scope, db);
          await this.service(identity.userId, {
            method: "apply",
            operation: {
              operationId: `job:${job.id}:${scope}`,
              action: "extract",
              scope,
              expected: job.states[scope],
              candidates: candidates.filter((c: any) => c.scope === scope),
            },
          });
        }
        await this.service(identity.userId, {
          method: "completeTurn",
          turnId: job.payload.turnId,
        });
        await db.query(
          "UPDATE memory_jobs SET status='done',payload='{}',identity='{}',result=NULL,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
          [job.id],
        );
      });
    } catch (e) {
      const denied =
        e instanceof HttpError && [401, 403, 404].includes(e.statusCode);
      await this.pool.query(
        "UPDATE memory_jobs SET status=$2,error=$3,lease_until=NULL,available_at=now()+interval '10 seconds',updated_at=now() WHERE id=$1",
        [
          job.id,
          denied || job.attempts >= 3 ? "failed" : "pending",
          denied ? "Authorization changed." : "Memory extraction failed.",
        ],
      );
    }
  }
}
