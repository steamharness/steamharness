import { executeTableData, type TableDataRequest } from "./table-data";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { assertDatabaseAlias, DatabaseResourceError, type DatabaseResource, type DatabaseGrant, type DatabaseAccessMode,
  type DatabaseBinding, type DatabaseConsumerIdentity, type DatabaseBindingIdentity,
  type DatabaseMigration, type DatabaseMigrationState, type DatabaseMigrationPlan } from "steamharness/database";
import { createPostgresClient, createPostgresPool } from "../postgres";
import { DatabaseCluster, databaseNames } from "./cluster";
import { emptyDifference, schemaDifference, validateModel } from "./engine";
import { BINDINGS_SQL, CATALOG_SQL, DATABASE_CATALOG_SCHEMA, DATABASE_HISTORY_SCHEMA, hash, identifier as q,
  modelHash, destructiveMigration, validateMigrationHistory } from "./schema";

interface AppliedMigration extends DatabaseMigrationState { readonly schema: string }
const uuid = (value: string): string => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "A database resource UUID is required.");
  return value.toLowerCase();
};
const userId = (value: string): string => {
  if (!value || value.length > 256 || value.includes("\0")) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "An account identity is required.");
  return value;
};
function consumerIdentity(value: DatabaseConsumerIdentity): DatabaseConsumerIdentity {
  const projectId = uuid(value.projectId);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value.entryId)) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "An entry identifier is required.");
  try { assertDatabaseAlias(value.alias); }
  catch { throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "A generated database alias is required."); }
  return { projectId, entryId: value.entryId, alias: value.alias };
}
interface ConnectionRequest extends DatabaseConsumerIdentity { schemaHash: string; binding?: DatabaseBindingIdentity }

async function advisoryLock<T>(pool: pg.Pool, key: string, message: string, work: () => Promise<T>, wait: boolean, shared = false): Promise<T> {
  const client = await pool.connect();
  const suffix = shared ? "_shared" : "";
  let locked = false, previousTimeout: string | undefined, releaseError: Error | undefined;
  try {
    if (wait) {
      previousTimeout = (await client.query("select current_setting('lock_timeout') as timeout")).rows[0].timeout;
      await client.query("select set_config('lock_timeout','5s',false)");
      try {
        await client.query(`select pg_advisory_lock${suffix}(hashtextextended($1,0))`, [key]);
        locked = true;
      } catch (error) {
        if ((error as { code?: string }).code !== '55P03') throw error;
      }
    } else {
      locked = (await client.query(`select pg_try_advisory_lock${suffix}(hashtextextended($1,0)) as locked`, [key])).rows[0].locked;
    }
    if (!locked) throw new DatabaseResourceError('DATABASE_BUSY', message);
    return await work();
  } finally {
    try {
      if (locked) await client.query(`select pg_advisory_unlock${suffix}(hashtextextended($1,0))`, [key]);
      if (previousTimeout !== undefined) await client.query("select set_config('lock_timeout',$1,false)", [previousTimeout]);
    } catch (error) { releaseError = error as Error; throw error; }
    finally { client.release(releaseError); }
  }
}

export class RelationalDatabaseRepository {
  readonly cluster: DatabaseCluster;
  private readonly pool: pg.Pool;
  private readonly lockPool: pg.Pool;
  private readonly bindingLockPool: pg.Pool;
  private readonly catalog: string;
  private timer?: ReturnType<typeof setInterval>;
  private cleanupTask?: Promise<void>;

