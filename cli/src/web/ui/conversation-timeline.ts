import type { AgentSessionTurn } from 'steamharness/agent';
import { outputText, type ConversationMessage, type ConversationQueuedInput, type ConversationSession, type OutputItem } from '../workflow-types';

export interface ConversationTimelineRow {
  id: string;
  message: ConversationMessage;
  previous?: boolean;
  progress?: ConversationMessage;
}
interface Boundary {
  message: ConversationMessage;
  requestId: string;
  turn?: AgentSessionTurn;
}
interface OutputCut {
  items: Set<string>;
  text: string;
}

/** Split presentation only: a steering input still belongs to its original Agent turn. */
export class ConversationTimeline {
  private scope = '';
  private readonly cuts = new Map<string, OutputCut>();

  project(scope: string, session: ConversationSession, promoted: ConversationQueuedInput[] = []): ConversationTimelineRow[] {
    if (this.scope !== scope) { this.scope = scope; this.cuts.clear(); }
    const turns = session.agent?.turns.filter(turn => turn.conversationId === (session.agentConversationId ?? session.agent?.conversationId)) ?? [];
    const boundaries = new Map<string, Boundary>();
    for (const message of session.messages) {
      if (message.role !== 'user' || message.status !== 'steer') continue;
      const requestId = message.sessionRequestId ?? message.input?.requestId ?? message.id?.replace(/^steer:/, '');
      if (requestId) boundaries.set(requestId, { requestId, message, turn: turns.find(turn => turn.requestId === requestId) });
    }
    const queued = session.queuedInputs ?? [];
    const pending = [...promoted, ...turns.filter(turn => turn.mode === 'steer' && turn.status === 'queued' && !turn.hiddenInput)
      .map(turn => queued.find(input => (input.requestId ?? input.id) === turn.requestId)
        ?? { id: turn.requestId, text: turn.prompt, params: {}, attachments: [], createdAt: turn.startedAt ?? session.updatedAt ?? 0 })];
    for (const input of pending) {
      const requestId = input.requestId ?? input.id;
      if (boundaries.has(requestId) || session.messages.some(message => message.role === 'user'
        && (message.sessionRequestId === requestId || message.input?.requestId === requestId))) continue;
      boundaries.set(requestId, { requestId, turn: turns.find(turn => turn.requestId === requestId), message: {
        id: `steer:${requestId}`, role: 'user', status: 'steer', content: input.text, createdAt: input.createdAt,
        sessionRequestId: requestId, attachments: input.attachments, references: input.references,
      } });
    }
    for (const requestId of this.cuts.keys()) if (!boundaries.has(requestId)) this.cuts.delete(requestId);
    const answers = session.messages.filter(message => message.role === 'assistant');
    const byAnswer = new Map<ConversationMessage, Boundary[]>();
    const unassigned: Boundary[] = [];
    for (const boundary of boundaries.values()) {
      const position = boundary.turn?.entryId;
      const source = position === undefined ? undefined : turns.filter(turn => turn.mode !== 'steer' && turn.entryId !== undefined
        && turn.entryId < position && (turn.answerId === undefined || turn.answerId > position)).sort((a, b) => b.entryId! - a.entryId!)[0];
      const answer = (source && answers.find(message => message.sessionRequestId === source.requestId
        || source.requestId === (message.agentAnchorRequestId ?? message.runId)
        || source.requestId.startsWith(`${message.agentAnchorRequestId ?? message.runId}:`)))
        || answers.filter(message => !boundary.message.createdAt || !message.createdAt || message.createdAt <= boundary.message.createdAt).at(-1);
      if (!answer) { unassigned.push(boundary); continue; }
      const list = byAnswer.get(answer) ?? [];
      list.push(boundary); byAnswer.set(answer, list);
    }
    const rows: ConversationTimelineRow[] = [];
    for (const [index, message] of session.messages.entries()) {
      if (message.role === 'user' && message.status === 'steer') continue;
      const id = message.id ?? `${index}:${message.role}`;
      const list = byAnswer.get(message);
      if (!list?.length) { rows.push({ id, message }); continue; }
      list.sort((a, b) => a.turn?.entryId !== undefined && b.turn?.entryId !== undefined
        ? a.turn.entryId - b.turn.entryId : (a.message.createdAt ?? 0) - (b.message.createdAt ?? 0));
      const cuts = list.map(boundary => {
        let cut = this.cuts.get(boundary.requestId);
        if (!cut) {
          cut = { items: new Set((message.items ?? []).map((item, i) => item.id ?? String(i))), text: message.content };
          this.cuts.set(boundary.requestId, cut);
        }
        return cut;
      });
      const segments: OutputItem[][] = Array.from({ length: list.length + 1 }, () => []);
      for (const [i, item] of (message.items ?? []).entries()) {
        // Durable output IDs contain the ledger position, so reopening history
        // reconstructs the same boundaries even without a live UI checkpoint.
        const entryId = item.id?.startsWith('agent-session-') ? Number(item.id.match(/-(\d+)-(?:\d+|retry|sources|search-.*)$/)?.[1]) : NaN;
        const startedAt = item.metadata?.startedAt;
        let segment = 0;
        for (const [j, boundary] of list.entries()) {
          const after = Number.isFinite(entryId) && boundary.turn?.entryId !== undefined ? entryId > boundary.turn.entryId
            : typeof startedAt === 'number' && boundary.message.createdAt !== undefined ? startedAt >= boundary.message.createdAt
              : !cuts[j].items.has(item.id ?? String(i));
          if (after) segment = j + 1;
        }
        segments[segment].push(item);
      }
      for (let i = 0; i <= list.length; i++) {
        if (i) rows.push({ id: `steer:${list[i - 1].requestId}`, message: list[i - 1].message });
        const previous = i < list.length;
        let content = outputText(segments[i]);
        if (!message.items?.length) {
          const start = i ? cuts[i - 1].text : '';
          const end = previous ? cuts[i].text : message.content;
          content = end.startsWith(start) ? end.slice(start.length) : end;
        }
        rows.push({ id: i ? `${id}:after:${list[i - 1].requestId}` : id, previous, progress: previous ? undefined : message, message: {
          ...message, items: segments[i], content,
          ...(previous ? { status: 'interrupted', error: undefined, pendingInput: undefined, submittingInput: undefined,
            cancelRequested: false, tokenUsage: undefined, timers: undefined, resolvedInputs: undefined } : {}),
        } });
      }
    }
    for (const boundary of unassigned) rows.push({ id: `steer:${boundary.requestId}`, message: boundary.message });
    return rows;
  }
}
