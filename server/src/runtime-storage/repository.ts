import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { RuntimeStorageError, type RuntimeWorkspaceInput, type RuntimeWorkspace, type RuntimeStorageLease, type RuntimeStorageCredentials, type RuntimeStorageOperation } from "steamharness/runtime-storage";
import { createPostgresPool } from "../postgres";
import { migrateRuntimeStorage, RUNTIME_STORAGE_SCHEMA, runtimeSchemaName } from "./migrations";
import { PostgresAgentStorage } from "./store";

export interface OwnedRuntimeWorkspace extends RuntimeWorkspace { ownerUserId: string }

export class RuntimeStorageRepository {
  private readonly pool: pg.Pool;
  private readonly name: string;
  readonly leaseDurationMs: number;

  constructor(connectionString: string, private readonly options: { schema?: string; leaseDurationMs?: number } = {}) {
    this.name = runtimeSchemaName(options.schema ?? RUNTIME_STORAGE_SCHEMA);
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 250 || this.leaseDurationMs > 120_000) throw new Error("Invalid runtime storage lease duration.");
    this.pool = createPostgresPool({ connectionString, label: "runtime storage" });
  }

  init(): Promise<void> { return migrateRuntimeStorage(this.pool, this.options.schema); }
  close(): Promise<void> { return this.pool.end(); }

  async registerWorkspace(userId: string, input: RuntimeWorkspaceInput): Promise<OwnedRuntimeWorkspace> {
    const result = await this.pool.query(`insert into ${this.name}.workspaces
      (id,owner_user_id,kind,project_id,entry_id,local_key) values ($1,$2,$3,$4,$5,$6)
      on conflict (owner_user_id,kind,project_id,entry_id,local_key) do update set owner_user_id=excluded.owner_user_id
      returning *`, [randomUUID(), userId, input.kind, input.projectId, input.entryId, input.kind === "project" ? "" : input.localKey]);
    return workspace(result.rows[0]);
  }

  async getWorkspace(userId: string, id: string): Promise<OwnedRuntimeWorkspace> {
    const result = await this.pool.query(`select * from ${this.name}.workspaces where id=$1 and owner_user_id=$2`, [id, userId]);
    if (!result.rows[0]) throw missing();
    return workspace(result.rows[0]);
  }

  async sessionWorkspace(userId: string, sessionId: string): Promise<OwnedRuntimeWorkspace> {
    const result = await this.pool.query(`select w.* from ${this.name}.workspaces w join ${this.name}.agent_sessions s on s.workspace_id=w.id
      where s.id=$1 and w.owner_user_id=$2`, [sessionId, userId]);
    if (!result.rows[0]) throw missing();
    return workspace(result.rows[0]);
  }

  async openSession(userId: string, workspaceId: string, sessionKey: string, ownerToken: string): Promise<RuntimeStorageLease> {
    return this.transaction(async client => {
      const owned = await client.query(`select id from ${this.name}.workspaces where id=$1 and owner_user_id=$2`, [workspaceId, userId]);
      if (!owned.rows[0]) throw missing();
      await client.query(`insert into ${this.name}.agent_sessions (id,workspace_id,session_key) values ($1,$2,$3) on conflict (workspace_id,session_key) do nothing`, [randomUUID(), workspaceId, sessionKey]);
      const selected = await client.query(`select *,lease_expires_at>clock_timestamp() as active from ${this.name}.agent_sessions where workspace_id=$1 and session_key=$2 for update`, [workspaceId, sessionKey]);
      const row = selected.rows[0];
      const tokenHash = hash(ownerToken);
      if (row.active && row.owner_token_hash !== tokenHash) throw new RuntimeStorageError("RUNTIME_STORAGE_OWNER_CONFLICT", "This agent session already has an execution owner.");
      if (row.active && row.owner_token_hash === tokenHash) return this.lease(row);
      const updated = await client.query(`update ${this.name}.agent_sessions set fence=fence+1,owner_token_hash=$2,
        lease_expires_at=clock_timestamp()+($3::integer * interval '1 millisecond') where id=$1 returning *`, [row.id, tokenHash, this.leaseDurationMs]);
      return this.lease(updated.rows[0]);
    });
  }

  async operation(userId: string, sessionId: string, credentials: RuntimeStorageCredentials, operation: RuntimeStorageOperation): Promise<unknown> {
    return this.transaction(async client => {
      const selected = await client.query(`select s.*,s.lease_expires_at>clock_timestamp() as active from ${this.name}.agent_sessions s
        join ${this.name}.workspaces w on w.id=s.workspace_id where s.id=$1 and w.owner_user_id=$2 for update of s`, [sessionId, userId]);
      const session = selected.rows[0];
      if (!session) throw missing();
      if (!session.active || Number(session.fence) !== credentials.fence || session.owner_token_hash !== hash(credentials.ownerToken)) {
        throw new RuntimeStorageError("RUNTIME_STORAGE_LEASE_LOST", "The runtime storage lease is no longer owned by this execution.");
      }
      if (operation.kind === "release") {
        await client.query(`update ${this.name}.agent_sessions set owner_token_hash=null,lease_expires_at=null where id=$1`, [sessionId]);
        return undefined;
      }
      if (operation.kind === "renew") {
        const updated = await client.query(`update ${this.name}.agent_sessions set lease_expires_at=clock_timestamp()+($2::integer * interval '1 millisecond') where id=$1 returning *`, [sessionId, this.leaseDurationMs]);
        return this.lease(updated.rows[0]);
      }
      const mutable = operation.kind === "commit" || operation.kind === "mintId";
      const payloadHash = mutable ? hash(JSON.stringify(operation)) : undefined;
      if (mutable) {
        const previous = await client.query(`select payload_hash,result from ${this.name}.agent_operations where session_id=$1 and request_id=$2`, [sessionId, operation.requestId]);
        if (previous.rows[0]) {
          if (previous.rows[0].payload_hash !== payloadHash) throw new RuntimeStorageError("RUNTIME_STORAGE_IDEMPOTENCY_CONFLICT", "The runtime storage request ID was reused with different content.");
          return JSON.parse(previous.rows[0].result);
        }
      }
      const store = new PostgresAgentStorage(client, this.name, sessionId);
      let result: unknown;
      if (operation.kind === "mintId") {
        const id = Number(session.next_id);
        if (!Number.isSafeInteger(id)) throw new Error("ID space is exhausted");
        await client.query(`update ${this.name}.agent_sessions set next_id=next_id+1 where id=$1`, [sessionId]);
        result = id;
      } else if (operation.kind === "commit") {
        const seq = Number(session.next_seq);
        if (!Number.isSafeInteger(seq)) throw new Error("Commit sequence space is exhausted");
        const nextId = await store.commit(operation.writes, seq, Number(session.next_id));
        await client.query(`update ${this.name}.agent_sessions set next_id=$2,next_seq=next_seq+1 where id=$1`, [sessionId, nextId]);
        result = seq;
      } else result = await store.read(operation);
      if (mutable) await client.query(`insert into ${this.name}.agent_operations (session_id,request_id,payload_hash,result) values ($1,$2,$3,$4)`, [sessionId, operation.requestId, payloadHash, JSON.stringify(result)]);
      return result;
    });
  }

  private lease(row: Record<string, any>): RuntimeStorageLease {
    const fence = Number(row.fence);
    if (!Number.isSafeInteger(fence)) throw new Error("Runtime storage fencing space is exhausted.");
    return { sessionId: row.id, fence, expiresAt: new Date(row.lease_expires_at).toISOString(), durationMs: this.leaseDurationMs };
  }

  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let client: pg.PoolClient | undefined;
      try {
        client = await this.pool.connect();
        await client.query("begin");
        const result = await operation(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client?.query("rollback").catch(() => undefined);
        const code = (error as { code?: string }).code ?? "";
        if (attempt >= 2 || !(/^(08|40)/.test(code) || ["57P01", "57P02", "57P03", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(code))) throw error;
      } finally { client?.release(); }
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

function workspace(row: Record<string, any>): OwnedRuntimeWorkspace {
  return { id: row.id, ownerUserId: row.owner_user_id, kind: row.kind, projectId: row.project_id, entryId: row.entry_id,
    ...(row.kind === "project" ? {} : { localKey: row.local_key }) };
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function missing(): RuntimeStorageError { return new RuntimeStorageError("RUNTIME_STORAGE_NOT_FOUND", "Runtime storage does not exist for this account."); }
