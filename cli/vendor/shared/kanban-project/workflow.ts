/** Local Workflow controls. Identity and storage are always supplied by the host. */
export interface KanbanWorkflowRun {
  id: string; title: string; entrypointId?: string; status: string; createdAt: number; updatedAt: number;
  total: number; revision: number; error?: string;
}
export interface KanbanWorkflowPage {
  run: KanbanWorkflowRun; items: Record<string, unknown>[]; total: number; page: number; pageSize: number; revision: number;
  files: { id: string; name: string; mimeType: string; size?: number }[];
}
export interface KanbanWorkflowClient {
  list(options?: {offset?: number; limit?: number}): Promise<{runs: KanbanWorkflowRun[]; total: number; activeRunId?: string; nextOffset?: number}>;
  start(input: {entrypointId: string; params: Record<string,string|string[]>; requestId: string; title?: string}): Promise<KanbanWorkflowRun>;
  page(runId: string, options?: {page?: number}): Promise<KanbanWorkflowPage>;
  stop(runId: string): Promise<KanbanWorkflowRun>;
  readImage(runId: string, fileId: string): Promise<{mimeType: string; buffer: ArrayBuffer}>;
}
export function validateWorkflowCall(input: Record<string, unknown>): void {
  if (typeof input.entryId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.entryId)) throw new Error('Invalid Workflow entry.');
  if (!['list', 'start', 'page', 'stop', 'file'].includes(String(input.action))) throw new Error('Invalid Workflow action.');
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
  if (['page', 'stop', 'file'].includes(String(input.action))) text(input.runId, 'runId');
  if (input.action === 'file') text(input.fileId, 'fileId');
  if (input.page !== undefined) integer(input.page, 'page', 1, Number.MAX_SAFE_INTEGER);
  if (input.offset !== undefined) integer(input.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  if (input.limit !== undefined) integer(input.limit, 'limit', 1, 100);
}
