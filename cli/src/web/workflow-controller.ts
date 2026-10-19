import { t } from './localization';
import {
  applyOutputChunk, resolvedProjectValues, validateProjectValues, projectFormValue, projectParameters, projectParamArgs,
  type ConversationSession, type Project, type Runtime, type ResolvedInput, type TimerRecord,
} from './workflow-types';
import {
  parseProjectArgs, projectStorageReferences, type Draft, type RunRecord, type StartInput, type WorkspaceContract,
} from './workflow-workspace';

interface Options {
  save(workspace: WorkspaceContract): Promise<void>;
  changed(): void;
  log(message: string): void;
  legacy?: ConversationSession[];
}
interface Task { record: RunRecord; cancelled: boolean; finished: Promise<void> }

export class Controller {
  readonly workspace: WorkspaceContract;
  private task?: Task;
  private disposed = false;
  private eventSave?: ReturnType<typeof setTimeout>;

  constructor(readonly project: Project, private readonly runtime: Runtime, saved: Partial<WorkspaceContract>, private readonly options: Options) {
    this.workspace = { version: 1, runs: [], drafts: {}, ...saved };
    for (const record of this.workspace.runs) {
      delete record.submittingInput;
      if (record.status === 'running' || record.status === 'waiting_for_input') {
        record.status = 'interrupted'; record.error = t("Run interrupted");
        this.clearTimers(record);
      }
    }
    this.workspace.occupiedId = this.workspace.runs.find(record => record.id === saved.occupiedId && record.pendingInput)?.id
      ?? this.workspace.runs.find(record => !!record.pendingInput)?.id;
    if (!this.workspace.runs.some(record => record.id === this.workspace.selectedId)) { delete this.workspace.selectedId; }
  }

