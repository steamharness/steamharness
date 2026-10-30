import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceBridge, traceSnapshot } from '../web/ui/trace-bridge';
import { isExecutionError } from '../web/ui/execution-error';

const project = { id: 'project', name: 'Example', projectType: 'conversation', privateField: 'private' };
const state = { type: 'state', project, activeId: 'session', running: true, account: { token: 'secret' },
  sessions: [{ id: 'session', title: 'Title', draft: 'draft', parameterValues: { key: 'draft-key' }, queuedInputs: ['queued'],
    messages: [{ id: 'answer', role: 'assistant', content: 'Answer', status: 'running', events: [{ type: 'node_started' }], items: [{ content: 'live' }] }] }] };
describe('embedded execution trace bridge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('classifies errors by origin instead of the current running flag', () => {
    for (const running of [true, false]) {
      expect(isExecutionError({ type: 'error', running, errorSource: 'execution', sessionId: 'session' })).toBe(true);
      expect(isExecutionError({ type: 'error', running, messageId: 'answer' })).toBe(true);
      for (const requestType of ['send', 'retry', 'resume', 'resolve', 'attach', 'resource', 'open-path', 'stop']) {
        expect(isExecutionError({ type: 'error', running, requestType, messageId: 'answer' })).toBe(false);
      }
      expect(isExecutionError({ type: 'error', running, errorSource: 'request', messageId: 'answer' })).toBe(false);
      expect(isExecutionError({ type: 'error', running })).toBe(false);
      expect(isExecutionError({ type: 'error', running, errorSource: 'execution', connectionError: true })).toBe(false);
    }
  });
  it('coalesces execution notifications and replays them after recovery, success and a late Trace handshake', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message));
    bridge.receive({ ...state, project: { ...project, uri: 'file:///project' } });
    const failure = { type: 'error', sessionId: 'session', messageId: 'answer', message: 'First attempt failed' };
    bridge.receive(failure); bridge.receive(failure);
    bridge.receive({ ...failure, requestType: 'attach', message: 'Operation during run' });
    bridge.receive({ ...failure, projectUri: 'file:///other', message: 'Other project' });
    bridge.receive({ ...failure, sessionId: 'missing', message: 'Other session' });
    bridge.enable(1);
    expect(sent.at(-1).snapshot.errors).toHaveLength(1);
    bridge.receive({ ...failure, message: 'Second attempt failed' });
    vi.advanceTimersByTime(100);
    expect(sent.at(-1).snapshot.errors).toHaveLength(2);
    bridge.receive({ ...state, running: false, sessions: [{ ...state.sessions[0], messages: [{ ...state.sessions[0].messages[0], status: 'success' }] }] });
    vi.advanceTimersByTime(100);
    expect(sent.at(-1).snapshot.errors.map((error: any) => error.message)).toEqual(['First attempt failed', 'Second attempt failed']);
    expect(sent.at(-1).snapshot.sessions[0].messages[0].status).toBe('success');
    bridge.enable(2); bridge.enable(1); expect(sent.at(-1).snapshot.errors).toHaveLength(2);
    bridge.receive({ ...state, project: { ...project, entryId: 'different' } }); vi.advanceTimersByTime(100);
    expect(sent.at(-1).snapshot.errors).toBeUndefined(); bridge.enable(2);
  });
  it('bounds supplemental diagnostics and keeps workflow errors scoped to their run', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message));
    bridge.receive({ type: 'state', project: { ...project, projectType: 'workflow' }, run: { id: 'run' } });
    for (let i = 0; i < 205; i++) bridge.receive({ type: 'error', errorSource: 'execution', runId: 'run', errorId: `attempt-${i}`, message: `Failure ${i}` });
    bridge.receive({ type: 'error', errorSource: 'execution', message: 'Unscoped' });
    bridge.enable(1);
    expect(sent.at(-1).snapshot.errors).toHaveLength(200);
    expect(sent.at(-1).snapshot.errors[0].message).toBe('Failure 5'); bridge.enable(2);
  });
  it('does not project standalone states, coalesces host frames and replays only the newest state after enabling', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message)), projected = vi.fn(() => []);
    bridge.receive({ ...state, get sessions() { return projected(); } }); expect(projected).not.toHaveBeenCalled();
    bridge.receive(state); bridge.enable(1);
    for (let revision = 1; revision <= 100; revision++) bridge.receive({ ...state, stateRevision: revision,
      sessions: [{ ...state.sessions[0], title: `Revision ${revision}` }] });
    expect(sent.filter(message => message.kind === 'state')).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(sent.filter(message => message.kind === 'state')).toHaveLength(2);
    expect(sent.at(-1).snapshot.sessions[0].title).toBe('Revision 100');
    vi.advanceTimersByTime(1000); expect(sent.filter(message => message.kind === 'state')).toHaveLength(2);
    bridge.receive({ ...state, stateRevision: 101 }); bridge.enable(2);
    vi.advanceTimersByTime(1000); const count = sent.length;
    bridge.receive({ ...state, stateRevision: 102 }); expect(sent).toHaveLength(count);
    bridge.enable(1); expect(sent.at(-1).snapshot.sessions[0].title).toBe('Title');
  });
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
  it('validates commands against a replacement owner before its throttled state is published', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message)); bridge.enable(1);
    bridge.receive(durable()); bridge.receive({ type: 'connection', status: 'connected' }); vi.advanceTimersByTime(50);
    const next = durable(); next.sessions[0].agent!.ownerId = 'replacement'; next.sessions[1].agent!.ownerId = 'replacement';
    bridge.receive(next);
    expect(sent.filter(message => message.kind === 'state').at(-1).snapshot.agents.session.ownerId).toBe('owner');
    const command = { type: 'agent', sessionId: 'child', ownerId: 'owner', conversationId: 2, requestId: 'cancel', command: { type: 'cancel', scope: 'all' } };
    expect(bridge.command(command)).toBeUndefined();
    expect(sent.at(-1)).toMatchObject({ kind: 'command', error: expect.any(String) });
    expect(bridge.command({ ...command, ownerId: 'replacement' })).toMatchObject({ type: 'agent-command', agentOwner: 'replacement' });
  });
  it('ignores out-of-order frames and marks the actual local conversation during navigation', () => {
    const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message)); bridge.enable(1);
    bridge.receive({ ...durable(), stateRevision: 2 }); bridge.select('child');
    bridge.receive({ ...durable(), stateRevision: 1 }); expect(sent.at(-1).snapshot.activeId).toBe('child');
    bridge.receive({ ...durable(), stateRevision: 3 }); expect(sent.at(-1).snapshot.activeId).toBe('child');
    bridge.select('local-unsaved'); expect(sent.at(-1).snapshot.activeId).toBe('local-unsaved');
  });
});

