import { t } from './localization';
import { isDeepStrictEqual } from 'node:util';
import type { AgentSessionCommand, AgentSessionReceipt, AgentSessionSnapshot } from 'steamharness/agent';
import {
  applyOutputChunk, outputText, validateProjectValues, projectParameters, projectParamArgs, resolvedProjectValues, projectFormValue, sessionRunning,
  type ConversationSession, type ConversationMessage, type ConversationQueuedInput, type ConversationDraftUpdate, type Attachment,
  type Project, type Runtime, type Run, type ParamValues,
  type ResolvedInput,
  type TimerRecord,
} from './workflow-types';

interface ControllerOptions {
  canRun?(session: ConversationSession): boolean;
  configurationRevision?(): number;
  save(sessions: ConversationSession[], activeId: string): Promise<void>;
  changed(): void;
  log(message: string): void;
}
interface RunTask { sessionId: string; cancelled: boolean; finished: Promise<void>; promote?: boolean }

export class ConversationController {
  readonly sessions: ConversationSession[];
  activeId: string;
  private readonly tasks = new Map<string, RunTask>();
  private disposed = false;
  private readonly reloading = new Map<string, Promise<void>>();
  private readonly removing = new Set<string>();
  private readonly agentWaiters = new Map<string, { ownerId: string; targetId?: number; requestId: string; promise: Promise<AgentSessionReceipt>; resolve(receipt: AgentSessionReceipt): void; reject(error: Error): void }>();
  private readonly agentSaves = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly project: Project, private readonly runtime: Runtime, saved: { sessions?: ConversationSession[]; activeId?: string; selectionVersion?: number }, private readonly options: ControllerOptions) {
    this.sessions = (saved.sessions ?? []).filter((entry) => typeof entry.id === 'string' && typeof entry.title === 'string' && Array.isArray(entry.messages));
    if (!this.sessions.length) { this.sessions.push(this.blank()); }
    for (const entry of this.sessions) {
      entry.createdAt ??= entry.messages[0]?.createdAt ?? 0;
      entry.updatedAt ??= entry.messages.at(-1)?.createdAt ?? entry.createdAt;
      delete entry.activeRunId;
      entry.queuedInputs ??= [];
      for (const message of entry.messages) {
        if (message.status === 'running') {
          if (message.cancelRequested) { message.status = 'aborted'; message.pendingInput = undefined; }
          else if (project.conversation?.recovery?.enabled && message.runId && message.args) { message.recovering = true; }
          else { message.status = message.pendingInput ? 'waiting_for_input' : 'aborted'; message.error = t("Run interrupted"); }
        }
      }
    }
    // Legacy histories could retain the first ID even after navigating elsewhere.
    const latest = this.sessions.reduce((latest, entry) => entry.updatedAt! >= latest.updatedAt! ? entry : latest);
    this.activeId = saved.selectionVersion === 1 && this.sessions.some(entry => entry.id === saved.activeId) ? saved.activeId! : latest.id;
    for (const entry of this.sessions) if (!entry.agentOwnerId && entry.agent) this.projectAgent(entry, entry.agent, true);
  }
  get current(): ConversationSession { return this.sessions.find((entry) => entry.id === this.activeId)!; }
  get running(): boolean { return sessionRunning(this.current); }
  get hasRuns(): boolean { return this.tasks.size > 0; }
  get executingIds(): Set<string> { return new Set([...this.tasks.values()].map(task => task.sessionId)); }
  private blank(id: string = globalThis.crypto.randomUUID()): ConversationSession {
    const now = Date.now();
    return { id, title: t("New conversation"), createdAt: now, updatedAt: now, messages: [], parameterValues: {}, toolPermissionPolicies: {}, queuedInputs: [], draft: { text: '', attachments: [] } };
  }
  async persist(): Promise<void> {
    await this.options.save(JSON.parse(JSON.stringify(this.sessions)), this.activeId);
  }
  recover(): void {
    if (!this.project.conversation?.recovery?.enabled || this.disposed) return;
    for (const entry of this.sessions) {
      if (entry.agentOwnerId) continue;
      if (entry.activeRunId) continue;
      if (entry.messages.some(message => message.cancelRequested)) {
        if (!this.options.canRun || this.options.canRun(entry)) void this.stop(entry).catch(error => this.options.log(String(error)));
        continue;
      }
      const answer = entry.messages.find(message => message.role === 'assistant' && message.status === 'running' && message.recovering && !message.cancelRequested);
      if (!answer) {
        const anchor = this.agentAnchor(entry);
        const pendingCommands = this.sessions.some(session => (session.agentOwnerId ?? session.id) === entry.id && session.agentCommands?.length);
        const activeAgent = entry.agent && (entry.agent.tasks.length || entry.agent.turns.some(turn => turn.status === 'queued' || turn.status === 'placed'));
        if (anchor && (activeAgent || pendingCommands) && (!this.options.canRun || this.options.canRun(entry))) this.start(entry, { id: anchor.id!, text: '', params: {}, attachments: [], createdAt: Date.now() }, anchor);
        continue;
      }
      // Durable replays the original stream under its stable output identities.
      if (!this.options.canRun || this.options.canRun(entry)) this.start(entry, { id: answer.id!, text: '', params: {}, attachments: [], createdAt: answer.createdAt ?? Date.now() }, answer);
    }
  }
  private changed(): void { if (!this.disposed) { this.options.changed(); } }
  async create(force = false): Promise<void> {
    const blank = force ? undefined : this.sessions.find((entry) => !entry.messages.length && !entry.activeRunId && !entry.queuedInputs?.length && !entry.draft?.text && !entry.draft?.attachments.length);
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
  async navigate(id: string, updates: ConversationDraftUpdate[], select = true): Promise<void> {
    const known = new Set(this.sessions.map(entry => entry.id));
    for (const update of updates) {
      if (!known.has(update.id) && !update.create) { throw new Error(t("Conversation no longer exists.")); }
      known.add(update.id);
    }
    if (!known.has(id)) { throw new Error(t("Conversation no longer exists.")); }
    for (const update of updates) {
      let entry = this.sessions.find(entry => entry.id === update.id);
      // Client-assigned IDs make recovery safe when a navigation response was lost.
      if (!entry) { entry = this.blank(update.id); this.sessions.push(entry); }
      entry.draft = { ...update.draft, attachments: [...update.draft.attachments] };
    }
    if (select) this.activeId = id;
    this.changed(); await this.persist();
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
      if (entry.agentOwnerId) {
        const owner = this.owner(entry);
        const descendants = new Set([entry.agentConversationId]);
        let count = -1;
        while (count !== descendants.size) {
          count = descendants.size;
          for (const conversation of owner.agent?.conversations ?? []) {
            if (conversation.parentId !== undefined && conversation.forkEntryId === undefined && descendants.has(conversation.parentId)) descendants.add(conversation.id);
          }
        }
        const views = this.sessions.filter(session => session.agentOwnerId === owner.id && descendants.has(session.agentConversationId));
        await this.agentCommand(entry.id, { type: 'delete', requestId: globalThis.crypto.randomUUID() });
        for (const view of views) {
          await this.runtime.deleteConversation(this.project, view.id);
          this.sessions.splice(this.sessions.indexOf(view), 1);
        }
        if (views.some(view => view.id === this.activeId)) this.activeId = owner.id;
        this.changed(); await this.persist(); return;
      }
      const task = entry.activeRunId && this.tasks.get(entry.activeRunId);
      if (task || entry.agent || entry.messages.some(message => message.pendingInput || message.cancelRequested || message.recovering)) await this.stop(entry);
      for (const child of this.sessions.filter(session => session.agentOwnerId === entry.id)) {
        await this.runtime.deleteConversation(this.project, child.id);
        this.sessions.splice(this.sessions.indexOf(child), 1);
      }
      await this.runtime.deleteConversation(this.project, id);
      this.sessions.splice(this.sessions.indexOf(entry), 1);
      if (!this.sessions.length) { this.sessions.push(this.blank()); }
      if (!this.sessions.some(session => session.id === this.activeId)) { this.activeId = this.sessions.at(-1)!.id; }
      this.changed(); await this.persist();
    } finally { this.removing.delete(id); }
  }
  async updateDraft(id: string, text: string, attachments: Attachment[], editingQueueId?: string): Promise<void> {
    const entry = this.sessions.find((entry) => entry.id === id);
    if (!entry) { return; }
    entry.draft = { text: text.slice(0, 100_000), attachments, editingQueueId: editingQueueId ?? entry.draft?.editingQueueId };
    await this.persist();
  }
  async recordCommand(command: string, content: string, entry = this.current): Promise<void> {
    if (this.disposed || this.removing.has(entry.id) || !this.sessions.includes(entry)) { throw new Error(t("Conversation no longer exists.")); }
    const now = Date.now();
    entry.messages.push({ id: globalThis.crypto.randomUUID(), role: 'user', content: `/${command}`, createdAt: now },
      { id: globalThis.crypto.randomUUID(), role: 'assistant', content, status: 'success', createdAt: now });
    entry.updatedAt = now; this.changed(); await this.persist();
  }
  async send(input: Omit<ConversationQueuedInput, 'id' | 'createdAt'>, entry = this.current, preserveDraft = false, requestId?: string, mode: 'steer' | 'followUp' | 'reject' = 'followUp', editingQueueId?: string): Promise<void> {
    const parameters = projectParameters(this.project, input.entrypointId);
    validateProjectValues(parameters.fields, input.params, input.states);
    if (this.disposed || this.removing.has(entry.id) || !this.sessions.includes(entry)) { throw new Error(t("Conversation no longer exists.")); }
    if (this.project.projectType !== 'conversation' && input.text) { this.rawArgs(input.text); }
    if (this.project.projectType === 'conversation' && !input.text.trim() && !input.attachments.length) { return; }
    const id = requestId ?? globalThis.crypto.randomUUID();
    const queued: ConversationQueuedInput = { ...input, id, requestId: id, createdAt: Date.now(), params: { ...input.params }, attachments: [...input.attachments] };
    if (entry.messages.some(message => message.id === id || message.sessionRequestId === id || message.input?.requestId === id) || entry.queuedInputs?.some(item => item.id === id || item.requestId === id)) return;
    const editingId = editingQueueId ?? entry.draft?.editingQueueId;
    if (editingId && !entry.queuedInputs?.some(item => item.id === editingId)) throw new Error(t('Queued message no longer exists.'));
    if (this.project.conversation?.durable?.enabled && (entry.agent || entry.activeRunId || entry.agentOwnerId)) {
      const owner = this.owner(entry);
      if (owner.messages.some(message => message.pendingInput)) throw new Error(t("Awaiting confirmation"));
      const args = projectParamArgs(parameters.fields, input.params, input.states);
      const previous = owner.agentParameters;
      const configChanged = previous && previous.configurationRevision !== this.options.configurationRevision?.();
      if (configChanged) {
        if (owner.agent?.tasks.length || owner.agent?.turns.some(turn => turn.status === 'queued' || turn.status === 'placed')) {
          (entry.queuedInputs ??= []).push({...queued,configurationPending:true});
          if (!preserveDraft) entry.draft = { text: '', attachments: [] };
          this.changed(); await this.persist(); return;
        }
        await this.reloadConfiguration(owner);
      }
      const changed = previous && (JSON.stringify(previous.args) !== JSON.stringify(args) || previous.entrypointId !== input.entrypointId || JSON.stringify(previous.policies) !== JSON.stringify(owner.toolPermissionPolicies));
      if (changed) {
        if (owner.agent?.tasks.length || owner.agent?.foreground || owner.agent?.turns.some(turn => turn.status === 'placed' || turn.status === 'queued') || !owner.agent) throw new Error(t('Wait for active tasks before changing session settings.'));
        if (entry !== owner) throw new Error(t('Change workflow settings in the main conversation.'));
        await this.retireAgentOwner(owner);
        const planIndex = args.indexOf('--plan');
        if (planIndex >= 0 && args[planIndex + 1] !== 'false') {
          // A new Plan workflow must plan this input and retain its approval lifecycle.
          if (!preserveDraft) entry.draft = { text: '', attachments: [] };
          this.start(entry, queued); await this.persist(); return;
        }
        owner.agentParameters = { configurationRevision: this.options.configurationRevision?.(), args, entrypointId: input.entrypointId, policies: JSON.parse(JSON.stringify(owner.toolPermissionPolicies ?? {})) };
      }
      const planIndex = previous?.args.indexOf('--plan') ?? -1;
      if (planIndex >= 0 && previous!.args[planIndex + 1] !== 'false' && owner.activeRunId) throw new Error(t("The current session is running."));
      if (attachmentsUnsupported(input.attachments)) throw new Error(t('This session accepts image attachments.'));
      if (input.text === '/compact' || input.text === '/summarize') {
        await this.agentCommand(entry.id, { type: 'compact', requestId: queued.id });
      } else {
        (entry.agentInputs ??= {})[queued.id] = queued;
        try { await this.agentCommand(entry.id, { type: 'submit', requestId: queued.id, prompt: input.text, mode }, input.attachments); }
        catch (error) {
          if (!entry.agentCommands?.some(item => item.command.requestId === queued.id)) { delete entry.agentInputs[queued.id]; await this.persist(); }
          throw error;
        }
      }
      if (!preserveDraft) entry.draft = { text: '', attachments: [] };
      this.changed(); await this.persist(); return;
    }
    const waiting = entry.messages.some((message) => message.pendingInput || message.cancelRequested || message.recovering);
    if (entry.activeRunId || waiting || entry.queuedInputs?.length) {
      if (!this.project.conversation?.inputQueue?.enabled) { throw new Error(t("The current session is running.")); }
      if (editingId) {
        const index = entry.queuedInputs!.findIndex((item) => item.id === editingId);
        if (index >= 0) { queued.id = entry.queuedInputs![index].id; entry.queuedInputs![index] = queued; }
        else { entry.queuedInputs!.push(queued); }
      } else { (entry.queuedInputs ??= []).push(queued); }
      if (!preserveDraft) entry.draft = { text: '', attachments: [] };
      this.changed(); await this.persist();
      if (!entry.activeRunId && !waiting) { this.drain(entry); }
      return;
    }
    if (!preserveDraft) { entry.draft = { text: '', attachments: [] }; }
    this.start(entry, queued); await this.persist();
  }
  private start(entry: ConversationSession, input: ConversationQueuedInput, answer?: ConversationMessage): void {
    if (entry.activeRunId) return;
    if (this.options.canRun && !this.options.canRun(entry)) throw new Error(t('This conversation is open or running in another window. You can read it here or start a new conversation.'));
    const resumeAgent = !!answer && this.project.conversation?.durable?.enabled === true && !!entry.agent?.turns.length
      && !answer.pendingInput && !answer.submittingInput;
    const parameters = projectParameters(this.project, input.entrypointId);
    const args = projectParamArgs(parameters.fields, input.params, input.states);
    if (this.project.projectType === 'conversation') {
      args.push('--message', input.text);
      for (const [flag, files] of [
        ['--images', input.attachments.filter((file) => file.kind === 'image')],
        ['--videos', input.attachments.filter((file) => file.mimeType.startsWith('video/'))],
        ['--files', input.attachments.filter((file) => file.kind !== 'image' && !file.mimeType.startsWith('video/'))],
      ] as const) { if (files.length) { args.push(flag, JSON.stringify(files.map(({ previewUrl: _, ...reference }) => reference))); } }
    } else if (input.text) { args.push(...this.rawArgs(input.text)); }
    if (!answer) {
      if (this.project.conversation?.durable?.enabled) entry.agentParameters = { configurationRevision: this.options.configurationRevision?.(), args: projectParamArgs(parameters.fields, input.params, input.states), entrypointId: input.entrypointId, policies: JSON.parse(JSON.stringify(entry.toolPermissionPolicies ?? {})) };
      if (!entry.messages.length && !entry.titleLocked) { entry.title = (input.text || input.attachments[0]?.name || t("Workflow run")).slice(0, 80); }
      entry.messages.push({ id: globalThis.crypto.randomUUID(), role: 'user', content: input.text || '', attachments: input.attachments, args, input, entrypointId: input.entrypointId, createdAt: Date.now() });
      answer = { id: input.id, role: 'assistant', content: '', items: [], status: 'running', createdAt: Date.now(), model: typeof input.params.model === 'string' ? input.params.model : undefined, args, entrypointId: input.entrypointId, events: [] };
      answer.runId = answer.id;
      entry.messages.push(answer);
    }
    const request: Run = {
      resumeAgent,
      configurationRunId: this.project.conversation?.durable?.enabled ? `${answer.runId}:configuration:${entry.agentParameters?.configurationRevision ?? 0}` : undefined,
      project: this.project, conversationId: entry.id, args: resumeAgent && entry.agentParameters && answer.args?.includes('--message')
        ? [...entry.agentParameters.args, ...answer.args.slice(answer.args.indexOf('--message'))] : answer.args ?? args, runId: answer.runId,
      entrypointId: answer.entrypointId, toolPermissionPolicies: entry.toolPermissionPolicies,
      resolvedInputs: [...(answer.resolvedInputs ?? []), ...(answer.submittingInput ? [answer.submittingInput] : [])],
      resumeAfterRequestId: answer.submittingInput?.requestId,
      agentCommands: this.sessions.filter(session => (session.agentOwnerId ?? session.id) === entry.id).flatMap(session => session.agentCommands ?? []),
    };
    const settled = entry.agent?.turns.some(turn => turn.requestId === answer.sessionRequestId && (turn.status === 'done' || turn.status === 'unanswered'));
    if (!settled) { answer.status = 'running'; answer.error = undefined; }
    if (!answer.submittingInput) { answer.pendingInput = undefined; }
    entry.updatedAt = Date.now();
    entry.activeRunId = answer.runId;
    const task: RunTask = { sessionId: entry.id, cancelled: false, finished: Promise.resolve() };
    this.tasks.set(answer.runId!, task);
    this.changed();
    task.finished = this.execute(entry, answer, request, task).catch((error) => this.options.log(`Workflow persistence: ${String(error)}`));
  }
  private rawArgs(text: string): string[] {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw) || !raw.every((arg) => typeof arg === 'string')) { throw new Error(t("Run arguments must be an array of strings.")); }
    return raw;
  }
  private async execute(entry: ConversationSession, answer: ConversationMessage, request: Run, task: RunTask): Promise<void> {
    const pending = answer.pendingInput;
    let restart = false;
    try {
      await this.persist();
      if (task.cancelled || this.disposed) { throw new Error(t("Stopped")); }
      const report = await this.runtime.run(request, (event) => {
        if (task.cancelled || this.disposed || this.tasks.get(answer.runId!) !== task) { return; }
        const chunk = event.type === 'node_chunk' ? event.chunk as any : undefined;
        const sessionFrame = chunk?.item?.metadata?.kind === 'agent-session' || chunk?.itemId === 'agent-session';
        // Full session frames already live in entry.agent; retaining each frame grows every saved trace.
        if (!sessionFrame) (answer.events ??= []).push(event);
        if (event.type === 'node_chunk') answer.recovering = false;
        if (event.type === 'node_chunk') {
          if (chunk?.type === 'output_item_start' && chunk.item?.metadata?.kind === 'agent-session') this.projectAgent(entry, chunk.item.content);
          else if (chunk?.itemId !== 'agent-session' && (!this.project.conversation?.durable?.enabled || !entry.agent || chunk?.item?.display)) {
            applyOutputChunk(answer.items ??= [], event.chunk); answer.content = outputText(answer.items);
          }
        }
        if (event.type === 'agent_command_receipt') this.acknowledgeAgent(entry, event.receipt as unknown as AgentSessionReceipt);
        if (event.type === 'agent_command_failed') {
          const id = String(event.requestId);
          const target = event.targetId ?? entry.agent?.conversationId;
          if (!['AGENT_NOT_READY', 'STEAMHARNESS_WORKER_INTERRUPTED'].includes(String(event.code))) {
            for (const session of this.sessions.filter(session => (session.agentOwnerId ?? session.id) === entry.id)) session.agentCommands = session.agentCommands?.filter(item => item.command.requestId !== id || (item.command.targetId ?? entry.agent?.conversationId) !== target);
          }
          for (const [key, waiter] of this.agentWaiters) if (waiter.ownerId === entry.id && waiter.requestId === id && (waiter.targetId ?? entry.agent?.conversationId) === target) {
            waiter.reject(Object.assign(new Error(String(event.message)), { code: event.code })); this.agentWaiters.delete(key);
          }
        }
        if (event.type === 'conversation_title_updated' && !entry.titleLocked && typeof event.title === 'string') { entry.title = event.title.slice(0, 160); }
        if (event.type === 'token_usage_updated' && !this.project.conversation?.durable?.enabled) {
          answer.tokenUsage = { enabled: true, display: true, run: event.usage as Record<string, unknown> };
        }
        if (event.type === 'user_input_requested') { answer.pendingInput = event as unknown as ConversationMessage['pendingInput']; }
        if (event.type === 'user_input_resolved') {
          this.confirmInput(entry, answer, event as unknown as ResolvedInput);
          if (answer.pendingInput?.requestId === event.requestId) { answer.pendingInput = undefined; }
          void this.persist().catch(error => this.options.log(`Workflow persistence: ${String(error)}`));
        }
        if (event.type === 'file_created') { (answer.files ??= []).push(event.file as unknown as Attachment); }
        if (event.type === 'timer_started' || event.type === 'timer_finished') {
          const timer = event.timer as TimerRecord;
          answer.timers = [...(answer.timers ?? []).filter((entry) => entry.timerId !== timer.timerId), timer];
        }
        this.changed();
      });
      if (task.cancelled || this.disposed) { throw new Error(t("Stopped")); }
      const primaryDone = entry.agent?.turns.some(turn => turn.requestId === answer.sessionRequestId && turn.status === 'done');
      answer.report = report; answer.status = primaryDone && report.status !== 'waiting_for_input' && report.status !== 'failed' ? 'success' : report.status;
      answer.durationMs = report.durationMs; answer.recovering = false;
      // Paused reports omit unfinished streams; resumed reports can omit earlier input stages.
      const items = (report.output?.items ?? []).filter(item => item.metadata?.kind !== 'agent-session');
      if ((!entry.agent || report.status === 'waiting_for_input') && report.output && (report.status === 'success' || !answer.items?.length || (report.status !== 'waiting_for_input' && items.length))) {
        const preceding = new Set([...(answer.resolvedInputs ?? []), ...(answer.submittingInput ? [answer.submittingInput] : [])].flatMap(input => input.precedingOutputItemIds ?? []));
        const history = (answer.items ?? []).filter((item, index) => preceding.has(item.id ?? String(index)));
        const historyIds = new Set(history.map(item => item.id));
        const current = new Map(items.filter(item => item.id).map(item => [item.id, item]));
        answer.items = [...history.map(item => current.get(item.id) ?? item), ...items.filter(item => !item.id || !historyIds.has(item.id))];
        answer.content = outputText(answer.items);
      }
      answer.pendingInput = report.status === 'waiting_for_input' ? report.pendingUserInput : undefined;
      for (const resolved of report.resolvedUserInputs ?? []) { this.confirmInput(entry, answer, resolved); }
      if (answer.submittingInput && report.status === 'success') { this.confirmInput(entry, answer, answer.submittingInput); }
      answer.files = [...new Map([...(answer.files ?? []), ...(report.files ?? [])].map((file) => [file.id, file])).values()];
      if (!this.project.conversation?.durable?.enabled) answer.tokenUsage = report.tokenUsage ?? answer.tokenUsage;
      answer.timers = report.timers ?? answer.timers;
      if (report.status === 'failed') {
        const data = report.result?.data;
        answer.error = report.result?.error?.message || (data && typeof data === 'object' && 'errMessage' in data && typeof data.errMessage === 'string' ? data.errMessage : t("Run failed"));
      }
      if (!primaryDone && (report.status === 'aborted' || report.status === 'timed_out')) { answer.error = report.status === 'aborted' ? t("Stopped") : t("Run timed out"); }
      if (answer.submittingInput && pending && report.status === 'failed') { answer.status = 'waiting_for_input'; answer.pendingInput = pending; }
      if (!answer.content && !answer.items?.length && report.status === 'success') { answer.content = report.result?.data === undefined ? t("Completed") : JSON.stringify(report.result.data, null, 2); }
    } catch (error) {
      const interrupted = this.project.conversation?.recovery?.enabled && !task.cancelled
        && (this.disposed || (error as { code?: string }).code === 'STEAMHARNESS_WORKER_INTERRUPTED');
      if (interrupted) {
        answer.recoveryAttempts = (answer.recoveryAttempts ?? 0) + (this.disposed ? 0 : 1);
        restart = !this.disposed && answer.recoveryAttempts <= 3;
        answer.status = this.disposed || restart ? 'running' : 'failed';
        answer.recovering = true;
        answer.error = restart || this.disposed ? undefined : t("Run interrupted");
      } else {
        answer.recovering = false;
        answer.error = error instanceof Error ? error.message : String(error);
        const primaryDone = entry.agent?.turns.some(turn => turn.requestId === answer.sessionRequestId && turn.status === 'done');
        answer.status = task.cancelled && primaryDone ? 'success' : task.cancelled ? 'aborted' : answer.submittingInput && pending ? 'waiting_for_input' : 'failed';
        if (task.cancelled && primaryDone) answer.error = undefined;
        if (answer.status === 'waiting_for_input') { answer.pendingInput = pending; }
        else if (task.cancelled) { answer.pendingInput = undefined; }
        this.options.log(`Workflow run: ${answer.error}`);
      }
    } finally {
      if (answer.status !== 'running' && answer.status !== 'failed') answer.recovering = false;
      if (answer.status !== 'waiting_for_input' && answer.status !== 'running') {
        answer.timers = answer.timers?.map((timer) => timer.status === 'running'
          ? { ...timer, status: 'cleared', endedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - new Date(timer.startedAt).getTime()) }
          : timer);
      }
      if (answer.status !== 'running' && !answer.recovering) delete answer.submittingInput;
      if (task.cancelled && answer.cancelRequested) {
        try {
          if (this.project.conversation?.recovery?.enabled) await this.runtime.cancelConversation(this.project, entry.id);
          delete answer.cancelRequested;
        } catch (error) { answer.error = String(error); this.options.log(`Workflow cancellation: ${String(error)}`); }
      }
      if (entry.activeRunId === answer.runId) { delete entry.activeRunId; }
      if (!restart) this.rejectAgentWaiters(entry.id, Object.assign(new Error('The agent owner disconnected.'), { code: 'STEAMHARNESS_WORKER_INTERRUPTED' }));
      this.changed();
      try { await this.persist(); }
      finally { if (this.tasks.get(answer.runId!) === task) this.tasks.delete(answer.runId!); this.changed(); }
      if (restart) this.recover();
      else if (!this.disposed && !this.removing.has(entry.id) && !answer.pendingInput && !answer.cancelRequested && (!task.cancelled || task.promote)) { this.drain(entry); }
    }
  }
  private owner(entry: ConversationSession): ConversationSession {
    const owner = this.sessions.find(session => session.id === (entry.agentOwnerId ?? entry.id));
    if (!owner) throw new Error(t("Conversation no longer exists."));
    return owner;
  }
  private agentAnchor(owner: ConversationSession): ConversationMessage | undefined {
    const anchors = owner.messages.filter(message => message.role === 'assistant' && message.runId && message.args);
    // A rejected bootstrap has no admitted turn and must never become the
    // historical input used to reconnect an existing durable owner.
    return [...anchors].reverse().find(message => owner.agent?.turns.some(turn => turn.entryId !== undefined && turn.requestId.startsWith(`${message.runId}:`)))
      ?? anchors.find(message => message.status !== 'failed') ?? anchors[0];
  }
  async openAgentConversation(sessionId: string, conversationId: number): Promise<string> {
    const entry = this.sessions.find(session => session.id === sessionId);
    if (!entry) throw new Error(t("Conversation no longer exists."));
    const owner = this.owner(entry), info = owner.agent?.conversations.find(conversation => conversation.id === conversationId);
    if (!info) throw new Error('The conversation is not part of this agent session.');
    if (conversationId === owner.agent?.conversationId) return owner.id;
    let source = entry;
    if (info.forkEntryId !== undefined && info.parentId !== undefined) {
      const parent = info.parentId === owner.agent?.conversationId ? owner
        : this.sessions.find(session => session.agentOwnerId === owner.id && session.agentConversationId === info.parentId);
      if (parent) source = parent;
      else if (owner.agent?.conversations.some(conversation => conversation.id === info.parentId)) {
        const parentId = await this.openAgentConversation(owner.id, info.parentId);
        source = this.sessions.find(session => session.id === parentId)!;
      }
    }
    const existing = this.sessions.find(session => session.agentOwnerId === owner.id && session.agentConversationId === conversationId);
    if (existing) return existing.id;
    const child = this.createAgentView(owner, source, info);
    if (owner.agent) this.projectAgent(owner, owner.agent, true);
    this.changed(); await this.persist(); return child.id;
  }
  private createAgentView(owner: ConversationSession, source: ConversationSession, info: AgentSessionSnapshot['conversations'][number]): ConversationSession {
    const child = { ...this.blank(), title: info.title, agentOwnerId: owner.id, agentConversationId: info.id, agent: owner.agent,
      parameterValues: JSON.parse(JSON.stringify(source.parameterValues ?? {})), toolPermissionPolicies: JSON.parse(JSON.stringify(source.toolPermissionPolicies ?? {})) };
    if (info.forkEntryId !== undefined) {
      child.forkSource = { sessionId: source.id, entryId: info.forkEntryId };
      const boundary = source.messages.findIndex(message => message.entryId === info.forkEntryId);
      child.messages = boundary < 0 ? [] : JSON.parse(JSON.stringify(source.messages.slice(0, boundary + 1)));
    }
    this.sessions.push(child);
    return child;
  }
  private acknowledgeAgent(owner: ConversationSession, receipt: AgentSessionReceipt): void {
    for (const session of this.sessions) if ((session.agentOwnerId ?? session.id) === owner.id) {
      session.agentCommands = session.agentCommands?.filter(item => item.command.requestId !== receipt.requestId || (item.command.targetId ?? owner.agent?.conversationId ?? receipt.conversationId) !== receipt.conversationId);
    }
    for (const [key, waiter] of this.agentWaiters) if (waiter.ownerId === owner.id && waiter.requestId === receipt.requestId && (waiter.targetId ?? owner.agent?.conversationId ?? receipt.conversationId) === receipt.conversationId) {
      waiter.resolve(receipt); this.agentWaiters.delete(key);
    }
  }
  private projectAgent(owner: ConversationSession, snapshot: AgentSessionSnapshot, restore = false): void {
    if (snapshot?.version !== 1 || !Number.isSafeInteger(snapshot.revision)) return;
    if (!restore && owner.agent?.ownerId === snapshot.ownerId && owner.agent.revision >= snapshot.revision) return;
    for (const entry of this.sessions.filter(session => (session.agentOwnerId ?? session.id) === owner.id)) {
      entry.agent = snapshot;
      entry.agentConversationId ??= snapshot.conversationId;
      const turns = snapshot.turns.filter(turn => turn.conversationId === entry.agentConversationId);
      const anchors = entry === owner ? entry.messages.filter(message => message.role === 'assistant' && message.runId) : [];
      entry.queuedInputs = [...turns.filter(turn => turn.status === 'queued').map(turn => entry.agentInputs?.[turn.requestId]
        ?? { id: turn.requestId, text: turn.prompt, params: {}, attachments: [], createdAt: entry.updatedAt ?? Date.now() }), ...(entry.queuedInputs??[]).filter(input=>input.configurationPending)];
      for (const turn of turns) {
        const input = entry.agentInputs?.[turn.requestId];
        if (turn.status === 'unanswered' && entry.agentInputs) delete entry.agentInputs[turn.requestId];
        if (turn.status === 'queued' || turn.status === 'unanswered' && !turn.entryId) continue;
        // Plan revisions and Build resumes belong to the original workflow answer.
        const continuation = anchors.find(message => turn.requestId.startsWith(`${message.runId}:`));
        const outputTurns = continuation ? turns.filter(part => part.requestId.startsWith(`${continuation.runId}:`) && part.status !== 'queued' && (part.status !== 'unanswered' || part.entryId !== undefined)) : [turn];
        if (turn !== outputTurns.at(-1)) continue;
        let answer = continuation ?? entry.messages.find(message => message.role === 'assistant' && message.sessionRequestId === turn.requestId);
        if (continuation) continuation.sessionRequestId = turn.requestId;
        if (!answer && turn.mode !== 'steer') {
          const id = `session:${turn.conversationId}:${turn.requestId}`;
          const pending = entry.agentCommands?.find(item => item.command.requestId === turn.requestId);
          entry.messages.push({ id: `${id}:input`, role: 'user', content: turn.prompt, createdAt: input?.createdAt ?? Date.now(), contextEpoch: turn.epoch,
            attachments: input?.attachments ?? pending?.attachments, ...(input ? { input } : {}) });
          answer = { id, role: 'assistant', content: '', items: [], createdAt: Date.now(), sessionRequestId: turn.requestId, sessionConversationId: turn.conversationId };
          entry.messages.push(answer);
        }
        if (turn.mode === 'steer') {
          const id = `steer:${turn.requestId}`;
          if (!entry.messages.some(message => message.id === id)) entry.messages.push({ id, role: 'user', content: turn.prompt, status: 'steer', createdAt: Date.now(), attachments: input?.attachments });
        }
        if (entry.agentInputs) delete entry.agentInputs[turn.requestId];
        if (!answer) continue;
        answer.sessionConversationId = turn.conversationId;
        answer.contextEpoch = turn.epoch;
        answer.entryId = turn.answerId;
        const usages = outputTurns.flatMap(part => part.usage ? [part.usage] : []);
        if (usages.length) {
          const run: Record<string, unknown> = {};
          for (const usage of usages) for (const [name, value] of Object.entries(usage)) run[name] = typeof value === 'number' ? Number(run[name] ?? 0) + value : value;
          answer.tokenUsage = { enabled: true, display: this.project.tokenUsage?.enabled !== false && this.project.tokenUsage?.display !== false, run };
        }
        if (answer.status !== 'failed' && (!restore || answer.status === undefined)) {
          answer.status = turn.status === 'done' ? 'success' : turn.status === 'unanswered' ? 'aborted' : 'running';
          answer.error = turn.reason;
        }
        if (!restore) answer.recovering = false;
        const extras = answer.items?.filter(item => item.display) ?? [];
        answer.items = [...outputTurns.flatMap(part => part.items), ...extras]; answer.content = outputText(answer.items);
      }
    }
    if (!restore) this.configurationChanged();
    for (const receipt of snapshot.receipts) this.acknowledgeAgent(owner, receipt);
    if (!restore && !this.agentSaves.has(owner.id)) this.agentSaves.set(owner.id, setTimeout(() => {
      this.agentSaves.delete(owner.id); void this.persist().catch(error => this.options.log(String(error)));
    }, 100));
  }
  async agentCommand(sessionId: string, command: AgentSessionCommand, attachments?: Attachment[]): Promise<AgentSessionReceipt> {
    if (!this.project.conversation?.durable?.enabled || !this.runtime.agentControl) throw new Error('Durable session control is unavailable.');
    const entry = this.sessions.find(session => session.id === sessionId);
    if (!entry || this.disposed) throw new Error(t("Conversation no longer exists."));
    const owner = this.owner(entry);
    const stored = entry.agentCommands?.find(item => item.command.requestId === command.requestId);
    const prepared = { ...command, targetId: command.targetId ?? stored?.command.targetId ?? entry.agentConversationId };
    if (stored && !isDeepStrictEqual(stored.command, prepared)) throw new Error('The requestId was used for another command.');
    if (!stored) (entry.agentCommands ??= []).push({ command: prepared, scopeId: entry.id, attachments });
    await this.persist();
    const key = JSON.stringify([owner.id, prepared.targetId ?? null, command.requestId]);
    const existingWaiter = this.agentWaiters.get(key);
    if (existingWaiter) return existingWaiter.promise;
    let resolve!: (receipt: AgentSessionReceipt) => void, reject!: (error: Error) => void;
    const confirmed = new Promise<AgentSessionReceipt>((done, fail) => { resolve = done; reject = fail; });
    void confirmed.catch(() => undefined);
    this.agentWaiters.set(key, { ownerId: owner.id, targetId: prepared.targetId, requestId: command.requestId, promise: confirmed, resolve, reject });
    const timeout = setTimeout(() => reject(Object.assign(new Error('Agent command confirmation timed out. Reconnect to check its result.'), { code: 'AGENT_COMMAND_TIMEOUT' })), 30_000);
    const apply = async (): Promise<AgentSessionReceipt> => {
      if (owner.activeRunId) return this.runtime.agentControl!(owner.activeRunId, prepared, entry.id, attachments);
      const anchor = this.agentAnchor(owner);
      if (!anchor) throw new Error('The agent has no resumable owner.');
      this.start(owner, { id: anchor.id!, text: '', params: {}, attachments: [], createdAt: Date.now() }, anchor);
      return confirmed;
    };
    try {
      const receipt = await Promise.race([apply(), confirmed]); this.acknowledgeAgent(owner, receipt);
      if (receipt.forkId !== undefined) {
        const fork = this.sessions.find(session => session.agentOwnerId === owner.id && session.agentConversationId === receipt.forkId);
        if (!fork) this.createAgentView(owner, entry, { id: receipt.forkId, title: `${entry.title} · ${t("Fork")}`, background: false,
          ...(command.type === 'fork' ? { forkEntryId: command.entryId } : {}) });
      }
      this.changed(); await this.persist(); return receipt;
    } catch (error) {
      if (!['STEAMHARNESS_WORKER_INTERRUPTED', 'AGENT_NOT_READY', 'AGENT_COMMAND_TIMEOUT'].includes((error as { code?: string }).code ?? '')) {
        entry.agentCommands = entry.agentCommands?.filter(item => item.command.requestId !== command.requestId);
        await this.persist();
      }
      throw error;
    } finally { clearTimeout(timeout); if (this.agentWaiters.get(key)?.promise === confirmed) this.agentWaiters.delete(key); }
  }
  configurationChanged(): void {
    if (this.disposed || !this.project.conversation?.durable?.enabled) return;
    for (const owner of this.sessions.filter(entry => !entry.agentOwnerId)) {
      if (owner.agentParameters && owner.agentParameters.configurationRevision !== this.options.configurationRevision?.()) {
        void this.reloadConfiguration(owner).catch(error => this.options.log(String(error)));
      }
    }
  }
  private reloadConfiguration(owner: ConversationSession): Promise<void> {
    const existing = this.reloading.get(owner.id);
    if (existing) return existing;
    if (this.disposed || !owner.agent || !owner.agentParameters || owner.agentParameters.configurationRevision === this.options.configurationRevision?.()
      || owner.agent.tasks.length || owner.agent.turns.some(turn => turn.status === 'queued' || turn.status === 'placed')
      || this.sessions.some(entry => (entry.agentOwnerId ?? entry.id) === owner.id && entry.messages.some(message => message.pendingInput))) return Promise.resolve();
    // Defer cancellation until the snapshot's receipts have been acknowledged.
    const reload = Promise.resolve().then(async () => {
      await this.retireAgentOwner(owner);
      if (this.disposed || !this.sessions.includes(owner)) return;
      owner.agentParameters!.configurationRevision = this.options.configurationRevision?.();
      const anchor = this.agentAnchor(owner);
      if (anchor) this.start(owner, { id: anchor.id!, text: '', params: {}, attachments: [], createdAt: Date.now() }, anchor);
      await this.persist();
    }).finally(() => { if (this.reloading.get(owner.id) === reload) this.reloading.delete(owner.id); });
    this.reloading.set(owner.id, reload);
    void reload.then(async () => {
      if (this.disposed) return;
      for (const entry of this.sessions.filter(entry => (entry.agentOwnerId ?? entry.id) === owner.id)) {
        while (entry.queuedInputs?.length) {
          const input = entry.queuedInputs.shift()!;
          delete input.configurationPending;
          try { await this.send(input, entry, true, input.id); }
          catch (error) { entry.queuedInputs.unshift(input); throw error; }
          // A newer edit may have queued this input again until the next idle boundary.
          if (entry.queuedInputs.some(queued => queued.id === input.id)) break;
        }
      }
    }).catch(error => this.options.log(String(error)));
    return reload;
  }
  private rejectAgentWaiters(ownerId: string, error: Error): void {
    for (const [id, waiter] of this.agentWaiters) if (waiter.ownerId === ownerId) { waiter.reject(error); this.agentWaiters.delete(id); }
  }
  private async retireAgentOwner(owner: ConversationSession): Promise<void> {
    const task = owner.activeRunId && this.tasks.get(owner.activeRunId);
    if (!task) return;
    task.cancelled = true;
    this.runtime.cancel(owner.activeRunId);
    await task.finished;
  }
  private confirmInput(entry: ConversationSession, answer: ConversationMessage, resolved: ResolvedInput): void {
    const existing = answer.resolvedInputs?.find((input) => input.requestId === resolved.requestId);
    const previous = existing
      ?? (answer.submittingInput?.requestId === resolved.requestId ? answer.submittingInput : undefined);
    const confirmed = { ...previous, ...resolved, request: resolved.request ?? previous?.request ??
      (answer.pendingInput?.requestId === resolved.requestId ? answer.pendingInput : undefined),
      precedingOutputItemIds: previous?.precedingOutputItemIds ?? resolved.precedingOutputItemIds };
    answer.resolvedInputs = [...(answer.resolvedInputs ?? []).filter((input) => input.requestId !== resolved.requestId), confirmed];
    if (answer.submittingInput?.requestId === resolved.requestId) { delete answer.submittingInput; }
    if (existing || !confirmed.request) { return; }
    const updates: ParamValues = {};
    for (const effect of this.project.conversation?.userInput?.effects ?? []) {
      const { when } = effect;
      if (when.type !== undefined && when.type !== confirmed.request.metadata?.type ||
          when.nodeName !== undefined && when.nodeName !== confirmed.nodeName ||
          Object.entries(when.values ?? {}).some(([name, value]) => JSON.stringify(confirmed.values[name]) !== JSON.stringify(value))) { continue; }
      Object.assign(updates, effect.params);
    }
    if (!Object.keys(updates).length) { return; }
    const key = answer.entrypointId ?? '';
    (entry.parameterValues ??= {})[key] = { ...entry.parameterValues[key], ...updates };
    const revision = globalThis.crypto.randomUUID();
    entry.parameterRevisions = { ...entry.parameterRevisions, [key]: { ...entry.parameterRevisions?.[key],
      ...Object.fromEntries(Object.keys(updates).map(name => [name, revision])) } };
  }
  private drain(entry: ConversationSession): void {
    if (this.project.conversation?.durable?.enabled || entry.activeRunId || entry.messages.some((message) => message.pendingInput || message.cancelRequested || message.recovering) || entry.draft?.editingQueueId || this.disposed || this.removing.has(entry.id)) { return; }
    const input = entry.queuedInputs?.shift();
    if (input) {
      try { this.start(entry, input); }
      catch (error) { entry.queuedInputs!.unshift(input); this.options.log(String(error)); this.changed(); }
    }
  }
  async stop(entry = this.current): Promise<void> {
    let controlError: unknown;
    if (this.project.conversation?.durable?.enabled && entry.agent && !entry.messages.some(message => message.pendingInput)) {
      const owner = this.owner(entry);
      try { await this.agentCommand(entry.id, { type: 'cancel', requestId: globalThis.crypto.randomUUID(), scope: 'all' }); }
      catch (error) { if (entry !== owner) throw error; controlError = error; }
      if (entry !== owner) return;
    }
    const task = entry.activeRunId && this.tasks.get(entry.activeRunId);
    if (task) {
      const runId = entry.activeRunId;
      task.cancelled = true;
      const answer = entry.messages.find(message => message.runId === entry.activeRunId);
      if (answer) answer.cancelRequested = true;
      try { await this.persist(); }
      finally { this.runtime.cancel(runId); await task.finished; }
    }
    else {
      const answer = entry.messages.find(message => message.pendingInput || message.cancelRequested || message.recovering);
      if (!answer) { if (controlError) throw controlError; return; }
      answer.cancelRequested = true; answer.recovering = false; answer.status = 'aborted'; answer.error = t("Stopped");
      entry.activeRunId = answer.runId;
      const cancellation: RunTask = { sessionId: entry.id, cancelled: true, finished: Promise.resolve() };
      if (answer.runId) this.tasks.set(answer.runId, cancellation);
      cancellation.finished = (async () => {
        this.changed();
        try {
          try { await this.persist(); }
          finally {
            if (this.project.conversation?.recovery?.enabled) await this.runtime.cancelConversation(this.project, entry.id);
            delete answer.cancelRequested; delete answer.pendingInput; delete answer.submittingInput;
          }
        } finally {
          delete entry.activeRunId; this.changed();
          try { await this.persist(); }
          finally { if (answer.runId && this.tasks.get(answer.runId) === cancellation) this.tasks.delete(answer.runId); this.changed(); }
        }
      })();
      await cancellation.finished;
    }
    if (controlError) throw controlError;
  }
  async resume(messageId: string, requestId: string, values: Record<string, unknown>, entry = this.current): Promise<void> {
    const answer = entry.messages.find((message) => message.id === messageId && message.pendingInput?.requestId === requestId);
    if (!answer?.pendingInput || entry.activeRunId) { return; }
    const request = answer.pendingInput;
    const allowed = Object.fromEntries(request.params.map((field) => [field.name, values[field.name] ?? request.defaultValues?.[field.name] ?? field.defaultValue ?? '']));
    const form: ParamValues = Object.fromEntries(request.params.map((field) => [field.name, projectFormValue(field, allowed[field.name])]));
    const typedValues = resolvedProjectValues(request.params, form);
    const resolved = { requestId, nodeName: request.nodeName, values: typedValues, submittedAt: new Date().toISOString(), request,
      precedingOutputItemIds: (answer.items ?? []).map((item, index) => item.id ?? String(index)) };
    answer.submittingInput = resolved;
    this.start(entry, { id: messageId, text: '', params: {}, entrypointId: answer.entrypointId, attachments: [], createdAt: Date.now() }, answer);
    await this.persist();
  }
  async editQueued(id: string, entry = this.current): Promise<void> {
    const input = entry.queuedInputs?.find((input) => input.id === id);
    if (!input) { return; }
    entry.draft = { text: input.text, attachments: input.attachments, editingQueueId: id };
    (entry.parameterValues ??= {})[input.entrypointId ?? ''] = input.params;
    this.changed(); await this.persist();
  }
  async removeQueued(id: string, entry = this.current, requestId: string = globalThis.crypto.randomUUID()): Promise<void> {
    if (this.project.conversation?.durable?.enabled) {
      if (entry.queuedInputs?.some(input => input.id === id)) await this.agentCommand(entry.id, { type: 'withdraw', requestId, inputId: id });
      return;
    }
    entry.queuedInputs = (entry.queuedInputs ?? []).filter((input) => input.id !== id);
    if (entry.draft?.editingQueueId === id) { entry.draft = { text: '', attachments: [] }; }
    this.changed(); await this.persist();
    this.drain(entry);
  }
  async cancelQueueEdit(entry = this.current): Promise<void> {
    entry.draft = { text: '', attachments: [] }; this.changed(); await this.persist(); this.drain(entry);
  }
  async runQueued(entry = this.current): Promise<void> { this.drain(entry); await this.persist(); }
  async reorderQueued(ids: string[], entry = this.current): Promise<void> {
    const queue = entry.queuedInputs ?? [];
    if (ids.length !== queue.length || new Set(ids).size !== queue.length || ids.some((id) => !queue.some((input) => input.id === id))) { return; }
    entry.queuedInputs = ids.map((id) => queue.find((input) => input.id === id)!); this.changed(); await this.persist();
  }
  async promoteQueued(id: string, entry = this.current, requestId: string = globalThis.crypto.randomUUID()): Promise<void> {
    const queue = entry.queuedInputs ?? [];
    if (!queue.some((input) => input.id === id)) { return; }
    if (this.project.conversation?.durable?.enabled) {
      await this.agentCommand(entry.id, { type: 'promote', requestId, inputId: id });
      return;
    }
    await this.reorderQueued([id, ...queue.filter((input) => input.id !== id).map((input) => input.id)], entry);
    if (entry.draft?.editingQueueId) { entry.draft = { text: '', attachments: [] }; }
    const task = entry.activeRunId && this.tasks.get(entry.activeRunId);
    if (task) task.promote = true;
    await this.stop(entry); this.drain(entry);
  }
  async retry(id: string, entry = this.current): Promise<void> {
    const index = entry.messages.findIndex((message) => message.id === id && message.role === 'assistant');
    const answer = entry.messages[index];
    if (answer?.recovering && !entry.activeRunId && !answer.cancelRequested) {
      answer.recoveryAttempts = 0; answer.status = 'running'; this.recover(); await this.persist(); return;
    }
    const user = [...entry.messages.slice(0, index)].reverse().find((message) => message.role === 'user');
    if (!user || entry.activeRunId && !entry.agent) { return; }
    if (user.input) { await this.send(user.input, entry); return; }
    const parameters = projectParameters(this.project, user.entrypointId);
    const params: ParamValues = {};
    for (const field of parameters.fields) { const index = user.args?.indexOf(field.flag ?? '') ?? -1; if (index >= 0) { params[field.name] = user.args![index + 1]; } }
    await this.send({ text: user.content, params, entrypointId: user.entrypointId, attachments: user.attachments ?? [] }, entry);
  }
  async idle(): Promise<void> { while (this.tasks.size) { await Promise.all([...this.tasks.values()].map((task) => task.finished)); } }
  dispose(): void {
    this.disposed = true;
    for (const timer of this.agentSaves.values()) clearTimeout(timer);
    this.agentSaves.clear();
    void this.persist().catch(error => this.options.log(String(error)));
    for (const owner of this.sessions.filter(session => !session.agentOwnerId)) this.rejectAgentWaiters(owner.id, Object.assign(new Error('The agent host closed.'), { code: 'STEAMHARNESS_WORKER_INTERRUPTED' }));
    if (!this.project.conversation?.recovery?.enabled) for (const entry of this.sessions) void this.stop(entry).catch(error => this.options.log(String(error)));
  }
}

export { sessionRunning } from './workflow-types';

function attachmentsUnsupported(attachments: Attachment[]): boolean { return attachments.some(file => file.kind !== 'image'); }
