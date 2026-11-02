import type pg from "pg";
import {
  applyAgentDocumentDelta, AgentStorageRequestError,
  type AgentStorageWrite, type RuntimeStorageOperation, type ConversationRecord,
  type DocumentAddress, type DocumentContent, type DocumentCopySource, type DocumentCreate,
  type DocumentPoint, type DocumentRecord, type StoredDocument, type JsonObject,
  type EntryRecord, type Seq, type Cursor, type ScanOrder,
} from "steamharness/runtime-storage";

type Table = "conversations" | "entries" | "tasks" | "submissions" | "documents";
type DocumentAction = { create?: DocumentCreate; content?: DocumentContent; copy?: DocumentCopySource; retire: boolean };
type ReadOperation = Exclude<RuntimeStorageOperation, { kind: "commit" | "mintId" | "renew" | "release" }>;

/** All operations run within a transaction holding this session's fencing row. */
export class PostgresAgentStorage {
  constructor(private readonly client: pg.PoolClient, private readonly schema: string, private readonly sessionId: string) {}

  async commit(writes: readonly AgentStorageWrite[], seq: number, nextId: number): Promise<number> {
    const actions = this.documentActions(writes);
    await this.checkIds(writes);
    await this.checkDocuments(actions);
    for (const write of writes) {
      if (write.type === "document.change" || write.type === "document.retire") continue;
      const id = "record" in write ? write.record.id : write.value.id;
      nextId = Math.max(nextId, id + 1);
      if (write.type === "document.create" || write.type === "document.copy") continue;
      const value = write.value;
      await this.claimId(value.id, write.type);
      switch (write.type) {
        case "conversation":
          await this.query(`insert into ${this.table("conversations")} (session_id,id,owner_conversation_id,owner_task_id,record) values ($1,$2,$3,$4,$5)`,
            [value.id, write.value.owner?.conversationId ?? null, write.value.owner?.taskId ?? null, JSON.stringify(value)]);
          break;
        case "entry":
          await this.query(`insert into ${this.table("entries")} (session_id,id,conversation_id,head,commit_seq,record) values ($1,$2,$3,$4,$5,$6)`,
            [value.id, write.value.conversationId, write.value.head ?? null, seq, JSON.stringify(value)]);
          break;
        case "task":
          await this.query(`insert into ${this.table("tasks")} (session_id,id,conversation_id,kind,status,abort_requested,background,record)
            values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (session_id,id) do update set
            conversation_id=excluded.conversation_id,kind=excluded.kind,status=excluded.status,
            abort_requested=excluded.abort_requested,background=excluded.background,record=excluded.record`,
          [value.id, write.value.conversationId, JSON.stringify(write.value.kind), write.value.state.status, write.value.abortRequested, write.value.background, JSON.stringify(value)]);
          break;
        case "submission":
          await this.query(`insert into ${this.table("submissions")} (session_id,id,conversation_id,request_id,status,record) values ($1,$2,$3,$4,$5,$6)
            on conflict (session_id,id) do update set conversation_id=excluded.conversation_id,request_id=excluded.request_id,status=excluded.status,record=excluded.record`,
          [value.id, write.value.conversationId, write.value.requestId === undefined ? null : JSON.stringify(write.value.requestId), write.value.status, JSON.stringify(value)]);
          break;
      }
    }
    await this.writeDocuments(actions, seq as Seq);
    return nextId;
  }

