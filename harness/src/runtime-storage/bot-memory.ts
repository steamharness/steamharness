import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface BotMemoryScope { projectId: string; entryId: string }
export interface BotMemoryAddress { category: string; key: string }
export interface BotMemorySummary extends BotMemoryAddress { revision: number; createdAt: string; updatedAt: string }
export interface BotMemoryEntry extends BotMemorySummary { content: string }
export type BotMemoryRequest =
  | ({ action: "save"; content: string } & BotMemoryAddress)
  | { action: "get"; category?: string; key?: string; query?: string; limit?: number; offset?: number }
  | { action: "search"; keywords: string[]; match?: "any" | "all"; category?: string; limit?: number; offset?: number }
  | ({ action: "update"; content: string; expectedRevision: number } & BotMemoryAddress)
  | ({ action: "delete"; expectedRevision: number } & BotMemoryAddress);
export interface BotMemoryStore {
  execute(request: BotMemoryRequest, requestId?: string): Promise<Record<string, unknown>>;
  close(): void;
}

export class BotMemoryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BotMemoryError"; }
}
const fail = (code: string, message: string): never => { throw new BotMemoryError(code, message); };
const invalid = (message: string): never => fail("BOT_MEMORY_INVALID_INPUT", message);
export function validateBotMemoryRequest(input: unknown): BotMemoryRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("Memory arguments must be an object.");
  const value = input as Record<string, unknown>;
  const text = (name: string, limit: number) => {
    const item = value[name];
    if (typeof item !== "string" || !item.trim() || item.length > limit || item.includes("\0")) return invalid(`Memory ${name} must contain 1-${limit} characters without NUL.`);
    return item.trim();
  };
  const integer = (name: string, min: number, max: number) => {
    const item = value[name];
    if (!Number.isSafeInteger(item) || (item as number) < min || (item as number) > max) return invalid(`Memory ${name} must be an integer between ${min} and ${max}.`);
    return item as number;
  };
  const action = value.action;
  const allowed = action === "get" ? ["action", "category", "key", "query", "limit", "offset"]
    : action === "search" ? ["action", "keywords", "match", "category", "limit", "offset"]
    : action === "save" ? ["action", "category", "key", "content"]
      : action === "update" ? ["action", "category", "key", "content", "expectedRevision"]
        : action === "delete" ? ["action", "category", "key", "expectedRevision"] : undefined;
  if (!allowed || Object.keys(value).some(key => !allowed.includes(key))) return invalid("Unknown memory action or argument.");
  if (action === "search") {
    const keywords = value.keywords;
    if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 12
      || [...keywords].some(word => typeof word !== "string" || !word.trim() || word.length > 80 || word.includes("\0"))
      || keywords.join(" ").length > 500) return invalid("Memory search requires 1-12 keywords, each 1-80 characters, totaling at most 500 characters.");
    if (value.match !== undefined && value.match !== "any" && value.match !== "all") return invalid("Memory search match must be any or all.");
    return { action, keywords: [...new Set((keywords as string[]).map(word => word.trim().toLowerCase()))],
      ...(value.match === undefined ? {} : { match: value.match }), ...(value.category === undefined ? {} : { category: text("category", 100) }),
      ...(value.limit === undefined ? {} : { limit: integer("limit", 1, 10) }), ...(value.offset === undefined ? {} : { offset: integer("offset", 0, 1_000_000) }) };
  }
  if (action === "get") {
    if (value.key !== undefined && (value.category === undefined || value.query !== undefined)) return invalid("Read one memory with category and key, without query.");
    if (typeof value.query === "string" && value.query.trim().split(/\s+/u).length > 12) return invalid("Memory queries support at most 12 search terms.");
    return { action, ...(value.category === undefined ? {} : { category: text("category", 100) }),
      ...(value.key === undefined ? {} : { key: text("key", 200) }), ...(value.query === undefined ? {} : { query: text("query", 500) }),
      ...(value.limit === undefined ? {} : { limit: integer("limit", 1, 20) }), ...(value.offset === undefined ? {} : { offset: integer("offset", 0, 1_000_000) }) };
  }
  const address = { category: text("category", 100), key: text("key", 200) };
  if (action === "save") return { action, ...address, content: text("content", 8_000) };
  const expectedRevision = integer("expectedRevision", 1, Number.MAX_SAFE_INTEGER);
  return action === "update" ? { action, ...address, content: text("content", 8_000), expectedRevision }
    : { action: "delete", ...address, expectedRevision };
}