it('forwards named-agent retries through Core only for settled work in its parent scope', () => {
  const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message)); bridge.enable(1);
  const failed = { id: 42, conversationId: 1, status: 'failed', agent: { taskId: 42, agentId: 'researcher', childConversationId: 2 } };
  const agent = { ownerId: 'owner', conversationId: 1, conversations: [{ id: 1 }, { id: 2 }], tasks: [], history: [failed] };
  bridge.receive({ type: 'state', project, activeId: 'main', sessions: [{ id: 'main', agent, messages: [] }] });
  bridge.receive({ type: 'connection', status: 'connected' });
  const action = { type: 'agent', sessionId: 'main', ownerId: 'owner', conversationId: 1, requestId: 'retry', command: { type: 'subagent', action: 'retry', taskId: 42 } };
  expect(bridge.command(action)).toMatchObject({ type: 'agent-command', command: { type: 'subagent', action: 'retry', taskId: 42, targetId: 1 } });
  expect(bridge.command({ ...action, command: { ...action.command, targetId: 2 } })).toBeUndefined();
  expect(bridge.command({ ...action, command: { ...action.command, action: 'spawn' } })).toBeUndefined();
  failed.status = 'completed'; bridge.receive({ type: 'state', project, sessions: [{ id: 'main', agent, messages: [] }] });
  expect(bridge.command(action)).toBeUndefined(); bridge.enable(2);
});
