import type pg from "pg";
import { RuntimeStorageError, type RuntimeHistoryKind, type RuntimeHistoryRecord, type TokenUsageEntry } from "steamharness/runtime-storage";

const collections = ["messages", "queue", "events", "values"] as const;
export class PostgresRuntimeHistory {
  constructor(private readonly client: pg.PoolClient, private readonly schema: string, private readonly workspaceId: string) {}

  async list(kind: RuntimeHistoryKind): Promise<RuntimeHistoryRecord[]> {
    const rows = await this.client.query(`select * from ${this.schema}.runtime_history where workspace_id=$1 and kind=$2 and not deleted order by updated_at,key`, [this.workspaceId, kind]);
    const items = await this.client.query(`select * from ${this.schema}.runtime_history_items where workspace_id=$1 and kind=$2 order by key,collection,position`, [this.workspaceId, kind]);
    const records = new Map<string, RuntimeHistoryRecord>(rows.rows.map(row => [row.key, { kind, key: row.key, scope: row.scope_key, revision: Number(row.revision), state: JSON.parse(row.state), messages: [], queue: [], events: [], values: [] }]));
    for (const row of items.rows) records.get(row.key)?.[row.collection as typeof collections[number]].push({ id: JSON.parse(row.id), value: JSON.parse(row.value) });
    return [...records.values()];
  }

  async write(record: RuntimeHistoryRecord, sessionKey: string, remove = false, ownerTokenHash?: string): Promise<RuntimeHistoryRecord> {
    if (sessionKey !== `host:${record.scope}`) throw new RuntimeStorageError("RUNTIME_STORAGE_ACCESS_DENIED", "History writes require the matching host execution lease.");
    // Lock a stable row, including tombstones, so stale windows cannot recreate deleted history.
    await this.client.query(`insert into ${this.schema}.runtime_history(workspace_id,kind,key,scope_key,state) values($1,$2,$3,$4,'{}') on conflict do nothing`, [this.workspaceId, record.kind, record.key, record.scope]);
    const row = (await this.client.query(`select * from ${this.schema}.runtime_history where workspace_id=$1 and kind=$2 and key=$3 for update`, [this.workspaceId, record.kind, record.key])).rows[0];
    if (Number(row.revision) !== record.revision) throw new RuntimeStorageError("RUNTIME_STORAGE_REVISION_CONFLICT", "History changed in another execution. Reload the committed history.");
    if (row.scope_key !== record.scope) {
      // Independence can transfer a child only while the previous scope is idle.
      const previous = await this.client.query(`select owner_token_hash from ${this.schema}.agent_sessions where workspace_id=$1 and session_key=$2 and lease_expires_at>clock_timestamp() for update`, [this.workspaceId, `host:${row.scope_key}`]);
      if (previous.rowCount && previous.rows[0].owner_token_hash !== ownerTokenHash) throw new RuntimeStorageError("RUNTIME_STORAGE_OWNER_CONFLICT", "The source conversation still has another execution owner.");
    }
    await this.client.query(`update ${this.schema}.runtime_history set scope_key=$4,revision=revision+1,status=$5,state=$6,deleted=$7,updated_at=clock_timestamp() where workspace_id=$1 and kind=$2 and key=$3`,
      [this.workspaceId, record.kind, record.key, record.scope, stringStatus(record.state), JSON.stringify(record.state), remove]);
    await this.client.query(`delete from ${this.schema}.runtime_history_items where workspace_id=$1 and kind=$2 and key=$3`, [this.workspaceId, record.kind, record.key]);
    if (remove && record.kind === "state") await this.client.query(`delete from ${this.schema}.runtime_usage where workspace_id=$1 and conversation_id=$2`, [this.workspaceId, record.key]);
    if (!remove) for (const collection of collections) for (const [position, item] of record[collection].entries()) {
      await this.client.query(`insert into ${this.schema}.runtime_history_items(workspace_id,kind,key,collection,id,position,status,value) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [this.workspaceId, record.kind, record.key, collection, JSON.stringify(item.id), position, stringStatus(item.value), JSON.stringify(item.value)]);
    }
    return { ...record, revision: record.revision + 1 };
  }

  async usage(entry: TokenUsageEntry, sessionKey: string): Promise<void> {
    if (sessionKey !== `host:core:${entry.conversationId ?? entry.runId}`) throw new RuntimeStorageError("RUNTIME_STORAGE_ACCESS_DENIED", "Usage requires its run or conversation lease.");
    const result = await this.client.query(`insert into ${this.schema}.runtime_usage(workspace_id,id,run_id,conversation_id,input_tokens,output_tokens,total_tokens,reasoning_tokens,cached_input_tokens,cache_creation_tokens,record)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(workspace_id,id) do update set
      input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,total_tokens=excluded.total_tokens,
      reasoning_tokens=excluded.reasoning_tokens,cached_input_tokens=excluded.cached_input_tokens,cache_creation_tokens=excluded.cache_creation_tokens,record=excluded.record
      where runtime_usage.run_id=excluded.run_id and runtime_usage.conversation_id is not distinct from excluded.conversation_id`,
      [this.workspaceId, JSON.stringify(entry.id), entry.runId, entry.conversationId ?? null, entry.inputTokens, entry.outputTokens, entry.totalTokens, entry.reasoningTokens, entry.cachedInputTokens, entry.cacheCreationTokens, JSON.stringify(entry)]);
    if (!result.rowCount) throw new RuntimeStorageError("RUNTIME_STORAGE_IDEMPOTENCY_CONFLICT", "The usage receipt already belongs to another run or conversation.");
  }
}
function stringStatus(value: Record<string, unknown>): string | null { return typeof value.status === "string" ? JSON.stringify(value.status) : null; }
