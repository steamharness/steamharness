import type { AgentSessionSnapshot, AgentSessionTask } from 'steamharness/agent';
import { locale, t } from '../localization';
import { iconHtml, iconButton, updateIcon } from './ui';

type Status = 'running' | 'queued' | 'waiting' | 'needs_review' | 'completed' | 'failed' | 'stopped' | 'stopping' | 'interrupted';
export interface ConversationSubagent {
  id: number; label: string; status: Status; role?: string; childId?: number; attempt?: number;
  phase?: string; activity?: string; result?: string; error?: string;
  progress?: { completed: number; total: number };
  startedAt?: number; endedAt?: number; totalTokens?: number;
}
export interface ConversationSubagentsState {
  ownerId: string; conversationId: number; connected: boolean; tasks: ConversationSubagent[];
  capturedAt?: number; displayUsage?: boolean;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const number = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
const terminal = (task: AgentSessionTask): boolean => ['completed', 'failed', 'faulted', 'aborted', 'orphaned'].includes(task.status);

/** Select actual delegations, excluding the subagent tool calls and work in other conversations/forks. */
export function conversationSubagents(snapshot: AgentSessionSnapshot | undefined, conversationId: number | undefined,
  connected: boolean, interrupted = false): ConversationSubagentsState | undefined {
  if (!snapshot) return;
  const scope = conversationId ?? snapshot.conversationId;
  const unique = new Map<number, AgentSessionTask>();
  for (const task of [...snapshot.history, ...snapshot.tasks]) {
    if (task.conversationId === scope && (task.kind === 'project.delegation' || task.agent)) unique.set(task.id, task);
  }
  const childActivity = new Map<number, string>();
  const conversations = new Set(snapshot.conversations.map(conversation => conversation.id));
  for (const task of snapshot.tasks) {
    if (task.toolName) childActivity.set(task.conversationId, task.label || task.toolName);
  }
  const tasks = [...unique.values()].map((task): ConversationSubagent => {
    const work = task.agent, details = record(task.details), checkpoint = record(task.checkpoint);
    const child = work?.childConversationId ?? task.childConversationId ?? number(checkpoint.childId);
    const childId = child !== undefined && conversations.has(child) ? child : undefined;
    const progress = work?.progress ?? task.progress;
    const phase = progress?.phase ?? task.phase;
    const error = work?.error ?? text(record(details.error).message) ?? text(details.reason) ?? task.blockedReason;
    const needsReview = phase === 'needs_review' || /\b(?:MEDIA|BODY)_RESULT_UNKNOWN\b/.test(error ?? '');
    const status: Status = terminal(task) ? task.status === 'completed' ? 'completed'
      : ['failed', 'faulted', 'orphaned'].includes(task.status) ? needsReview ? 'needs_review' : 'failed' : 'stopped'
      : interrupted ? 'interrupted' : task.stopping ? 'stopping' : needsReview ? 'needs_review'
        : task.status === 'queued' || phase === 'create' || task.status === 'pending' && !childId ? 'queued'
        : task.status === 'blocked' ? 'waiting' : childId || task.status === 'running' ? 'running' : 'waiting';
    return { id: task.id, label: work?.label || task.label || t('Subagent {0}', task.id), role: work?.agentId,
      status, childId, attempt: work?.attempt ?? task.attempt, phase,
      activity: childId === undefined ? undefined : childActivity.get(childId),
      progress: progress && Number.isFinite(progress.total) && progress.total > 0 ? progress : undefined,
      startedAt: task.startedAt, endedAt: task.endedAt, totalTokens: task.usage?.totalTokens,
      result: work?.result ?? text(details.result),
      error };
  });
  const active = (task: ConversationSubagent): number => ['running', 'queued', 'waiting', 'stopping'].includes(task.status) ? 0 : 1;
  // Outstanding work stays visible above history; progress updates retain stable order.
  tasks.sort((a, b) => active(a) - active(b) || a.id - b.id);
  return tasks.length ? { ownerId: snapshot.ownerId, conversationId: scope, connected, capturedAt: snapshot.capturedAt, tasks } : undefined;
}

/** Child details show the same delegation receipt as the parent; independent forks have no such owner. */
export function childConversationSubagent(snapshot: AgentSessionSnapshot | undefined, childId: number | undefined,
  connected: boolean, interrupted = false): ConversationSubagent | undefined {
  const child = snapshot?.conversations.find(conversation => conversation.id === childId);
  if (!child || child.parentId === undefined || child.forkEntryId !== undefined) return;
  return conversationSubagents(snapshot, child.parentId, connected, interrupted)?.tasks
    .filter(task => task.childId === childId).reduce<ConversationSubagent | undefined>((latest, task) => !latest || task.id > latest.id ? task : latest, undefined);
}

const statusLabel = (status: Status): string => ({
  running: t('Running'), queued: t('Queued'), waiting: t('Waiting'), needs_review: t('Awaiting verification'), completed: t('Completed'),
  failed: t('Failed'), stopped: t('Stopped'), stopping: t('Stopping...'), interrupted: t('Interrupted'),
})[status];
const statusIcon = (status: Status): string => ({
  running: 'loading', queued: 'clock', waiting: 'debug-pause', needs_review: 'warning', completed: 'pass', failed: 'error', stopped: 'debug-stop', stopping: 'debug-stop', interrupted: 'debug-pause',
})[status];
const phaseLabel = (phase: string): string => ({ create: t('Queued'), wait: t('Working'), report: t('Returning result'), needs_review: t('Awaiting verification') } as Record<string, string>)[phase] ?? phase;
const setText = (element: HTMLElement, value: string): void => { if (element.textContent !== value) element.textContent = value; };
const taskMeta = (task: ConversationSubagent): string => [t('Task {0}', task.id), statusLabel(task.status), task.role && t('Role: {0}', task.role), task.attempt && t('Attempt {0}', task.attempt),
  task.phase && t('Phase: {0}', phaseLabel(task.phase)), task.progress && t('{0}/{1} completed', task.progress.completed, task.progress.total)].filter(Boolean).join(' · ');
const taskError = (task: ConversationSubagent): string => task.error ? t(task.status === 'needs_review' ? 'Reason: {0}' : 'Error: {0}', task.error) : '';
function taskDuration(task: ConversationSubagent, state: ConversationSubagentsState, now: number): string {
  const end = task.endedAt ?? (task.status === 'interrupted' ? state.capturedAt
    : ['running', 'waiting', 'stopping'].includes(task.status) ? state.connected ? now : state.capturedAt : undefined);
  if (!Number.isFinite(task.startedAt) || !Number.isFinite(end)) return '—';
  const seconds = Math.floor(Math.max(0, end! - task.startedAt!) / 1000);
  return seconds >= 3600 ? t('{0}h {1}m {2}s', Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60)
    : seconds >= 60 ? t('{0}m {1}s', Math.floor(seconds / 60), seconds % 60) : t('{0}s', seconds);
}

/** A model reply can finish while the delegated business work still lacks a verified result. */
export class ChildConversationStatus {
  readonly root = document.createElement('section');
  private readonly title = document.createElement('p');
  private readonly meta = document.createElement('p');
  private readonly note = document.createElement('p');
  private readonly error = document.createElement('pre');
  private readonly connection = document.createElement('p');

