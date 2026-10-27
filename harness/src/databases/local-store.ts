import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DATABASE_UUID_PATTERN } from "@steamharness/database-spaces";
import type { KVNamespaceLockInput, KVStore, KVStoreGetInput } from "../kv/index";

const transactions = new AsyncLocalStorage<Map<string, DatabaseSync>>();
const queues = new Map<string, Promise<unknown>>();

/** All KV and knowledge changes in one space use the same SQLite transaction. */
export function createLocalDatabaseSpaceStore(directory: string, spaceId: string): KVStore {
  if (!DATABASE_UUID_PATTERN.test(spaceId)) throw new Error("Invalid database space ID.");
  const spaceDir = path.join(directory, "spaces", spaceId);
  const file = path.join(spaceDir, "data.sqlite");
  const transaction = async <T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T> => {
    const current = transactions.getStore()?.get(file);
    if (current) return operation(current);
    const previous = queues.get(file) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      mkdirSync(spaceDir, { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(file);
      try {
        db.exec("PRAGMA busy_timeout = 0;");
        // Avoid blocking the event loop while another process holds the lock.
        for (let attempt = 0; ; attempt++) {
          try { db.exec("BEGIN IMMEDIATE"); break; }
          catch (error) { if (attempt >= 200 || !/locked|busy/i.test(String(error))) throw error; await delay(25); }
        }
        try {
          db.exec("CREATE TABLE IF NOT EXISTS entries (kind TEXT NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL, source TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(kind, namespace, key))");
          db.exec("CREATE TABLE IF NOT EXISTS space_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO space_revision VALUES(1,0)");
          const stores = new Map(transactions.getStore()); stores.set(file, db);
          const result = await transactions.run(stores, () => operation(db));
          db.exec("COMMIT");
          return result;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      } finally { db.close(); }
    });
    queues.set(file, pending);
    try { return await pending; } finally { if (queues.get(file) === pending) queues.delete(file); }
  };
  const address = (input: KVStoreGetInput | KVNamespaceLockInput) => {
    if (input.projectId !== spaceId) throw new Error("Database space address mismatch.");
    if (input.scope === "conversation" && !input.conversationId) throw new Error("A conversation namespace is required.");
    return [input.storageKind, input.scope === "conversation" ? `conversation:${input.conversationId}` : "space"] as const;
  };
  const read = (db: DatabaseSync, input: KVStoreGetInput): unknown => {
    const row = db.prepare("SELECT value FROM entries WHERE kind = ? AND namespace = ? AND key = ?").get(...address(input), input.key);
    return row ? JSON.parse(String(row.value)) : undefined;
  };
  const set = (db: DatabaseSync, input: KVStoreGetInput, value: unknown, source?: unknown): void => {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("A database value must be JSON serializable.");
    db.prepare("INSERT INTO entries(kind, namespace, key, value, revision, source, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(kind, namespace, key) DO UPDATE SET value = excluded.value, revision = entries.revision + 1, source = excluded.source, updated_at = excluded.updated_at").run(...address(input), input.key, json, source ? JSON.stringify(source) : null, new Date().toISOString());
    db.exec("UPDATE space_revision SET revision=revision+1 WHERE id=1");
  };
  return {
    listValues: input => transaction(db => {
      const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 30)));
      const offset = Number(input.cursor ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid database cursor.');
      const prefixes = input.keyPrefixes;
      const clauses = ['kind=?', 'namespace=?'];
      const parameters: Array<string | number> = [...address(input)];
      if (prefixes) {
        clauses.push(prefixes.length ? `(${prefixes.map(() => 'substr(key,1,length(?))=?').join(' OR ')})` : '0');
        for (const prefix of prefixes) parameters.push(prefix, prefix);
      }
      if (input.query) { clauses.push('instr(lower(key),lower(?))>0'); parameters.push(input.query); }
      const where = clauses.join(' AND ');
      const total = Number(db.prepare(`SELECT count(*) AS total FROM entries WHERE ${where}`).get(...parameters)!.total);
      const items = db.prepare(`SELECT key,value,updated_at FROM entries WHERE ${where} ORDER BY key LIMIT ? OFFSET ?`).all(...parameters,pageSize,offset)
        .map(row => ({ key: String(row.key), value: JSON.parse(String(row.value)), updatedAt: String(row.updated_at), scope: input.scope, conversationId: input.conversationId }));
      return { items, total, hasMore: offset + pageSize < total, ...(offset + pageSize < total ? { nextCursor: String(offset + pageSize) } : {}) };
    }),
    readRevision: () => transaction(db => String(db.prepare("SELECT revision FROM space_revision WHERE id=1").get()!.revision)),
    getValue: (input) => transaction((db) => read(db, input)),
    setValue: (input) => transaction((db) => set(db, input, input.value, input.source)),
    deleteValue: (input) => transaction((db) => { const removed = Number(db.prepare("DELETE FROM entries WHERE kind = ? AND namespace = ? AND key = ?").run(...address(input), input.key).changes) > 0; if (removed) db.exec("UPDATE space_revision SET revision=revision+1 WHERE id=1"); return removed; }),
    updateValue: (input, update) => transaction((db) => { const value = update(read(db, input)); set(db, input, value, input.source); return value; }),
    withNamespaceLock: (input, operation) => { address(input); return transaction(() => operation()); },
    withNamespaceReadLock: (input, operation) => { address(input); return transaction(() => operation()); },
  };
}
