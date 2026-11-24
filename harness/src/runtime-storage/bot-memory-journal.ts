import type { DatabaseSync } from "node:sqlite";
import { fail, type BotMemoryProperties } from "./bot-memory-request";

export const BOT_MEMORY_MANAGEMENT_VERSION = 1;
const retentionMs = 30 * 86400_000;
const filter = "project_id=? AND entry_id=?";
export interface BotMemoryChangeSource {
  actor: "bot" | "user" | "runtime";
  conversationId?: string;
  runId?: string;
  requestId?: string;
}
export interface BotMemoryFields { title: string | null; summary: string | null; content: string; properties: BotMemoryProperties }
type FieldValue = BotMemoryFields[keyof BotMemoryFields];
export type BotMemoryDelta = { fields: { field: keyof BotMemoryFields; before: FieldValue | null; after: FieldValue | null }[] }
  | { link: { targetId: string; relation: string; before: boolean; after: boolean } };
export interface BotMemoryChange {
  revision: number;
  previousRevision: number | null;
  action: "save" | "update" | "link" | "unlink" | "undo" | "forget";
  changedAt: string;
  source: BotMemoryChangeSource;
  delta?: BotMemoryDelta;
  expiresAt?: string;
  undoOf?: number;
  canUndo: boolean;
}

export function initializeBotMemoryJournal(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS bot_memory_changes (
    project_id TEXT NOT NULL, entry_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
    previous_revision INTEGER, action TEXT NOT NULL, changed_at INTEGER NOT NULL, source TEXT NOT NULL,
    related_id TEXT, delta TEXT, undo_of INTEGER,
    PRIMARY KEY(project_id,entry_id,memory_id,revision));
    CREATE INDEX IF NOT EXISTS bot_memory_changes_related ON bot_memory_changes(project_id,entry_id,related_id);
    CREATE INDEX IF NOT EXISTS bot_memory_changes_expiry ON bot_memory_changes(project_id,entry_id,changed_at) WHERE delta IS NOT NULL;`);
}

export function memoryFieldDelta(before: BotMemoryFields | undefined, after: BotMemoryFields): BotMemoryDelta {
  const fields = (Object.keys(after) as (keyof BotMemoryFields)[]).flatMap(field => {
    const old = before?.[field] ?? null, value = after[field];
    return JSON.stringify(old) === JSON.stringify(value) ? [] : [{ field, before: old, after: value }];
  });
  return { fields };
}

export function createBotMemoryJournal(scope: string[]) {
  const where = `${filter} AND memory_id=?`;
  const decode = (row: Record<string, unknown>, now: number, revision?: number): BotMemoryChange => {
    const action = row.action as BotMemoryChange["action"];
    const expiry = Number(row.changed_at) + retentionMs;
    const delta = typeof row.delta === "string" && expiry > now ? JSON.parse(row.delta) as BotMemoryDelta : undefined;
    return { revision: Number(row.revision), previousRevision: row.previous_revision as number | null, action,
      changedAt: new Date(Number(row.changed_at)).toISOString(), source: JSON.parse(row.source as string) as BotMemoryChangeSource,
      ...(delta ? { delta, expiresAt: new Date(expiry).toISOString() } : {}),
      ...(typeof row.undo_of === "number" ? { undoOf: row.undo_of } : {}),
      canUndo: !!delta && action !== "save" && revision === row.revision && ("link" in delta || delta.fields.length > 0) };
  };
  return {
    append(database: DatabaseSync, input: { id: string; revision: number; previousRevision?: number; action: BotMemoryChange["action"];
      now: number; source?: BotMemoryChangeSource; delta?: BotMemoryDelta; undoOf?: number }) {
      const source = input.source;
      const actor = source?.actor === "user" || source?.actor === "bot" ? source.actor : "runtime";
      const context = Object.fromEntries(["conversationId", "runId", "requestId"].flatMap(key => {
        const value = source?.[key as "conversationId" | "runId" | "requestId"];
        return typeof value === "string" && value.length > 0 && value.length <= 1024 ? [[key, value]] : [];
      }));
      const delta = input.delta;
      database.prepare(`INSERT INTO bot_memory_changes(project_id,entry_id,memory_id,revision,previous_revision,action,changed_at,source,related_id,delta,undo_of)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(...scope, input.id, input.revision, input.previousRevision ?? null, input.action, input.now,
        JSON.stringify({ actor, ...context }), delta && "link" in delta ? delta.link.targetId : null, delta ? JSON.stringify(delta) : null, input.undoOf ?? null);
    },
    prune(database: DatabaseSync, now: number) {
      database.prepare(`UPDATE bot_memory_changes SET delta=NULL WHERE ${filter} AND changed_at<=? AND delta IS NOT NULL`).run(...scope, now - retentionMs);
    },
    list(database: DatabaseSync, id: string, revision: number | undefined, now: number, before?: number) {
      const rows = database.prepare(`SELECT * FROM bot_memory_changes WHERE ${where}${before === undefined ? "" : " AND revision<?"}
        ORDER BY revision DESC LIMIT 16`).all(...scope, id, ...(before === undefined ? [] : [before]));
      const changes: BotMemoryChange[] = [];
      let size = 0;
      for (const row of rows.slice(0, 15)) {
        const change = decode(row, now, revision);
        size += JSON.stringify(change).length;
        if (size > 96_000 && changes.length) break;
        changes.push(change);
      }
      return { changes, ...(rows.length > changes.length ? { nextBefore: changes.at(-1)!.revision } : {}) };
    },
    undoable(database: DatabaseSync, id: string, revision: number, now: number): BotMemoryDelta {
      const row = database.prepare(`SELECT * FROM bot_memory_changes WHERE ${where} AND revision=?`).get(...scope, id, revision);
      if (!row || Number(row.changed_at) + retentionMs <= now) return fail("BOT_MEMORY_UNDO_UNAVAILABLE", "This memory change can no longer be undone.");
      const change = decode(row, now, revision);
      return change.canUndo ? change.delta! : fail("BOT_MEMORY_UNDO_UNAVAILABLE", "This memory change can no longer be undone.");
    },
    forget(database: DatabaseSync, id: string) {
      database.prepare(`DELETE FROM bot_memory_changes WHERE ${where}`).run(...scope, id);
      // Keep other memories' revision and actor trail, but don't retain a restorable link to the forgotten entry.
      database.prepare(`UPDATE bot_memory_changes SET related_id=NULL,delta=NULL WHERE ${filter} AND related_id=?`).run(...scope, id);
      // Keep opaque replay receipts so a retry cannot re-create a forgotten memory.
      database.prepare(`UPDATE bot_memory_receipts SET result='{"forgotten":true}' WHERE ${filter}
        AND (json_extract(result,'$.memory.id')=? OR json_extract(result,'$.id')=?)`).run(...scope, id, id);
    },
  };
}
