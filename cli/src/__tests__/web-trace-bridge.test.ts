import { describe, expect, it } from 'vitest';
import { TraceBridge, traceSnapshot } from '../web/ui/trace-bridge';

const project = { id: 'project', name: 'Example', projectType: 'conversation', privateField: 'private' };
const state = { type: 'state', project, activeId: 'session', running: true, account: { token: 'secret' },
  sessions: [{ id: 'session', title: 'Title', draft: 'draft', parameterValues: { key: 'draft-key' }, queuedInputs: ['queued'],
    messages: [{ id: 'answer', role: 'assistant', content: 'Answer', status: 'running', events: [{ type: 'node_started' }], items: [{ content: 'live' }] }] }] };
describe('embedded execution trace bridge', () => {
  it('keeps account, parameters, drafts and unrelated project metadata outside the host snapshot', () => {
    const snapshot = traceSnapshot(state)!;
    expect(snapshot.project).toEqual({ id: 'project', name: 'Example', projectType: 'conversation' });
    expect(snapshot.sessions[0].messages[0].items).toEqual([{ content: 'live' }]);
    for (const value of ['secret', 'draft', 'draft-key', 'queued', 'private']) { expect(JSON.stringify(snapshot)).not.toContain(value); }
    expect(traceSnapshot({ project: { projectType: 'kanban' } })).toBeUndefined();
  });
  it('replays the initial state and connection status when the parent handshake follows SSE startup', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message));
    bridge.receive(state); bridge.receive({ type: 'connection', status: 'connected' }); expect(sent).toEqual([]);
    bridge.enable(1); expect(sent.map(message => message.kind)).toEqual(['status', 'state']);
    expect(sent[0].status).toBe('connected'); expect(sent[1].snapshot.sessions[0].messages[0].content).toBe('Answer');
    expect(bridge.open({ sessionId: 'session', messageId: 'answer', runId: 'run', extra: 'ignored' })).toBe(true);
    expect(sent.at(-1).target).toEqual({ sessionId: 'session', messageId: 'answer', runId: 'run' });
    bridge.enable(2); expect(bridge.open({})).toBe(false);
  });
  it('only forwards read operations for Workflow runs and propagates lookup failures', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message));
    bridge.enable(1); bridge.receive({ type: 'state', project: { ...project, projectType: 'workflow' }, runs: [], run: { id: 'run', events: [] }, drafts: 'private' });
    expect(bridge.command({ type: 'run', runId: 'history' })).toEqual({ type: 'workflow-trace', id: 'history' });
    expect(bridge.command({ type: 'more' })).toEqual({ type: 'workflow-history', query: '', more: true });
    expect(bridge.command({ type: 'workflow-run' })).toBeUndefined();
    bridge.receive({ type: 'trace-run', runId: 'missing', error: 'Run no longer exists.' });
    expect(sent.at(-1)).toMatchObject({ kind: 'run', runId: 'missing', error: 'Run no longer exists.' });
  });

  const durable = () => {
    const agent = { ownerId: 'owner', conversationId: 1, conversations: [{ id: 1 }, { id: 2 }, { id: 3, forkEntryId: 7 }],
      tasks: [{ id: 10, conversationId: 2 }], contexts: [], plan: { version: 2, items: [] }, records: [], history: [], usage: [] };
    return { ...state, project: { ...project, conversation: { durable: { enabled: true } } }, sessions: [
      { ...state.sessions[0], agent, messages: [{ ...state.sessions[0].messages[0], submittingInput: { requestId: 'approval' } }] },
      { id: 'child', agentOwnerId: 'session', agentConversationId: 2, agent, forkSource: { sessionId: 'session', entryId: 7 }, messages: [] },
    ] };
  };
  it('transfers each owner once with conversation identity, fork source and plan submission boundaries', () => {
    const snapshot = traceSnapshot(durable())!;
    expect(snapshot.durable).toBe(true);
    expect(Object.keys(snapshot.agents)).toEqual(['session']);
    expect(snapshot.sessions[1]).toMatchObject({ agentOwnerId: 'session', agentConversationId: 2, forkSource: { sessionId: 'session', entryId: 7 } });
    expect(snapshot.sessions[1].agent).toBeUndefined();
    expect(snapshot.sessions[0].messages[0].submittingInput).toEqual({ requestId: 'approval' });
    expect(JSON.stringify(snapshot)).not.toMatch(/draft-key|secret|privateField/);
  });
  it('routes every migrated action to its explicit owner and internal conversation', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message)); bridge.enable(1);
    bridge.receive(durable()); bridge.receive({ type: 'connection', status: 'connected' });
    const context = { sessionId: 'child', ownerId: 'owner', conversationId: 2, requestId: 'operation' };
    for (const command of [{ type: 'compact' }, { type: 'reset', handoff: 'Keep notes\nNext step' },
      { type: 'cancel', scope: 'foreground' }, { type: 'cancel', scope: 'all' }, { type: 'cancel', scope: 'task', taskId: 10 },
      { type: 'plan', expectedVersion: 2, items: [{ id: 'step', text: 'Read', status: 'completed' }] }]) {
      expect(bridge.command({ ...context, type: 'agent', command })).toEqual({ type: 'agent-command', sessionId: 'child', agentOwner: 'owner', command: { ...command, targetId: 2, requestId: 'operation' } });
    }
    expect(bridge.command({ ...context, type: 'open-conversation', targetId: 3 })).toEqual({ type: 'agent-open', sessionId: 'child', agentOwner: 'owner', conversationId: 3 });
    expect(bridge.command({ ...context, type: 'open-session', targetSessionId: 'session' })).toEqual({ type: 'trace-navigate', sessionId: 'session' });
    bridge.result('operation', 'CAS conflict'); expect(sent.at(-1)).toMatchObject({ kind: 'command', requestId: 'operation', error: 'CAS conflict' });
  });
  it('rejects disconnected, stale and foreign actions without forwarding a write', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message)); bridge.enable(1);
    bridge.receive(durable()); bridge.receive({ type: 'connection', status: 'connected' });
    const context = { type: 'agent', sessionId: 'child', ownerId: 'owner', conversationId: 2, requestId: 'operation', command: { type: 'compact' } };
    for (const invalid of [{ ownerId: 'previous-owner' }, { sessionId: 'missing' }, { conversationId: 1 },
      { command: { type: 'delete' } }, { command: { type: 'fork', entryId: 7 } }, { command: { type: 'compact', targetId: 1 } },
      { command: { type: 'plan', expectedVersion: 'old', items: [] } }, { command: { type: 'cancel', scope: 'task', taskId: 10, targetId: 1 } },
      { type: 'open-conversation', targetId: 77 }, { type: 'open-session', targetSessionId: 'missing' }]) {
      expect(bridge.command({ ...context, ...invalid })).toBeUndefined(); expect(sent.at(-1).kind).toBe('command'); expect(sent.at(-1).error).toBeTruthy();
    }
    bridge.receive({ type: 'connection', status: 'offline' }); expect(bridge.command(context)).toBeUndefined();
  });
  it('ignores out-of-order frames and marks the actual local conversation during navigation', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message)); bridge.enable(1);
    bridge.receive({ ...durable(), stateRevision: 2 }); bridge.select('child');
    bridge.receive({ ...durable(), stateRevision: 1 }); expect(sent.at(-1).snapshot.activeId).toBe('child');
    bridge.receive({ ...durable(), stateRevision: 3 }); expect(sent.at(-1).snapshot.activeId).toBe('child');
    bridge.select('local-unsaved'); expect(sent.at(-1).snapshot.activeId).toBe('local-unsaved');
  });
});
