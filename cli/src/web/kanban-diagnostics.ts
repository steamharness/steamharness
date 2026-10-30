import { createKanbanBridgeError, type KanbanBridgeCall } from '@steamharness/kanban-project';

export interface KanbanReadAttempt {
  source: 'configuration-cache' | 'configuration-attachment' | 'database' | 'host';
  status?: number;
}

/** Keep routing evidence, never request arguments, file bytes or raw exceptions. */
export class KanbanDiagnostics {
  private requests: ReturnType<KanbanDiagnostics['entry']>[] = [];
  private readonly pending = new Map<symbol, { call: KanbanBridgeCall; configurationId: string; started: number; attempts: KanbanReadAttempt[] }>();
  private entry(call: KanbanBridgeCall, configurationId: string, started: number, attempts: KanbanReadAttempt[], error?: unknown, pending = false) {
    return {
      operation: call.operation, configurationId, startedAt: started, durationMs: Date.now() - started,
      ...(typeof call.input.database === 'string' ? { database: call.input.database } : {}),
      ...(call.operation === 'files.readFile' ? { fileId: String(call.input.fileId) } : {}),
      attempts, ok: pending ? null : error === undefined, status: pending ? 'pending' : error === undefined ? 'success' : 'error',
      ...(error === undefined ? {} : { error: { ...createKanbanBridgeError(error), category: failureCategory(error) } }),
    };
  }
  record(...args: Parameters<KanbanDiagnostics['entry']>): void {
    this.requests.push(this.entry(...args));
    this.requests = this.requests.slice(-50);
  }
  start(call: KanbanBridgeCall, configurationId: string, started: number, attempts: KanbanReadAttempt[]): symbol {
    const id = Symbol();
    this.pending.set(id, { call, configurationId, started, attempts });
    return id;
  }
  finish(id: symbol, error?: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.record(pending.call, pending.configurationId, pending.started, pending.attempts, error);
  }
  snapshot() {
    return structuredClone([...this.requests, ...[...this.pending.values()].map(({ call, configurationId, started, attempts }) =>
      this.entry(call, configurationId, started, attempts, undefined, true))].sort((a, b) => a.startedAt - b.startedAt).slice(-50));
  }
  clear(): void { this.requests = []; this.pending.clear(); }
}

function failureCategory(error: unknown): 'timeout' | 'cancelled' | 'other' {
  const seen = new Set<unknown>(), reasons = [error];
  while (reasons.length && seen.size < 10) {
    const reason = reasons.shift();
    if (typeof reason !== 'object' || reason === null || seen.has(reason)) continue;
    seen.add(reason);
    const value = reason as { name?: unknown; cause?: unknown; safeCause?: unknown; code?: unknown; message?: unknown };
    if (value.name === 'TimeoutError' || value.code === 'ETIMEDOUT' || value.code === 'UND_ERR_HEADERS_TIMEOUT' || value.code === 'KANBAN_BRIDGE_TIMEOUT') return 'timeout';
    // Database consumer errors can serialize the cause into HarnessError and
    // preserve only its message. Extract a category without returning that text.
    if (typeof value.message === 'string' && /\b(?:timed out|aborted due to timeout|headers timeout)\b/i.test(value.message)) return 'timeout';
    if (value.name === 'AbortError') return 'cancelled';
    reasons.push(value.cause, value.safeCause);
  }
  return 'other';
}
