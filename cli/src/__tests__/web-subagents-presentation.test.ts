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
  ], agent: { ownerId: 'owner', conversationId: 1, contexts: [], turns: [], conversations: [{ id: 1 }, { id: 2, parentId: 1 }],
    tasks: [{ id: 10, conversationId: 1, kind: 'project.delegation', status: 'waiting', phase: 'wait', childConversationId: 2, label: 'Read video' }], history: [] },
  } as unknown as ConversationSession;
  const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
  const render = async () => { emit({ type: 'state', project, sessions: [session], activeId: session.id, running: true }); await vi.advanceTimersByTimeAsync(1); };
  await render(); expect(document.querySelectorAll('.subagents-button')).toHaveLength(1);
  const entry = document.querySelector<HTMLButtonElement>('.subagents-button')!; expect(entry.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('current');
  entry.click(); const row = document.querySelector<HTMLDetailsElement>('.subagent-task')!; row.open = true;
  row.querySelector<HTMLButtonElement>('.subagent-open')!.click();
  expect(host.postMessage).toHaveBeenLastCalledWith({ type: 'agent-open', projectUri: project.uri, sessionId: 'parent', conversationId: 2, agentOwner: 'owner' });
  emit({ type: 'connection', status: 'offline' }); expect(row.querySelector<HTMLButtonElement>('.subagent-open')!.disabled).toBe(true);
  emit({ type: 'connection', status: 'connected' }); expect(row.querySelector<HTMLButtonElement>('.subagent-open')!.disabled).toBe(false);
  const focused = row.querySelector<HTMLButtonElement>('.subagent-open')!; focused.focus();
  session.messages.push({ id: 'next', role: 'assistant', content: 'Next answer', status: 'success' });
  await render(); expect(document.querySelectorAll('.subagents-button')).toHaveLength(1);
  expect(document.querySelector('.subagents-button')?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('next');
  expect(document.querySelector('.subagents-button')).toBe(entry);
  expect(document.querySelector('.subagent-task')).toBe(row); expect(row.open).toBe(true);
  expect(document.activeElement).toBe(focused);
});
