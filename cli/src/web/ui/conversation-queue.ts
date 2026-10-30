import { t } from '../localization';
import { sessionRunning, type ConversationQueuedInput, type ConversationSession } from '../workflow-types';
import { iconButton } from './ui';

interface QueueState {
  projectUri: string;
  session: ConversationSession;
  sessions: ConversationSession[];
  durable: boolean;
  ready: boolean;
  canExecute?: boolean;
  pendingIds: Set<string>;
}
export interface QueueAction {
  projectUri: string;
  sessionId: string;
  id: string;
  requestId: string;
  type: 'queue-promote' | 'queue-remove';
}
interface PendingAction extends QueueAction {
  phase: 'waiting' | 'sending' | 'accepted' | 'failed';
  input: ConversationQueuedInput;
  index: number;
  error?: string;
}
interface QueueRow {
  root: HTMLDivElement;
  label: HTMLSpanElement;
  status: HTMLSpanElement;
  edit: HTMLButtonElement;
  up: HTMLButtonElement;
  send: HTMLButtonElement;
  remove: HTMLButtonElement;
  error: HTMLDivElement;
  errorText: HTMLSpanElement;
  retry: HTMLButtonElement;
}

export class ConversationQueue {
  private state?: QueueState;
  private scope = '';
  private readonly rows = new Map<string, QueueRow>();
  private readonly actions = new Map<string, PendingAction>();
  private readonly heading = document.createElement('div');
  private readonly title = document.createElement('span');
  private readonly list = document.createElement('div');
  private readonly resume: HTMLButtonElement;

  constructor(private readonly root: HTMLElement, private readonly options: {
    action(action: QueueAction): void;
    pendingAction?(action: QueueAction): boolean;
    edit(id: string): void;
    reorder(ids: string[]): void;
    resume(): void;
  }) {
    this.heading.className = 'queue-heading';
    this.resume = iconButton('play', t('Resume queue'), options.resume);
    this.heading.append(this.title, this.resume);
    this.root.replaceChildren(this.heading, this.list);
  }

  update(state: QueueState): void {
    this.state = state;
    const scope = JSON.stringify([state.projectUri, state.session.id]);
    if (scope !== this.scope) { this.scope = scope; this.rows.clear(); this.list.replaceChildren(); }
    for (const [key, action] of this.actions) {
      const session = state.sessions.find(session => session.id === action.sessionId);
      if (action.projectUri === state.projectUri && (!session || action.phase === 'accepted'
        && !session.queuedInputs?.some(input => this.matches(action, input)) && !state.pendingIds.has(action.input.requestId ?? action.id))) this.actions.delete(key);
    }
    this.render();
  }

  receive(message: Record<string, any>): boolean {
    if (message.type !== 'queue-updated' && message.type !== 'error') return false;
    const entry = [...this.actions.values()].find(action => action.requestId === message.requestId && action.sessionId === message.sessionId
      && (message.type === 'error' ? action.type === message.requestType : action.projectUri === message.projectUri && action.id === message.id));
    if (!entry) return false;
    if (message.type === 'error') { entry.phase = 'failed'; entry.error = message.message; }
    else { entry.phase = 'accepted'; delete entry.error; }
    this.render();
    return true;
  }

  private key(id: string): string { return JSON.stringify([this.state!.projectUri, this.state!.session.id, id]); }
  private matches(action: PendingAction, input: Pick<ConversationQueuedInput, 'id' | 'requestId'>): boolean {
    return action.id === input.id || action.input.id === input.id || (action.input.requestId ?? action.id) === (input.requestId ?? input.id);
  }
  private actionFor(input: Pick<ConversationQueuedInput, 'id' | 'requestId'>): PendingAction | undefined {
    return [...this.actions.values()].find(action => action.projectUri === this.state!.projectUri
      && action.sessionId === this.state!.session.id && this.matches(action, input));
  }

  private act(id: string, type: QueueAction['type']): void {
    const state = this.state!;
    const input = state.session.queuedInputs?.find(input => input.id === id) ?? [...this.actions.values()].find(action =>
      action.projectUri === state.projectUri && action.sessionId === state.session.id && action.input.id === id)?.input;
    if (!state.ready || type === 'queue-promote' && state.canExecute === false || !input) return;
    const previous = this.actionFor(input);
    if (previous && previous.phase !== 'failed') return;
    const actionId = previous?.id ?? id;
    this.actions.set(this.key(actionId), { projectUri: state.projectUri, sessionId: state.session.id, id: actionId, type, input,
      index: previous?.index ?? state.session.queuedInputs!.indexOf(input),
      requestId: previous?.type === type ? previous.requestId : crypto.randomUUID(), phase: 'waiting' });
    this.render();
  }

