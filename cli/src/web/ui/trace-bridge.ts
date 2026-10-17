import { t } from '../localization';
type Message = Record<string, any>;

// Only execution data crosses into an embedding host; account and draft state stay here.
export function traceSnapshot(state: Message): Message | undefined {
  const project = state.project;
  if (!project || !['conversation', 'workflow'].includes(project.projectType)) { return; }
  const base = { project: { id: project.id, name: project.name, projectType: project.projectType }, running: state.running };
  if (project.projectType === 'workflow') {
    return { ...base, runs: state.runs, selectedId: state.selectedId, run: state.run, occupiedRun: state.occupiedRun, history: state.history };
  }
  const agents = Object.fromEntries((state.sessions ?? []).filter((session: Message) => session.agent)
    .map((session: Message) => [session.agentOwnerId ?? session.id, session.agent]));
  return { ...base, durable: project.conversation?.durable?.enabled === true, agents, activeId: state.activeId, sessions: (state.sessions ?? []).map((session: Message) => ({
    id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt,
    agentOwnerId: session.agentOwnerId, agentConversationId: session.agentConversationId, forkSource: session.forkSource,
    messages: (session.messages ?? []).map((message: Message) => {
      const { id, role, content, items, error, status, durationMs, createdAt, model, runId, report, events, pendingInput, resolvedInputs, submittingInput } = message;
      return { id, role, content, items, error, status, durationMs, createdAt, model, runId, report, events, pendingInput, resolvedInputs, submittingInput };
    }),
  })) };
}

export class TraceBridge {
  private enabled = false;
  private snapshot?: Message;
  private status = 'connecting';
  private revision = -1;
  private activeId?: string;
  constructor(private readonly send: (message: Message) => void) {}
  get active(): boolean { return this.enabled; }
  enable(version: unknown): void {
    this.enabled = version === 1;
    if (this.enabled) { this.publish('status', { status: this.status }); if (this.snapshot) { this.publish('state', { snapshot: this.snapshot }); } }
  }
  receive(message: Message): void {
    if (message.type === 'state') {
      if (typeof message.stateRevision === 'number') {
        if (message.stateRevision <= this.revision) return;
        this.revision = message.stateRevision;
      }
      this.snapshot = traceSnapshot(message);
      if (this.snapshot) { if (this.activeId) this.snapshot.activeId = this.activeId; this.publish('state', { snapshot: this.snapshot }); }
    }
    if (message.type === 'connection') { this.status = message.status; this.publish('status', { status: this.status }); }
    if (message.type === 'trace-run') { this.publish('run', { run: message.run, runId: message.runId, error: message.error }); }
  }
  open(target: Message): boolean {
    if (!this.enabled) { return false; }
    this.publish('open', { target: { sessionId: target.sessionId, messageId: target.messageId, runId: target.runId } });
    return true;
  }
  select(sessionId: string): void {
    this.activeId = sessionId;
    if (this.snapshot) { this.snapshot.activeId = sessionId; this.publish('state', { snapshot: this.snapshot }); }
  }
  command(value: Message): Message | undefined {
    if (!this.enabled || !this.snapshot) return;
    if (this.snapshot.project.projectType === 'workflow') {
      if (value?.type === 'run' && typeof value.runId === 'string') return { type: 'workflow-trace', id: value.runId };
      if (value?.type === 'more') return { type: 'workflow-history', query: '', more: true };
      return;
    }
    if (!['agent', 'open-conversation', 'open-session'].includes(value?.type) || typeof value.requestId !== 'string') return;
    const session = this.snapshot.sessions.find((session: Message) => session.id === value.sessionId);
    const agent = session && this.snapshot.agents[session.agentOwnerId ?? session.id];
    if (this.status !== 'connected' || !session || !agent || agent.ownerId !== value.ownerId
      || (session.agentConversationId ?? agent.conversationId) !== value.conversationId) {
      this.result(value.requestId, t('Task state changed. Refresh the trace and try again.')); return;
    }
    if (value.type === 'open-session') {
      if (this.snapshot.sessions.some((entry: Message) => entry.id === value.targetSessionId)) return { type: 'trace-navigate', sessionId: value.targetSessionId };
    } else if (value.type === 'open-conversation') {
      if (agent.conversations.some((entry: Message) => entry.id === value.targetId)) return { type: 'agent-open', sessionId: session.id, conversationId: value.targetId, agentOwner: agent.ownerId };
    } else {
      const command = value.command;
      const targetId = command?.targetId ?? value.conversationId;
      if (this.validCommand(command, agent, targetId, value.conversationId)) return {
        type: 'agent-command', sessionId: session.id, agentOwner: agent.ownerId,
        command: { ...command, targetId, requestId: value.requestId },
      };
    }
    this.result(value.requestId, t('Invalid task action.'));
  }
  result(requestId: string, error?: string): void { this.publish('command', { requestId, error }); }
  private validCommand(command: Message | undefined, agent: Message, targetId: number, conversationId: number): boolean {
    if (!command || !agent.conversations.some((entry: Message) => entry.id === targetId)) return false;
    if (command.type === 'cancel' && command.scope === 'task') return agent.tasks.some((task: Message) => task.id === command.taskId && task.conversationId === targetId);
    if (targetId !== conversationId) return false;
    if (command.type === 'compact') return command.instructions === undefined || typeof command.instructions === 'string';
    if (command.type === 'reset') return command.handoff === undefined || typeof command.handoff === 'string';
    if (command.type === 'cancel') return ['foreground', 'all'].includes(command.scope);
    return command.type === 'plan' && Number.isSafeInteger(command.expectedVersion) && Array.isArray(command.items)
      && command.items.every((item: Message) => typeof item?.id === 'string' && typeof item.text === 'string' && ['pending', 'in_progress', 'completed'].includes(item.status));
  }
  private publish(kind: string, value: Message): void { if (this.enabled) { this.send({ type: 'workflow-trace', version: 1, kind, ...value }); } }
}
