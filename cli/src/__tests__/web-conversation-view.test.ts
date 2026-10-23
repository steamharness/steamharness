// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSession, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
const viewId = 'aaaaaaaa-1111-2222-3333-444444444444';
const project: Project = { id: 'view', uri: 'file:///view', folderPath: '/view', name: 'View', projectType: 'conversation', fields: [], entrypoints: [] };
const session = (id: string): ConversationSession => ({ id, title: id, createdAt: 1, updatedAt: 1, messages: [], draft: { text: '', attachments: [] } });

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { target, type, listener, options } of listeners.splice(0)) target.removeEventListener(type, listener, options);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); history.replaceState(null, '', '/');
});

async function fixture(query = '', saved?: object) {
  vi.resetModules(); vi.useFakeTimers(); host.postMessage.mockReset(); host.getState.mockReturnValue(saved); host.setState.mockReset();
  history.replaceState(null, '', `/${query}`);
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) listeners.push({ target, type, listener, options }); add(type, listener, options);
    });
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? false : matches.call(this, selector); });
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const emit = (message: object) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  const receive = (sessions: ConversationSession[], activeId = 'running') => {
    emit({ type: 'state', project, sessions, activeId, running: activeId === 'running', conversationAccess: { readOnly: activeId === 'running' } });
    const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0);
  };
  const requests = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'navigate');
  const savedState = () => host.setState.mock.calls.at(-1)?.[0];
  return { receive, emit, requests, savedState, input: document.querySelector<HTMLTextAreaElement>('#message')! };
}

it.each(['bbbbbbbb-1111-2222-3333-444444444444', 'cccccccc-1111-2222-3333-444444444444'])(
  'a new assistant view opens its own blank conversation %s without touching a running conversation or reusing another blank', async id => {
    const f = await fixture(`?projectView=${viewId}&conversationId=${id}&createConversation=1`);
    const running = { ...session('running'), activeRunId: 'active-run', draft: { text: 'Keep the original draft', attachments: [] },
      messages: [{ id: 'reply', role: 'assistant' as const, content: 'Original conversation is still running', status: 'running' }] };
    const original = structuredClone(running), availableBlank = session('existing-blank');
    f.receive([running, availableBlank]);
    expect(f.input.value).toBe(''); expect(f.input.disabled).toBe(false);
    expect(document.querySelector('#transcript-content')?.textContent).not.toContain('Original conversation');
    expect(f.requests()).toHaveLength(1);
    const request = f.requests()[0];
    expect(request).toMatchObject({ id, updates: [{ id, create: true, draft: { text: '', attachments: [] } }] });
    expect(request.updates).toHaveLength(1); expect(running).toEqual(original);
    expect(f.savedState().navigation.activeId).toBe(id);
    f.emit({ type: 'navigated', requestId: request.requestId, activeId: id });
    expect(f.savedState().navigation).toMatchObject({ activeId: id, updates: [] });
    f.receive([running, availableBlank, session(id)]);
    expect(f.requests().flatMap(request => request.updates).filter(update => update.create)).toHaveLength(1);
    expect(f.input.value).toBe(''); expect(running).toEqual(original);
  },
);

it('restores a tab selection ahead of the workspace default and an obsolete startup target', async () => {
  const selected = 'dddddddd-1111-2222-3333-444444444444';
  const f = await fixture(`?projectView=${viewId}&conversationId=${viewId}&createConversation=1`, {
    navigation: { projectUri: project.uri, activeId: selected, updates: [] },
  });
  f.receive([session('running'), { ...session(selected), draft: { text: 'This tab draft', attachments: [] } }, session(viewId)]);
  expect(f.input.value).toBe('This tab draft');
  expect(f.requests()[0]).toMatchObject({ id: selected, updates: [] });
  expect(f.savedState().navigation.activeId).toBe(selected);
});

it('restores the host selection after a service origin changes without creating it again', async () => {
  const f = await fixture(`?projectView=${viewId}&conversationId=${viewId}`);
  f.receive([session('running'), { ...session(viewId), draft: { text: 'Recovered draft', attachments: [] } }]);
  expect(f.input.value).toBe('Recovered draft');
  expect(f.requests()[0]).toMatchObject({ id: viewId, updates: [] });
});

it('ordinary CLI pages continue opening the last selected conversation', async () => {
  const f = await fixture();
  f.receive([{ ...session('running'), draft: { text: 'Last selected draft', attachments: [] } }]);
  expect(f.input.value).toBe('Last selected draft'); expect(f.requests()).toEqual([]);
});