  get runs(): RunRecord[] { return this.workspace.runs; }
  get current(): RunRecord | undefined { return this.runs.find(record => record.id === this.workspace.selectedId); }
  get running(): boolean { return !!this.workspace.occupiedId; }
  get occupied(): RunRecord | undefined { return this.runs.find(record => record.id === this.workspace.occupiedId); }
  draft(entrypointId?: string): Draft {
    return this.workspace.drafts[entrypointId ?? ''] ??= { scopeId: globalThis.crypto.randomUUID(), values: {}, rawArgs: '[]', inputMode: 'form', policies: {} };
  }
  async persist(): Promise<void> {
    await this.options.save(JSON.parse(JSON.stringify({ ...this.workspace, runs: this.runs.map(({ submittingInput: _, ...record }) => record) })));
  }
  private changed(): void { if (!this.disposed) { this.options.changed(); } }
  private scheduleSave(): void {
    if (this.eventSave) { return; }
    this.eventSave = setTimeout(() => {
      this.eventSave = undefined;
      void this.persist().catch(error => this.options.log(String(error)));
    }, 100);
  }
  async select(id?: string): Promise<void> {
    if (id && !this.runs.some(record => record.id === id)) { throw new Error('Run no longer exists.'); }
    this.workspace.selectedId = id; this.changed(); await this.persist();
  }
  async updateDraft(entrypointId: string | undefined, draft: Partial<Omit<Draft, 'scopeId'>>): Promise<void> {
    Object.assign(this.draft(entrypointId), draft); this.changed(); await this.persist();
  }
  private assertAvailable(): void {
    if (this.disposed) { throw new Error('Workflow workspace has closed.'); }
    if (this.running || this.task) { throw new Error('A workflow is already running or waiting for input.'); }
  }
  async start(input: StartInput): Promise<RunRecord> {
    this.assertAvailable();
    const parameters = projectParameters(this.project, input.entrypointId);
    const args = input.inputMode === 'raw' ? parseProjectArgs(input.rawArgs ?? '[]')
      : (validateProjectValues(parameters.fields, input.params, input.states), projectParamArgs(parameters.fields, input.params, input.states));
    const files = await this.inputFiles([input.params, args]);
    this.assertAvailable();
    const draft = this.draft(input.entrypointId);
    const id = globalThis.crypto.randomUUID(), now = Date.now();
    const record: RunRecord = {
      id, scopeId: id, entrypointId: input.entrypointId,
      title: this.project.entrypoints.find(entry => entry.id === input.entrypointId)?.title ?? this.project.name,
      createdAt: now, updatedAt: now, status: 'running', args: [...args], params: { ...input.params }, policies: structuredClone(draft.policies),
      items: [], events: [], files, nodes: [], logs: '', resolvedInputs: [],
    };
    this.runs.unshift(record); this.workspace.selectedId = id;
    draft.values = { ...input.params }; draft.rawArgs = input.rawArgs ?? draft.rawArgs; draft.inputMode = input.inputMode ?? 'form';
    this.launch(record); await this.persist(); return record;
  }
  async rerun(previousId: string): Promise<RunRecord> {
    this.assertAvailable();
    const previous = this.runs.find(record => record.id === previousId);
    if (!previous) { throw new Error('Run no longer exists.'); }
    const files = await this.inputFiles([previous.params, previous.args]);
    this.assertAvailable();
    const id = globalThis.crypto.randomUUID(), now = Date.now();
    const record: RunRecord = { id, scopeId: id, title: previous.title, entrypointId: previous.entrypointId, createdAt: now, updatedAt: now,
      status: 'running', args: [...previous.args], params: structuredClone(previous.params), policies: structuredClone(previous.policies),
      items: [], events: [], files, nodes: [], logs: '', resolvedInputs: [] };
    this.runs.unshift(record); this.workspace.selectedId = id; this.launch(record); await this.persist(); return record;
  }
  private async inputFiles(value: unknown) {
    return Promise.all([...projectStorageReferences(value).files].map(async id => (await this.runtime.readFile(this.project, id)).reference));
  }
  private launch(record: RunRecord): void {
    record.status = 'running'; record.error = undefined; record.updatedAt = Date.now();
    this.workspace.occupiedId = record.id;
    const task: Task = { record, cancelled: false, finished: Promise.resolve() };
    this.task = task; this.changed();
    task.finished = this.execute(task).catch(error => this.options.log(`Workflow persistence: ${String(error)}`));
  }
  private async execute(task: Task): Promise<void> {
    const record = task.record, pending = record.pendingInput;
    try {
      await this.persist();
      if (task.cancelled || this.disposed) { throw new Error('Stopped.'); }
      const report = await this.runtime.run({
        project: this.project, conversationId: record.scopeId, args: record.args, entrypointId: record.entrypointId,
        runId: record.id, toolPermissionPolicies: record.policies,
        resolvedInputs: [...record.resolvedInputs, ...(record.submittingInput ? [record.submittingInput] : [])],
        resumeAfterRequestId: record.submittingInput?.requestId,
      }, event => {
        if (task.cancelled || this.disposed || this.task !== task) { return; }
        record.events.push(event);
        if (event.type === 'node_chunk') { applyOutputChunk(record.items, event.chunk); }
        if (event.type === 'node_started' || event.type === 'node_finished') {
          const index = record.nodes.findIndex(node => node.executionId === event.executionId);
          const node = { ...(index >= 0 ? record.nodes[index] : {}), ...event, name: event.nodeName, status: event.status ?? 'running' };
          if (index >= 0) { record.nodes[index] = node; } else { record.nodes.push(node); }
        }
        if (event.type === 'runtime_log' && typeof event.text === 'string') { record.logs = (record.logs + event.text).slice(-100_000); }
        if (event.type === 'user_input_requested') { record.pendingInput = event as unknown as RunRecord['pendingInput']; }
        if (event.type === 'user_input_resolved') {
          this.confirmInput(record, event as unknown as ResolvedInput);
          if (record.pendingInput?.requestId === event.requestId) { delete record.pendingInput; }
        }
        if (event.type === 'token_usage_updated') {
          record.tokenUsage = { enabled: true, display: projectParameters(this.project, record.entrypointId).tokenUsage?.display !== false, run: event.usage as Record<string, unknown> };
        }
        if (event.type === 'file_created') { record.files.push(event.file as unknown as RunRecord['files'][number]); }
        if (event.type === 'timer_started' || event.type === 'timer_finished') {
          const timer = event.timer as TimerRecord;
          record.timers = [...(record.timers ?? []).filter(entry => entry.timerId !== timer.timerId), timer];
        }
        record.updatedAt = Date.now(); this.changed(); this.scheduleSave();
      });
      if (task.cancelled || this.disposed) { throw new Error('Stopped.'); }
      record.report = report; record.durationMs = report.durationMs;
      record.status = report.status as RunRecord['status'];
      // Paused reports omit unfinished streams; successful reports replace the replayed snapshot.
      const items = report.output?.items ?? [];
      if (report.output && (report.status === 'success' || !record.items.length || (report.status !== 'waiting_for_input' && items.length))) { record.items = items; }
      record.nodes = report.nodes ?? record.nodes;
      record.logs = report.logs ?? record.logs;
      record.tokenUsage = report.tokenUsage ?? record.tokenUsage;
      record.timers = report.timers ?? record.timers;
      record.files = [...new Map([...record.files, ...(report.files ?? [])].map(file => [file.id, file])).values()];
      record.pendingInput = report.status === 'waiting_for_input' ? report.pendingUserInput : undefined;
      for (const resolved of report.resolvedUserInputs ?? []) { this.confirmInput(record, resolved); }
      if (record.submittingInput && report.status === 'success') { this.confirmInput(record, record.submittingInput); }
      if (report.status === 'failed') {
        const data = report.result?.data;
        record.error = report.result?.error?.message
          || (data && typeof data === 'object' && 'errMessage' in data && typeof data.errMessage === 'string' ? data.errMessage : '')
          || 'Workflow failed.';
      }
      if (record.submittingInput && pending && report.status === 'failed') { record.status = 'waiting_for_input'; record.pendingInput = pending; }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      record.status = task.cancelled ? this.disposed ? 'interrupted' : 'aborted' : record.submittingInput && pending ? 'waiting_for_input' : 'failed';
      if (record.status === 'waiting_for_input') { record.pendingInput = pending; }
      else if (this.disposed) { record.pendingInput ??= pending; }
      else { delete record.pendingInput; }
    } finally {
      if (task.cancelled) { record.status = this.disposed ? 'interrupted' : 'aborted'; if (!this.disposed) { delete record.pendingInput; } }
      delete record.submittingInput;
      if (!record.pendingInput || this.disposed) { delete this.workspace.occupiedId; }
      if (record.status !== 'running') { this.clearTimers(record); }
      record.updatedAt = Date.now(); this.task = undefined; this.changed(); await this.persist();
    }
  }
  private clearTimers(record: RunRecord): void {
    record.timers = record.timers?.map(timer => timer.status === 'running'
      ? { ...timer, status: 'cleared', endedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - Date.parse(timer.startedAt)) } : timer);
  }
  private confirmInput(record: RunRecord, resolved: ResolvedInput): void {
    const previous = record.resolvedInputs.find(input => input.requestId === resolved.requestId)
      ?? (record.submittingInput?.requestId === resolved.requestId ? record.submittingInput : undefined);
    record.resolvedInputs = [...record.resolvedInputs.filter(input => input.requestId !== resolved.requestId),
      { ...previous, ...resolved, precedingOutputItemIds: previous?.precedingOutputItemIds ?? resolved.precedingOutputItemIds }];
    if (record.submittingInput?.requestId === resolved.requestId) { delete record.submittingInput; }
  }
  async resume(id: string, requestId: string, values: Record<string, unknown>): Promise<void> {
    if (this.task || this.disposed) { throw new Error('Workflow is already running.'); }
    const record = this.runs.find(record => record.id === id && record.pendingInput?.requestId === requestId);
    if (!record?.pendingInput) { throw new Error('Input request is no longer available.'); }
    if (this.workspace.occupiedId && this.workspace.occupiedId !== id) { throw new Error('Another workflow is waiting for input.'); }
    const request = record.pendingInput;
    const form = Object.fromEntries(request.params.map(field => [field.name, projectFormValue(field, values[field.name] ?? request.defaultValues?.[field.name])]));
    record.submittingInput = { requestId, nodeName: request.nodeName, values: resolvedProjectValues(request.params, form),
      submittedAt: new Date().toISOString(), request, precedingOutputItemIds: record.items.map((item, index) => item.id ?? String(index)) };
    this.launch(record); await this.persist();
  }
  async stop(reason = 'Stopped.'): Promise<void> {
    const record = this.occupied;
    if (!record) { return; }
    if (this.task) { this.task.cancelled = true; this.runtime.cancel(record.id); await this.task.finished; }
    record.status = 'aborted'; record.error = reason; delete record.pendingInput; delete this.workspace.occupiedId;
    this.clearTimers(record); this.changed(); await this.persist();
  }
  async remove(id: string): Promise<void> {
    if (this.workspace.occupiedId === id || this.task?.record.id === id) { throw new Error('Stop the workflow before deleting its record.'); }
    const record = this.runs.find(record => record.id === id);
    if (!record) { throw new Error('Run no longer exists.'); }
    const other = projectStorageReferences([this.runs.filter(item => item !== record), this.workspace.drafts, this.options.legacy ?? []]);
    const own = projectStorageReferences(record);
    for (const session of this.options.legacy ?? []) { other.scopes.add(session.id); }
    let unresolvedOwner = false;
    for (const id of other.files) {
      const file = await this.runtime.readFile(this.project, id).catch(() => undefined);
      if (file?.reference.conversationId) { other.scopes.add(file.reference.conversationId); }
      else { unresolvedOwner = true; }
    }
    const owners = new Map<string, string[]>();
    for (const fileId of own.files) {
      if (other.files.has(fileId)) { continue; }
      const file = await this.runtime.readFile(this.project, fileId).catch(() => undefined);
      if (file?.reference.conversationId) { const ids = owners.get(file.reference.conversationId) ?? []; ids.push(fileId); owners.set(file.reference.conversationId, ids); }
    }
    for (const [scope, ids] of owners) { await this.runtime.deleteFiles(this.project, scope, ids); }
    if (!unresolvedOwner && !other.scopes.has(record.scopeId)) { await this.runtime.deleteConversation(this.project, record.scopeId); }
    this.runs.splice(this.runs.indexOf(record), 1);
    if (this.workspace.selectedId === id) { delete this.workspace.selectedId; }
    this.changed(); await this.persist();
  }
  async idle(): Promise<void> { if (this.task) { await this.task.finished; } }
  dispose(): void {
    this.disposed = true; clearTimeout(this.eventSave);
    if (this.task) { this.task.cancelled = true; this.runtime.cancel(this.task.record.id); }
    else if (this.occupied) { this.occupied.status = 'interrupted'; this.occupied.error = 'Host closed.'; this.clearTimers(this.occupied); delete this.workspace.occupiedId; }
  }
}
