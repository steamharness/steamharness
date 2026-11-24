import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail, validateBotMemoryProperties, validateBotMemoryRequest } from "./bot-memory-request";
import type { BotMemoryEntry, BotMemoryProperties, BotMemoryRequest, BotMemorySummary } from "./bot-memory-request";

export { BotMemoryError, validateBotMemoryRequest } from "./bot-memory-request";
export type { BotMemoryAddress, BotMemoryEntry, BotMemoryProperties, BotMemoryRequest, BotMemorySummary } from "./bot-memory-request";

export interface BotMemoryScope { projectId: string; entryId: string }
export interface BotMemoryStore {
  execute(request: BotMemoryRequest, requestId?: string): Promise<Record<string, unknown>>;
  close(): void;
}

function memoryTable(table: "bot_memories" | "bot_memories_new"): string {
  return `CREATE TABLE ${table} (
    project_id TEXT NOT NULL, entry_id TEXT NOT NULL, category TEXT NOT NULL, key TEXT NOT NULL,
    content TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))), title TEXT, summary TEXT,
    properties TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(properties) AND json_type(properties)='object'),
    PRIMARY KEY(project_id,entry_id,category,key), UNIQUE(project_id,entry_id,id));`;
}

function initializeSchema(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
  try {
    const columns = database.prepare("PRAGMA table_info(bot_memories)").all();
    if (columns.length === 0) database.exec(memoryTable("bot_memories"));
    else if (!columns.some(column => column.name === "id")) {
      // The new default assigns IDs to legacy rows and to inserts from older workers.
      const legacyColumns = "project_id,entry_id,category,key,content,revision,created_at,updated_at";
      database.exec(`${memoryTable("bot_memories_new")}
        INSERT INTO bot_memories_new(${legacyColumns}) SELECT ${legacyColumns} FROM bot_memories;
        DROP TABLE bot_memories;
        ALTER TABLE bot_memories_new RENAME TO bot_memories;`);
    }
    database.exec(`CREATE TABLE IF NOT EXISTS bot_memory_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO bot_memory_sequence VALUES(1,0);
      CREATE TABLE IF NOT EXISTS bot_memory_receipts(project_id TEXT NOT NULL,entry_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project_id,entry_id,request_id));
      CREATE TABLE IF NOT EXISTS bot_memory_relations (
        project_id TEXT NOT NULL, entry_id TEXT NOT NULL, source_id TEXT NOT NULL, relation TEXT NOT NULL, target_id TEXT NOT NULL,
        PRIMARY KEY(project_id,entry_id,source_id,relation,target_id), CHECK(source_id<>target_id),
        FOREIGN KEY(project_id,entry_id,source_id) REFERENCES bot_memories(project_id,entry_id,id) ON DELETE CASCADE,
        FOREIGN KEY(project_id,entry_id,target_id) REFERENCES bot_memories(project_id,entry_id,id) ON DELETE RESTRICT);
      CREATE INDEX IF NOT EXISTS bot_memory_backlinks ON bot_memory_relations(project_id,entry_id,target_id,relation,source_id);
      COMMIT;`);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const metadata = (row: Record<string, unknown>): BotMemorySummary => ({ id: row.id as string, category: row.category as string, key: row.key as string,
  revision: Number(row.revision), createdAt: row.created_at as string, updatedAt: row.updated_at as string });
const summary = (row: Record<string, unknown>): BotMemorySummary => ({ ...metadata(row),
  ...(typeof row.title === "string" ? { title: row.title } : {}), ...(typeof row.summary === "string" ? { summary: row.summary } : {}) });
const propertiesOf = (row: Record<string, unknown>): BotMemoryProperties => JSON.parse(row.properties as string) as BotMemoryProperties;
const entry = (row: Record<string, unknown>): BotMemoryEntry => ({ ...summary(row), content: row.content as string, properties: propertiesOf(row) });

const scopeFilter = "project_id=? AND entry_id=?";
const byId = `${scopeFilter} AND id=?`;
const relationFilter = `${scopeFilter} AND source_id=? AND relation=? AND target_id=?`;
const indexColumns = "id,category,key,title,summary,revision,created_at,updated_at";
const searchFields = [["key", 6], ["category", 3], ["title", 6], ["summary", 3], ["content", 1]] as const;
const contains = (field: string, term: "?" | "term") => `instr(lower(${field}),${term})>0`;

function memoryFilters(scope: string[], request: Extract<BotMemoryRequest, { action: "get" | "search" }>) {
  const filters = [scopeFilter], args: (string | number)[] = [...scope];
  if (request.category !== undefined) { filters.push("category=?"); args.push(request.category); }
  for (const [name, value] of Object.entries(request.where ?? {})) {
    const comparison = value === null || typeof value === "boolean" ? "p.type=?"
      : typeof value === "number" ? "p.type IN ('integer','real') AND p.atom=?" : "p.type='text' AND p.atom=?";
    filters.push(`EXISTS (SELECT 1 FROM json_each(bot_memories.properties) p WHERE p.key=? AND ${comparison})`);
    args.push(name, value === null || typeof value === "boolean" ? String(value) : value);
  }
  return { filters, args };
}

/** A host chooses the file and identity. Model arguments can never select another Bot. */
export function createSqliteBotMemoryStore(options: BotMemoryScope & { file: string }): BotMemoryStore {
  if (!options.projectId || !options.entryId) throw new Error("Bot memory requires projectId and entryId.");
  const scope = [options.projectId.toLowerCase(), options.entryId];
  let database: DatabaseSync | undefined, closed = false;
  const db = () => {
    if (closed) throw new Error("Bot memory storage is closed.");
    if (database) return database;
    if (options.file !== ":memory:") mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
    const opened = new DatabaseSync(options.file, { timeout: 5_000, enableForeignKeyConstraints: true });
    try { initializeSchema(opened); }
    catch (error) { opened.close(); throw error; }
    return database = opened;
  };
  const find = (selector: { id?: string; category?: string; key?: string }) => selector.id !== undefined
    ? db().prepare(`SELECT * FROM bot_memories WHERE ${byId}`).get(...scope, selector.id)
    : db().prepare(`SELECT * FROM bot_memories WHERE ${scopeFilter} AND category=? AND key=?`).get(...scope, selector.category!, selector.key!);

  const readRelations = (id: string, direction: "incoming" | "outgoing", limit: number, offset: number) => {
    const [from, to] = direction === "outgoing" ? ["source_id", "target_id"] : ["target_id", "source_id"];
    const rows = db().prepare(`SELECT r.relation,${indexColumns},m.properties FROM bot_memory_relations r
      JOIN bot_memories m ON m.project_id=r.project_id AND m.entry_id=r.entry_id AND m.id=r.${to}
      WHERE r.project_id=? AND r.entry_id=? AND r.${from}=? ORDER BY r.relation,r.${to} LIMIT ? OFFSET ?`)
      .all(...scope, id, limit + 1, offset);
    const relations: { relation: string; memory: BotMemorySummary & { properties: BotMemoryProperties } }[] = [];
    for (const row of rows.slice(0, limit)) {
      const related = { relation: row.relation as string, memory: { ...summary(row), properties: propertiesOf(row) } };
      if (relations.length && JSON.stringify([...relations, related]).length > 10_000) break;
      relations.push(related);
    }
    return { relations, ...(rows.length > relations.length ? { nextOffset: offset + relations.length } : {}) };
  };

  return {
    async execute(input, requestId) {
      const request = validateBotMemoryRequest(input), database = db();
      if (request.action === "search") {
        const { keywords } = request, limit = request.limit ?? 5, offset = request.offset ?? 0;
        // Literal substring matching also works for Chinese and does not interpret SQL wildcards.
        const matches = searchFields.map(([field]) => contains(field, "term")).join(" OR ");
        const rank = searchFields.map(([field, weight]) => `(CASE WHEN ${contains(field, "term")} THEN ${weight} ELSE 0 END)`).join("+");
        const { filters, args } = memoryFilters(scope, request);
        const rows = database.prepare(`WITH terms(term) AS (VALUES ${keywords.map(() => "(?)").join(",")}), ranked AS (
          SELECT ${indexColumns},content,
            (SELECT COUNT(*) FROM terms WHERE ${matches}) AS matched,
            (SELECT SUM(${rank}) FROM terms) AS relevance
          FROM bot_memories WHERE ${filters.join(" AND ")})
          SELECT * FROM ranked WHERE matched>=? ORDER BY matched DESC,relevance DESC,updated_at DESC,category,key LIMIT ? OFFSET ?`)
          .all(...keywords, ...args, request.match === "all" ? keywords.length : 1, limit + 1, offset);
        const memories: Record<string, unknown>[] = [];
        for (const row of rows.slice(0, limit)) {
          const content = row.content as string, lowered = content.toLowerCase();
          const positions = keywords.map(word => lowered.indexOf(word)).filter(index => index >= 0);
          let start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 60);
          if (start > 0 && /[\uDC00-\uDFFF]/u.test(content[start]!)) start--;
          const excerpt = Array.from(content.slice(start)).slice(0, 240).join("");
          const values = searchFields.map(([field]) => String(row[field] ?? "").toLowerCase());
          const memory = { ...summary(row), excerpt, matchedKeywords: keywords.filter(word => values.some(value => value.includes(word))) };
          // Bound the whole response as well as its count; long keys/keywords cannot flood context.
          const responseSize = () => JSON.stringify({ memories: [...memories, memory], nextOffset: offset + memories.length + 1 }).length;
          // Escaped control characters can enlarge even one summary. Shorten its excerpt
          // rather than returning an empty page whose nextOffset would never advance.
          if (memories.length === 0) {
            for (const field of ["excerpt", "summary"] as const) {
              while (memory[field]?.length && responseSize() > 6_000) memory[field] = Array.from(memory[field]!).slice(0, -16).join("");
            }
            while (memory.matchedKeywords.length && responseSize() > 6_000) memory.matchedKeywords.pop();
          }
          if (responseSize() > 6_000) break;
          memories.push(memory);
        }
        return { memories, ...(rows.length > memories.length ? { nextOffset: offset + memories.length } : {}) };
      }
      if (request.action === "get") {
        if (request.key !== undefined || request.id !== undefined) {
          if (!request.relations) {
            const row = find(request);
            return { memory: row ? entry(row) : null };
          }
          // Read the root and its immediate neighbors from the same SQLite snapshot.
          database.exec("BEGIN");
          try {
            const row = find(request);
            const result = row ? { memory: entry(row), ...readRelations(row.id as string, request.relations, request.limit ?? 5, request.offset ?? 0) } : { memory: null };
            database.exec("COMMIT");
            return result;
          } catch (error) { database.exec("ROLLBACK"); throw error; }
        }
        const limit = request.limit ?? 10, offset = request.offset ?? 0;
        if (request.category === undefined && request.query === undefined && request.where === undefined) {
          const rows = database.prepare("SELECT category,COUNT(*) AS count FROM bot_memories WHERE project_id=? AND entry_id=? GROUP BY category ORDER BY category LIMIT ? OFFSET ?").all(...scope, limit + 1, offset);
          return { categories: rows.slice(0, limit).map(row => ({ category: row.category, count: Number(row.count) })), ...(rows.length > limit ? { nextOffset: offset + limit } : {}) };
        }
        const { filters, args } = memoryFilters(scope, request);
        if (request.query !== undefined) {
          for (const term of request.query.toLowerCase().split(/\s+/u)) {
            filters.push(`(${searchFields.map(([field]) => contains(field, "?")).join(" OR ")})`);
            args.push(...searchFields.map(() => term));
          }
        }
        const rows = database.prepare(`SELECT ${indexColumns},substr(content,1,240) AS excerpt FROM bot_memories WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC,category,key LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
        return { memories: rows.slice(0, limit).map(row => ({ ...summary(row), excerpt: row.excerpt })), ...(rows.length > limit ? { nextOffset: offset + limit } : {}) };
      }
      if (requestId !== undefined && (!requestId || requestId.length > 1_000)) return fail("BOT_MEMORY_INVALID_INPUT", "Invalid memory request ID.");
      const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      database.exec("BEGIN IMMEDIATE");
      try {
        if (requestId) {
          const receipt = database.prepare("SELECT fingerprint,result FROM bot_memory_receipts WHERE project_id=? AND entry_id=? AND request_id=?").get(...scope, requestId);
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) fail("BOT_MEMORY_IDEMPOTENCY_CONFLICT", "This memory request ID already belongs to a different operation.");
            database.exec("COMMIT"); return JSON.parse(receipt.result as string) as Record<string, unknown>;
          }
        }
        const revision = Number(database.prepare("UPDATE bot_memory_sequence SET revision=revision+1 WHERE singleton=1 RETURNING revision").get()!.revision);
        const now = new Date().toISOString();
        let result: Record<string, unknown>;
        if (request.action === "save") {
          if (find(request)) fail("BOT_MEMORY_ALREADY_EXISTS", "This category and key already exist. Read the memory, then update its revision.");
          const row = database.prepare(`INSERT INTO bot_memories(project_id,entry_id,category,key,content,revision,created_at,updated_at,title,summary,properties)
            VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING ${indexColumns}`)
            .get(...scope, request.category, request.key, request.content ?? "", revision, now, now, request.title ?? null, request.summary ?? null,
              JSON.stringify(request.properties ?? {}))!;
          result = { memory: metadata(row) };
        } else {
          const previous = find("sourceId" in request ? { id: request.sourceId } : request)
            ?? fail("BOT_MEMORY_NOT_FOUND", "This memory does not exist.");
          const current = metadata(previous);
          if (current.revision !== request.expectedRevision) fail("BOT_MEMORY_REVISION_CONFLICT", "This memory changed. Read its latest revision before writing.");
          if (request.action === "delete") {
            if (database.prepare(`SELECT 1 FROM bot_memory_relations WHERE ${scopeFilter} AND target_id=? LIMIT 1`).get(...scope, current.id)) {
              fail("BOT_MEMORY_REFERENCED", "Other memories reference this memory. Read its incoming relations and unlink them before deleting it.");
            }
            database.prepare(`DELETE FROM bot_memories WHERE ${byId}`).run(...scope, current.id);
            result = { deleted: true, id: current.id, category: current.category, key: current.key, revision };
          } else if (request.action === "update") {
            const fields = request.properties || request.removeProperties
              ? JSON.stringify(validateBotMemoryProperties(Object.fromEntries(Object.entries({ ...propertiesOf(previous), ...request.properties })
                .filter(([name]) => !request.removeProperties?.includes(name))))) : previous.properties as string;
            database.prepare(`UPDATE bot_memories SET content=?,title=?,summary=?,properties=?,revision=?,updated_at=? WHERE ${byId}`)
              .run(request.content === undefined ? previous.content as string : request.content ?? "",
                request.title === undefined ? previous.title as string | null : request.title,
                request.summary === undefined ? previous.summary as string | null : request.summary, fields, revision, now, ...scope, current.id);
            result = { memory: { ...current, revision, updatedAt: now } };
          } else {
            if (!find({ id: request.targetId })) fail("BOT_MEMORY_NOT_FOUND", "The target memory does not exist in this Bot.");
            const args = [...scope, current.id, request.relation, request.targetId];
            if (request.action === "link") {
              const linked = database.prepare("INSERT INTO bot_memory_relations VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(...args);
              if (!linked.changes) fail("BOT_MEMORY_RELATION_ALREADY_EXISTS", "This relation already exists.");
            } else {
              const unlinked = database.prepare(`DELETE FROM bot_memory_relations WHERE ${relationFilter}`).run(...args);
              if (!unlinked.changes) fail("BOT_MEMORY_RELATION_NOT_FOUND", "This relation does not exist.");
            }
            database.prepare(`UPDATE bot_memories SET revision=?,updated_at=? WHERE ${byId}`).run(revision, now, ...scope, current.id);
            result = { [request.action === "link" ? "linked" : "unlinked"]: true, memory: { ...current, revision, updatedAt: now } };
          }
        }
        // Receipts contain metadata only, so deletion does not leave a second copy of memory content.
        if (requestId) database.prepare("INSERT INTO bot_memory_receipts VALUES(?,?,?,?,?)").run(...scope, requestId, fingerprint, JSON.stringify(result));
        database.exec("COMMIT"); return result;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    close() { if (!closed) { closed = true; database?.close(); database = undefined; } },
  };
}