  constructor() {
    this.root.className = 'child-work-status'; this.root.hidden = true;
    this.root.setAttribute('role', 'status'); this.root.setAttribute('aria-live', 'polite');
    this.title.className = 'child-work-title'; this.meta.className = 'subagent-meta'; this.error.className = 'subagent-error';
    this.note.textContent = t('The request result is unknown. This task has not been verified as complete.');
    this.connection.textContent = t('Connection lost. Showing the last known task state.');
    this.root.append(this.title, this.meta, this.note, this.error, this.connection);
  }

  update(task: ConversationSubagent | undefined, connected: boolean): void {
    this.root.hidden = !task;
    if (!task) { delete this.root.dataset.state; return; }
    this.root.dataset.state = task.status;
    setText(this.title, t('Task status: {0} · {1}', statusLabel(task.status), task.label));
    setText(this.meta, taskMeta(task));
    this.note.hidden = task.status !== 'needs_review';
    this.error.hidden = !task.error; setText(this.error, taskError(task));
    this.connection.hidden = connected;
  }
}
interface TaskView {
  root: HTMLDetailsElement; title: HTMLElement; metrics: HTMLElement; icon: HTMLElement; meta: HTMLElement;
  progress: HTMLProgressElement; activity: HTMLElement; error: HTMLElement; result: HTMLElement; open: HTMLButtonElement;
}

/** Keyed DOM keeps disclosure, focus, text selection and scroll intact during streaming updates. */
export class ConversationSubagents {
  readonly button = document.createElement('button');
  readonly summary = document.createElement('div');
  readonly panel = document.createElement('section');
  private readonly label = document.createElement('span');
  private readonly chevron = document.createElement('span');
  private readonly connection = document.createElement('p');
  private readonly list = document.createElement('div');
  private readonly rows = new Map<number, TaskView>();
  private state?: ConversationSubagentsState;
  private key = '';