  constructor(connectionString: string, options: { adminConnectionString: string; schema?: string }) {
    this.catalog = q(options.schema ?? DATABASE_CATALOG_SCHEMA);
    this.pool = createPostgresPool({ connectionString, label: "relational database catalog", max: 6, connectionTimeoutMillis: 10_000 });
    this.lockPool = createPostgresPool({ connectionString, label: "database management locks", max: 4, connectionTimeoutMillis: 10_000 });
    this.bindingLockPool = createPostgresPool({ connectionString, label: "database binding locks", max: 4, connectionTimeoutMillis: 10_000 });
    this.cluster = new DatabaseCluster(options.adminConnectionString);
  }
  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`steamharness:database:catalog:${this.catalog}`]);
      await client.query(`create schema if not exists ${this.catalog};
        create table if not exists ${this.catalog}.schema_migrations(version integer primary key,checksum text not null)`);
      for (const [index, sql] of [CATALOG_SQL, BINDINGS_SQL].entries()) {
        const version = index + 1, previous = await client.query(`select checksum from ${this.catalog}.schema_migrations where version=$1`, [version]);
        if (previous.rows[0] && previous.rows[0].checksum !== hash(sql)) throw new Error("Database catalog migration checksum does not match.");
        if (!previous.rowCount) {
          await client.query(sql.replaceAll("__SCHEMA__", this.catalog));
          await client.query(`insert into ${this.catalog}.schema_migrations values($1,$2)`, [version, hash(sql)]);
        }
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
    finally { client.release(); }
    const pending = await this.pool.query(`select id,owner_user_id,status from ${this.catalog}.resources where status in ('requested','provisioning','ready')`);
    for (const row of pending.rows) {
      try {
        if (row.status !== "ready") await this.provision(row.id, row.owner_user_id);
        else await this.lock(row.id, async () => {
          await this.cluster.disableRole(databaseNames(row.id).owner);
          await this.cluster.protectHistory(row.id);
          await this.cluster.authorizeMigration(row.id);
          await this.cluster.cleanShadow(row.id);
          // A crashed planning request also leaves a shadow database, without
          // a running deploy. Clean transient identities under the same lock.
          if ((await this.owner(row.owner_user_id, row.id)).migrationStatus !== "running") return;
          await this.synchronizeHistory(row.id);
          await this.pool.query(`update ${this.catalog}.migration_attempts set status='failed',failure_code='DATABASE_MIGRATION_FAILED',ended_at=clock_timestamp() where database_id=$1 and status='running'`, [row.id]);
          await this.pool.query(`update ${this.catalog}.resources set migration_status='failed' where id=$1`, [row.id]);
        });
      } catch (error) { if (!(error instanceof DatabaseResourceError)) throw error; }
    }
    await this.expireCredentials();
    this.timer = setInterval(() => {
      this.cleanupTask ??= this.expireCredentials().catch(() => undefined).finally(() => { this.cleanupTask = undefined; });
    }, 30_000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    clearInterval(this.timer); await this.cleanupTask;
    await Promise.all([this.pool.end(), this.lockPool.end(), this.bindingLockPool.end(), this.cluster.close()]);
  }

  async create(actor: string, input: { name: string; requestId: string }): Promise<DatabaseResource> {
    actor = userId(actor); const requestId = uuid(input.requestId), name = input.name.trim();
    if (!name || name.length > 128 || name.includes("\0")) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Use a database name with 1–128 characters.");
    const result = await this.pool.query(`insert into ${this.catalog}.resources(id,request_id,owner_user_id,name,status,stage)
      values($1,$2,$3,$4,'requested','requested') on conflict(owner_user_id,request_id) do nothing returning id`, [randomUUID(), requestId, actor, name]);
    const row = result.rows[0] ?? (await this.pool.query(`select id,name from ${this.catalog}.resources where owner_user_id=$1 and request_id=$2`, [actor, requestId])).rows[0];
    if (row.name !== undefined && row.name !== name) throw new DatabaseResourceError("DATABASE_HISTORY_CONFLICT", "The creation request ID was already used with another name.");
    const resource = await this.get(actor, row.id);
    if (["requested", "provisioning"].includes(resource.status)) await this.provision(resource.id, actor);
    return this.get(actor, resource.id);
  }

  async retry(actor: string, id: string): Promise<DatabaseResource> { await this.owner(actor, id); await this.provision(id, actor); return this.get(actor, id); }
  async list(actor: string): Promise<DatabaseResource[]> {
    const rows = await this.pool.query(`select r.* from ${this.catalog}.resources r where r.owner_user_id=$1 or exists
      (select 1 from ${this.catalog}.grants g where g.database_id=r.id and g.user_id=$1 and not g.revoked) order by r.created_at,r.id`, [userId(actor)]);
    return rows.rows.map(resourceView);
  }
  async listPage(actor: string, input: { page?: number; pageSize?: number; search?: string } = {}) {
    const page = input.page ?? 1, pageSize = input.pageSize ?? 20, search = input.search ?? '';
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || typeof search !== 'string' || search.length > 500) throw new DatabaseResourceError('DATABASE_INVALID_REQUEST', 'Invalid database pagination.');
    const where = `(r.owner_user_id=$1 or exists(select 1 from ${this.catalog}.grants g where g.database_id=r.id and g.user_id=$1 and not g.revoked)) and strpos(lower(r.name),lower($2))>0`;
    const total = Number((await this.pool.query(`select count(*) as total from ${this.catalog}.resources r where ${where}`, [userId(actor), search])).rows[0].total);
    const rows = await this.pool.query(`select r.* from ${this.catalog}.resources r where ${where} order by r.created_at,r.id limit $3 offset $4`, [actor, search, pageSize, (page - 1) * pageSize]);
    return { items: rows.rows.map(resourceView), total, page, pageSize };
  }
  async get(actor: string, id: string): Promise<DatabaseResource> {
    const rows = await this.pool.query(`select r.* from ${this.catalog}.resources r where r.id=$1 and (r.owner_user_id=$2 or exists
      (select 1 from ${this.catalog}.grants g where g.database_id=r.id and g.user_id=$2 and not g.revoked))`, [uuid(id), userId(actor)]);
    if (!rows.rowCount) throw new DatabaseResourceError("DATABASE_NOT_FOUND", "Database resource not found.");
    return resourceView(rows.rows[0]);
  }
  private async owner(actor: string, id: string): Promise<DatabaseResource> {
    const resource = await this.get(actor, id);
    if (resource.ownerUserId !== actor) throw new DatabaseResourceError("DATABASE_ACCESS_DENIED", "Only the database migration owner can manage this resource.");
    return resource;
  }
  private async ready(actor: string, id: string, manage = false): Promise<DatabaseResource> {
    const resource = await (manage ? this.owner(actor, id) : this.get(actor, id));
    if (resource.status !== "ready") throw new DatabaseResourceError("DATABASE_NOT_READY", "Database provisioning is not complete.");
    return resource;
  }
  private async lock<T>(id: string, work: () => Promise<T>, wait = false, shared = false): Promise<T> {
    return advisoryLock(this.lockPool, `steamharness:database:${this.catalog}:${uuid(id)}`,
      "Another database management operation is running. Retry shortly.", work, wait, shared);
  }
  private async provision(id: string, actor: string): Promise<void> {
    await this.lock(id, async () => {
      if ((await this.owner(actor, id)).status === "ready") return;
      try {
        await this.cluster.prepare();
        for (const [stage, action] of [
          ["roles", () => this.cluster.roles(id)], ["database", () => this.cluster.database(id)], ["permissions", () => this.cluster.permissions(id)],
        ] as const) {
          await this.pool.query(`update ${this.catalog}.resources set status='provisioning',stage=$2,failure_code=null,updated_at=clock_timestamp() where id=$1`, [id, stage]);
          await action();
        }
        await this.pool.query(`update ${this.catalog}.resources set status='ready',stage='ready',failure_code=null,updated_at=clock_timestamp() where id=$1`, [id]);
      } catch (error) {
        const code = error instanceof DatabaseResourceError ? error.code : "DATABASE_PROVISION_FAILED";
        await this.pool.query(`update ${this.catalog}.resources set status='failed',failure_code=$2,updated_at=clock_timestamp() where id=$1`, [id, code]);
      }
    });
  }

  async grants(actor: string, id: string): Promise<DatabaseGrant[]> {
    await this.owner(actor, id);
    return (await this.pool.query(`select * from ${this.catalog}.grants where database_id=$1 order by user_id`, [id])).rows.map(grantView);
  }
  async grant(actor: string, id: string, targetUserId: string, mode: DatabaseAccessMode): Promise<DatabaseGrant> {
    userId(targetUserId);
    if (!["read", "write"].includes(mode)) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Choose read or write database access.");
    return this.lock(id, async () => {
      await this.ready(actor, id, true);
      if (targetUserId === actor) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "The migration owner already has resource access.");
      const result = await this.pool.query(`insert into ${this.catalog}.grants(database_id,user_id,mode) values($1,$2,$3)
        on conflict(database_id,user_id) do update set mode=excluded.mode,revoked=false,revision=${this.catalog}.grants.revision+1 returning *`, [id, targetUserId, mode]);
      await this.revokeCredentials(id, targetUserId);
      return grantView(result.rows[0]);
    });
  }
  async revoke(actor: string, id: string, targetUserId: string): Promise<void> {
    userId(targetUserId);
    await this.lock(id, async () => {
      await this.owner(actor, id);
      if (targetUserId === actor) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "The database migration owner cannot be revoked through a sharing grant.");
      await this.pool.query(`update ${this.catalog}.grants set revoked=true,revision=revision+1 where database_id=$1 and user_id=$2`, [id, targetUserId]);
      await this.revokeCredentials(id, targetUserId);
    });
  }
  private async revokeCredentials(id: string, actor?: string): Promise<void> {
    // Fence lease renewal as well as current sessions. Regranting access or a
    // data-only migration must never revive an old client after its TTL elapses.
    await this.pool.query(`update ${this.catalog}.bindings set revision=revision+1 where database_id=$1 and ($2::text is null or user_id=$2)`, [id, actor ?? null]);
    const rows = await this.pool.query(`update ${this.catalog}.credentials set revoking=true where database_id=$1 and ($2::text is null or user_id=$2) returning id,role_name`, [id, actor ?? null]);
    for (const row of rows.rows) {
      await this.cluster.dropCredential(row.role_name);
      await this.pool.query(`delete from ${this.catalog}.credentials where id=$1`, [row.id]);
    }
  }
  private async expireCredentials(): Promise<void> {
    const rows = await this.pool.query(`select distinct database_id from ${this.catalog}.credentials where revoking or expires_at<=clock_timestamp()`);
    for (const row of rows.rows) {
      try { await this.lock(row.database_id, async () => {
        const expired = await this.pool.query(`select id,role_name from ${this.catalog}.credentials where database_id=$1 and (revoking or expires_at<=clock_timestamp())`, [row.database_id]);
        for (const item of expired.rows) { await this.cluster.dropCredential(item.role_name); await this.pool.query(`delete from ${this.catalog}.credentials where id=$1`, [item.id]); }
      }); } catch (error) { if (!(error instanceof DatabaseResourceError && error.code === "DATABASE_BUSY")) throw error; }
    }
  }

  private async bindingLock<T>(actor: string, input: DatabaseConsumerIdentity, work: (identity: DatabaseConsumerIdentity) => Promise<T>, wait = false, shared = false): Promise<T> {
    const identity = consumerIdentity(input);
    const key = JSON.stringify([this.catalog, userId(actor), identity.projectId, identity.entryId, identity.alias]);
    return advisoryLock(this.bindingLockPool, key,
      "Another operation is changing this database binding. Retry shortly.", () => work(identity), wait, shared);
  }
  private async findBinding(actor: string, identity: DatabaseConsumerIdentity): Promise<DatabaseBinding | undefined> {
    const result = await this.pool.query(`select * from ${this.catalog}.bindings where user_id=$1 and project_id=$2 and entry_id=$3 and alias=$4`, [actor, identity.projectId, identity.entryId, identity.alias]);
    return result.rows[0] ? bindingView(result.rows[0]) : undefined;
  }
  async bindings(actor: string, projectId: string, entryId: string): Promise<DatabaseBinding[]> {
    const identity = consumerIdentity({ projectId, entryId, alias: "main" });
    return (await this.pool.query(`select * from ${this.catalog}.bindings where user_id=$1 and project_id=$2 and entry_id=$3 order by alias`, [userId(actor), identity.projectId, identity.entryId])).rows.map(bindingView);
  }
  private async access(actor: string, id: string, mode?: DatabaseAccessMode, schemaHash?: string) {
    const resource = await this.ready(actor, id);
    if (resource.migrationStatus !== "idle") throw new DatabaseResourceError("DATABASE_BUSY", "Finish or retry the database migration before opening business connections.");
    if (schemaHash !== undefined && schemaHash !== resource.schemaHash) throw new DatabaseResourceError("DATABASE_SCHEMA_MISMATCH", "The generated model does not match the applied database migrations.");
    const grant = resource.ownerUserId === actor ? { mode: "write", revision: 1 } : (await this.pool.query(`select mode,revision from ${this.catalog}.grants where database_id=$1 and user_id=$2 and not revoked`, [id, actor])).rows[0];
    const requestedMode = mode ?? grant?.mode;
    if (!grant || !["read", "write"].includes(requestedMode) || requestedMode === "write" && grant.mode !== "write") throw new DatabaseResourceError("DATABASE_ACCESS_DENIED", "This account has read-only database access.");
    return { mode: requestedMode as DatabaseAccessMode, revision: grant.revision as number, resource };
  }
  private async revokeBindingCredentials(binding: DatabaseBinding): Promise<void> {
    await this.lock(binding.databaseId, async () => {
      const rows = await this.pool.query(`update ${this.catalog}.credentials set revoking=true where binding_id=$1 returning id,role_name`, [binding.id]);
      for (const row of rows.rows) {
        await this.cluster.dropCredential(row.role_name);
        await this.pool.query(`delete from ${this.catalog}.credentials where id=$1`, [row.id]);
      }
    });
  }
  /** A binding selects a resource already granted to this account; it cannot grant resource access. */
  async bind(actor: string, input: DatabaseConsumerIdentity & { databaseId: string; mode?: DatabaseAccessMode; schemaHash: string }): Promise<DatabaseBinding> {
    const id = uuid(input.databaseId);
    return this.bindingLock(actor, input, async identity => {
      // Validate before disconnecting an existing, valid mapping.
      const access = await this.lock(id, () => this.access(actor, id, input.mode, input.schemaHash));
      const previous = await this.findBinding(actor, identity);
      if (previous?.databaseId === id && previous.mode === access.mode) return previous;
      if (previous) await this.revokeBindingCredentials(previous);
      return this.lock(id, async () => {
        await this.access(actor, id, access.mode, input.schemaHash);
        const row = await this.pool.query(`insert into ${this.catalog}.bindings(id,user_id,project_id,entry_id,alias,database_id,mode) values($1,$2,$3,$4,$5,$6,$7)
          on conflict(user_id,project_id,entry_id,alias) do update set database_id=excluded.database_id,mode=excluded.mode,revision=${this.catalog}.bindings.revision+1 returning *`,
        [randomUUID(), actor, identity.projectId, identity.entryId, identity.alias, id, access.mode]);
        return bindingView(row.rows[0]);
      });
    });
  }
  async unbind(actor: string, input: DatabaseConsumerIdentity): Promise<void> {
    await this.bindingLock(actor, input, async identity => {
      const previous = await this.findBinding(actor, identity);
      if (!previous) return;
      await this.revokeBindingCredentials(previous);
      await this.pool.query(`delete from ${this.catalog}.bindings where id=$1`, [previous.id]);
    });
  }
  private async checkedBinding(actor: string, input: ConnectionRequest): Promise<DatabaseBinding> {
    const binding = await this.findBinding(actor, consumerIdentity(input));
    if (!binding) throw new DatabaseResourceError(input.binding ? "DATABASE_BINDING_CHANGED" : "DATABASE_UNBOUND", "This project entry's database alias is not bound on this host.");
    if (input.binding && (binding.id !== input.binding.id || binding.revision !== input.binding.revision)) throw new DatabaseResourceError("DATABASE_BINDING_CHANGED", "The database binding changed. Open a new client explicitly.");
    return binding;
  }
  async resolveQueryBinding(actor: string, input: ConnectionRequest) {
    return this.bindingLock(actor, input, async () => {
      const binding = await this.checkedBinding(actor, input);
      const access = await this.lock(binding.databaseId, () => this.access(actor, binding.databaseId, binding.mode, input.schemaHash), true);
      return { ...binding, accessRevision: access.revision };
    }, true);
  }
  async openConnection(actor: string, input: ConnectionRequest) {
    return this.bindingLock(actor, input, async () => {
      const binding = await this.checkedBinding(actor, input);
      const credential = await this.lock(binding.databaseId, () => this.issueCredentialsUnlocked(actor, binding.databaseId, { mode: binding.mode, expectedSchemaHash: input.schemaHash }, binding.id));
      return { binding, credential };
    });
  }
  async authorizeConnection(actor: string, credentialId: string, input: ConnectionRequest): Promise<void> {
    // Authorization only reads access state. Readers may overlap, while binding
    // changes, migrations and revocation retain their exclusive locks.
    await this.bindingLock(actor, input, async () => {
      const binding = await this.checkedBinding(actor, input);
      await this.lock(binding.databaseId, async () => {
        await this.access(actor, binding.databaseId, binding.mode, input.schemaHash);
        const credential = await this.pool.query(`select id from ${this.catalog}.credentials where id=$1 and user_id=$2 and binding_id=$3 and database_id=$4 and not revoking and expires_at>clock_timestamp()`, [uuid(credentialId), actor, binding.id, binding.databaseId]);
        if (!credential.rowCount) throw new DatabaseResourceError("DATABASE_CONNECTION_EXPIRED", "This database connection expired or was revoked. Open a new client.");
      }, true, true);
    }, true, true);
  }
  async closeConnection(actor: string, credentialId: string): Promise<void> {
    const rows = await this.pool.query(`select database_id from ${this.catalog}.credentials where id=$1 and user_id=$2 and binding_id is not null`, [uuid(credentialId), userId(actor)]);
    if (!rows.rowCount) return;
    await this.lock(rows.rows[0].database_id, async () => {
      const result = await this.pool.query(`update ${this.catalog}.credentials set revoking=true where id=$1 and user_id=$2 returning role_name`, [credentialId, actor]);
      if (!result.rowCount) return;
      await this.cluster.dropCredential(result.rows[0].role_name);
      await this.pool.query(`delete from ${this.catalog}.credentials where id=$1`, [credentialId]);
    });
  }

  /** Trusted native-host building block; projects receive the model facade, never this credential. */
  async issueCredentials(actor: string, id: string, options: { mode?: DatabaseAccessMode; expectedSchemaHash?: string; ttlMs?: number } = {}) {
    return this.lock(id, () => this.issueCredentialsUnlocked(actor, id, options));
  }
  private async issueCredentialsUnlocked(actor: string, id: string, options: { mode?: DatabaseAccessMode; expectedSchemaHash?: string; ttlMs?: number }, bindingId?: string) {
    const { mode, revision, resource } = await this.access(actor, id, options.mode, options.expectedSchemaHash);
    const ttl = options.ttlMs ?? 5 * 60_000;
    if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 15 * 60_000) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Database credentials must expire within 1 second and 15 minutes.");
    const credentialId = randomUUID(), role = `shc_${credentialId.replaceAll("-", "")}`, expiresAt = new Date(Date.now() + ttl);
    await this.pool.query(`insert into ${this.catalog}.credentials(id,database_id,user_id,role_name,expires_at,binding_id) values($1,$2,$3,$4,$5,$6)`, [credentialId, id, actor, role, expiresAt, bindingId ?? null]);
    try {
      const connectionString = await this.cluster.credential(id, role, mode, expiresAt);
      return { id: credentialId, databaseId: id, mode, revision,
        expiresAt: expiresAt.toISOString(), schemaHash: resource.schemaHash, connectionString };
    } catch (error) {
      await this.cluster.dropCredential(role);
      await this.pool.query(`delete from ${this.catalog}.credentials where id=$1`, [credentialId]);
      throw error;
    }
  }

  /** Queue before executing SQL; revalidate after acquiring the binding and resource locks. */
  async data(actor: string, id: string, input: TableDataRequest, consumer?: ConnectionRequest & { binding: { id: string; revision: number }; accessRevision: number }) {
    const work = () => this.lock(id, async () => {
      if (!input || typeof input !== 'object' || !['models', 'rows', 'insert', 'update', 'delete'].includes(input.operation)) throw new DatabaseResourceError('DATABASE_INVALID_REQUEST', 'Invalid table operation.');
      if (input.operation !== 'models' && !/^[a-f0-9]{64}$/.test(consumer?.schemaHash ?? input.schemaHash ?? '')) throw new DatabaseResourceError('DATABASE_SCHEMA_MISMATCH', 'Read the applied model fingerprint before querying table data.');
      const write = !['models', 'rows'].includes(input.operation);
      const binding = consumer ? await this.checkedBinding(actor, consumer) : undefined;
      if (binding && (binding.databaseId !== id || write && binding.mode !== 'write')) throw new DatabaseResourceError('DATABASE_ACCESS_DENIED', 'This database binding is read-only or changed.');
      const access = await this.access(actor, id, write ? 'write' : undefined, consumer?.schemaHash ?? input.schemaHash);
      if (consumer && access.revision !== consumer.accessRevision) throw new DatabaseResourceError('DATABASE_ACCESS_DENIED', 'Database authorization changed. Open a new client.');
      const applied = await this.applied(id), schema = applied.at(-1)?.schema;
      if (!schema) throw new DatabaseResourceError('DATABASE_SCHEMA_MISMATCH', 'Apply database models before managing table data.');
      const credential = await this.issueCredentialsUnlocked(actor, id, { mode: write ? 'write' : 'read', expectedSchemaHash: access.resource.schemaHash ?? undefined, ttlMs: 60_000 });
      const client = createPostgresClient({ label: "database table data", connectionString: credential.connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
      try {
        await client.connect(); await client.query('begin');
        if (!write) await client.query('set transaction read only');
        const result = await executeTableData(client, schema, input); await client.query('commit');
        return { ...result, schemaHash: access.resource.schemaHash, mode: binding?.mode === 'read' ? 'read' : access.mode, canManage: access.resource.ownerUserId === actor };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if (error instanceof DatabaseResourceError) throw error;
        throw new DatabaseResourceError('DATABASE_QUERY_FAILED', 'Table operation failed. Check field types, required values and unique constraints.');
      } finally {
        await client.end().catch(() => undefined);
        await this.cluster.dropCredential(`shc_${credential.id.replaceAll('-', '')}`);
        await this.pool.query(`delete from ${this.catalog}.credentials where id=$1`, [credential.id]);
      }
    }, true);
    return consumer ? this.bindingLock(actor, consumer, work, true) : work();
  }

  private async applied(id: string): Promise<AppliedMigration[]> {
    return this.cluster.withAdminDatabase(databaseNames(id).database, async client => {
      const result = await client.query(`select name,checksum,schema_hash,model_schema,applied_at from ${q(DATABASE_HISTORY_SCHEMA)}.history order by ordinal`);
      return result.rows.map(row => ({ name: row.name, checksum: row.checksum, schemaHash: row.schema_hash, schema: row.model_schema, appliedAt: row.applied_at.toISOString() }));
    });
  }
  private async synchronizeHistory(id: string, applied?: AppliedMigration[]): Promise<AppliedMigration[]> {
    const history = applied ?? await this.applied(id), last = history.at(-1);
    await this.pool.query(`update ${this.catalog}.resources set schema_hash=$2,migration_name=$3,updated_at=clock_timestamp() where id=$1`, [id, last?.schemaHash ?? null, last?.name ?? null]);
    return history;
  }
  async history(actor: string, id: string): Promise<DatabaseMigrationState[]> {
    await this.ready(actor, id);
    return (await this.applied(id)).map(({ schema: _schema, ...migration }) => migration);
  }
  private assertPrefix(applied: AppliedMigration[], migrations: readonly DatabaseMigration[]): void {
    if (applied.length > migrations.length || applied.some((row, index) => row.name !== migrations[index].name
      || row.checksum !== migrations[index].checksum || row.schemaHash !== migrations[index].schemaHash)) {
      throw new DatabaseResourceError("DATABASE_HISTORY_CONFLICT", "Applied migration history cannot be omitted, reordered or changed.");
    }
  }
  private async checkDrift(id: string, applied: AppliedMigration[]): Promise<void> {
    await this.cluster.withMigration(id, async (_client, url) => {
      if (!emptyDifference(await schemaDifference(url, applied.at(-1)?.schema))) throw new DatabaseResourceError("DATABASE_SCHEMA_DRIFT", "The live database differs from its applied models. Review the drift before migrating.");
    });
  }
  private async shadow<T>(id: string, migrations: readonly DatabaseMigration[], work: (url: string) => Promise<T>): Promise<T> {
    return this.cluster.withShadow(id, async (client, url) => {
      for (const migration of migrations) {
        await this.applySql(client, migration.sql);
        if (!emptyDifference(await schemaDifference(url, migration.schema))) throw new DatabaseResourceError("DATABASE_SCHEMA_DRIFT", "Migration SQL does not produce its declared model schema.");
      }
      return work(url);
    });
  }
  async plan(actor: string, id: string, input: { schema: string; migrations: readonly DatabaseMigration[] }): Promise<DatabaseMigrationPlan> {
    validateMigrationHistory(input.migrations); await validateModel(input.schema);
    return this.lock(id, async () => {
      await this.ready(actor, id, true);
      const applied = await this.synchronizeHistory(id); this.assertPrefix(applied, input.migrations);
      if (applied.length !== input.migrations.length) throw new DatabaseResourceError("DATABASE_HISTORY_CONFLICT", "Deploy pending migrations before generating another migration.");
      await this.checkDrift(id, applied);
      const schemaHash = modelHash(input.schema);
      return this.shadow(id, input.migrations, async url => {
        const sql = applied.at(-1)?.schemaHash === schemaHash ? null : await schemaDifference(url, input.schema);
        return { sql, schemaHash, destructive: sql !== null && destructiveMigration(sql) };
      });
    });
  }
  private async applySql(client: pg.Client, sql: string, record?: { databaseId: string; migration: DatabaseMigration; ordinal: number }): Promise<void> {
    if (record) await this.cluster.authorizeMigration(record.databaseId, record);
    try {
      await client.query("begin"); await client.query(sql);
      if (record) await client.query(`insert into ${q(DATABASE_HISTORY_SCHEMA)}.history(ordinal,name,checksum,schema_hash,model_schema) values($1,$2,$3,$4,$5)`,
        [record.ordinal, record.migration.name, record.migration.checksum, record.migration.schemaHash, record.migration.schema]);
      await client.query("commit");
    } catch { await client.query("rollback").catch(() => undefined); throw new DatabaseResourceError("DATABASE_MIGRATION_FAILED", "Migration SQL failed; its transaction was rolled back."); }
    finally { if (record) await this.cluster.authorizeMigration(record.databaseId); }
  }
  async deploy(actor: string, id: string, input: { migrations: readonly DatabaseMigration[]; schemaHash: string; acceptDataLoss?: boolean }): Promise<DatabaseMigrationState[]> {
    validateMigrationHistory(input.migrations);
    if (!input.migrations.length || input.migrations.at(-1)!.schemaHash !== input.schemaHash) throw new DatabaseResourceError("DATABASE_HISTORY_CONFLICT", "The final migration must match the current generated model.");
    for (const migration of input.migrations) await validateModel(migration.schema);
    return this.lock(id, async () => {
      await this.ready(actor, id, true);
      let applied = await this.synchronizeHistory(id); this.assertPrefix(applied, input.migrations);
      const pending = input.migrations.slice(applied.length);
      if (pending.some(item => destructiveMigration(item.sql)) && input.acceptDataLoss !== true) throw new DatabaseResourceError("DATABASE_DESTRUCTIVE_MIGRATION", "This migration can remove or rewrite data. Review its SQL and explicitly accept data loss.");
      await this.checkDrift(id, applied);
      await this.shadow(id, input.migrations, async () => undefined);
      if (!pending.length) {
        // A process can stop after committing the last business transaction but
        // before acknowledging it in the catalog. Reconcile the immutable
        // history and schema before allowing new connections again.
        await this.pool.query(`update ${this.catalog}.resources set migration_status='idle' where id=$1`, [id]);
        return applied.map(({ schema: _schema, ...item }) => item);
      }
      const attempt = randomUUID();
      await this.pool.query(`insert into ${this.catalog}.migration_attempts(id,database_id,actor_user_id,status) values($1,$2,$3,'running')`, [attempt, id, actor]);
      await this.pool.query(`update ${this.catalog}.resources set migration_status='running' where id=$1`, [id]);
      try {
        await this.revokeCredentials(id);
        await this.cluster.withMigration(id, async (client, url) => {
          for (const migration of pending) {
            await this.applySql(client, migration.sql, { databaseId: id, migration, ordinal: applied.length + 1 });
            applied = await this.synchronizeHistory(id);
          }
          if (!emptyDifference(await schemaDifference(url, input.migrations.at(-1)!.schema))) throw new DatabaseResourceError("DATABASE_SCHEMA_DRIFT", "The applied migration does not match its declared models.");
        });
        await this.pool.query(`update ${this.catalog}.migration_attempts set status='applied',ended_at=clock_timestamp() where id=$1`, [attempt]);
        await this.pool.query(`update ${this.catalog}.resources set migration_status='idle' where id=$1`, [id]);
      } catch (error) {
        const code = error instanceof DatabaseResourceError ? error.code : "DATABASE_MIGRATION_FAILED";
        await this.pool.query(`update ${this.catalog}.migration_attempts set status='failed',failure_code=$2,ended_at=clock_timestamp() where id=$1`, [attempt, code]);
        await this.pool.query(`update ${this.catalog}.resources set migration_status='failed' where id=$1`, [id]);
        throw error instanceof DatabaseResourceError ? error : new DatabaseResourceError("DATABASE_MIGRATION_FAILED", "Database migration failed. Retry the same immutable migration history.");
      }
      return applied.map(({ schema: _schema, ...item }) => item);
    });
  }
}

function resourceView(row: pg.QueryResultRow): DatabaseResource {
  return { id: row.id, name: row.name, ownerUserId: row.owner_user_id, migrationOwnerUserId: row.owner_user_id,
    status: row.status, stage: row.stage, failureCode: row.failure_code, schemaHash: row.schema_hash,
    migrationName: row.migration_name, migrationStatus: row.migration_status,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function grantView(row: pg.QueryResultRow): DatabaseGrant {
  return { databaseId: row.database_id, userId: row.user_id, mode: row.mode, revision: row.revision, revoked: row.revoked };
}
function bindingView(row: pg.QueryResultRow): DatabaseBinding {
  return { id: row.id, projectId: row.project_id, entryId: row.entry_id, alias: row.alias, databaseId: row.database_id, mode: row.mode, revision: row.revision };
}
