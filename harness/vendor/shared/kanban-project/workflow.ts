/** Local Workflow controls. Identity and storage are always supplied by the host. */
export interface KanbanWorkflowRun {
  id: string; title: string; entrypointId?: string; status: string; createdAt: number; updatedAt: number;
  total: number; revision: number; error?: string;
}
export interface KanbanWorkflowPage {
  run: KanbanWorkflowRun; items: Record<string, unknown>[]; total: number; page: number; pageSize: number; revision: number;
  files: { id: string; name: string; mimeType: string; size?: number }[];
}
export interface KanbanTimelineQuery {
  from?: number; to?: number; at?: number; limit?: number;
  position?: number; direction?: 'previous' | 'next';
}
export interface KanbanTimelinePoint {
  id: string; position: number; timestamp: number; kind: string; title: string;
  imageFileId?: string; fields: {label: string; value: string}[];
}
export interface KanbanWorkflowTimeline {
  run: KanbanWorkflowRun; runId: string; total: number; revision: number;
  bounds: {from: number; to: number} | null; from: number; to: number;
  frames: KanbanTimelinePoint[];
  buckets: {from: number; to: number; snapshot: number; click: number; input: number}[];
  selection: {point: KanbanTimelinePoint; item: Record<string, unknown>; frame: KanbanTimelinePoint | null; nearby: KanbanTimelinePoint[]} | null;
}
export interface KanbanWorkflowClient {
  list(options?: {offset?: number; limit?: number}): Promise<{runs: KanbanWorkflowRun[]; total: number; activeRunId?: string; nextOffset?: number}>;
  start(input: {entrypointId: string; params: Record<string,string|string[]>; requestId: string; title?: string}): Promise<KanbanWorkflowRun>;
  page(runId: string, options?: {page?: number}): Promise<KanbanWorkflowPage>;
  timeline(runId: string, query?: KanbanTimelineQuery): Promise<KanbanWorkflowTimeline>;
  stop(runId: string): Promise<KanbanWorkflowRun>;
  readImage(runId: string, fileId: string): Promise<{mimeType: string; buffer: ArrayBuffer}>;
}
export function validateWorkflowCall(input: Record<string, unknown>): void {
  if (typeof input.entryId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.entryId)) throw new Error('Invalid Workflow entry.');
  if (!['list', 'start', 'page', 'timeline', 'stop', 'file'].includes(String(input.action))) throw new Error('Invalid Workflow action.');
  if (JSON.stringify(input).length > 262144) throw new Error('Workflow request is too large.');
  const text = (value: unknown, name: string) => { if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`Invalid ${name}.`); };
  const integer = (value: unknown, name: string, min: number, max: number) => { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}.`); };
  if (input.action === 'start') {
    text(input.requestId, 'requestId');
    if (input.title !== undefined) text(input.title, 'title');
    if (typeof input.entrypointId !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(input.entrypointId)) throw new Error('Invalid Workflow operation.');
    if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)
      || !Object.values(input.params).every(value => typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string'))) throw new Error('Invalid Workflow parameters.');
  }
  if (['page', 'timeline', 'stop', 'file'].includes(String(input.action))) text(input.runId, 'runId');
  if (input.action === 'timeline') {
    for (const key of ['from', 'to', 'at', 'position']) if (input[key] !== undefined) integer(input[key], key, 0, 8_640_000_000_000_000);
    if (input.from !== undefined && input.to !== undefined && Number(input.from) > Number(input.to)) throw new Error('Invalid timeline range.');
    if (input.direction !== undefined && (!['previous', 'next'].includes(String(input.direction)) || input.position === undefined)) throw new Error('Invalid timeline direction.');
    if (input.limit !== undefined) integer(input.limit, 'limit', 1, 48);
  }
  if (input.action === 'file') text(input.fileId, 'fileId');
  if (input.page !== undefined) integer(input.page, 'page', 1, Number.MAX_SAFE_INTEGER);
  if (input.offset !== undefined) integer(input.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  if (input.limit !== undefined && input.action !== 'timeline') integer(input.limit, 'limit', 1, 100);
}