  constructor(private readonly openConversation: (conversationId: number, ownerId: string) => void) {
    this.button.type = 'button'; this.button.className = 'subagents-button';
    this.button.innerHTML = iconHtml('organization'); this.chevron.innerHTML = iconHtml('chevron-right');
    this.button.append(this.label, this.chevron);
    this.panel.id = `subagents-${crypto.randomUUID()}`; this.panel.className = 'subagents-panel'; this.panel.hidden = true;
    this.panel.setAttribute('aria-label', t('Subagent execution details'));
    this.button.setAttribute('aria-controls', this.panel.id); this.button.setAttribute('aria-expanded', 'false');
    this.button.title = t('View subagent execution details');
    this.button.addEventListener('click', () => this.expand(this.panel.hidden !== false));
    this.panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.expand(false); this.button.focus(); }
    });
    this.summary.className = 'subagents-summary'; this.connection.className = 'subagents-connection';
    this.connection.textContent = t('Connection lost. Showing the last known task state.');
    this.list.className = 'subagents-list'; this.panel.append(this.connection, this.list);
  }

  private expand(open: boolean): void {
    this.panel.hidden = !open; this.button.setAttribute('aria-expanded', String(open));
    if (open) this.renderRows();
  }

  update(state: ConversationSubagentsState): void {
    // An owner can change on reconnect; preserve the user's expansion for the same conversation.
    const key = String(state.conversationId);
    if (this.key !== key) { this.expand(false); this.rows.clear(); this.list.replaceChildren(); this.key = key; }
    this.state = state;
    const counts = new Map<Status, number>();
    for (const task of state.tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    const parts = (['running', 'queued', 'waiting', 'stopping', 'needs_review', 'failed', 'interrupted', 'completed', 'stopped'] as Status[])
      .filter(status => counts.has(status)).map(status => t('{0} {1}', counts.get(status)!, statusLabel(status)));
    setText(this.label, t('Subagents · {0}', parts.join(t(', '))));
    this.button.dataset.state = counts.has('failed') ? 'failed' : counts.has('running') ? 'running' : 'settled';
    this.button.title = state.connected ? t('View subagent execution details') : this.connection.textContent!;
    this.connection.hidden = state.connected;
    if (!this.panel.hidden) this.renderRows();
  }

  private renderRows(): void {
    const state = this.state;
    if (!state) return;
    const keep = new Set<number>();
    state.tasks.forEach((task, index) => {
      keep.add(task.id);
      let view = this.rows.get(task.id);
      if (!view) {
        const root = document.createElement('details'); root.className = 'subagent-task'; root.dataset.taskId = String(task.id);
        const summary = document.createElement('summary');
        const icon = document.createElement('span'); icon.className = 'subagent-icon';
        const title = document.createElement('span'); title.className = 'subagent-title';
        const metrics = document.createElement('span'); metrics.className = 'subagent-metrics';
        const chevron = document.createElement('span'); chevron.className = 'subagent-chevron'; chevron.innerHTML = iconHtml('chevron-right');
        summary.append(icon, title, metrics, chevron);
        const body = document.createElement('div'); body.className = 'subagent-detail';
        const meta = document.createElement('p'); meta.className = 'subagent-meta';
        const progress = document.createElement('progress'); progress.setAttribute('aria-label', t('Task progress'));
        const activity = document.createElement('p'); activity.className = 'subagent-current';
        const error = document.createElement('pre'); error.className = 'subagent-error';
        const result = document.createElement('pre'); result.className = 'subagent-result';
        const open = iconButton('comment-discussion', t('Open child conversation'), () => {
          const current = this.state?.tasks.find(item => item.id === task.id);
          if (this.state?.connected && current?.childId !== undefined) this.openConversation(current.childId, this.state.ownerId);
        });
        open.className = 'subagent-open'; open.append(document.createTextNode(t('Open child conversation')));
        body.append(meta, progress, activity, error, result, open); root.append(summary, body);
        view = { root, title, icon, metrics, meta, progress, activity, error, result, open }; this.rows.set(task.id, view);
      }
      view.root.dataset.state = task.status;
      updateIcon(view.icon, statusIcon(task.status));
      view.icon.title = statusLabel(task.status); view.icon.setAttribute('role', 'img'); view.icon.setAttribute('aria-label', statusLabel(task.status));
      setText(view.title, task.label); view.title.title = task.label;
      this.updateMetrics(view, task, state, Date.now());
      setText(view.meta, taskMeta(task));
      view.progress.hidden = !task.progress;
      if (task.progress) { view.progress.max = task.progress.total; view.progress.value = Math.max(0, task.progress.completed); }
      view.activity.hidden = !task.activity; setText(view.activity, task.activity ? t('Current activity: {0}', task.activity) : '');
      view.error.hidden = !task.error; setText(view.error, taskError(task));
      view.result.hidden = !task.result; setText(view.result, task.result ?? '');
      view.open.hidden = task.childId === undefined; view.open.disabled = !state.connected;
      const current = this.list.children[index] ?? null;
      if (current !== view.root) {
        if (this.list.moveBefore && this.list.isConnected && view.root.isConnected) this.list.moveBefore(view.root, current);
        else {
          const focused = view.root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
          this.list.insertBefore(view.root, current); focused?.focus({ preventScroll: true });
        }
      }
    });
    for (const [id, view] of this.rows) if (!keep.has(id)) { view.root.remove(); this.rows.delete(id); }
  }

  private updateMetrics(view: TaskView, task: ConversationSubagent, state: ConversationSubagentsState, now: number): void {
    const duration = taskDuration(task, state, now);
    const tokens = t('{0} tokens', Number.isFinite(task.totalTokens) ? Number(task.totalTokens).toLocaleString(locale()) : '—');
    setText(view.metrics, state.displayUsage === false ? duration : `${duration} · ${tokens}`);
    view.metrics.title = [t('Duration: {0}', duration), ...(state.displayUsage === false ? [] : [tokens])].join('\n');
  }

  /** Reuse the transcript clock; completed and disconnected rows keep their persisted span. */
  tick(now = Date.now()): void {
    if (this.panel.hidden || !this.state) return;
    for (const task of this.state.tasks) {
      const view = this.rows.get(task.id);
      if (view) this.updateMetrics(view, task, this.state, now);
    }
  }

  remove(): void { this.button.remove(); this.summary.remove(); this.panel.remove(); }
}