/** A host chooses the file and identity. Model arguments can never select another Bot. */
export function createSqliteBotMemoryStore(options: BotMemoryScope & { file: string }): BotMemoryStore {
  if (!options.projectId || !options.entryId) throw new Error("Bot memory requires projectId and entryId.");
  const scope = [options.projectId.toLowerCase(), options.entryId];
  let database: DatabaseSync | undefined, closed = false;
  const db = () => {
    if (closed) throw new Error("Bot memory storage is closed.");
    if (!database) {
      if (options.file !== ":memory:") mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
      database = new DatabaseSync(options.file, { timeout: 5_000 });
      database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS bot_memories(project_id TEXT NOT NULL,entry_id TEXT NOT NULL,category TEXT NOT NULL,key TEXT NOT NULL,content TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,entry_id,category,key));
        CREATE TABLE IF NOT EXISTS bot_memory_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO bot_memory_sequence VALUES(1,0);
        CREATE TABLE IF NOT EXISTS bot_memory_receipts(project_id TEXT NOT NULL,entry_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project_id,entry_id,request_id));`);
    }
    return database;
  };
  const summary = (row: Record<string, unknown>): BotMemorySummary => ({ category: row.category as string, key: row.key as string,
    revision: Number(row.revision), createdAt: row.created_at as string, updatedAt: row.updated_at as string });
  const find = (category: string, key: string) => db().prepare("SELECT * FROM bot_memories WHERE project_id=? AND entry_id=? AND category=? AND key=?").get(...scope, category, key);
  return {
    async execute(input, requestId) {
      const request = validateBotMemoryRequest(input), database = db();
      if (request.action === "search") {
        const { keywords } = request, limit = request.limit ?? 5, offset = request.offset ?? 0;
        // Literal substring matching also works for Chinese and does not interpret SQL wildcards.
        const matches = "instr(lower(category),term)>0 OR instr(lower(key),term)>0 OR instr(lower(content),term)>0";
        const rows = database.prepare(`WITH terms(term) AS (VALUES ${keywords.map(() => "(?)").join(",")}), ranked AS (
          SELECT category,key,content,revision,created_at,updated_at,
            (SELECT COUNT(*) FROM terms WHERE ${matches}) AS matched,
            (SELECT SUM((CASE WHEN instr(lower(key),term)>0 THEN 6 ELSE 0 END)
              +(CASE WHEN instr(lower(category),term)>0 THEN 3 ELSE 0 END)
              +(CASE WHEN instr(lower(content),term)>0 THEN 1 ELSE 0 END)) FROM terms) AS relevance
          FROM bot_memories WHERE project_id=? AND entry_id=?${request.category === undefined ? "" : " AND category=?"})
          SELECT * FROM ranked WHERE matched>=? ORDER BY matched DESC,relevance DESC,updated_at DESC,category,key LIMIT ? OFFSET ?`)
          .all(...keywords, ...scope, ...(request.category === undefined ? [] : [request.category]), request.match === "all" ? keywords.length : 1, limit + 1, offset);
        const memories: Record<string, unknown>[] = [];
        for (const row of rows.slice(0, limit)) {
          const content = row.content as string, lowered = content.toLowerCase();
          const positions = keywords.map(word => lowered.indexOf(word)).filter(index => index >= 0);
          let start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 60);
          if (start > 0 && /[\uDC00-\uDFFF]/u.test(content[start]!)) start--;
          const excerpt = Array.from(content.slice(start)).slice(0, 240).join("");
          const memory = { ...summary(row), excerpt, matchedKeywords: keywords.filter(word =>
            `${row.category}\n${row.key}\n${content}`.toLowerCase().includes(word)) };
          // Bound the whole response as well as its count; long keys/keywords cannot flood context.
          const responseSize = () => JSON.stringify({ memories: [...memories, memory], nextOffset: offset + memories.length + 1 }).length;
          // Escaped control characters can enlarge even one summary. Shorten its excerpt
          // rather than returning an empty page whose nextOffset would never advance.
          if (memories.length === 0) while (memory.excerpt.length > 0 && responseSize() > 6_000) {
            memory.excerpt = Array.from(memory.excerpt).slice(0, -16).join("");
          }
          if (responseSize() > 6_000) break;
          memories.push(memory);
        }
        return { memories, ...(rows.length > memories.length ? { nextOffset: offset + memories.length } : {}) };
      }
      if (request.action === "get") {
        if (request.key !== undefined) {
          const row = find(request.category!, request.key);
          return { memory: row ? { ...summary(row), content: row.content } : null };
        }
        const limit = request.limit ?? 10, offset = request.offset ?? 0;
        if (request.category === undefined && request.query === undefined) {
          const rows = database.prepare("SELECT category,COUNT(*) AS count FROM bot_memories WHERE project_id=? AND entry_id=? GROUP BY category ORDER BY category LIMIT ? OFFSET ?").all(...scope, limit + 1, offset);
          return { categories: rows.slice(0, limit).map(row => ({ category: row.category, count: Number(row.count) })), ...(rows.length > limit ? { nextOffset: offset + limit } : {}) };
        }
        const filters = ["project_id=?", "entry_id=?"], args: (string | number)[] = [...scope];
        if (request.category !== undefined) { filters.push("category=?"); args.push(request.category); }
        if (request.query !== undefined) {
          for (const term of request.query.toLowerCase().split(/\s+/u)) {
            filters.push("(instr(lower(category),?)>0 OR instr(lower(key),?)>0 OR instr(lower(content),?)>0)"); args.push(term, term, term);
          }
        }
        const rows = database.prepare(`SELECT category,key,revision,created_at,updated_at,substr(content,1,240) AS excerpt FROM bot_memories WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC,category,key LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
        return { memories: rows.slice(0, limit).map(row => ({ ...summary(row), excerpt: row.excerpt })), ...(rows.length > limit ? { nextOffset: offset + limit } : {}) };
      }
      if (requestId !== undefined && (!requestId || requestId.length > 1_000)) return invalid("Invalid memory request ID.");
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
        const previous = find(request.category, request.key);
        if (request.action === "save" && previous) fail("BOT_MEMORY_ALREADY_EXISTS", "This category and key already exist. Read the memory, then update its revision.");
        if (request.action !== "save") {
          if (!previous) fail("BOT_MEMORY_NOT_FOUND", "This memory does not exist.");
          if (Number(previous!.revision) !== request.expectedRevision) fail("BOT_MEMORY_REVISION_CONFLICT", "This memory changed. Read its latest revision before editing or deleting.");
        }
        const revision = Number(database.prepare("UPDATE bot_memory_sequence SET revision=revision+1 WHERE singleton=1 RETURNING revision").get()!.revision);
        const now = new Date().toISOString();
        let result: Record<string, unknown>;
        if (request.action === "delete") {
          database.prepare("DELETE FROM bot_memories WHERE project_id=? AND entry_id=? AND category=? AND key=?").run(...scope, request.category, request.key);
          result = { deleted: true, category: request.category, key: request.key, revision };
        } else {
          const createdAt = previous?.created_at as string | undefined ?? now;
          database.prepare("INSERT INTO bot_memories(project_id,entry_id,category,key,content,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,entry_id,category,key) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at")
            .run(...scope, request.category, request.key, request.content, revision, createdAt, now);
          result = { memory: { category: request.category, key: request.key, revision, createdAt, updatedAt: now } };
        }
        // Receipts contain metadata only, so deletion does not leave a second copy of memory content.
        if (requestId) database.prepare("INSERT INTO bot_memory_receipts VALUES(?,?,?,?,?)").run(...scope, requestId, fingerprint, JSON.stringify(result));
        database.exec("COMMIT"); return result;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    close() { if (!closed) { closed = true; database?.close(); database = undefined; } },
  };
}
