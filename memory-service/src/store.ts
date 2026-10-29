import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { buildFtsQuery, tokenizeForFts } from "../vendor/tencent/tokenize.js";

export type MemoryScope =
  | "global"
  | `project:${string}`
  | `directory:${string}`;
export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  content: string;
  origin: "manual" | "automatic";
  version: number;
  updatedAt: string;
  sources: { id: string; role: string; content: string }[];
}
export class MemoryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const fingerprint = (s: string) =>
  digest(s.normalize("NFKC").replace(/\s+/gu, "").toLowerCase());
const decode = (r: any): MemoryItem => ({
  id: r.id,
  scope: r.scope,
  content: r.content,
  origin: r.origin,
  version: r.version,
  updatedAt: r.updated_at,
  sources: JSON.parse(r.sources),
});

/** One account per file. Identities are hashed, never interpolated into a path. */
export class MemoryStore {
  private db: DatabaseSync;
  constructor(root: string, account: string) {
    const dir = path.join(root, digest(account));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, "memory.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scopes (scope TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY,scope TEXT NOT NULL,content TEXT NOT NULL,fingerprint TEXT NOT NULL,origin TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,sources TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope,deleted,updated_at,id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,tokens);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,body TEXT NOT NULL,states TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS suppressed (scope TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(scope,fingerprint));
      CREATE TABLE IF NOT EXISTS source_suppression (scope TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(scope,source_id));`);
    // Fail visibly when the runtime lacks FTS5, instead of reporting an empty search.
    this.db.prepare("SELECT count(*) FROM memory_fts").get();
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  state(scope: string) {
    this.db.prepare("INSERT OR IGNORE INTO scopes(scope) VALUES(?)").run(scope);
    const row = this.db
      .prepare("SELECT generation,revision FROM scopes WHERE scope=?")
      .get(scope)!;
    return { generation: Number(row.generation), revision: Number(row.revision) };
  }
  stageTurn(turn: {
    turnId: string;
    scope: MemoryScope;
    messages: {
      id: string;
      role: string;
      content: string;
      timestamp: number;
    }[];
  }) {
    return this.transaction(() => {
      const hash = digest(
        JSON.stringify({
          scope: turn.scope,
          messages: turn.messages.map(({ id, role, content }) => ({
            id,
            role,
            content,
          })),
        }),
      );
      const old = this.db
        .prepare("SELECT * FROM turns WHERE id=?")
        .get(turn.turnId);
      if (old) {
        if (old.payload_hash !== hash)
          throw new MemoryError(409, "Turn ID reused with different messages.");
        return JSON.parse(String(old.states));
      }
      const states = Object.fromEntries(
        [...new Set(["global", turn.scope])].map((scope) => [
          scope,
          this.state(scope),
        ]),
      );
      this.db
        .prepare("INSERT INTO turns VALUES(?,?,?,?,0)")
        .run(turn.turnId, hash, JSON.stringify(turn), JSON.stringify(states));
      return states;
    });
  }
  getTurn(id: string) {
    const turn = this.db
      .prepare("SELECT body,completed FROM turns WHERE id=?")
      .get(id);
    if (!turn || turn.completed)
      throw new MemoryError(404, "Pending turn not found.");
    return JSON.parse(String(turn.body));
  }
  completeTurn(id: string) {
    this.db
      .prepare("UPDATE turns SET body='{}',completed=1 WHERE id=?")
      .run(id);
  }
  locate(id: string, scopes: string[]) {
    const row = this.db
      .prepare("SELECT scope FROM memories WHERE id=?")
      .get(id);
    if (!row || !scopes.includes(String(row.scope)))
      throw new MemoryError(404, "Memory not found.");
    return { scope: String(row.scope) };
  }
  get(id: string, scopes: string[]) {
    const r = this.db
      .prepare("SELECT * FROM memories WHERE id=? AND deleted=0")
      .get(id);
    if (!r || !scopes.includes(String(r.scope)))
      throw new MemoryError(404, "Memory not found.");
    return decode(r);
  }
  list(
    scopes: string[],
    options: {
      query?: string;
      origin?: string;
      cursor?: string;
      pageSize?: number;
    } = {},
  ) {
    if (
      options.pageSize !== undefined &&
      (!Number.isInteger(options.pageSize) ||
        options.pageSize < 1 ||
        options.pageSize > 100)
    )
      throw new MemoryError(400, "Invalid page size.");
    if (
      options.origin !== undefined &&
      !["manual", "automatic"].includes(options.origin)
    )
      throw new MemoryError(400, "Invalid memory source.");
    const limit = options.pageSize ?? 20;
    if (!scopes.length) return { items: [], nextCursor: undefined };
    const args: SQLInputValue[] = [...scopes];
    let where = `m.deleted=0 AND m.scope IN (${scopes.map(() => "?").join(",")})`;
    if (options.origin) {
      where += " AND m.origin=?";
      args.push(options.origin);
    }
    const query = options.query?.trim()
      ? buildFtsQuery(options.query.slice(0, 4000))
      : null;
    if (options.query?.trim() && !query) return { items: [] };
    if (query) {
      where += " AND memory_fts MATCH ?";
      args.push(query);
    }
    // Stable keyset pagination; search rank is scoped before LIMIT, including in recall.
    let cursor: { updatedAt: string; id: string } | undefined;
    if (options.cursor) {
      try {
        if (typeof options.cursor !== "string" || options.cursor.length > 1000)
          throw new Error();
        cursor = JSON.parse(
          Buffer.from(options.cursor, "base64url").toString(),
        );
        if (
          !cursor ||
          typeof cursor.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(cursor.updatedAt)) ||
          typeof cursor.id !== "string" ||
          !/^[a-f0-9]{32}$/.test(cursor.id)
        )
          throw new Error();
      } catch {
        throw new MemoryError(400, "Invalid cursor.");
      }
    }
    if (cursor) {
      where += " AND (m.updated_at < ? OR (m.updated_at = ? AND m.id < ?))";
      args.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m ${query ? "JOIN memory_fts ON memory_fts.id=m.id" : ""} WHERE ${where} ORDER BY m.updated_at DESC,m.id DESC LIMIT ?`,
      )
      .all(...args, limit + 1);
    const items = rows.slice(0, limit).map(decode),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ updatedAt: last.updatedAt, id: last.id }),
            ).toString("base64url")
          : undefined,
    };
  }
  recall(scopes: string[], query: string, limit = 8) {
    const match = buildFtsQuery(query.slice(0, 4000));
    if (!match || !scopes.length) return [];
    return this.db
      .prepare(
        `SELECT m.* FROM memory_fts JOIN memories m ON m.id=memory_fts.id WHERE memory_fts MATCH ? AND m.deleted=0 AND m.scope IN (${scopes.map(() => "?").join(",")}) ORDER BY bm25(memory_fts),m.updated_at DESC LIMIT ?`,
      )
      .all(match, ...scopes, Math.min(8, limit))
      .map(decode);
  }
  counts(scopes: string[]) {
    return Object.fromEntries(
      scopes.map((scope) => [
        scope,
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS n FROM memories WHERE scope=? AND deleted=0",
            )
            .get(scope)?.n ?? 0,
        ),
      ]),
    );
  }
  apply(operation: {
    operationId: string;
    action: "remember" | "update" | "forget" | "clear" | "extract";
    scope: MemoryScope;
    id?: string;
    version?: number;
    content?: string;
    expected?: { generation: number; revision: number };
    candidates?: {
      content: string;
      scope: MemoryScope;
      sources: MemoryItem["sources"];
    }[];
  }) {
    if (!operation.operationId || operation.operationId.length > 200)
      throw new MemoryError(400, "A stable operation ID is required.");
    return this.transaction(() => {
      const hash = digest(JSON.stringify(operation)),
        receipt = this.db
          .prepare("SELECT * FROM receipts WHERE id=?")
          .get(operation.operationId);
      if (receipt) {
        if (receipt.payload_hash !== hash)
          throw new MemoryError(
            409,
            "Operation ID reused with different content.",
          );
        const result = JSON.parse(String(receipt.result));
        if (result.id && ["remember", "update"].includes(operation.action)) {
          try {
            return this.get(result.id, [operation.scope]);
          } catch {
            return { ...result, deleted: true };
          }
        }
        return result;
      }
      const { scope, action } = operation;
      const state = this.state(scope);
      let result: unknown = {};
      if (
        operation.expected &&
        (state.generation !== operation.expected.generation ||
          state.revision !== operation.expected.revision)
      ) {
        result = { discarded: true, reason: "scope_changed" };
      } else if (action === "clear") {
        for (const row of this.db
          .prepare("SELECT * FROM memories WHERE scope=? AND deleted=0")
          .all(scope))
          this.suppress(decode(row));
        this.db
          .prepare(
            "DELETE FROM memory_fts WHERE id IN (SELECT id FROM memories WHERE scope=?)",
          )
          .run(scope);
        this.db
          .prepare(
            "UPDATE memories SET deleted=1,content='',sources='[]' WHERE scope=?",
          )
          .run(scope);
        this.db
          .prepare(
            "UPDATE scopes SET generation=generation+1,revision=revision+1 WHERE scope=?",
          )
          .run(scope);
      } else if (action === "forget") {
        const old = this.get(operation.id!, [scope]);
        this.suppress(old);
        this.db
          .prepare(
            "UPDATE memories SET deleted=1,content='',sources='[]',version=version+1 WHERE id=?",
          )
          .run(old.id);
        this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(old.id);
        this.bump(scope);
        result = { id: old.id };
      } else if (action === "update") {
        const old = this.get(operation.id!, [scope]);
        if (old.version !== operation.version)
          throw new MemoryError(409, "Memory changed. Refresh before editing.");
        this.suppress(old);
        const content = this.content(operation.content);
        this.db
          .prepare(
            "UPDATE memories SET content=?,fingerprint=?,version=version+1,origin='manual',updated_at=? WHERE id=?",
          )
          .run(content, fingerprint(content), new Date().toISOString(), old.id);
        this.index(old.id, content);
        this.bump(scope);
        result = this.get(old.id, [scope]);
      } else if (action === "remember") {
        result = this.insert(
          scope,
          this.content(operation.content),
          "manual",
          [],
          operation.operationId,
        );
        this.bump(scope);
      } else {
        // No model-selected identities/scopes: the caller validates global promotion and supplies the target.
        let stored = 0;
        for (const c of (operation.candidates ?? []).slice(0, 20)) {
          if (c.scope !== scope)
            throw new MemoryError(400, "Candidate scope mismatch.");
          const content = this.content(c.content);
          const suppressed = this.db
            .prepare("SELECT 1 FROM suppressed WHERE scope=? AND fingerprint=?")
            .get(scope, fingerprint(content));
          const sourceSuppressed = c.sources.some((s) =>
            this.db
              .prepare(
                "SELECT 1 FROM source_suppression WHERE scope=? AND source_id=?",
              )
              .get(scope, s.id),
          );
          const exists = this.db
            .prepare(
              "SELECT 1 FROM memories WHERE scope=? AND fingerprint=? AND deleted=0",
            )
            .get(scope, fingerprint(content));
          if (!suppressed && !sourceSuppressed && !exists) {
            this.insert(
              scope,
              content,
              "automatic",
              c.sources,
              `${operation.operationId}:${stored}`,
            );
            stored++;
          }
        }
        result = { stored };
      }
      const receiptResult =
        result && typeof result === "object" && "id" in result
          ? { id: result.id }
          : result;
      this.db
        .prepare("INSERT INTO receipts VALUES(?,?,?)")
        .run(operation.operationId, hash, JSON.stringify(receiptResult));
      return result;
    });
  }
  private bump(scope: string) {
    this.db
      .prepare("UPDATE scopes SET revision=revision+1 WHERE scope=?")
      .run(scope);
  }
  private content(raw: unknown) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 16000)
      throw new MemoryError(400, "Memory must contain 1–16000 characters.");
    return raw.trim();
  }
  private index(id: string, content: string) {
    this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(id);
    this.db
      .prepare("INSERT INTO memory_fts(id,tokens) VALUES(?,?)")
      .run(id, tokenizeForFts(content));
  }
  private insert(
    scope: MemoryScope,
    content: string,
    origin: MemoryItem["origin"],
    sources: MemoryItem["sources"],
    key: string,
  ) {
    this.state(scope);
    const id = digest(key).slice(0, 32);
    this.db
      .prepare("INSERT INTO memories VALUES(?,?,?,?,?,1,?,?,0)")
      .run(
        id,
        scope,
        content,
        fingerprint(content),
        origin,
        new Date().toISOString(),
        JSON.stringify(sources),
      );
    this.index(id, content);
    return this.get(id, [scope]);
  }
  private suppress(item: MemoryItem) {
    this.db
      .prepare("INSERT OR IGNORE INTO suppressed VALUES(?,?)")
      .run(item.scope, fingerprint(item.content));
    for (const s of item.sources)
      this.db
        .prepare("INSERT OR IGNORE INTO source_suppression VALUES(?,?)")
        .run(item.scope, s.id);
  }
}
