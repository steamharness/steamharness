import { createHash } from 'node:crypto';
import { emptyRuntimeRecord, type RuntimeHistoryRecord, type RuntimePersistence } from 'steamharness/runtime-storage';
import { userSettingsJsonReplacer } from './user-settings';
import type { ConversationSession } from './workflow-types';
import type { ConversationOwnership } from './conversation-ownership';

interface History { sessions?: ConversationSession[]; activeId?: string; selectionVersion?: number }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, userSettingsJsonReplacer)).digest('hex');

/** Memory projection of persisted history. Every changed session is fenced and versioned. */
export class ConversationHistory {
  private records = new Map<string, RuntimeHistoryRecord>();
  private versions = new Map<string, string>();
  private stamp = '';
  private pending: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  constructor(private readonly persistence: () => RuntimePersistence | undefined, private readonly ownership: ConversationOwnership) {}
  async reset(): Promise<void> {
    this.epoch++;
    await this.pending;
    this.records.clear(); this.versions.clear(); this.stamp = '';
  }
  private backend(): RuntimePersistence { const backend = this.persistence(); if (!backend) throw new Error('Conversation history is not ready.'); return backend; }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation); this.pending = next.catch(() => undefined); return next;
  }
  private async load(): Promise<History> {
    const records = await this.backend().list('conversation');
    this.records = new Map(records.map(record => [record.key, record]));
    const sessions = records.map(decodeSession);
    for (const session of sessions) this.ownership.rememberScope(session.id, session.agentOwnerId ?? session.id);
    return { sessions };
  }
  read(): Promise<History> { return this.enqueue(async () => {
    const history = await this.load();
    const selection = (await this.backend().list('workflow')).find(record => record.key === 'conversation-selection');
    if (typeof selection?.state.activeId === 'string') { history.activeId = selection.state.activeId; history.selectionVersion = 1; }
    for (const session of history.sessions ?? []) this.versions.set(session.id, digest(session)); return history;
  }); }
  refresh(acquired: Set<string> = new Set()): Promise<History | undefined> {
    return this.enqueue(async () => {
      const history = await this.load(), stamp = digest([...this.records.values()].map(record => [record.key, record.revision]));
      if (stamp === this.stamp && !acquired.size) return;
      this.stamp = stamp;
      for (const session of history.sessions ?? []) if (!this.ownership.owns(session.id) || acquired.has(this.ownership.scope(session.id))) this.versions.set(session.id, digest(session));
      return history;
    });
  }
  save(sessions: ConversationSession[], _activeId: string): Promise<void> {
    const epoch = this.epoch;
    const incoming = new Set(sessions.map(session => session.id));
    const changes = sessions.filter(session => this.ownership.owns(session.id) || !this.versions.has(session.id))
      .map(session => JSON.parse(JSON.stringify(session, userSettingsJsonReplacer)) as ConversationSession);
    return this.enqueue(async () => {
      if (epoch !== this.epoch) return;
      for (const session of changes) {
        if (epoch !== this.epoch) return;
        const version = digest(session); if (this.versions.get(session.id) === version) continue;
        this.ownership.rememberScope(session.id, session.agentOwnerId ?? session.id);
        const release = await this.ownership.hold(session.id);
        try {
          const record = encodeSession(session, this.records.get(session.id)?.revision ?? 0);
          const saved = await this.ownership.lease(session.id).write(record);
          this.records.set(session.id, saved); this.versions.set(session.id, version);
        } finally { release(); }
      }
      if (epoch !== this.epoch) return;
      for (const [id, record] of this.records) if (!incoming.has(id) && this.ownership.owns(id)) {
        await this.ownership.lease(id).delete(record); this.records.delete(id); this.versions.delete(id);
      }
      if (incoming.has(_activeId) && this.ownership.owns(_activeId)) {
        let lease;
        try { lease = await this.backend().acquire('conversation-selection'); }
        catch (error) { if ((error as { code?: string }).code !== 'RUNTIME_STORAGE_OWNER_CONFLICT') throw error; }
        if (lease) try {
          const previous = (await this.backend().list('workflow')).find(record => record.key === 'conversation-selection');
          if (previous?.state.activeId !== _activeId) await lease.write({ ...emptyRuntimeRecord('workflow', 'conversation-selection'), revision: previous?.revision ?? 0, state: { activeId: _activeId } });
        } finally { await lease.close(); }
      }
    });
  }
}
export function encodeSession(session: ConversationSession, revision: number): RuntimeHistoryRecord {
  const { messages, queuedInputs, agentInputs, agentCommands, ...state } = session;
  const record = emptyRuntimeRecord('conversation', session.id, session.agentOwnerId ?? session.id);
  record.revision = revision; record.state = state;
  record.messages = messages.map((message, index) => { const { events, ...value } = message; return { id: message.id ?? `message:${index}`, value }; });
  record.events = messages.flatMap((message, messageIndex) => (message.events ?? []).map((event, index) => ({ id: `${messageIndex}:${index}`, value: { messageIndex, event } })));
  record.queue = [ ...(queuedInputs ?? []).map(value => ({ id: `queued:${value.id}`, value: { type: 'queued', input: value } })),
    ...Object.entries(agentInputs ?? {}).map(([id, value]) => ({ id: `input:${id}`, value: { type: 'input', key: id, input: value } })),
    ...(agentCommands ?? []).map((value, index) => ({ id: `command:${index}`, value: { type: 'command', command: value } })) ];
  return record;
}
export function decodeSession(record: RuntimeHistoryRecord): ConversationSession {
  const session = { ...record.state, messages: record.messages.map(item => ({ ...item.value })), queuedInputs: [] } as unknown as ConversationSession;
  for (const { value } of record.events) { const message = session.messages[Number(value.messageIndex)]; if (message) (message.events ??= []).push(value.event as Record<string, unknown>); }
  for (const { value } of record.queue) {
    if (value.type === 'queued') session.queuedInputs!.push(value.input as never);
    else if (value.type === 'input') (session.agentInputs ??= {})[String(value.key)] = value.input as never;
    else if (value.type === 'command') (session.agentCommands ??= []).push(value.command as never);
  }
  return session;
}