  async read(operation: ReadOperation): Promise<unknown> {
    switch (operation.kind) {
      case "conversation": return this.record("conversations", operation.id);
      case "task": return this.record("tasks", operation.id);
      case "submission": return this.record("submissions", operation.id);
      case "entry": return this.entry(operation.id, operation.conversationId);
      case "head": {
        const segments = await this.segments(operation.conversationId, operation.atOrBeforeEntryId);
        for (const segment of segments) {
          const conditions = new Conditions(this.sessionId).add("conversation_id", "=", segment.id).raw("head is not null");
          if (segment.upper !== undefined) conditions.add("id", "<=", segment.upper);
          const rows = await this.select("entries", conditions, "descending", 1);
          if (rows[0]) return JSON.parse(rows[0].record);
        }
        return undefined;
      }
      case "entries": {
        const query = operation.query;
        const start = scanStart(query.order, operation.cursor, "descending");
        const segments = await this.segments(query.conversationId, query.maxEntryId);
        const values: EntryRecord[] = [];
        for (const segment of start.order === "ascending" ? segments.reverse() : segments) {
          const conditions = new Conditions(this.sessionId).add("conversation_id", "=", segment.id);
          if (query.minEntryId !== undefined) conditions.add("id", ">=", query.minEntryId);
          if (segment.upper !== undefined) conditions.add("id", "<=", segment.upper);
          if (start.after !== undefined) conditions.add("id", start.order === "ascending" ? ">" : "<", start.after);
          const rows = await this.select("entries", conditions, start.order, operation.limit + 1 - values.length);
          values.push(...rows.map(row => JSON.parse(row.record) as EntryRecord));
          if (values.length > operation.limit) break;
        }
        return page(values, operation.limit, start.order);
      }
      case "conversations":
      case "tasks":
      case "submissions": {
        const start = scanStart(operation.query.order, operation.cursor, "ascending");
        const conditions = new Conditions(this.sessionId);
        if (start.after !== undefined) conditions.add("id", start.order === "ascending" ? ">" : "<", start.after);
        const columns = operation.kind === "conversations"
          ? { ownerConversationId: "owner_conversation_id", ownerTaskId: "owner_task_id" }
          : operation.kind === "tasks"
            ? { conversationId: "conversation_id", kind: "kind", status: "status", abortRequested: "abort_requested", background: "background" }
            : { conversationId: "conversation_id", status: "status" };
        for (const [key, column] of Object.entries(columns)) {
          const value = (operation.query as Record<string, unknown>)[key];
          if (value !== undefined) conditions.add(column!, "=", key === "kind" ? JSON.stringify(value) : value);
        }
        const rows = await this.select(operation.kind, conditions, start.order, operation.limit + 1);
        return page(rows.map(row => JSON.parse(row.record)), operation.limit, start.order);
      }
      case "submissionByRequest": {
        const rows = await this.select("submissions", new Conditions(this.sessionId).add("conversation_id", "=", operation.conversationId).add("request_id", "=", JSON.stringify(operation.requestId)), "ascending", 1);
        return rows[0] ? JSON.parse(rows[0].record) : undefined;
      }
      case "findDocument": {
        const conditions = this.documentMembership(new Conditions(this.sessionId).add("address_key", "=", addressKey(operation.address)), operation.at);
        const rows = await this.select("documents", conditions, "descending", 1);
        return rows[0] ? JSON.parse(rows[0].record) : undefined;
      }
      case "document": return this.materialize(operation.id, operation.at);
      case "documents": {
        const scope = scopeParts(operation.query.scope);
        const conditions = new Conditions(this.sessionId).add("scope_kind", "=", scope.kind).add("owner_id", "=", scope.owner);
        if (operation.cursor !== undefined) {
          const after = operation.cursor.after;
          if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new AgentStorageRequestError("Invalid storage cursor");
          conditions.add("id", ">", after);
        }
        if (operation.query.kind !== undefined) conditions.add("kind", "=", JSON.stringify(operation.query.kind));
        this.documentMembership(conditions, operation.query.at);
        const rows = await this.select("documents", conditions, "ascending", operation.limit + 1);
        return page(rows.map(row => JSON.parse(row.record)), operation.limit, "ascending");
      }
    }
  }

