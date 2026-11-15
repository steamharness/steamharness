import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export interface RuntimeTimelineQuery {
  from?: number; to?: number; at?: number; limit?: number;
  position?: number; direction?: "previous" | "next";
}
export interface RuntimeTimelinePoint {
  id: string; position: number; timestamp: number; kind: string; title: string;
  imageFileId?: string; fields: { label: string; value: string }[];
}
export interface RuntimeOutputTimeline {
  runId: string; total: number; revision: number;
  bounds: { from: number; to: number } | null;
  from: number; to: number;
  frames: RuntimeTimelinePoint[];
  buckets: { from: number; to: number; snapshot: number; click: number; input: number }[];
  selection: { point: RuntimeTimelinePoint; item: Record<string, unknown>; frame: RuntimeTimelinePoint | null; nearby: RuntimeTimelinePoint[] } | null;
}

// An expression index projects timestamps from the existing output, without a second history store.
const milliseconds = "CAST(ROUND((julianday(json_extract(record,'$.content.timestamp'))-2440587.5)*86400000) AS INTEGER)";
const activity = "json_extract(record,'$.metadata.kind')='activity-record' AND json_extract(record,'$.content.version')=1 AND json_type(record,'$.content.timestamp')='text' AND json_extract(record,'$.content.kind') IN ('snapshot','click','input')";
const image = "json_type(record,'$.content.imageFileId')='text' AND length(json_extract(record,'$.content.imageFileId'))>0";
type Row = Record<string, SQLOutputValue>;

