import type { EntryConversationAction, EntryConversationSnapshot } from 'steamharness';
import { sessionRunning, type ConversationSession, type ConversationQueuedInput } from './workflow-types';
import type { ConversationController } from './conversation-controller';
import { isDeepStrictEqual } from 'node:util';

export interface AggregateEntryCall {
  readOnly?: boolean;
  entryId: string;
  action: EntryConversationAction | 'workflow' | 'workflow-control';
  input: Record<string, unknown>;
  sourceEntryId: string;
  sourceConversationId?: string;
  sourceRunId?: string;
  projectId: string;
  actor: import("@steamharness/project-access").AccessActor;
  abortSignal?: AbortSignal;
}
export function conversationProjection(entryId: string, session: ConversationSession, ownerId: string, revision: number): EntryConversationSnapshot {
  return {
    entryId, conversationId: session.id, title: session.title, ownerId, revision,
    running: !session.recoveryPaused && sessionRunning(session), queuePaused: !!session.queuePaused,
    messages: session.messages.map(message => ({
      id: message.id ?? '', role: message.role, content: message.content, status: session.recoveryPaused && message.recovering ? "paused" : message.status,
      requestId: message.sessionRequestId ?? message.input?.requestId ?? (message.role === 'assistant' ? message.id : undefined), runId: message.runId, error: message.error,
      items: message.items, pendingInput: message.pendingInput && {
        requestId: message.pendingInput.requestId, title: message.pendingInput.title, description: message.pendingInput.description,
        metadata: message.pendingInput.metadata && { type: message.pendingInput.metadata.type, toolName: message.pendingInput.metadata.toolName, toolArguments: message.pendingInput.metadata.toolArguments },
        params: message.pendingInput.params, defaultValues: message.pendingInput.defaultValues,
      },
    })),
    queue: (session.queuedInputs ?? []).map((input, index) => ({ id: input.requestId ?? input.id, text: input.text, position: index + 1 })),
  };
}
function required(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid conversation ${name}.`);
  return value;
}

/** Adapts the existing controller; never opens a second runtime or changes the selected tab. */
export class EntryConversations {
  private readonly admissions = new Map<string, { signature: Record<string, unknown>; result: Promise<unknown> }>();
  constructor(private readonly controller: ConversationController, private readonly snapshot: (session: ConversationSession) => EntryConversationSnapshot,
    private readonly prepare?: (session: ConversationSession, text: string, params: Record<string, string | string[]>) => Promise<Pick<ConversationQueuedInput, "params" | "states" | "configurationSelection">>) {}
  async invoke(action: EntryConversationAction, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (action === 'list') return this.controller.sessions.map(session => ({ conversationId: session.id, title: session.title }));
    const id = required(input.conversationId, 'id');
    let session = this.controller.sessions.find(session => session.id === id);
    if (!session && action === 'submit') {
      await this.controller.navigate(id, [{ id, create: true, draft: { text: '', attachments: [] } }], false);
      session = this.controller.sessions.find(session => session.id === id);
    }
    signal?.throwIfAborted();
    if (!session) throw new Error('Conversation no longer exists.');
    if (action === 'snapshot') return this.snapshot(session);
    const requestId = required(input.requestId, 'requestId');
    const key = JSON.stringify([id, action, requestId]);
    const signature = structuredClone(input);
    const pending = this.admissions.get(key);
    if (pending) {
      if (!isDeepStrictEqual(pending.signature, signature)) throw new Error('A requestId cannot be reused with different content.');
      return pending.result;
    }
    const target = session;
    const operation = (async () => {
      if (action === 'submit') {
        const text = required(input.text, 'text', 200_000);
        const params = input.params ?? {};
        if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.values(params).every(value => typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string'))) throw new Error('Invalid conversation parameters.');
        const previous = target.queuedInputs?.find(item => (item.requestId ?? item.id) === requestId)
          ?? target.messages.find(message => message.role === 'user' && (message.id === requestId || message.sessionRequestId === requestId || message.input?.requestId === requestId));
        if (previous && (('text' in previous ? previous.text : previous.content) !== text
          || !isDeepStrictEqual('text' in previous ? previous.entrySubmission?.params ?? previous.params : previous.input?.entrySubmission?.params ?? previous.input?.params ?? {}, params))) throw new Error('A requestId cannot be reused with different content.');
        if (previous) {
          // The original persisted input is the durable receipt, even if model defaults have changed.
          await this.controller.persist();
        } else {
          const submitted = params as Record<string, string | string[]>;
          const prepared = this.prepare ? await this.prepare(target, text, submitted) : { params: submitted };
          signal?.throwIfAborted();
          await this.controller.send({ text, ...prepared, entrySubmission: { params: structuredClone(submitted) }, attachments: [] }, target, true, requestId);
        }
        return { conversationId: id, requestId, messageId: requestId,
          status: target.queuedInputs?.some(item => (item.requestId ?? item.id) === requestId) ? 'queued' : 'accepted' };
      }
      if (action === 'cancel') { await this.controller.stop(target); return { stopped: true }; }
      if (action === 'resumeQueue') { await this.controller.runQueued(target); return { resumed: true }; }
      if (action === 'resolveInput') {
        const messageId = required(input.messageId, 'messageId');
        if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw new Error('Invalid input values.');
        if (!target.messages.some(message => message.id === messageId && message.pendingInput?.requestId === requestId)) throw new Error('The confirmation request has changed.');
        await this.controller.resume(messageId, requestId, input.values as Record<string, unknown>, target);
        return { resolved: true };
      }
      throw new Error('Unsupported conversation operation.');
    })();
    this.admissions.set(key, { signature, result: operation });
    // Persisted controller IDs provide durable submit deduplication after eviction/restart.
    if (this.admissions.size > 512) this.admissions.delete(this.admissions.keys().next().value!);
    try { return await operation; } catch (error) { this.admissions.delete(key); throw error; }
  }
}
