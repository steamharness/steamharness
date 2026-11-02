import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { RuntimeStorageError, type AgentSessionSnapshot, type RuntimeHistoryKind, type RuntimeHistoryRecord, type RuntimeWorkspaceInput, type RuntimeWorkspace, type RuntimeStorageLease, type RuntimeStorageCredentials, type RuntimeStorageOperation } from "steamharness/runtime-storage";
import { createPostgresPool } from "../postgres";
import { migrateRuntimeStorage, RUNTIME_STORAGE_SCHEMA, runtimeSchemaName } from "./migrations";
import { PostgresAgentStorage } from "./store";
import { PostgresRuntimeHistory } from "./history";

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

  async getSystemTokenUsage(options: { pageSize?: number; cursor?: string } = {}): Promise<import('../storage').TokenUsagePage> {
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
    let after = '';
    if (options.cursor) {
      try { after = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')).projectId; }
      catch { throw new RuntimeStorageError('RUNTIME_STORAGE_INVALID_REQUEST', 'Invalid usage cursor.'); }
      if (typeof after !== 'string' || !/^[0-9a-f-]{36}$/.test(after)) throw new RuntimeStorageError('RUNTIME_STORAGE_INVALID_REQUEST', 'Invalid usage cursor.');
    }
    const source = `${this.name}.runtime_usage u join ${this.name}.workspaces w on w.id=u.workspace_id`;
    const system = (await this.pool.query(`select ${usageProjection} from ${source}`)).rows[0];
    const total = Number((await this.pool.query(`select count(distinct w.project_id) as total from ${source}`)).rows[0].total);
    const rows = (await this.pool.query(`select w.project_id,${usageProjection} from ${source} where w.project_id>$1 group by w.project_id order by w.project_id limit $2`, [after, pageSize + 1])).rows;
    const hasMore = rows.length > pageSize;
    const projects = rows.slice(0, pageSize).map(row => ({ projectId: row.project_id, total: usageAggregate(row), updatedAt: row.updated_at ?? undefined }));
    return { systemTotal: usageAggregate(system), projects, total, hasMore, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ projectId: projects.at(-1)!.projectId })).toString('base64url') } : {}) };
  }

  async getProjectTokenUsage(options: { projectId: string; conversationId?: string; includeEntries?: boolean }): Promise<import('../storage').TokenUsageDetail> {
    const source = `${this.name}.runtime_usage u join ${this.name}.workspaces w on w.id=u.workspace_id`;
    const projectTotal = usageAggregate((await this.pool.query(`select ${usageProjection} from ${source} where w.project_id=$1`, [options.projectId])).rows[0]);
    const conversationTotal = options.conversationId === undefined ? undefined : usageAggregate((await this.pool.query(`select ${usageProjection} from ${source} where w.project_id=$1 and u.conversation_id=$2`, [options.projectId, options.conversationId])).rows[0]);
    // The public inspector already bounds history to a selected conversation.
    const entries = options.includeEntries ? (await this.pool.query(`select u.record from ${source} where w.project_id=$1 and ($2::text is null or u.conversation_id=$2) order by u.record::jsonb->>'createdAt',u.id limit 1000`, [options.projectId, options.conversationId ?? null])).rows.map(row => JSON.parse(row.record)) : undefined;
    return { projectId: options.projectId, projectTotal, ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId, conversationTotal }), ...(entries ? { entries } : {}) };
  }

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
      if (row.deleted) throw missing();
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
      const mutable = ["commit", "mintId", "history.write", "history.delete", "usage", "snapshot.import", "session.delete"].includes(operation.kind);
      const payloadHash = mutable ? hash(JSON.stringify(operation)) : undefined;
      if (mutable) {
        const previous = await client.query(`select payload_hash,result from ${this.name}.agent_operations where session_id=$1 and request_id=$2`, [sessionId, "requestId" in operation ? operation.requestId : undefined]);
        if (previous.rows[0]) {
          if (previous.rows[0].payload_hash !== payloadHash) throw new RuntimeStorageError("RUNTIME_STORAGE_IDEMPOTENCY_CONFLICT", "The runtime storage request ID was reused with different content.");
          return JSON.parse(previous.rows[0].result);
        }
      }
      const store = new PostgresAgentStorage(client, this.name, sessionId);
      let result: unknown;
      if (session.deleted) throw missing();
      if (operation.kind === "session.delete") {
        for (const table of ["agent_entries", "agent_tasks", "agent_submissions", "agent_document_revisions", "agent_documents", "agent_conversations", "agent_record_ids", "agent_commits"]) {
          await client.query(`delete from ${this.name}.${table} where session_id=$1`, [sessionId]);
        }
        await client.query(`update ${this.name}.agent_sessions set deleted=true where id=$1`, [sessionId]);
      } else if (operation.kind === "history.write" || operation.kind === "history.delete") {
        const history = new PostgresRuntimeHistory(client, this.name, session.workspace_id);
        const record = operation.kind === "history.write" ? operation.record : { ...operation.record, state: {}, messages: [], queue: [], events: [], values: [] } as RuntimeHistoryRecord;
        result = await history.write(record, session.session_key, operation.kind === "history.delete", session.owner_token_hash);
      } else if (operation.kind === "usage") {
        const owned = await client.query(`select project_id from ${this.name}.workspaces where id=$1`, [session.workspace_id]);
        if (owned.rows[0]?.project_id !== operation.entry.projectId) throw new RuntimeStorageError("RUNTIME_STORAGE_ACCESS_DENIED", "Usage must belong to this workspace project.");
        await new PostgresRuntimeHistory(client, this.name, session.workspace_id).usage(operation.entry, session.session_key);
      } else if (operation.kind === "snapshot.import") {
        if (Number(session.next_seq) !== 1 || Number(session.next_id) !== 2) throw new RuntimeStorageError("RUNTIME_STORAGE_REVISION_CONFLICT", "Import requires a new empty agent session.");
        let nextId = 2, nextSeq = 1;
        for (const commit of operation.snapshot.commits) {
          if (commit.seq !== nextSeq) throw new RuntimeStorageError("RUNTIME_STORAGE_INVALID_REQUEST", "Snapshot commits must be contiguous and ordered.");
          nextId = await store.commit(commit.writes, commit.seq, nextId);
          await client.query(`insert into ${this.name}.agent_commits(session_id,seq,writes) values($1,$2,$3)`, [sessionId, commit.seq, JSON.stringify(commit.writes)]);
          nextSeq++;
        }
        if (operation.snapshot.nextId < nextId) throw new RuntimeStorageError("RUNTIME_STORAGE_INVALID_REQUEST", "Invalid snapshot ID watermark.");
        await client.query(`update ${this.name}.agent_sessions set next_id=$2,next_seq=$3 where id=$1`, [sessionId, operation.snapshot.nextId, nextSeq]);
      } else if (operation.kind === "mintId") {
        const id = Number(session.next_id);
        if (!Number.isSafeInteger(id)) throw new Error("ID space is exhausted");
        await client.query(`update ${this.name}.agent_sessions set next_id=next_id+1 where id=$1`, [sessionId]);
        result = id;
      } else if (operation.kind === "commit") {
        const seq = Number(session.next_seq);
        if (!Number.isSafeInteger(seq)) throw new Error("Commit sequence space is exhausted");
        const nextId = await store.commit(operation.writes, seq, Number(session.next_id));
        await client.query(`insert into ${this.name}.agent_commits(session_id,seq,writes) values($1,$2,$3)`, [sessionId, seq, JSON.stringify(operation.writes)]);
        await client.query(`update ${this.name}.agent_sessions set next_id=$2,next_seq=next_seq+1 where id=$1`, [sessionId, nextId]);
        result = seq;
      } else result = await store.read(operation);
      if (mutable) await client.query(`insert into ${this.name}.agent_operations (session_id,request_id,payload_hash,result) values ($1,$2,$3,$4)`, [sessionId, "requestId" in operation ? operation.requestId : undefined, payloadHash, JSON.stringify(result ?? null)]);
      return result;
    });
  }

  async history(userId: string, workspaceId: string, kind: RuntimeHistoryKind): Promise<RuntimeHistoryRecord[]> {
    return this.transaction(async client => {
      await client.query("set transaction isolation level repeatable read");
      const owned = await client.query(`select id from ${this.name}.workspaces where id=$1 and owner_user_id=$2`, [workspaceId, userId]);
      if (!owned.rowCount) throw missing();
      return new PostgresRuntimeHistory(client, this.name, workspaceId).list(kind);
    });
  }

  async agentSessions(userId: string, workspaceId: string, prefix: string): Promise<string[]> {
    await this.getWorkspace(userId, workspaceId);
    const result = await this.pool.query(`select session_key from ${this.name}.agent_sessions where workspace_id=$1 and not deleted and starts_with(session_key,$2) order by session_key`, [workspaceId, prefix]);
    return result.rows.map(row => row.session_key);
  }

  async snapshot(userId: string, workspaceId: string, sessionKey: string): Promise<AgentSessionSnapshot> {
    return this.transaction(async client => {
      await client.query("set transaction isolation level repeatable read");
      const result = await client.query(`select s.* from ${this.name}.agent_sessions s join ${this.name}.workspaces w on w.id=s.workspace_id where s.workspace_id=$1 and s.session_key=$2 and w.owner_user_id=$3`, [workspaceId, sessionKey, userId]);
      const session = result.rows[0];
      if (!session || session.deleted) throw missing();
      const rows = await client.query(`select seq,writes from ${this.name}.agent_commits where session_id=$1 order by seq`, [session.id]);
      if (rows.rows.length !== Number(session.next_seq) - 1) throw new RuntimeStorageError("RUNTIME_STORAGE_INVALID_REQUEST", "This session predates versioned snapshots. Start a new conversation.");
      return { format: "steamharness.agent-session", version: 1, nextId: Number(session.next_id), commits: rows.rows.map(row => ({ seq: Number(row.seq), writes: JSON.parse(row.writes) })) };
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

const usageProjection = `coalesce(sum(input_tokens),0) as input_tokens,coalesce(sum(output_tokens),0) as output_tokens,
  coalesce(sum(total_tokens),0) as total_tokens,coalesce(sum(reasoning_tokens),0) as reasoning_tokens,
  coalesce(sum(cached_input_tokens),0) as cached_input_tokens,coalesce(sum(cache_creation_tokens),0) as cache_creation_tokens,
  count(*) as calls,max(u.record::jsonb->>'createdAt') as updated_at`;
function usageAggregate(row: Record<string, any>): import('steamharness').TokenUsageAggregate {
  return { inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens),
    reasoningTokens: Number(row.reasoning_tokens), cachedInputTokens: Number(row.cached_input_tokens), cacheCreationTokens: Number(row.cache_creation_tokens),
    calls: Number(row.calls), ...(row.updated_at ? { updatedAt: row.updated_at } : {}) };
}
