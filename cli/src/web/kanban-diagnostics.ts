import { createKanbanBridgeError, type KanbanBridgeCall } from '@steamharness/kanban-project';

export interface KanbanReadAttempt {
  source: 'configuration-cache' | 'configuration-attachment' | 'database' | 'host';
  status?: number;
}

/** Keep routing evidence, never request arguments, file bytes or raw exceptions. */
export class KanbanDiagnostics {
  private requests: ReturnType<KanbanDiagnostics['entry']>[] = [];
  private readonly pending = new Map<symbol, { call: KanbanBridgeCall; configurationId: string; started: number; attempts: KanbanReadAttempt[]; diagnosticId?: string }>();
  private entry(call: KanbanBridgeCall, configurationId: string, started: number, attempts: KanbanReadAttempt[], error?: unknown, pending = false, diagnosticId?: string) {
    return {
      operation: call.operation, configurationId, startedAt: started, durationMs: Date.now() - started,
      ...(diagnosticId ? { diagnosticId } : {}),
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
  has(diagnosticId: string): boolean { return this.requests.some(request => request.diagnosticId === diagnosticId); }
  start(call: KanbanBridgeCall, configurationId: string, started: number, attempts: KanbanReadAttempt[], diagnosticId?: string): symbol {
    const id = Symbol();
    this.pending.set(id, { call, configurationId, started, attempts, diagnosticId });
    return id;
  }
  finish(id: symbol, error?: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.record(pending.call, pending.configurationId, pending.started, pending.attempts, error, false, pending.diagnosticId);
  }
  snapshot() {
    return structuredClone([...this.requests, ...[...this.pending.values()].map(({ call, configurationId, started, attempts, diagnosticId }) =>
      this.entry(call, configurationId, started, attempts, undefined, true, diagnosticId))].sort((a, b) => a.startedAt - b.startedAt).slice(-50));
  }
  clear(): void { this.requests = []; this.pending.clear(); }
}

export function failureCategory(error: unknown): 'timeout' | 'cancelled' | 'connection' | 'permission' | 'missing' | 'other' {
  const seen = new Set<unknown>(), reasons = [error];
  while (reasons.length && seen.size < 10) {
    const reason = reasons.shift();
    if (typeof reason !== 'object' || reason === null || seen.has(reason)) continue;
    seen.add(reason);
    const value = reason as { name?: unknown; cause?: unknown; safeCause?: unknown; code?: unknown; message?: unknown };
    if (value.name === 'TimeoutError' || value.code === 'ETIMEDOUT' || value.code === 'UND_ERR_HEADERS_TIMEOUT' || value.code === 'UND_ERR_CONNECT_TIMEOUT' || value.code === 'KANBAN_BRIDGE_TIMEOUT') return 'timeout';
    // Database consumer errors can serialize the cause into HarnessError and
    // preserve only its message. Extract a category without returning that text.
    if (typeof value.message === 'string' && /\b(?:timed out|aborted due to timeout|headers timeout)\b/i.test(value.message)) return 'timeout';
    if (value.name === 'AbortError') return 'cancelled';
    if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(value.code))) return 'connection';
    if (value.code === 'EACCES' || value.code === 'EPERM') return 'permission';
    if (value.code === 'ENOENT' || value.code === 'ERR_MODULE_NOT_FOUND') return 'missing';
    reasons.push(value.cause, value.safeCause);
  }
  return 'other';
}

export function failureLogReason(error: unknown): string {
  const seen = new Set<unknown>(), reasons = [error], parts: string[] = [];
  while (reasons.length && seen.size < 6) {
    const reason = reasons.shift();
    if (typeof reason !== 'object' || reason === null || seen.has(reason)) continue;
    seen.add(reason);
    const value = reason as { name?: unknown; type?: unknown; code?: unknown; message?: unknown; cause?: unknown; safeCause?: unknown };
    const label = typeof value.name === 'string' ? value.name : typeof value.type === 'string' ? value.type : 'Error';
    const name = /^[a-z][a-z0-9_.-]{0,63}$/i.test(label) ? label : 'Error';
    const code = typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? ` (${value.code})` : '';
    const message = parts.length === 0 && typeof value.message === 'string' ? value.message.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const safeMessage = /\b(?:bearer|authorization|password|secret|token|api[-_]?key)\b|:\/\//i.test(message) ? '[redacted]' : message;
    parts.push(`${name}${code}${safeMessage ? `: ${safeMessage}` : ''}`);
    reasons.push(value.cause, value.safeCause);
  }
  return parts.join(' <- ') || 'Unknown error';
}
