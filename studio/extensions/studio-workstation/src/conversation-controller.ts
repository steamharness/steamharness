import { t } from './localization';
import {
  applyOutputChunk, outputText, validateWorkflowValues, workflowParameters, workflowParamArgs, resolvedWorkflowValues, workflowFormValue,
  type ConversationSession, type ConversationMessage, type ConversationQueuedInput, type WorkflowAttachment,
  type WorkflowProject, type WorkflowRuntime, type WorkflowRun, type WorkflowParamValues,
  type WorkflowResolvedInput,
  type WorkflowTimerRecord,
} from './workflow-types';

interface ControllerOptions {
  save(sessions: ConversationSession[], activeId: string): Promise<void>;
  changed(): void;
  log(message: string): void;
}
interface RunTask { cancelled: boolean; finished: Promise<void>; promote?: boolean }

export class ConversationController {
  readonly sessions: ConversationSession[];
  activeId: string;
  private readonly tasks = new Map<string, RunTask>();
  private disposed = false;
  private readonly removing = new Set<string>();

  constructor(readonly project: WorkflowProject, private readonly runtime: WorkflowRuntime, saved: { sessions?: ConversationSession[]; activeId?: string }, private readonly options: ControllerOptions) {
    this.sessions = (saved.sessions ?? []).filter((entry) => typeof entry.id === 'string' && typeof entry.title === 'string' && Array.isArray(entry.messages));
    if (!this.sessions.length) { this.sessions.push(this.blank()); }
    this.activeId = this.sessions.some((entry) => entry.id === saved.activeId) ? saved.activeId! : this.sessions.at(-1)!.id;
    for (const entry of this.sessions) {
      entry.createdAt ??= entry.messages[0]?.createdAt ?? 0;
      entry.updatedAt ??= entry.messages.at(-1)?.createdAt ?? entry.createdAt;
      delete entry.activeRunId;
      entry.queuedInputs ??= [];
      for (const message of entry.messages) {
        delete message.submittingInput;
        if (message.status === 'running') { message.status = message.pendingInput ? 'waiting_for_input' : 'aborted'; message.error = t("Run interrupted"); }
      }
    }
  }
  get current(): ConversationSession { return this.sessions.find((entry) => entry.id === this.activeId)!; }
  get running(): boolean { return !!this.current.activeRunId; }
  get hasRuns(): boolean { return this.tasks.size > 0; }
  private blank(): ConversationSession {
    const now = Date.now();
    return { id: globalThis.crypto.randomUUID(), title: t("New conversation"), createdAt: now, updatedAt: now, messages: [], parameterValues: {}, toolPermissionPolicies: {}, queuedInputs: [], draft: { text: '', attachments: [] } };
  }
  async persist(): Promise<void> {
    const sessions = this.sessions.map((entry) => ({ ...entry, messages: entry.messages.map(({ submittingInput: _, ...message }) => message) }));
    await this.options.save(JSON.parse(JSON.stringify(sessions)), this.activeId);
  }
  private changed(): void { if (!this.disposed) { this.options.changed(); } }
  async create(): Promise<void> {
    const blank = this.sessions.find((entry) => !entry.messages.length && !entry.activeRunId && !entry.queuedInputs?.length && !entry.draft?.text && !entry.draft?.attachments.length);
    const next = blank ?? this.blank();
    next.updatedAt = Date.now();
    if (blank) { this.sessions.splice(this.sessions.indexOf(blank), 1); }
    this.sessions.push(next);
    this.activeId = next.id; this.changed(); await this.persist();
  }
  async select(id: string): Promise<void> {
    if (!this.sessions.some((entry) => entry.id === id)) { return; }
    this.activeId = id; this.changed(); await this.persist();
  }
  async rename(id: string, title: string): Promise<void> {
    const entry = this.sessions.find((entry) => entry.id === id);
    if (!entry || !title.trim()) { return; }
    entry.title = title.trim().slice(0, 160); entry.titleLocked = true; this.changed(); await this.persist();
  }
  async lockTitle(id: string, locked: boolean): Promise<void> {
    const entry = this.sessions.find((entry) => entry.id === id);
    if (entry) { entry.titleLocked = locked; this.changed(); await this.persist(); }
  }
  async remove(id: string): Promise<void> {
    if (this.removing.has(id)) { return; }
    const index = this.sessions.findIndex((entry) => entry.id === id);
    if (index < 0) { return; }
    const entry = this.sessions[index];
    this.removing.add(id);
    try {
      const task = entry.activeRunId && this.tasks.get(entry.activeRunId);
      if (task) { task.cancelled = true; this.runtime.cancel(entry.activeRunId); await task.finished; }
      await this.runtime.deleteConversation(this.project, id);
      this.sessions.splice(this.sessions.indexOf(entry), 1);
      if (!this.sessions.length) { this.sessions.push(this.blank()); }
      if (this.activeId === id) { this.activeId = this.sessions.at(-1)!.id; }
      this.changed(); await this.persist();
    } finally { this.removing.delete(id); }
  }
  async updateDraft(id: string, text: string, attachments: WorkflowAttachment[], editingQueueId?: string): Promise<void> {
    const entry = this.sessions.find((entry) => entry.id === id);
    if (!entry) { return; }
    entry.draft = { text: text.slice(0, 100_000), attachments, editingQueueId: editingQueueId ?? entry.draft?.editingQueueId };
    await this.persist();
  }
  async send(input: Omit<ConversationQueuedInput, 'id' | 'createdAt'>): Promise<void> {
    const entry = this.current;
    const parameters = workflowParameters(this.project, input.entrypointId);
    validateWorkflowValues(parameters.fields, input.params, input.states);
    if (this.removing.has(entry.id)) { return; }
    if (this.project.projectType !== 'conversation' && input.text) { this.rawArgs(input.text); }
    if (this.project.projectType === 'conversation' && !input.text.trim() && !input.attachments.length) { return; }
    const queued: ConversationQueuedInput = { ...input, id: globalThis.crypto.randomUUID(), createdAt: Date.now(), params: { ...input.params }, attachments: [...input.attachments] };
    const waiting = entry.messages.some((message) => message.pendingInput);
    if (entry.activeRunId || waiting || entry.queuedInputs?.length) {
      if (!this.project.conversation?.inputQueue?.enabled) { throw new Error(t("The current session is running.")); }
      if (entry.draft?.editingQueueId) {
        const index = entry.queuedInputs!.findIndex((item) => item.id === entry.draft?.editingQueueId);
        if (index >= 0) { queued.id = entry.queuedInputs![index].id; entry.queuedInputs![index] = queued; }
        else { entry.queuedInputs!.push(queued); }
      } else { (entry.queuedInputs ??= []).push(queued); }
      entry.draft = { text: '', attachments: [] }; this.changed(); await this.persist();
      if (!entry.activeRunId && !waiting) { this.drain(entry); }
      return;
    }
    entry.draft = { text: '', attachments: [] };
    this.start(entry, queued); await this.persist();
  }
  private start(entry: ConversationSession, input: ConversationQueuedInput, answer?: ConversationMessage): void {
    const parameters = workflowParameters(this.project, input.entrypointId);
    const args = workflowParamArgs(parameters.fields, input.params, input.states);
    if (this.project.projectType === 'conversation') {
      args.push('--message', input.text);
      for (const [flag, files] of [
        ['--images', input.attachments.filter((file) => file.kind === 'image')],
        ['--videos', input.attachments.filter((file) => file.mimeType.startsWith('video/'))],
        ['--files', input.attachments.filter((file) => file.kind !== 'image' && !file.mimeType.startsWith('video/'))],
      ] as const) { if (files.length) { args.push(flag, JSON.stringify(files.map(({ previewUrl: _, ...reference }) => reference))); } }
    } else if (input.text) { args.push(...this.rawArgs(input.text)); }
    if (!answer) {
      if (!entry.messages.length && !entry.titleLocked) { entry.title = (input.text || input.attachments[0]?.name || t("Workflow run")).slice(0, 80); }
      entry.messages.push({ id: globalThis.crypto.randomUUID(), role: 'user', content: input.text || '', attachments: input.attachments, args, input, entrypointId: input.entrypointId, createdAt: Date.now() });
      answer = { id: globalThis.crypto.randomUUID(), role: 'assistant', content: '', items: [], status: 'running', createdAt: Date.now(), model: typeof input.params.model === 'string' ? input.params.model : undefined, args, entrypointId: input.entrypointId, events: [] };
      answer.runId = answer.id;
      entry.messages.push(answer);
    }
    const request: WorkflowRun = {
      project: this.project, conversationId: entry.id, args: answer.args ?? args, runId: answer.runId,
      entrypointId: answer.entrypointId, toolPermissionPolicies: entry.toolPermissionPolicies,
      resolvedInputs: [...(answer.resolvedInputs ?? []), ...(answer.submittingInput ? [answer.submittingInput] : [])],
      resumeAfterRequestId: answer.submittingInput?.requestId,
    };
    answer.status = 'running'; answer.error = undefined;
    if (!answer.submittingInput) { answer.pendingInput = undefined; }
    entry.updatedAt = Date.now();
    entry.activeRunId = answer.runId;
    const task: RunTask = { cancelled: false, finished: Promise.resolve() };
    this.tasks.set(answer.runId!, task);
    this.changed();
    task.finished = this.execute(entry, answer, request, task).catch((error) => this.options.log(`Workflow persistence: ${String(error)}`));
  }
  private rawArgs(text: string): string[] {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw) || !raw.every((arg) => typeof arg === 'string')) { throw new Error(t("Run arguments must be an array of strings.")); }
    return raw;
  }
  private async execute(entry: ConversationSession, answer: ConversationMessage, request: WorkflowRun, task: RunTask): Promise<void> {
    const pending = answer.pendingInput;
    try {
      await this.persist();
      if (task.cancelled || this.disposed) { throw new Error(t("Stopped")); }
      const report = await this.runtime.run(request, (event) => {
        if (this.disposed) { return; }
        (answer.events ??= []).push(event);
        if (event.type === 'node_chunk') { applyOutputChunk(answer.items ??= [], event.chunk); answer.content = outputText(answer.items); }
        if (event.type === 'conversation_title_updated' && !entry.titleLocked && typeof event.title === 'string') { entry.title = event.title.slice(0, 160); }
        if (event.type === 'token_usage_updated') { answer.tokenUsage = { enabled: true, display: true, run: event.usage as Record<string, unknown> }; }
        if (event.type === 'user_input_requested') { answer.pendingInput = event as unknown as ConversationMessage['pendingInput']; }
        if (event.type === 'user_input_resolved') {
          this.confirmInput(answer, event as unknown as WorkflowResolvedInput);
          if (answer.pendingInput?.requestId === event.requestId) { answer.pendingInput = undefined; }
        }
        if (event.type === 'file_created') { (answer.files ??= []).push(event.file as unknown as WorkflowAttachment); }
        if (event.type === 'timer_started' || event.type === 'timer_finished') {
          const timer = event.timer as WorkflowTimerRecord;
          answer.timers = [...(answer.timers ?? []).filter((entry) => entry.timerId !== timer.timerId), timer];
        }
        this.changed();
      });
      answer.report = report; answer.status = report.status; answer.durationMs = report.durationMs;
      if (report.output?.items?.length) { answer.items = report.output.items; answer.content = outputText(answer.items); }
      answer.pendingInput = report.status === 'waiting_for_input' ? report.pendingUserInput : undefined;
      for (const resolved of report.resolvedUserInputs ?? []) { this.confirmInput(answer, resolved); }
      if (answer.submittingInput && report.status === 'success') { this.confirmInput(answer, answer.submittingInput); }
      answer.files = [...new Map([...(answer.files ?? []), ...(report.files ?? [])].map((file) => [file.id, file])).values()];
      answer.tokenUsage = report.tokenUsage ?? answer.tokenUsage;
      answer.timers = report.timers ?? answer.timers;
      if (report.status === 'failed') {
        const data = report.result?.data;
        answer.error = report.result?.error?.message || (data && typeof data === 'object' && 'errMessage' in data && typeof data.errMessage === 'string' ? data.errMessage : t("Run failed"));
      }
      if (report.status === 'aborted' || report.status === 'timed_out') { answer.error = report.status === 'aborted' ? t("Stopped") : t("Run timed out"); }
      if (answer.submittingInput && pending && report.status === 'failed') { answer.status = 'waiting_for_input'; answer.pendingInput = pending; }
      if (!answer.content && !answer.items?.length && report.status === 'success') { answer.content = report.result?.data === undefined ? t("Completed") : JSON.stringify(report.result.data, null, 2); }
    } catch (error) {
      answer.error = error instanceof Error ? error.message : String(error);
      answer.status = task.cancelled ? 'aborted' : answer.submittingInput && pending ? 'waiting_for_input' : 'failed';
      if (answer.status === 'waiting_for_input') { answer.pendingInput = pending; }
      else if (task.cancelled) { answer.pendingInput = undefined; }
      this.options.log(`Workflow run: ${answer.error}`);
    } finally {
      if (answer.status !== 'waiting_for_input') {
        answer.timers = answer.timers?.map((timer) => timer.status === 'running'
          ? { ...timer, status: 'cleared', endedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - new Date(timer.startedAt).getTime()) }
          : timer);
      }
      delete answer.submittingInput;
      if (entry.activeRunId === answer.runId) { delete entry.activeRunId; }
      this.tasks.delete(answer.runId!); this.changed(); await this.persist();
      if (!this.disposed && !this.removing.has(entry.id) && !answer.pendingInput && (!task.cancelled || task.promote)) { this.drain(entry); }
    }
  }
  private confirmInput(answer: ConversationMessage, resolved: WorkflowResolvedInput): void {
    const previous = answer.resolvedInputs?.find((input) => input.requestId === resolved.requestId)
      ?? (answer.submittingInput?.requestId === resolved.requestId ? answer.submittingInput : undefined);
    const confirmed = { ...previous, ...resolved, precedingOutputItemIds: previous?.precedingOutputItemIds ?? resolved.precedingOutputItemIds };
    answer.resolvedInputs = [...(answer.resolvedInputs ?? []).filter((input) => input.requestId !== resolved.requestId), confirmed];
    if (answer.submittingInput?.requestId === resolved.requestId) { delete answer.submittingInput; }
  }
  private drain(entry: ConversationSession): void {
    if (entry.activeRunId || entry.messages.some((message) => message.pendingInput) || entry.draft?.editingQueueId || this.disposed || this.removing.has(entry.id)) { return; }
    const input = entry.queuedInputs?.shift();
    if (input) {
      try { this.start(entry, input); }
      catch (error) { entry.queuedInputs!.unshift(input); this.options.log(String(error)); this.changed(); }
    }
  }
  stop(entry = this.current): void {
    const task = entry.activeRunId && this.tasks.get(entry.activeRunId);
    if (task) { task.cancelled = true; this.runtime.cancel(entry.activeRunId); }
    else { const pending = entry.messages.find((message) => message.pendingInput); if (pending) { pending.pendingInput = undefined; pending.status = 'aborted'; pending.error = t("Stopped"); this.changed(); void this.persist().catch((error) => this.options.log(String(error))); } }
  }
  async resume(messageId: string, requestId: string, values: Record<string, unknown>): Promise<void> {
    const entry = this.current;
    const answer = entry.messages.find((message) => message.id === messageId && message.pendingInput?.requestId === requestId);
    if (!answer?.pendingInput || entry.activeRunId) { return; }
    const request = answer.pendingInput;
    const allowed = Object.fromEntries(request.params.map((field) => [field.name, values[field.name] ?? request.defaultValues?.[field.name] ?? field.defaultValue ?? '']));
    const form: WorkflowParamValues = Object.fromEntries(request.params.map((field) => [field.name, workflowFormValue(field, allowed[field.name])]));
    const typedValues = resolvedWorkflowValues(request.params, form);
    const resolved = { requestId, nodeName: request.nodeName, values: typedValues, submittedAt: new Date().toISOString(), request,
      precedingOutputItemIds: (answer.items ?? []).map((item, index) => item.id ?? String(index)) };
    answer.submittingInput = resolved;
    if (request.metadata?.type === 'agent-plan-approval' && allowed.decision === 'approve') {
      const mode = workflowParameters(this.project, answer.entrypointId).fields.find((field) => field.panel === 'mode');
      if (mode) { (entry.parameterValues ??= {})[answer.entrypointId ?? ''] ??= {}; entry.parameterValues[answer.entrypointId ?? ''][mode.name] = 'build'; }
    }
    this.start(entry, { id: messageId, text: '', params: {}, entrypointId: answer.entrypointId, attachments: [], createdAt: Date.now() }, answer);
    await this.persist();
  }
  async editQueued(id: string): Promise<void> {
    const input = this.current.queuedInputs?.find((input) => input.id === id);
    if (!input) { return; }
    this.current.draft = { text: input.text, attachments: input.attachments, editingQueueId: id };
    (this.current.parameterValues ??= {})[input.entrypointId ?? ''] = input.params;
    this.changed(); await this.persist();
  }
  async removeQueued(id: string): Promise<void> {
    this.current.queuedInputs = (this.current.queuedInputs ?? []).filter((input) => input.id !== id);
    if (this.current.draft?.editingQueueId === id) { this.current.draft = { text: '', attachments: [] }; }
    this.changed(); await this.persist();
    this.drain(this.current);
  }
  async cancelQueueEdit(): Promise<void> {
    this.current.draft = { text: '', attachments: [] }; this.changed(); await this.persist(); this.drain(this.current);
  }
  async runQueued(): Promise<void> { this.drain(this.current); await this.persist(); }
  async reorderQueued(ids: string[]): Promise<void> {
    const queue = this.current.queuedInputs ?? [];
    if (ids.length !== queue.length || new Set(ids).size !== queue.length || ids.some((id) => !queue.some((input) => input.id === id))) { return; }
    this.current.queuedInputs = ids.map((id) => queue.find((input) => input.id === id)!); this.changed(); await this.persist();
  }
  async promoteQueued(id: string): Promise<void> {
    const entry = this.current;
    const queue = entry.queuedInputs ?? [];
    if (!queue.some((input) => input.id === id)) { return; }
    await this.reorderQueued([id, ...queue.filter((input) => input.id !== id).map((input) => input.id)]);
    if (entry.draft?.editingQueueId) { entry.draft = { text: '', attachments: [] }; }
    const task = entry.activeRunId && this.tasks.get(entry.activeRunId);
    if (task) { task.promote = true; task.cancelled = true; this.runtime.cancel(entry.activeRunId); }
    else { this.stop(entry); this.drain(entry); }
  }
  async retry(id: string): Promise<void> {
    const index = this.current.messages.findIndex((message) => message.id === id && message.role === 'assistant');
    const user = [...this.current.messages.slice(0, index)].reverse().find((message) => message.role === 'user');
    if (!user || this.current.activeRunId) { return; }
    if (user.input) { await this.send(user.input); return; }
    const parameters = workflowParameters(this.project, user.entrypointId);
    const params: WorkflowParamValues = {};
    for (const field of parameters.fields) { const index = user.args?.indexOf(field.flag ?? '') ?? -1; if (index >= 0) { params[field.name] = user.args![index + 1]; } }
    await this.send({ text: user.content, params, entrypointId: user.entrypointId, attachments: user.attachments ?? [] });
  }
  async idle(): Promise<void> { while (this.tasks.size) { await Promise.all([...this.tasks.values()].map((task) => task.finished)); } }
  dispose(): void { this.disposed = true; for (const entry of this.sessions) { this.stop(entry); } }
}
