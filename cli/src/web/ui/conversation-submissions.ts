import type { ConversationMessage, ConversationQueuedInput, ConversationSession } from '../workflow-types';

export interface ConversationSubmission {
  projectUri: string;
  sessionId: string;
  input: ConversationQueuedInput;
  queued: boolean;
  replacesId?: string;
  phase: 'pending' | 'sending' | 'accepted' | 'failed';
  error?: string;
}

export class ConversationSubmissions {
  private readonly entries = new Map<string, ConversationSubmission>();
  private readonly previews = new Map<string, ConversationMessage[]>();
  private readonly localMessages = new WeakSet<ConversationMessage>();
  private readonly localInputs = new WeakSet<ConversationQueuedInput>();

  constructor(saved: ConversationSubmission[] = [], interrupted = '') {
    for (const entry of saved) {
      if (typeof entry?.projectUri !== 'string' || typeof entry.sessionId !== 'string' || typeof entry.input?.id !== 'string'
        || typeof entry.input.text !== 'string' || !Array.isArray(entry.input.attachments) || !entry.input.params) continue;
      const restored = this.add({ ...entry, input: structuredClone(entry.input), phase: 'failed', error: entry.error || interrupted });
      this.fail(restored.input.id, restored.error!);
    }
  }

  add(entry: ConversationSubmission): ConversationSubmission {
    this.entries.set(entry.input.id, entry);
    this.localInputs.add(entry.input);
    const pair: ConversationMessage[] = [
      { id: `submission:${entry.input.id}:input`, role: 'user', content: entry.input.text, attachments: entry.input.attachments, createdAt: entry.input.createdAt },
      { id: `submission:${entry.input.id}:answer`, role: 'assistant', content: '', status: 'sending', createdAt: entry.input.createdAt,
        model: typeof entry.input.params.model === 'string' ? entry.input.params.model : undefined },
    ];
    for (const message of pair) this.localMessages.add(message);
    this.previews.set(entry.input.id, pair);
    return entry;
  }

  list(): ConversationSubmission[] { return [...this.entries.values()]; }
  get(id: string): ConversationSubmission | undefined { return this.entries.get(id); }
  retain(projectUri: string, sessionIds: Set<string>): void {
    for (const entry of this.entries.values()) {
      if (entry.projectUri === projectUri && !sessionIds.has(entry.sessionId)) {
        this.entries.delete(entry.input.id); this.previews.delete(entry.input.id);
      }
    }
  }
  busy(projectUri: string, sessionId: string): boolean {
    return this.list().some(entry => entry.projectUri === projectUri && entry.sessionId === sessionId && entry.phase !== 'failed');
  }
  local(message: ConversationMessage): boolean { return this.localMessages.has(message); }
  forMessage(message: ConversationMessage): ConversationSubmission | undefined {
    return this.list().find(entry => this.previews.get(entry.input.id)?.includes(message));
  }
  accept(id: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.phase !== 'failed') entry.phase = 'accepted';
  }
  fail(id: string, error: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.phase = 'failed'; entry.error = error;
    const answer = this.previews.get(id)![1]; answer.status = 'failed'; answer.error = error;
  }
  retry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.phase !== 'failed') return;
    entry.phase = 'pending'; delete entry.error;
    const answer = this.previews.get(id)![1]; answer.status = 'sending'; delete answer.error;
  }

  project(projectUri: string, session: ConversationSession, reconcile: boolean): ConversationSession {
    // Local previews survive unrelated snapshots until the backend confirms this exact input.
    const entries = this.list().filter(entry => entry.projectUri === projectUri && entry.sessionId === session.id);
    if (!entries.length && !session.messages.some(message => this.localMessages.has(message))
      && !session.queuedInputs?.some(input => this.localInputs.has(input))) return session;
    const messages = session.messages.filter(message => !this.localMessages.has(message));
    let queuedInputs = (session.queuedInputs ?? []).filter(input => !this.localInputs.has(input));
    for (const entry of entries) {
      const id = entry.input.id;
      const confirmed = messages.some(message => message.id === id || message.sessionRequestId === id || message.input?.requestId === id)
        || queuedInputs.some(input => input.id === id || input.requestId === id);
      if (reconcile && confirmed) {
        this.entries.delete(id); this.previews.delete(id); continue;
      }
      if (entry.queued && entry.phase !== 'failed') {
        queuedInputs = queuedInputs.filter(input => input.id !== entry.replacesId);
        queuedInputs.push(entry.input);
      } else {
        const position = messages.findIndex(message => (message.createdAt ?? 0) > entry.input.createdAt);
        messages.splice(position < 0 ? messages.length : position, 0, ...this.previews.get(id)!);
      }
    }
    const first = messages.find(message => message.role === 'user');
    return { ...session, messages, queuedInputs,
      ...(!session.messages.length && first && !session.titleLocked ? { title: (first.content || first.attachments?.[0]?.name || session.title).slice(0, 80) } : {}) };
  }
}
