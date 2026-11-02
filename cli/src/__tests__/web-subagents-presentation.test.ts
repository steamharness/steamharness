// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSession, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));
afterEach(() => {
  window.dispatchEvent(new Event('pagehide')); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); document.body.replaceChildren();
});

it('shows one live entry on the latest response and routes child navigation through the existing Core host command', async () => {
  vi.useFakeTimers(); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? false : matches.call(this, selector); });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout); document.documentElement.lang = 'en'; document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const project: Project = { entryId: 'main', aggregateName: 'Test', defaultEntry: 'main', entryRoot: '/project', databases: [],
    entries: [{ entryId: 'main', name: 'Main', type: 'conversation', root: '.', entry: 'index.ts', databases: [] }],
    id: 'project', uri: 'file:///project', folderPath: '/project', name: 'Project', projectType: 'conversation', fields: [], entrypoints: [] };
  const session = { id: 'parent', title: 'Parent', messages: [
    { id: 'old', role: 'assistant', content: 'Earlier answer', status: 'success' },
    { id: 'current', role: 'assistant', content: 'Current answer', status: 'running' },
  ], agent: { ownerId: 'owner', conversationId: 1, capturedAt: Date.now(), contexts: [
    { conversationId: 1, tokenUsage: { totalTokens: 1400 } }, { conversationId: 2, tokenUsage: { totalTokens: 400 } },
  ], turns: [], conversations: [{ id: 1 }, { id: 2, parentId: 1 }],
    tasks: [{ id: 10, conversationId: 1, kind: 'project.delegation', status: 'waiting', phase: 'wait', childConversationId: 2,
      label: 'Read video', startedAt: Date.now() - 20_000, usage: { totalTokens: 400 } }], history: [] },
  } as unknown as ConversationSession;
  const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
  const render = async () => { emit({ type: 'state', project, sessions: [session], activeId: session.id, running: true }); await vi.advanceTimersByTimeAsync(1); };
  await render(); expect(document.querySelectorAll('.subagents-button')).toHaveLength(1);
  expect(document.querySelector('[data-message-id="current"] .message-metadata')!.textContent).toContain('Conversation usage: 1,400 tokens');
  expect(document.querySelector('[data-message-id="old"] .message-metadata')!.textContent).not.toContain('Conversation usage');
  const entry = document.querySelector<HTMLButtonElement>('.subagents-button')!; expect(entry.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('current');
  entry.click(); const row = document.querySelector<HTMLDetailsElement>('.subagent-task')!; row.open = true;
  expect(row.querySelector('.subagent-metrics')!.textContent).toBe('20s · 400 tokens');
  await vi.advanceTimersByTimeAsync(1200);
  expect(row.querySelector('.subagent-metrics')!.textContent).toBe('21s · 400 tokens');
  row.querySelector<HTMLButtonElement>('.subagent-open')!.click();
  expect(host.postMessage).toHaveBeenLastCalledWith({ type: 'agent-open', projectUri: project.uri, sessionId: 'parent', conversationId: 2, agentOwner: 'owner', requestId: expect.any(String) });
  emit({ type: 'connection', status: 'offline' }); expect(row.querySelector<HTMLButtonElement>('.subagent-open')!.disabled).toBe(true);
  emit({ type: 'connection', status: 'connected' }); expect(row.querySelector<HTMLButtonElement>('.subagent-open')!.disabled).toBe(false);
  const focused = row.querySelector<HTMLButtonElement>('.subagent-open')!; focused.focus();
  session.messages.push({ id: 'next', role: 'assistant', content: 'Next answer', status: 'success' });
  session.agent!.contexts[0].tokenUsage!.totalTokens = 2100;
  session.agent!.contexts[1].tokenUsage!.totalTokens = 1100;
  session.agent!.tasks[0].usage!.totalTokens = 1100;
  await render(); expect(document.querySelectorAll('.subagents-button')).toHaveLength(1);
  expect(document.querySelector('.subagents-button')?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('next');
  expect(document.querySelector('.subagents-button')).toBe(entry);
  expect(document.querySelector('.subagent-task')).toBe(row); expect(row.open).toBe(true);
  expect(document.activeElement).toBe(focused);
  expect(document.querySelector('[data-message-id="current"] .message-metadata')!.textContent).not.toContain('Conversation usage');
  expect(document.querySelector('[data-message-id="next"] .message-metadata')!.textContent).toContain('Conversation usage: 2,100 tokens');
  expect(row.querySelector('.subagent-metrics')!.textContent).toContain('1,100 tokens');
  // A repeated full snapshot replaces usage rather than incrementing a counter.
  await render(); expect(document.querySelector('[data-message-id="next"] .message-metadata')!.textContent).toContain('Conversation usage: 2,100 tokens');

  const job = session.agent!.tasks[0];
  job.status = 'failed'; job.progress = { completed: 0, total: 3, phase: 'needs_review' };
  job.details = { error: { message: 'MEDIA_RESULT_UNKNOWN: Headers Timeout Error' } };
  await render(); expect(row.dataset.state).toBe('needs_review');
  const child = { id: 'child', title: 'Research video', agentOwnerId: 'parent', agentConversationId: 2, agent: session.agent,
    messages: [{ id: 'reply', role: 'assistant', content: 'Draft saved; ready=false', status: 'success' }],
  } as unknown as ConversationSession;
  const show = async (active: ConversationSession) => {
    emit({ type: 'state', project, sessions: [session, active], activeId: active.id, running: false }); await vi.advanceTimersByTimeAsync(1);
  };
  await show(child);
  expect(document.querySelector('[data-message-id="reply"] .message-metadata')!.textContent).toContain('Conversation usage: 1,100 tokens');
  const banner = document.querySelector<HTMLElement>('.child-work-status')!;
  expect(banner.hidden).toBe(false); expect(banner.dataset.state).toBe('needs_review');
  expect(banner.textContent).toContain('Awaiting verification'); expect(banner.textContent).toContain('0/3 completed');
  expect(document.querySelector('#transcript')!.textContent).toContain('Draft saved; ready=false');
  emit({ type: 'connection', status: 'offline' }); expect(banner.textContent).toContain('Connection lost');
  emit({ type: 'connection', status: 'connected' });
  job.status = 'completed'; job.progress = { completed: 3, total: 3, phase: 'ready' }; job.details = {};
  await show(child); expect(banner.dataset.state).toBe('completed'); expect(banner.textContent).toContain('3/3 completed');
  await show({ ...child, id: 'fork', forkSource: { sessionId: 'parent' } } as ConversationSession); expect(banner.hidden).toBe(true);
  await show({ id: 'new', title: 'New conversation', messages: [], agent: session.agent } as ConversationSession); expect(banner.hidden).toBe(true);
  project.tokenUsage = { enabled: true, display: false }; await render();
  expect(document.querySelector('[data-message-id="next"] .message-metadata')!.textContent).not.toContain('Conversation usage');
  document.querySelector<HTMLButtonElement>('.subagents-button')!.click();
  expect(document.querySelector('.subagent-metrics')!.textContent).not.toContain('tokens');
});
