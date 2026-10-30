import type { ConversationMessage, OutputItem, ResolvedInput } from '../src/workflow-types';
import type { TracePanelState } from '../src/workflow-trace-types';
import type { TraceAgentSnapshot, TraceTask } from '../src/workflow-agent-types';

export interface AgentPlanDocument {
  text: string;
  state: 'awaiting_approval' | 'submitting' | 'approved' | 'changes_requested' | 'ready';
}

export function agentSession(state: TracePanelState) {
  const snapshot = state.snapshot;
  const session = snapshot?.sessions?.find(session => session.id === (state.selection.sessionId ?? snapshot.activeId));
  const original = session && snapshot?.agents?.[session.agentOwnerId ?? session.id];
  const context = original?.contexts.find(context => context.conversationId === (session?.agentConversationId ?? original.conversationId));
  const agent: TraceAgentSnapshot | undefined = original && context ? { ...original, ...context }
    : session?.agentConversationId === undefined || session.agentConversationId === original?.conversationId ? original : undefined;
  const opened = snapshot?.sessions?.find(session => session.id === snapshot.activeId);
  const current = opened && session && (opened.agentOwnerId ?? opened.id) === (session.agentOwnerId ?? session.id)
    ? opened.agentConversationId ?? original?.conversationId : undefined;
  return { session, agent, current, connected: state.status === 'connected' && !state.pending };
}

export function ownedActivity(snapshot: TraceAgentSnapshot): boolean {
  const scope = new Set([snapshot.conversationId]);
  for (let size = 0; size !== scope.size;) {
    size = scope.size;
    for (const conversation of snapshot.conversations) {
      if (conversation.parentId !== undefined && conversation.forkEntryId === undefined && scope.has(conversation.parentId)) scope.add(conversation.id);
    }
  }
  return snapshot.foreground || snapshot.tasks.some(task => scope.has(task.conversationId))
    || snapshot.turns.some(turn => scope.has(turn.conversationId) && turn.status === 'queued');
}

export const terminalTask = (task: TraceTask): boolean => ['completed', 'aborted', 'failed', 'faulted', 'orphaned'].includes(task.status);
export const retryableAgentTask = (task: TraceTask): boolean => !!task.agent && ['aborted', 'failed', 'faulted', 'orphaned'].includes(task.status);
export const taskConversation = (task: TraceTask): number => task.agent?.childConversationId ?? task.childConversationId ?? task.conversationId;

export function orderedTasks(tasks: TraceTask[], all: TraceTask[]): { task: TraceTask; depth: number }[] {
  const byId = new Map(all.map(task => [task.id, task])), visible = new Set(tasks.map(task => task.id));
  const children = new Map<number, TraceTask[]>();
  for (const task of tasks) {
    if (task.parentId === undefined || !visible.has(task.parentId)) continue;
    const siblings = children.get(task.parentId) ?? []; siblings.push(task); children.set(task.parentId, siblings);
  }
  const ordered: TraceTask[] = [], visited = new Set<number>();
  const visit = (task: TraceTask): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id); ordered.push(task); for (const child of children.get(task.id) ?? []) visit(child);
  };
  for (const task of tasks) if (task.parentId === undefined || !visible.has(task.parentId)) visit(task);
  for (const task of tasks) visit(task);
  return ordered.map(task => {
    let parent = task.parentId, depth = 0; const seen = new Set([task.id]);
    while (parent !== undefined && !seen.has(parent) && depth < 8) { seen.add(parent); depth++; parent = byId.get(parent)?.parentId; }
    return { task, depth };
  });
}

function planText(items: OutputItem[]): string {
  let lastTool = -1;
  for (const [index, item] of items.entries()) if (item.metadata?.partType === 'tool') lastTool = index;
  return items.slice(lastTool + 1).filter(item => typeof item.content === 'string' && !item.collapsed && !item.display
    && [undefined, 'text', 'markdown'].includes(item.contentType)
    && (item.metadata?.plan === true || item.metadata?.kind === undefined || item.metadata?.kind === 'agent-answer'
      || item.metadata?.kind === 'agent-part' && item.metadata.partType === 'text'))
    .map(item => item.content).join('\n\n').trim();
}

/** Read the plan at its approval boundary, excluding earlier revisions and later Build output. */
export function latestAgentPlan(messages: readonly ConversationMessage[]): AgentPlanDocument | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const items = message.items ?? [];
    const answers = [...new Map([...(message.resolvedInputs ?? []), ...(message.submittingInput ? [message.submittingInput] : [])]
      .map(answer => [answer.requestId, answer])).values()];
    const inputs: { request: ResolvedInput['request']; preceding?: string[]; state: AgentPlanDocument['state'] }[] = answers.map(answer => ({
      request: answer.request, preceding: answer.precedingOutputItemIds,
      state: message.submittingInput?.requestId === answer.requestId ? 'submitting'
        : answer.values.decision === 'approve' ? 'approved' : 'changes_requested',
    }));
    if (message.pendingInput && !answers.some(answer => answer.requestId === message.pendingInput!.requestId)) inputs.push({
      request: message.pendingInput, preceding: items.map((item, index) => item.id ?? String(index)), state: 'awaiting_approval',
    });
    const previous = new Set<string>();
    let latest: AgentPlanDocument | undefined;
    for (const input of inputs) {
      if (!input.preceding) continue;
      const preceding = new Set(input.preceding);
      if (input.request?.metadata?.type === 'agent-plan-approval') {
        const text = planText(items.filter((item, index) => preceding.has(item.id ?? String(index)) && !previous.has(item.id ?? String(index))));
        if (text) latest = { text, state: input.state };
      }
      for (const id of preceding) previous.add(id);
    }
    if (latest) return latest;
    const explicit = [...items].reverse().find(item => item.metadata?.plan === true && typeof item.content === 'string' && item.content.trim());
    if (explicit) return { text: String(explicit.content), state: 'ready' };
  }
  return undefined;
}
