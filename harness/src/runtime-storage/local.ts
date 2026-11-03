import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage, type SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { StorageWrite, Id } from "@earendil-works/pi-durable";
import { RuntimeStorageError, type AgentSessionSnapshot, type RuntimeHistoryRecord } from "./contract";
import { agentRuntimeSessionKey, type RuntimeHistoryLease, type RuntimePersistence } from "./history";
import { SnapshotMemoryStorage } from "./memory";

export interface LocalRuntimePersistenceOptions {
  /** Host-owned directory, isolated by project/entry and optionally account. */
  directory: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const conflict = () => new RuntimeStorageError("RUNTIME_STORAGE_OWNER_CONFLICT", "This session already has an execution owner.");
const missing = () => new RuntimeStorageError("RUNTIME_STORAGE_NOT_FOUND", "The local agent session does not exist.");
const revisionConflict = () => new RuntimeStorageError("RUNTIME_STORAGE_REVISION_CONFLICT", "History changed in another execution. Reload the committed history.");

/** Local checkpoints are authoritative. Network access is never part of this backend. */
export function createLocalRuntimePersistence(options: LocalRuntimePersistenceOptions): RuntimePersistence {
  const directory = path.toNamespacedPath(path.resolve(options.directory));
  let database: DatabaseSync | undefined;
  let closed = false;
  const leases = new Map<string, RuntimeHistoryLease>();
  const agents = new Set<() => Promise<void>>();
  const assertOpen = () => { if (closed) throw new Error("Local runtime persistence is closed."); };
  const db = () => {
    assertOpen();
    if (!database) {
      mkdirSync(directory, { recursive: true });
      database = new DatabaseSync(path.join(directory, "history.sqlite"), { timeout: 5_000 });
      database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS history(kind TEXT NOT NULL,key TEXT NOT NULL,scope TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,record TEXT NOT NULL,PRIMARY KEY(kind,key));
        CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,conversation_id TEXT,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_sessions(key TEXT PRIMARY KEY,file TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);`);
    }
    return database;
  };
  const transaction = <T>(action: (database: DatabaseSync) => T): T => {
    const database = db();
    database.exec("BEGIN IMMEDIATE");
    try { const value = action(database); database.exec("COMMIT"); return value; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  };
  const own = (key: string) => {
    assertOpen();
    const owners = path.join(directory, "owners"); mkdirSync(owners, { recursive: true });
    const owner = new DatabaseSync(path.join(owners, `${digest(key)}.sqlite`));
    try { owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
    catch (cause) {
      owner.close();
      if ((cause as { errcode?: number }).errcode === 5 || /locked/i.test(String(cause))) throw conflict();
      throw cause;
    }
    return owner;
  };
  const session = (key: string) => db().prepare("SELECT file,deleted FROM agent_sessions WHERE key=?").get(key) as { file: string; deleted: number } | undefined;
  const fileFor = (key: string) => path.join(directory, "agents", `${digest(key)}.sqlite`);

  return {
    async list(kind) {
      return db().prepare("SELECT record FROM history WHERE kind=? AND deleted=0 ORDER BY key").all(kind)
        .map(row => JSON.parse(row.record as string) as RuntimeHistoryRecord);
    },
    async acquire(scope) {
      if (leases.has(scope)) throw conflict();
      const owner = own(`history:${scope}`);
      let released = false;
      const assertOwned = () => { assertOpen(); if (released) throw new RuntimeStorageError("RUNTIME_STORAGE_LEASE_LOST", "The local execution owner was released."); };
      const write = (record: RuntimeHistoryRecord, deleted: boolean): RuntimeHistoryRecord => {
        assertOwned();
        if (record.scope !== scope) throw new RuntimeStorageError("RUNTIME_STORAGE_ACCESS_DENIED", "History writes require the matching execution owner.");
        const previous = db().prepare("SELECT scope,revision FROM history WHERE kind=? AND key=?").get(record.kind, record.key);
        // Transferring a fork requires the source to be idle or held by this host.
        const sourceOwner = previous && previous.scope !== scope && !leases.has(previous.scope as string) ? own(`history:${previous.scope}`) : undefined;
        try {
          return transaction(database => {
            const row = database.prepare("SELECT revision FROM history WHERE kind=? AND key=?").get(record.kind, record.key);
            if (Number(row?.revision ?? 0) !== record.revision) throw revisionConflict();
            const saved = JSON.parse(JSON.stringify({ ...record, revision: record.revision + 1 })) as RuntimeHistoryRecord;
            database.prepare("INSERT INTO history(kind,key,scope,revision,deleted,record) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET scope=excluded.scope,revision=excluded.revision,deleted=excluded.deleted,record=excluded.record")
              .run(record.kind, record.key, scope, saved.revision, Number(deleted), JSON.stringify(saved));
            if (deleted && record.kind === "state") database.prepare("DELETE FROM usage WHERE conversation_id=?").run(record.key);
            return saved;
          });
        } finally { sourceOwner?.close(); }
      };
      const lease: RuntimeHistoryLease = {
        assertOwned,
        async write(record) { return write(record, false); },
        async delete(record) { write({ ...record, state: {}, messages: [], queue: [], events: [], values: [] }, true); },
        async usage(entry) {
          assertOwned();
          if (scope !== `core:${entry.conversationId ?? entry.runId}`) throw new RuntimeStorageError("RUNTIME_STORAGE_ACCESS_DENIED", "Usage requires its run or conversation owner.");
          transaction(database => {
            const previous = database.prepare("SELECT run_id,conversation_id FROM usage WHERE id=?").get(entry.id);
            if (previous && (previous.run_id !== entry.runId || previous.conversation_id !== (entry.conversationId ?? null))) throw new RuntimeStorageError("RUNTIME_STORAGE_IDEMPOTENCY_CONFLICT", "The usage receipt belongs to another run or conversation.");
            database.prepare("INSERT INTO usage(id,run_id,conversation_id,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
              .run(entry.id, entry.runId, entry.conversationId ?? null, JSON.stringify(entry));
          });
        },
        async close() { if (!released) { released = true; owner.close(); leases.delete(scope); } },
      };
      leases.set(scope, lease);
      return lease;
    },
    agentStorage(conversationId, sessionKey) {
      const key = agentRuntimeSessionKey(conversationId, sessionKey);
      return { label: "SteamHarness local SQLite", async open() {
        const owner = own(`agent:${key}`);
        let storage: Awaited<ReturnType<typeof openLoggedAgentStorage>> | undefined;
        try {
          if (session(key)?.deleted) throw missing();
          storage = await openLoggedAgentStorage(fileFor(key));
          db().prepare("INSERT INTO agent_sessions(key,file) VALUES(?,?) ON CONFLICT DO NOTHING").run(key, fileFor(key));
        } catch (error) { await storage?.close(BACKGROUND_CONTEXT).catch(() => undefined); owner.close(); throw error; }
        let closing: Promise<void> | undefined;
        const release = () => closing ??= storage!.close(BACKGROUND_CONTEXT).finally(() => { owner.close(); agents.delete(release); });
        agents.add(release);
        return { storage, release };
      } };
    },
    async agentSessions(conversationId) {
      const prefix = `agent:${encodeURIComponent(conversationId)}:`;
      return db().prepare("SELECT key FROM agent_sessions WHERE deleted=0 ORDER BY key").all().map(row => row.key as string).filter(key => key.startsWith(prefix));
    },
    async exportSession(key) {
      const row = session(key); if (!row || row.deleted) throw missing();
      const database = new DatabaseSync(row.file, { readOnly: true, timeout: 5_000 });
      try {
        database.exec("BEGIN");
        const metadata = database.prepare("SELECT next_id,next_seq FROM durable_metadata WHERE singleton=1").get()!;
        const commits = database.prepare("SELECT seq,writes FROM runtime_commits ORDER BY seq").all();
        if (commits.length !== Number(metadata.next_seq) - 1) throw new Error("Agent snapshot commit history is incomplete.");
        return { format: "steamharness.agent-session", version: 1, nextId: Number(metadata.next_id),
          commits: commits.map(row => ({ seq: Number(row.seq), writes: JSON.parse(row.writes as string) })) };
      } finally { database.close(); }
    },
    async importSession(key, snapshot) {
      // Validate the entire snapshot before creating any destination files.
      new SnapshotMemoryStorage(snapshot);
      const owner = own(`agent:${key}`), file = fileFor(key), temporary = `${file}.${randomUUID()}.tmp`;
      try {
        if (session(key)) throw revisionConflict();
        const storage = await openLoggedAgentStorage(temporary);
        try {
          for (const commit of snapshot.commits) await storage.commit(commit.writes, BACKGROUND_CONTEXT);
          await storage.reserveThrough(snapshot.nextId);
        } finally { await storage.close(BACKGROUND_CONTEXT); }
        await rename(temporary, file);
        db().prepare("INSERT INTO agent_sessions(key,file) VALUES(?,?)").run(key, file);
      } finally { owner.close(); await rm(temporary, { force: true }); }
    },
    async deleteSession(key) {
      const owner = own(`agent:${key}`);
      try {
        const row = session(key); if (!row || row.deleted) return;
        db().prepare("UPDATE agent_sessions SET deleted=1 WHERE key=?").run(key);
        await rm(row.file, { force: true });
      } finally { owner.close(); }
    },
    async close() {
      if (closed) return;
      try { await Promise.all([...agents].map(release => release())); await Promise.all([...leases.values()].map(lease => lease.close())); }
      finally { closed = true; database?.close(); database = undefined; }
    },
  };
}

/** Log exportable commits in the same SQLite transaction as Pi's native tables. */
async function openLoggedAgentStorage(file: string) {
  const database = await openNodeSqliteDatabase(file);
  const committing = new AsyncLocalStorage<readonly StorageWrite[]>();
  try {
    await database.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS runtime_commits(seq INTEGER PRIMARY KEY,writes TEXT NOT NULL)");
    const adapter: SqliteDatabase = {
      exec: sql => database.exec(sql), run: (sql, ...params) => database.run(sql, ...params),
      get: (sql, ...params) => database.get(sql, ...params), all: (sql, ...params) => database.all(sql, ...params), close: () => database.close(),
      transaction(callback) {
        const writes = committing.getStore();
        return database.transaction(async transaction => {
          const result = await callback(transaction);
          if (writes) await transaction.run("INSERT INTO runtime_commits(seq,writes) VALUES(?,?)", result as number, JSON.stringify(writes));
          return result;
        });
      },
    };
    const storage = await SqliteStorage.open(adapter);
    const commit = storage.commit.bind(storage), mintId = storage.mintId.bind(storage);
    storage.commit = (writes, context) => {
      const detached = JSON.parse(JSON.stringify(writes)) as StorageWrite[];
      return committing.run(detached, () => commit(detached, context));
    };
    const reserveThrough = (nextId: number) => database.run("UPDATE durable_metadata SET next_id=CAST(MAX(CAST(next_id AS INTEGER),?) AS TEXT) WHERE singleton=1", nextId);
    storage.mintId = async <I extends Id<string>>() => { const id = await mintId<I>(); await reserveThrough(id + 1); return id; };
    return Object.assign(storage, { reserveThrough });
  } catch (error) { await database.close().catch(() => undefined); throw error; }
}