export function createOutputTimeline(database: () => DatabaseSync) {
  let initialized = false;
  return (runId: string, query: RuntimeTimelineQuery = {}): RuntimeOutputTimeline => {
    for (const key of ["from", "to", "at", "position"] as const) {
      if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || query[key]! < 0 || query[key]! > 8_640_000_000_000_000)) throw new Error("Invalid timeline coordinate.");
    }
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) throw new Error("Invalid timeline range.");
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 48)) throw new Error("Invalid timeline limit.");
    if (query.direction !== undefined && (!["previous", "next"].includes(query.direction) || query.position === undefined)) throw new Error("Invalid timeline direction.");
    const db = database();
    if (!initialized) {
      db.exec(`CREATE INDEX IF NOT EXISTS run_output_time ON run_output_items(run_id,${milliseconds},position) WHERE ${activity};
        CREATE INDEX IF NOT EXISTS run_output_frame_time ON run_output_items(run_id,${milliseconds},position) WHERE ${activity} AND ${image};`);
      initialized = true;
    }
    let meta = db.prepare("SELECT total,revision FROM run_output_meta WHERE run_id=?").get(runId);
    let table = "run_output_items";
    // Older runs keep OutputItems in their history record. Query them in place, without migration.
    if (!meta && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history'").get()) {
      meta = db.prepare("SELECT json_array_length(record,'$.messages') AS total,revision FROM history WHERE kind='run' AND key=? AND deleted=0").get(runId);
      table = "(SELECT h.key AS run_id,CAST(j.key AS INTEGER) AS position,json_extract(j.value,'$.value') AS record FROM history h,json_each(h.record,'$.messages') j WHERE h.kind='run' AND h.deleted=0)";
    }
    const order = (reverse: boolean) => `${milliseconds} ${reverse ? "DESC" : "ASC"},position ${reverse ? "DESC" : "ASC"}`;
    const select = (where: string, reverse: boolean, params: (string | number)[], frames = false, limit = 1) => db.prepare(
      `SELECT position,record,${milliseconds} AS ms FROM ${table} WHERE run_id=? AND ${activity} AND ${milliseconds}>=0 ${frames ? `AND ${image}` : ""} ${where} ORDER BY ${order(reverse)} LIMIT ?`,
    ).all(runId, ...params, limit);
    const point = (row: Row): RuntimeTimelinePoint => {
      const item = JSON.parse(String(row.record)), content = item.content;
      return { id: item.id, position: Number(row.position), timestamp: Number(row.ms), kind: content.kind,
        title: typeof content.title === "string" ? content.title.slice(0, 200) : "",
        imageFileId: typeof content.imageFileId === "string" ? content.imageFileId : undefined,
        fields: Array.isArray(content.fields) ? content.fields.filter((field: { label?: unknown; value?: unknown }) => typeof field?.label === "string" && typeof field.value === "string").slice(0, 16).map((field: { label: string; value: string }) => ({ label: field.label.slice(0, 100), value: field.value.slice(0, 500) })) : [] };
    };
    const first = select("", false, [])[0], last = select("", true, [])[0];
    const bounds = first && last ? { from: Number(first.ms), to: Number(last.ms) } : null;
    const from = query.from ?? Math.min(query.to ?? Infinity, bounds?.from ?? 0), to = query.to ?? Math.max(from, bounds?.to ?? from);
    const result: RuntimeOutputTimeline = { runId, total: Number(meta?.total ?? 0), revision: Number(meta?.revision ?? 0), bounds, from, to, frames: [], buckets: [], selection: null };
    if (!bounds) return result;
    const nearest = (at: number, frames = false) => {
      const before = select(`AND ${milliseconds}<=?`, true, [at], frames)[0];
      const after = select(`AND ${milliseconds}>=?`, false, [at], frames)[0];
      return !before ? after : !after ? before : at - Number(before.ms) <= Number(after.ms) - at ? before : after;
    };
    const limit = query.limit ?? 16, span = Math.max(1, to - from);
    // At most one thumbnail per real time interval. Empty intervals stay empty.
    for (let index = 0; index < limit; index++) {
      const left = from + Math.floor(span * index / limit), right = from + Math.floor(span * (index + 1) / limit);
      const row = select(`AND ${milliseconds}>=? AND ${milliseconds}${index === limit - 1 ? "<=" : "<"}?`, false, [left, right], true)[0];
      if (row) result.frames.push(point(row));
    }
    const bucketSize = Math.max(1, Math.ceil((span + 1) / 80));
    result.buckets = db.prepare(`SELECT CAST((${milliseconds}-?)/? AS INTEGER) AS bucket,
      SUM(json_extract(record,'$.content.kind')='snapshot') AS snapshot,SUM(json_extract(record,'$.content.kind')='click') AS click,SUM(json_extract(record,'$.content.kind')='input') AS input
      FROM ${table} WHERE run_id=? AND ${activity} AND ${milliseconds}>=? AND ${milliseconds}<=? GROUP BY bucket ORDER BY bucket`)
      .all(from, bucketSize, runId, from, to).map(row => ({ from: from + Number(row.bucket) * bucketSize, to: Math.min(to, from + (Number(row.bucket) + 1) * bucketSize), snapshot: Number(row.snapshot), click: Number(row.click), input: Number(row.input) }));
    let selected = query.position === undefined ? nearest(query.at ?? bounds.to) : db.prepare(
      `SELECT position,record,${milliseconds} AS ms FROM ${table} WHERE run_id=? AND position=? AND ${activity} AND ${milliseconds}>=0`,
    ).get(runId, query.position);
    if (selected && query.direction) {
      const previous = query.direction === "previous", comparator = previous ? "<" : ">";
      selected = select(`AND (${milliseconds}${comparator}? OR (${milliseconds}=? AND position${comparator}?))`, previous, [Number(selected.ms), Number(selected.ms), Number(selected.position)], true)[0] ?? selected;
    }
    if (selected) {
      const selectedPoint = point(selected), at = selectedPoint.timestamp, position = selectedPoint.position;
      const before = select(`AND (${milliseconds}<? OR (${milliseconds}=? AND position<?))`, true, [at, at, position], false, 4).reverse();
      const after = select(`AND (${milliseconds}>? OR (${milliseconds}=? AND position>?))`, false, [at, at, position], false, 4);
      const frame = selectedPoint.imageFileId ? selected : nearest(at, true);
      result.selection = { point: selectedPoint, item: JSON.parse(String(selected.record)), frame: frame ? point(frame) : null, nearby: [...before, selected, ...after].map(point) };
    }
    return result;
  };
}
