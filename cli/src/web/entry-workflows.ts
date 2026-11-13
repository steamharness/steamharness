import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { validateWorkflowCall } from '@steamharness/kanban-project';
import type { Controller } from './workflow-controller';
import type { RunRecord } from './workflow-workspace';
import type { Runtime, Project, ParamValues } from './workflow-types';

/** Reuses the entry's native controller, journal and execution lease. */
export class EntryWorkflows {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly controller: Controller, private readonly project: Project, private readonly runtime: Runtime) {}
  private summary(run: RunRecord) {
    return { id: run.id, title: run.title, entrypointId: run.entrypointId, status: run.status, createdAt: run.createdAt,
      updatedAt: run.updatedAt, total: run.outputSummary?.total ?? run.items.length, revision: run.outputSummary?.revision ?? run.updatedAt, error: run.error };
  }
  async invoke(input: Record<string, unknown>, sourceEntryId: string, readOnly = false): Promise<unknown> {
    validateWorkflowCall(input);
    if (input.entryId !== this.project.entryId) throw new Error('Workflow entry identity changed.');
    if (readOnly && !['list', 'page', 'file'].includes(String(input.action))) throw new Error('Read-only views cannot control a Workflow.');
    if (input.action === 'list') {
      const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 50);
      return { runs: this.controller.runs.slice(offset, offset + limit).map(run => this.summary(run)), total: this.controller.runs.length,
        activeRunId: this.controller.occupied?.id, nextOffset: offset + limit < this.controller.runs.length ? offset + limit : undefined };
    }
    if (input.action === 'start') {
      const requestId = String(input.requestId), entrypointId = String(input.entrypointId), params = input.params as ParamValues;
      if (!this.project.entrypoints.some(entry => entry.id === entrypointId)) throw new Error('Unknown Workflow operation.');
      const signature = createHash('sha256').update(JSON.stringify([entrypointId, Object.entries(params).sort(([a], [b]) => a.localeCompare(b)), input.title ?? null])).digest('hex');
      const key = `${sourceEntryId}:${requestId}`;
      const existing = this.controller.runs.find(run => run.entryRequest?.sourceEntryId === sourceEntryId && run.entryRequest.requestId === requestId);
      if (existing) { if (existing.entryRequest!.signature !== signature) throw new Error('Request id already has different parameters.'); return this.summary(existing); }
      if (this.pending.has(key)) { await this.pending.get(key); return this.invoke(input, sourceEntryId, readOnly); }
      const started = this.controller.start({ entrypointId, params, title: input.title as string | undefined, inputMode: 'form', entryRequest: { sourceEntryId, requestId, signature } }).then(run => this.summary(run));
      this.pending.set(key, started);
      try { return await started; } finally { this.pending.delete(key); }
    }
    const run = this.controller.runs.find(run => run.id === input.runId);
    if (!run) throw new Error('Run no longer exists.');
    if (input.action === 'stop') {
      if (this.controller.occupied?.id === run.id) await this.controller.stop();
      return this.summary(run);
    }
    if (input.action === 'page') {
      const page = await this.controller.outputPage(run.id, input.page as number | undefined);
      return { ...page, run: this.summary(run), files: page.files.map(file => ({ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size })) };
    }
    if (input.action === 'file') {
      const file = await this.runtime.readFile(this.project, String(input.fileId));
      if (file.reference.conversationId !== run.scopeId || !/^image\/(png|jpeg|webp|gif|avif)$/.test(file.reference.mimeType)) throw new Error('Image does not belong to this run.');
      if ((await stat(file.path)).size > 10 * 1024 * 1024) throw new Error('Run image is too large.');
      const bytes = await readFile(file.path);
      return { mimeType: file.reference.mimeType, base64: bytes.toString('base64') };
    }
    throw new Error('Invalid Workflow action.');
  }
}