  private table(table: Table): string { return `${this.schema}.agent_${table}`; }
  private query(sql: string, params: unknown[] = []): Promise<pg.QueryResult> { return this.client.query(sql, [this.sessionId, ...params]); }
  private async record<T>(table: Table, id: number): Promise<T | undefined> {
    const result = await this.query(`select record from ${this.table(table)} where session_id=$1 and id=$2`, [id]);
    return result.rows[0] ? JSON.parse(result.rows[0].record) as T : undefined;
  }
  private async select(table: Table, conditions: Conditions, order: ScanOrder, limit: number): Promise<Record<string, any>[]> {
    const result = await this.client.query(`select * from ${this.table(table)} where ${conditions.sql.join(" and ")} order by id ${order === "ascending" ? "asc" : "desc"} limit $${conditions.params.length + 1}`, [...conditions.params, limit]);
    return result.rows;
  }

  private async segments(conversationId: number, upper?: number): Promise<{ id: number; upper?: number }[]> {
    const segments: { id: number; upper?: number }[] = [];
    const visited = new Set<number>();
    while (true) {
      if (visited.has(conversationId)) throw new AgentStorageRequestError("Conversation ancestry contains a cycle");
      visited.add(conversationId);
      const conversation = await this.record<ConversationRecord>("conversations", conversationId);
      if (!conversation) throw new AgentStorageRequestError(`Unknown conversation: ${conversationId}`);
      segments.push({ id: conversationId, upper });
      if (!conversation.parent) return segments;
      upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, conversation.parent.at);
      conversationId = conversation.parent.conversationId;
    }
  }

  private async entry(id: number, conversationId?: number): Promise<unknown> {
    const segments = conversationId === undefined ? undefined : await this.segments(conversationId);
    const result = await this.query(`select record,commit_seq from ${this.table("entries")} where session_id=$1 and id=$2`, [id]);
    if (!result.rows[0]) return undefined;
    const entry = JSON.parse(result.rows[0].record) as EntryRecord;
    if (segments && !segments.some(segment => segment.id === entry.conversationId && entry.id <= (segment.upper ?? Number.MAX_SAFE_INTEGER))) return undefined;
    return { entry, commitSeq: Number(result.rows[0].commit_seq) };
  }

  private documentMembership(conditions: Conditions, at: DocumentPoint): Conditions {
    if (at === "current") conditions.raw("retired_at is null");
    else {
      conditions.add("created_at", "<=", at);
      conditions.params.push(at);
      conditions.raw(`(retired_at is null or retired_at > $${conditions.params.length})`);
    }
    return conditions;
  }

  private async materialize(id: number, at: DocumentPoint): Promise<StoredDocument | undefined> {
    const record = await this.record<DocumentRecord>("documents", id);
    if (!record) return undefined;
    if (at !== "current" && currentOnly(record)) throw new AgentStorageRequestError(`Document ${id} does not retain historical content`);
    if (at === "current" ? record.retiredAt !== undefined : record.createdAt > at || record.retiredAt !== undefined && record.retiredAt <= at) return undefined;
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
    const bases = await this.query(`select seq,version,content from ${this.schema}.agent_document_revisions
      where session_id=$1 and document_id=$2 and kind='base' and seq <= $3 order by seq desc limit 1`, [id, upper]);
    const base = bases.rows[0];
    if (!base) throw new Error(`Document ${id} is missing a required base`);
    let value = JSON.parse(base.content) as JsonObject;
    const revisions = await this.query(`select kind,version,content from ${this.schema}.agent_document_revisions
      where session_id=$1 and document_id=$2 and seq > $3 and seq <= $4 order by seq`, [id, base.seq, upper]);
    for (const revision of revisions.rows) {
      if (revision.kind !== "delta" || revision.version !== base.version) throw new Error(`Document ${id} crosses a stored version boundary without a base`);
      value = applyAgentDocumentDelta(value, JSON.parse(revision.content));
    }
    return { record, version: base.version, value, deltasSinceBase: revisions.rows.length };
  }

  private async checkIds(writes: readonly AgentStorageWrite[]): Promise<void> {
    const claimed = new Map<number, string>();
    for (const write of writes) {
      if (write.type === "document.change" || write.type === "document.retire") continue;
      const document = write.type === "document.create" || write.type === "document.copy";
      const id = "record" in write ? write.record.id : write.value.id;
      const table = document ? "document" : write.type;
      if (!Number.isSafeInteger(id) || id < 1) throw new AgentStorageRequestError("Invalid storage record ID");
      const result = await this.query(`select record_type from ${this.schema}.agent_record_ids where session_id=$1 and id=$2`, [id]);
      const existing = result.rows[0]?.record_type as string | undefined;
      const earlier = claimed.get(id);
      if (table === "conversation" || table === "entry" || table === "document") {
        if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
      } else {
        if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
      }
      claimed.set(id, table);
    }
  }

  private claimId(id: number, type: string): Promise<pg.QueryResult> {
    return this.query(`insert into ${this.schema}.agent_record_ids (session_id,id,record_type) values ($1,$2,$3) on conflict do nothing`, [id, type]);
  }

  private documentActions(writes: readonly AgentStorageWrite[]): Map<number, DocumentAction> {
    const actions = new Map<number, DocumentAction>();
    for (const write of writes) {
      if (!write.type.startsWith("document.")) continue;
      if (!("id" in write) && !("record" in write)) continue;
      const id = "record" in write ? write.record.id : write.id;
      const action = actions.get(id) ?? { retire: false };
      actions.set(id, action);
      switch (write.type) {
        case "document.create":
        case "document.copy":
          if (action.create || action.content || action.copy) throw new Error(`Document ${id} has more than one content command`);
          action.create = write.record;
          if (write.type === "document.create") action.content = write.content; else action.copy = write.source;
          break;
        case "document.change":
          if (action.content || action.copy) throw new Error(`Document ${id} has more than one content command`);
          action.content = write.content;
          break;
        case "document.retire":
          if (action.retire) throw new Error(`Document ${id} is retired more than once`);
          action.retire = true;
          break;
      }
    }
    return actions;
  }

  private async checkDocuments(actions: Map<number, DocumentAction>): Promise<void> {
    const liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      if (action.copy && actions.has(action.copy.id)) throw new Error(`Document copy ${id} source is changed in the copy batch`);
      const existing = await this.record<DocumentRecord>("documents", id);
      if (!action.create && !existing) throw new Error(`Unknown document: ${id}`);
      if (action.create && existing) throw new Error(`Document ${id} already exists`);
      if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        const previous = await this.query(`select version from ${this.schema}.agent_document_revisions where session_id=$1 and document_id=$2 order by seq desc limit 1`, [id]);
        if (!previous.rows[0]) throw new Error(`Document ${id} delta has no base`);
        if (previous.rows[0].version !== action.content.version) throw new Error(`Document ${id} version transition requires a base`);
      }
      const key = addressKey(action.create ?? existing!);
      let live = liveCounts.get(key);
      if (live === undefined) {
        const current = await this.query(`select id from ${this.table("documents")} where session_id=$1 and address_key=$2 and retired_at is null limit 1`, [key]);
        live = current.rows.length;
      }
      if (action.retire && existing) live--;
      if (action.create && !action.retire) live++;
      liveCounts.set(key, live);
    }
    if ([...liveCounts.values()].some(count => count > 1)) throw new Error("Document address already has a current incarnation");
  }

  private async writeDocuments(actions: Map<number, DocumentAction>, seq: Seq): Promise<void> {
    for (const [id, action] of actions) {
      let content = action.content;
      if (action.copy) {
        try {
          const stored = await this.materialize(action.copy.id, action.copy.at);
          const create = action.create!;
          if (!stored || stored.record.scope.kind !== "conversation" || create.scope.kind !== "conversation"
            || stored.record.kind !== create.kind || stored.record.key !== create.key || stored.record.history !== create.history || stored.record.fork !== create.fork) {
            throw new Error("The source does not match the copied document.");
          }
          content = { kind: "base", version: stored.version, value: stored.value };
        } catch (cause) { throw new Error(`Document copy ${id} was rejected`, { cause }); }
      }
      let record: DocumentRecord;
      if (action.create) {
        record = { ...action.create, createdAt: seq, ...(action.retire ? { retiredAt: seq } : {}) } as DocumentRecord;
        const scope = scopeParts(record.scope);
        await this.claimId(id, "document");
        await this.query(`insert into ${this.table("documents")} (session_id,id,address_key,kind,scope_kind,owner_id,created_at,retired_at,record)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, addressKey(record), JSON.stringify(record.kind), scope.kind, scope.owner, seq, action.retire ? seq : null, JSON.stringify(record)]);
      } else record = (await this.record<DocumentRecord>("documents", id))!;
      if (content) {
        if (content.kind === "base" && currentOnly(record)) await this.clearRevisions(id);
        await this.query(`insert into ${this.schema}.agent_document_revisions (session_id,document_id,seq,kind,version,content) values ($1,$2,$3,$4,$5,$6)`,
          [id, seq, content.kind, content.version, JSON.stringify(content.kind === "base" ? content.value : content.ops)]);
      }
      if (action.retire) {
        if (!action.create) {
          record = { ...record, retiredAt: seq };
          await this.query(`update ${this.table("documents")} set retired_at=$3,record=$4 where session_id=$1 and id=$2`, [id, seq, JSON.stringify(record)]);
        }
        if (currentOnly(record)) await this.clearRevisions(id);
      }
    }
  }

  private clearRevisions(id: number): Promise<pg.QueryResult> {
    return this.query(`delete from ${this.schema}.agent_document_revisions where session_id=$1 and document_id=$2`, [id]);
  }
}

class Conditions {
  readonly sql = ["session_id=$1"];
  readonly params: unknown[];
  constructor(sessionId: string) { this.params = [sessionId]; }
  add(column: string, operator: string, value: unknown): this {
    this.params.push(value); this.sql.push(`${column} ${operator} $${this.params.length}`); return this;
  }
  raw(sql: string): this { this.sql.push(sql); return this; }
}
function scopeParts(scope: DocumentAddress["scope"]): { kind: string; owner: number } {
  return { kind: scope.kind, owner: scope.kind === "session" ? 0 : scope.kind === "conversation" ? scope.conversationId : scope.taskId };
}
function addressKey(address: DocumentAddress): string {
  const scope = scopeParts(address.scope);
  return JSON.stringify([address.kind, scope.kind, scope.owner, address.key === undefined ? 0 : 1, address.key ?? ""]);
}
function currentOnly(record: DocumentRecord): boolean { return record.scope.kind !== "conversation" || record.history === "latest"; }
function scanStart(requested: ScanOrder | undefined, cursor: Cursor | undefined, fallback: ScanOrder): { order: ScanOrder; after?: number } {
  if (requested !== undefined && requested !== "ascending" && requested !== "descending") throw new AgentStorageRequestError(`Invalid scan order: ${String(requested)}`);
  if (cursor === undefined) return { order: requested ?? fallback };
  const { after, order } = cursor;
  if (typeof after !== "number" || !Number.isSafeInteger(after) || order !== undefined && order !== "ascending" && order !== "descending") throw new AgentStorageRequestError("Invalid storage cursor");
  const resolved = order ?? fallback;
  if (requested !== undefined && requested !== resolved) throw new AgentStorageRequestError(`The cursor continues a ${resolved} scan; the query asks for ${requested}`);
  return { order: resolved, after };
}
function page<T extends { id: number }>(values: T[], limit: number, order: ScanOrder): { items: T[]; next?: Cursor } {
  const items = values.slice(0, limit);
  return { items, ...(values.length > limit ? { next: { after: items.at(-1)!.id, order } } : {}) };
}
