import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BotFileWorkspace } from "./bot-files";

const MAX_BYTES = 50 * 1024 * 1024;
const columns = "position,id,title,name,size,created_at,conversation_id,run_id,request_id,output_id";
const validId = (id: string) => /^ba_[a-f0-9]{32}$/u.test(id);
const validateId = (id: string) => { if (!validId(id)) throw new Error("Invalid Bot artifact ID."); };

export interface BotArtifactSource {
  conversationId: string;
  runId: string;
  requestId: string;
  outputId: string;
}

export interface BotArtifact {
  id: string;
  title: string;
  name: string;
  size: number;
  createdAt: string;
  source: BotArtifactSource;
}

export interface BotArtifactStore {
  publish(input: { path: string; title?: string }, source: BotArtifactSource, callId: string, signal?: AbortSignal): Promise<BotArtifact>;
  list(before?: number, limit?: number): { artifacts: BotArtifact[]; nextBefore?: number };
  get(id: string): BotArtifact | undefined;
  read(id: string): { artifact: BotArtifact; bytes: Uint8Array } | undefined;
  delete(id: string): boolean;
}

type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;
function artifact(row: Row): BotArtifact {
  return { id: String(row.id), name: String(row.name), title: String(row.title), size: Number(row.size), createdAt: String(row.created_at),
    source: { conversationId: String(row.conversation_id), runId: String(row.run_id), requestId: String(row.request_id), outputId: String(row.output_id) } };
}

/** One database per host-owned Bot scope, independent of conversations and mutable source files. */
export function createBotArtifactStore(file: string, files: BotFileWorkspace, assertOpen: () => void): BotArtifactStore {
  const use = <T>(write: boolean, action: (database: DatabaseSync) => T): T | undefined => {
    assertOpen();
    const parent = path.dirname(file);
    if (write) {
      mkdirSync(path.dirname(parent), { recursive: true, mode: 0o700 });
      try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const folder = lstatSync(parent, { throwIfNoEntry: false });
    if (!folder && !write) return;
    if (!folder?.isDirectory()) throw new Error("The Bot artifact directory is unavailable.");
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat && !write) return;
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error("The Bot artifact database is unavailable.");
    const db = new DatabaseSync(file, { timeout: 5_000, readOnly: !write });
    try {
      if (write) db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS bot_artifacts(
          position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
          title TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL,
          conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL, output_id TEXT NOT NULL, bytes BLOB);`);
      // A first writer may have opened SQLite but not committed the schema yet.
      else if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='bot_artifacts'").get()) return;
      return action(db);
    } finally { db.close(); }
  };
  return {
    async publish(input, source, callId, signal) {
      const title = input.title?.trim();
      if (typeof input.path !== "string" || (title !== undefined && (!title || title.length > 160 || /[\u0000-\u001f\u007f]/u.test(title)))) throw new Error("Invalid Bot artifact path or title.");
      if ([source.conversationId, source.runId, source.requestId, source.outputId, callId].some(value => typeof value !== "string" || !value || value.length > 1024)) {
        throw new Error("A Bot artifact needs an active conversation and tool call.");
      }
      const receipt = createHash("sha256").update(JSON.stringify([source.conversationId, source.requestId, callId])).digest("hex");
      const fingerprint = createHash("sha256").update(JSON.stringify([input.path, title ?? null])).digest("hex");
      const committed = (db: DatabaseSync) => {
        const row = db.prepare(`SELECT ${columns},fingerprint,bytes IS NULL AS removed FROM bot_artifacts WHERE receipt=?`).get(receipt);
        if (!row) return;
        if (row.fingerprint !== fingerprint) throw new Error("This tool call already delivered a different file.");
        if (row.removed) throw new Error("This delivery was removed by the user.");
        return artifact(row);
      };
      signal?.throwIfAborted();
      const existing = use(false, committed);
      if (existing) return existing;
      const { name, bytes } = await files.snapshotArtifact(input.path, MAX_BYTES, signal);
      signal?.throwIfAborted();
      return use(true, db => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = committed(db) ?? artifact(db.prepare(`INSERT INTO bot_artifacts
            (id,receipt,fingerprint,title,name,size,created_at,conversation_id,run_id,request_id,output_id,bytes)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING ${columns}`).get(`ba_${randomUUID().replaceAll("-", "")}`, receipt, fingerprint,
            title ?? name, name, bytes.length, new Date().toISOString(), source.conversationId, source.runId, source.requestId, source.outputId, bytes)!);
          db.exec("COMMIT");
          return result;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      })!;
    },
    list(before, limit = 30) {
      if ((before !== undefined && (!Number.isSafeInteger(before) || before < 1)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid Bot artifact page.");
      const rows = use(false, db => db.prepare(`SELECT ${columns} FROM bot_artifacts WHERE bytes IS NOT NULL
        ${before === undefined ? "" : "AND position < ?"} ORDER BY position DESC LIMIT ?`).all(...(before === undefined ? [] : [before]), limit + 1)) ?? [];
      return { artifacts: rows.slice(0, limit).map(artifact), ...(rows.length > limit ? { nextBefore: Number(rows[limit - 1]!.position) } : {}) };
    },
    get(id) {
      validateId(id);
      return use(false, db => { const row = db.prepare(`SELECT ${columns} FROM bot_artifacts WHERE id=? AND bytes IS NOT NULL`).get(id); return row && artifact(row); });
    },
    read(id) {
      validateId(id);
      return use(false, db => { const row = db.prepare(`SELECT ${columns},bytes FROM bot_artifacts WHERE id=? AND bytes IS NOT NULL`).get(id);
        return row && { artifact: artifact(row), bytes: row.bytes as Uint8Array }; });
    },
    delete(id) {
      validateId(id);
      if (!this.get(id)) return false;
      // Retain an opaque receipt so recovery cannot re-create a removed delivery.
      return use(true, db => Number(db.prepare(`UPDATE bot_artifacts SET bytes=NULL,title='',name='',size=0,
        conversation_id='',run_id='',request_id='',output_id='' WHERE id=? AND bytes IS NOT NULL`).run(id).changes) === 1) ?? false;
    },
  };
}
