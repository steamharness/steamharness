import type { AgentPlanItem } from 'steamharness/agent';
import type { ConversationMessage } from '../workflow-types';
import { t } from '../localization';
import { iconHtml, updateIcon } from './ui';

type PlanStatus = 'running' | 'waiting' | 'stopping' | 'failed' | 'stopped' | 'paused';
export interface ConversationPlanState { items: AgentPlanItem[]; status: PlanStatus }
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function planItems(value: unknown): AgentPlanItem[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return;
  const ids = new Set<string>();
  for (const item of value) {
    const entry = record(item);
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 128 || ids.has(entry.id)
      || typeof entry.text !== 'string' || entry.text.length > 10_000 || typeof entry.status !== 'string'
      || !['pending', 'in_progress', 'completed'].includes(entry.status)) return;
    ids.add(entry.id);
  }
  return value.map(({ id, text, status }) => ({ id, text, status }));
}

/** Only committed updates in this answer own its progress; the session plan can belong to an older turn. */
export function conversationPlan(message: ConversationMessage): ConversationPlanState | undefined {
  if (message.role !== 'assistant' || message.status === 'success' && !message.pendingInput && !message.submittingInput
    && !message.recovering && !message.error && !message.cancelRequested) return;
  let items: AgentPlanItem[] | undefined;
  for (const item of message.items ?? []) {
    if (item.metadata?.kind !== 'agent-part') continue;
    let content = record(item.content);
    if (!content && typeof item.content === 'string') {
      try { content = record(JSON.parse(item.content)); } catch { continue; }
    }
    if ((item.metadata?.partType ?? content?.type) !== 'tool' || content?.tool !== 'update_plan'
      || (item.metadata?.status ?? content.status) !== 'success') continue;
    const updated = planItems(record(content.input)?.items);
    if (updated) items = updated;
  }
  if (!items?.length) return;
  const status: PlanStatus = ['failed', 'timed_out'].includes(message.status ?? '') ? 'failed'
    : message.status === 'aborted' ? 'stopped' : message.cancelRequested ? 'stopping'
      : message.pendingInput || message.submittingInput || message.status === 'waiting_for_input' ? 'waiting'
        : message.recovering || !['running', 'sending'].includes(message.status ?? '') ? 'paused' : 'running';
  return { items, status };
}

const setText = (element: HTMLElement, value: string): void => { if (element.textContent !== value) element.textContent = value; };
const statusLabel = (status: PlanStatus): string => status === 'failed' ? t('Failed') : status === 'stopped' ? t('Stopped')
  : status === 'waiting' ? t('Awaiting confirmation') : status === 'stopping' ? t('Stopping') : status === 'paused' ? t('Paused') : '';
interface PlanRow { root: HTMLLIElement; icon: HTMLElement; text: HTMLElement; status: HTMLElement }

/** Keyed rows preserve selection and scroll while the model revises its plan. */
export class ConversationPlan {
  readonly button = document.createElement('button');
  readonly panel = document.createElement('section');
  private readonly label = document.createElement('span');
  private readonly current = document.createElement('span');
  private readonly progress = document.createElement('progress');
  private readonly status = document.createElement('p');
  private readonly connection = document.createElement('p');
  private readonly list = document.createElement('ol');
  private readonly rows = new Map<string, PlanRow>();

  constructor() {
    this.button.type = 'button'; this.button.className = 'plan-button';
    this.label.className = 'plan-label'; this.current.className = 'plan-current';
    const chevron = document.createElement('span'); chevron.className = 'plan-chevron'; chevron.innerHTML = iconHtml('chevron-right');
    this.button.innerHTML = iconHtml('checklist'); this.button.append(this.label, this.current, chevron);
    this.panel.id = `plan-${crypto.randomUUID()}`; this.panel.className = 'plan-panel'; this.panel.hidden = true;
    this.panel.setAttribute('aria-label', t('Task plan'));
    this.button.setAttribute('aria-controls', this.panel.id); this.button.setAttribute('aria-expanded', 'false');
    this.button.addEventListener('click', () => this.expand(this.panel.hidden !== false));
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || this.panel.hidden) return;
      event.preventDefault(); event.stopPropagation(); this.expand(false); this.button.focus();
    };
    this.panel.addEventListener('keydown', escape); this.button.addEventListener('keydown', escape);
    this.status.className = 'plan-status'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-atomic', 'true');
    this.progress.setAttribute('aria-label', t('Plan progress'));
    this.connection.className = 'plan-connection'; this.connection.textContent = t('Connection lost. Showing the last known task state.');
    const header = document.createElement('div'); header.className = 'plan-header'; header.append(this.status, this.progress);
    this.list.className = 'plan-list'; this.list.tabIndex = 0; this.list.setAttribute('aria-label', t('Plan items'));
    this.panel.append(header, this.connection, this.list);
  }

  private expand(open: boolean): void {
    this.panel.hidden = !open; this.button.setAttribute('aria-expanded', String(open));
  }

  update(state: ConversationPlanState, connected: boolean): void {
    const completed = state.items.filter(item => item.status === 'completed').length;
    const active = state.items.find(item => item.status === 'in_progress');
    const status = state.status === 'running' && !connected ? 'paused' : state.status;
    const summary = [t('Plan · {0}/{1}', completed, state.items.length), statusLabel(status)].filter(Boolean).join(' · ');
    setText(this.label, summary); setText(this.current, active?.text ?? ''); this.current.hidden = !active;
    const title = [summary, active?.text].filter(Boolean).join(' · ');
    this.button.ariaLabel = title; this.button.title = `${t('View task plan')}\n${title}`;
    this.panel.dataset.state = this.button.dataset.state = status;
    setText(this.status, [t('{0}/{1} completed', completed, state.items.length), statusLabel(status)].filter(Boolean).join(' · '));
    this.progress.max = state.items.length; this.progress.value = completed; this.connection.hidden = connected;
    const keep = new Set<string>();
    state.items.forEach((item, index) => {
      keep.add(item.id);
      let row = this.rows.get(item.id);
      if (!row) {
        const root = document.createElement('li'); root.className = 'plan-item'; root.dataset.planId = item.id;
        const icon = document.createElement('span'); icon.className = 'plan-item-icon';
        const text = document.createElement('span'); text.className = 'plan-item-text';
        const label = document.createElement('span'); label.className = 'plan-item-status';
        root.append(icon, text, label); row = { root, icon, text, status: label }; this.rows.set(item.id, row);
      }
      const running = item.status === 'in_progress' && status === 'running';
      row.root.dataset.state = item.status === 'in_progress' ? status : item.status;
      updateIcon(row.icon, item.status === 'completed' ? 'check' : running ? 'loading' : 'circle-outline');
      setText(row.text, item.text);
      setText(row.status, item.status === 'completed' ? t('Completed') : item.status === 'pending' ? t('Not started')
        : running ? t('In progress') : status === 'failed' || status === 'stopped' ? t('Incomplete') : t('Paused'));
      const current = this.list.children[index] ?? null;
      if (current !== row.root) {
        if (this.list.moveBefore && this.list.isConnected && row.root.isConnected) this.list.moveBefore(row.root, current);
        else this.list.insertBefore(row.root, current);
      }
    });
    for (const [id, row] of this.rows) if (!keep.has(id)) { row.root.remove(); this.rows.delete(id); }
  }

  remove(): void { this.button.remove(); this.panel.remove(); }
}
