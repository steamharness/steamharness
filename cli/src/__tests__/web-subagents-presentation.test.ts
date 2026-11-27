// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import type { ConversationSession, OutputItem, Project } from '../web/workflow-types';

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
  const project: Project = { entryId: 'main', aggregateName: 'Test', defaultEntry: 'main', entryRoot: '/project',
    entries: [{ entryId: 'main', name: 'Main', type: 'bot', root: '.', entry: 'index.ts' }],
    id: 'project', uri: 'file:///project', folderPath: '/project', name: 'Project', projectType: 'bot', fields: [], entrypoints: [] };
  const context: OutputItem = { id: 'context', title: 'Context window', content: { value: 300, total: 1000, unit: 'tokens' },
    contentType: 'json', display: { type: 'ring', placement: 'composer-right' } };
  const session = { id: 'parent', title: 'Parent', messages: [
    { id: 'old', role: 'assistant', content: 'Earlier answer', status: 'success' },
    { id: 'current', role: 'assistant', content: 'Current answer', status: 'running',
      tokenUsage: { enabled: true, display: true, run: { calls: 4, totalTokens: 1_000, cachedInputTokens: 720 } } },
  ], agent: { ownerId: 'owner', conversationId: 1, capturedAt: Date.now(), contexts: [
    { conversationId: 1, tokenUsage: { totalTokens: 1400 }, outputs: [context] }, { conversationId: 2, tokenUsage: { totalTokens: 400 } },
  ], turns: [], conversations: [{ id: 1 }, { id: 2, parentId: 1 }],
    tasks: [{ id: 10, conversationId: 1, kind: 'project.delegation', status: 'waiting', phase: 'wait', childConversationId: 2,
      label: 'Read video', startedAt: Date.now() - 20_000, usage: { totalTokens: 400 } }], history: [] },
  } as unknown as ConversationSession;
  const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
  const render = async () => { emit({ type: 'state', project, sessions: [session], activeId: session.id, running: true }); await vi.advanceTimersByTimeAsync(1); };
  await render(); expect(document.querySelectorAll('.subagents-button')).toHaveLength(1);
  const metadata = document.querySelector<HTMLElement>('[data-message-id="current"] .message-metadata')!;
  expect(metadata.textContent).toContain('Turn total: 1,000 tokens · Conversation total: 1,400 tokens');
  expect(metadata.title).toContain('They do not show current context usage.');
  expect(metadata.title).toContain('Model calls: 4');
  expect(metadata.title).toContain('Cache read: 720 tokens');
  expect(document.querySelector('.composer-output .output-ring')?.getAttribute('aria-label')).toBe('Context window: 30% full; 300 / 1,000 tokens used');
  expect(document.querySelector('[data-message-id="old"] .message-metadata')!.textContent).not.toContain('Conversation total');
  initI18n({ preference: 'zh-CN' });
  try {
    await render();
    expect(metadata.textContent).toContain('本轮累计用量：1,000 tokens · 会话累计用量：1,400 tokens');
    expect(metadata.title).toContain('不等于当前上下文占用');
  } finally {
    initI18n({ preference: 'en' });
    await render();
  }
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
  expect(document.querySelector('[data-message-id="current"] .message-metadata')!.textContent).not.toContain('Conversation total');
  expect(document.querySelector('[data-message-id="next"] .message-metadata')!.textContent).toContain('Conversation total: 2,100 tokens');
  expect(row.querySelector('.subagent-metrics')!.textContent).toContain('1,100 tokens');
  // A repeated full snapshot replaces usage rather than incrementing a counter.
  await render(); expect(document.querySelector('[data-message-id="next"] .message-metadata')!.textContent).toContain('Conversation total: 2,100 tokens');

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
  expect(document.querySelector('[data-message-id="reply"] .message-metadata')!.textContent).toContain('Conversation total: 1,100 tokens');
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
  expect(document.querySelector('[data-message-id="next"] .message-metadata')!.textContent).not.toContain('Conversation total');
  document.querySelector<HTMLButtonElement>('.subagents-button')!.click();
  expect(document.querySelector('.subagent-metrics')!.textContent).not.toContain('tokens');

  project.conversation = { engine: 'llm' };
  await show(child);
  expect(banner.hidden).toBe(true);
  expect(document.querySelector('.subagents-button')).toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
  expect(document.querySelector('.conversation-access')!.textContent).toContain('different Bot engine');
  expect(document.querySelector('#transcript')!.textContent).toContain('Draft saved; ready=false');

  await show({ id: 'llm', title: 'LLM conversation', engine: 'llm', messages: [
    { id: 'llm-reply', role: 'assistant', content: 'LLM answer', status: 'success', tokenUsage: { enabled: true, display: true, run: { calls: 1, totalTokens: 12 } } },
  ] });
  expect(document.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false);
  expect(document.querySelector('.subagents-button')).toBeNull();
  expect(document.querySelector('[data-message-id="llm-reply"] .message-metadata')!.textContent).toContain('Turn total: 12 tokens');
});