  private createRow(id: string): QueueRow {
    const root = document.createElement('div'); root.className = 'queued-input'; root.dataset.id = id;
    const label = document.createElement('span'); label.className = 'queued-input-label';
    const status = document.createElement('span'); status.className = 'queued-input-status'; status.setAttribute('role', 'status');
    const controls = document.createElement('div'); controls.className = 'queued-input-actions';
    const edit = iconButton('edit', t('Edit'), () => this.options.edit(id));
    const up = iconButton('arrow-up', t('Move up'), () => {
      const ids = this.state!.session.queuedInputs!.map(input => input.id), index = ids.indexOf(id);
      if (index <= 0) return;
      [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; this.options.reorder(ids);
    });
    const send = iconButton('send', t('Send now'), () => this.act(id, 'queue-promote'));
    const remove = iconButton('close', t('Withdraw input'), () => this.act(id, 'queue-remove'));
    const error = document.createElement('div'); error.className = 'queued-input-error'; error.setAttribute('role', 'alert');
    const errorText = document.createElement('span');
    const retry = iconButton('refresh', t('Retry'), () => {
      const input = this.state?.session.queuedInputs?.find(input => input.id === id);
      const action = this.actionFor(input ?? { id });
      if (action?.phase === 'failed') this.act(id, action.type);
    });
    error.append(errorText, retry);
    controls.append(edit, up, send, remove); root.append(label, status, controls, error);
    root.addEventListener('dragstart', event => { if (root.draggable) event.dataTransfer?.setData('application/x-studio-queue', id); });
    root.addEventListener('dragover', event => { if (root.draggable && event.dataTransfer?.types.includes('application/x-studio-queue')) event.preventDefault(); });
    root.addEventListener('drop', event => {
      const source = event.dataTransfer?.getData('application/x-studio-queue');
      const queue = this.state!.session.queuedInputs ?? [];
      if (!root.draggable || !source || !this.rows.get(source)?.root.draggable) return;
      event.preventDefault();
      const ids = queue.filter(input => input.id !== source).map(input => input.id); ids.splice(ids.indexOf(id), 0, source);
      this.options.reorder(ids);
    });
    return { root, label, status, edit, up, send, remove, error, errorText, retry };
  }

  private render(): void {
    const state = this.state;
    if (!state) return;
    const queue = [...(state.session.queuedInputs ?? [])];
    for (const action of this.actions.values()) {
      if (action.projectUri === state.projectUri && action.sessionId === state.session.id && action.phase === 'failed'
        && !queue.some(input => this.matches(action, input))) queue.splice(Math.min(action.index, queue.length), 0, action.input);
    }
    const visible = queue.filter(input => {
      const action = this.actionFor(input);
      return !action || action.phase === 'failed';
    });
    this.root.hidden = !visible.length;
    this.title.textContent = t('Queued messages ({0})', visible.length);
    this.resume.hidden = state.durable || sessionRunning(state.session) || state.session.messages.some(message => message.pendingInput);
    this.resume.disabled = !state.ready || state.canExecute === false || queue.some(input => state.pendingIds.has(input.requestId ?? input.id));
    for (const [id, row] of this.rows) if (!visible.some(input => input.id === id)) { row.root.remove(); this.rows.delete(id); }
    for (const [index, input] of visible.entries()) {
      let row = this.rows.get(input.id);
      if (!row) { row = this.createRow(input.id); this.rows.set(input.id, row); }
      // Keep untouched rows in place while snapshots stream in.
      if (this.list.children[index] !== row.root) this.list.insertBefore(row.root, this.list.children[index] ?? null);
      const action = this.actionFor(input);
      const promoted = state.session.agent?.turns.some(turn => turn.requestId === (input.requestId ?? input.id) && turn.mode === 'steer') === true;
      const text = input.text || [...input.attachments, ...(input.references ?? [])].map(file => file.name).join(', ');
      if (row.label.textContent !== text) row.label.textContent = text;
      row.label.title = text;
      const status = promoted ? t('Send requested') : '';
      if (row.status.textContent !== status) row.status.textContent = status;
      row.status.hidden = !status; row.status.title = status;
      row.root.setAttribute('aria-busy', 'false');
      row.edit.hidden = row.up.hidden = state.durable;
      row.edit.disabled = row.up.disabled = !state.ready || state.pendingIds.has(input.requestId ?? input.id);
      row.up.disabled ||= index === 0;
      row.send.disabled = !state.ready || state.canExecute === false || promoted;
      row.remove.disabled = !state.ready;
      row.retry.disabled = !state.ready || action?.type === 'queue-promote' && state.canExecute === false;
      row.root.draggable = !state.durable && state.ready && !state.pendingIds.has(input.requestId ?? input.id);
      row.error.hidden = !action?.error;
      if (row.errorText.textContent !== (action?.error ?? '')) row.errorText.textContent = action?.error ?? '';
    }
    for (const action of this.actions.values()) {
      if (action.projectUri !== state.projectUri || action.phase !== 'waiting' || !state.ready || action.type === 'queue-promote' && state.canExecute === false) continue;
      const request: QueueAction = { projectUri: action.projectUri, sessionId: action.sessionId, id: action.id, requestId: action.requestId, type: action.type };
      if (state.pendingIds.has(action.input.requestId ?? action.id)) {
        if (this.options.pendingAction?.(request)) action.phase = 'accepted';
        continue;
      }
      action.phase = 'sending';
      this.options.action(request);
    }
  }
}
