import type { DatabaseSync } from "node:sqlite";

export interface RuntimeOutputSummary { total: number; revision: number }
export interface RuntimeOutputPage extends RuntimeOutputSummary {
  runId: string;
  page: number;
  pageSize: number;
  items: Record<string, unknown>[];
  files: Record<string, unknown>[];
}
export interface RuntimeOutputAppend {
  events?: Record<string, unknown>[];
  items?: Record<string, unknown>[];
  files?: Record<string, unknown>[];
}
export interface RuntimeOutputDetails {
  items: Record<string, unknown>[];
  events: Record<string, unknown>[];
  files: Record<string, unknown>[];
}

/** Ordered output lives separately from run metadata so a stream never rewrites its history. */
export function createLocalOutputJournal(database: () => DatabaseSync) {
  let initialized = false;
  const db = () => {
    const db = database();
    if (!initialized) {
      db.exec(`CREATE TABLE IF NOT EXISTS run_output_meta(run_id TEXT PRIMARY KEY,total INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,event_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS run_output_items(run_id TEXT NOT NULL,item_id TEXT NOT NULL,position INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(run_id,item_id),UNIQUE(run_id,position));
        CREATE TABLE IF NOT EXISTS run_output_events(run_id TEXT NOT NULL,position INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(run_id,position));
        CREATE TABLE IF NOT EXISTS run_output_files(run_id TEXT NOT NULL,file_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(run_id,file_id));
        CREATE TABLE IF NOT EXISTS run_output_refs(run_id TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(run_id,file_id));
        CREATE TABLE IF NOT EXISTS run_output_item_refs(run_id TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(run_id,file_id));`);
      initialized = true;
    }
    return db;
  };
  const references = (runId: string, value: unknown, item = false) => {
    const insert = db().prepare("INSERT OR IGNORE INTO run_output_refs(run_id,file_id) VALUES(?,?)");
    for (const id of new Set(JSON.stringify(value).match(/wf_[a-f0-9]{32}/g) ?? [])) {
      insert.run(runId, id);
      if (item) db().prepare("INSERT OR IGNORE INTO run_output_item_refs(run_id,file_id) VALUES(?,?)").run(runId, id);
    }
  };
  const summary = (runId: string) => db().prepare("SELECT total,revision,event_count FROM run_output_meta WHERE run_id=?").get(runId) as { total: number; revision: number; event_count: number } | undefined;
  const upsert = (runId: string, item: Record<string, unknown>, state: { total: number }, fallback: string) => {
    const id = typeof item.id === "string" && item.id ? item.id : fallback;
    const existing = db().prepare("SELECT position FROM run_output_items WHERE run_id=? AND item_id=?").get(runId, id);
    const position = existing ? Number(existing.position) : state.total++;
    const record = { ...item, id };
    db().prepare("INSERT INTO run_output_items(run_id,item_id,position,record) VALUES(?,?,?,?) ON CONFLICT(run_id,item_id) DO UPDATE SET record=excluded.record")
      .run(runId, id, position, JSON.stringify(record));
    references(runId, record, true);
  };
  const putFile = (runId: string, file: Record<string, unknown>) => {
    if (typeof file.id !== "string") return;
    db().prepare("INSERT INTO run_output_files(run_id,file_id,record) VALUES(?,?,?) ON CONFLICT(run_id,file_id) DO UPDATE SET record=excluded.record")
      .run(runId, file.id, JSON.stringify(file));
    references(runId, file);
  };
  const chunk = (runId: string, event: Record<string, unknown>, state: { total: number }) => {
    const value = event.chunk;
    if (!value || typeof value !== "object") return;
    const chunk = value as { type?: string; item?: Record<string, unknown>; itemId?: string; delta?: unknown };
    if (chunk.type === "output_item_start" && chunk.item) {
      upsert(runId, chunk.item, state, `stream:${event.executionId ?? "output"}:${event.chunkOrder ?? state.total}`);
    } else if (chunk.type === "output_item_delta" && chunk.itemId) {
      const row = db().prepare("SELECT record FROM run_output_items WHERE run_id=? AND item_id=?").get(runId, chunk.itemId);
      if (!row) return;
      const item = JSON.parse(row.record as string) as Record<string, unknown>;
      if (chunk.item) {
        const { metadata, ...patch } = chunk.item;
        Object.assign(item, patch);
        if (metadata !== undefined) item.metadata = { ...(item.metadata as object), ...(metadata as object) };
      }
      if (typeof chunk.delta === "string") item.content = `${typeof item.content === "string" ? item.content : ""}${chunk.delta}`;
      else if (Array.isArray(item.content) && Array.isArray(chunk.delta)) item.content = [...item.content, ...chunk.delta];
      else if (item.content && typeof item.content === "object" && chunk.delta && typeof chunk.delta === "object") item.content = { ...item.content, ...chunk.delta };
      else if (chunk.delta !== undefined) item.content = chunk.delta;
      upsert(runId, item, state, chunk.itemId);
    }
  };
  return {
    append(runId: string, input: RuntimeOutputAppend): RuntimeOutputSummary {
      const database = db();
      database.exec("BEGIN IMMEDIATE");
      try {
        const previous = summary(runId) ?? { total: 0, revision: 0, event_count: 0 };
        const state = { ...previous };
        for (const event of input.events ?? []) {
          database.prepare("INSERT INTO run_output_events(run_id,position,record) VALUES(?,?,?)").run(runId, state.event_count++, JSON.stringify(event));
          if (event.type === "node_chunk") chunk(runId, event, state);
          if (event.type === "file_created" && event.file && typeof event.file === "object") putFile(runId, event.file as Record<string, unknown>);
        }
        for (const [index, item] of (input.items ?? []).entries()) upsert(runId, item, state, `final:${index}`);
        for (const file of input.files ?? []) putFile(runId, file);
        state.revision++;
        database.prepare("INSERT INTO run_output_meta(run_id,total,revision,event_count) VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET total=excluded.total,revision=excluded.revision,event_count=excluded.event_count")
          .run(runId, state.total, state.revision, state.event_count);
        database.exec("COMMIT");
        return { total: state.total, revision: state.revision };
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    page(runId: string, requestedPage?: number, pageSize = 100): RuntimeOutputPage {
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Output page size must be between 1 and 100.");
      if (requestedPage !== undefined && (!Number.isSafeInteger(requestedPage) || requestedPage < 1)) throw new Error("Invalid output page.");
      const state = summary(runId) ?? { total: 0, revision: 0 };
      const page = Math.min(requestedPage ?? Infinity, Math.max(1, Math.ceil(state.total / pageSize)));
      const items = db().prepare("SELECT record FROM run_output_items WHERE run_id=? AND position>=? AND position<? ORDER BY position")
        .all(runId, (page - 1) * pageSize, page * pageSize).map(row => JSON.parse(row.record as string) as Record<string, unknown>);
      const ids = new Set(JSON.stringify(items).match(/wf_[a-f0-9]{32}/g) ?? []);
      const lookup = db().prepare("SELECT record FROM run_output_files WHERE run_id=? AND file_id=?");
      const files = [...ids].flatMap(id => { const file = lookup.get(runId, id); return file ? [JSON.parse(file.record as string) as Record<string, unknown>] : []; });
      const standalone = db().prepare("SELECT record FROM run_output_files f WHERE run_id=? AND NOT EXISTS (SELECT 1 FROM run_output_item_refs r WHERE r.run_id=f.run_id AND r.file_id=f.file_id) ORDER BY file_id LIMIT 100")
        .all(runId).map(row => JSON.parse(row.record as string) as Record<string, unknown>);
      return { runId, total: state.total, revision: state.revision, page, pageSize, items, files: [...new Map([...files, ...standalone].map(file => [file.id, file])).values()] };
    },
    details(runId: string): RuntimeOutputDetails {
      const read = (table: string, order: string) => db().prepare(`SELECT record FROM ${table} WHERE run_id=? ORDER BY ${order}`).all(runId)
        .map(row => JSON.parse(row.record as string) as Record<string, unknown>);
      return { items: read("run_output_items", "position"), events: read("run_output_events", "position"), files: read("run_output_files", "file_id") };
    },
    references(runId: string): string[] { return db().prepare("SELECT file_id FROM run_output_refs WHERE run_id=?").all(runId).map(row => row.file_id as string); },
    delete(runId: string) {
      for (const table of ["run_output_items", "run_output_events", "run_output_files", "run_output_refs", "run_output_item_refs", "run_output_meta"]) db().prepare(`DELETE FROM ${table} WHERE run_id=?`).run(runId);
    },
  };
}
