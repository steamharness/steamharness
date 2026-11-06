// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationAccess } from '../web/conversation-ownership';
import type { ConversationSession, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
const viewId = 'aaaaaaaa-1111-2222-3333-444444444444';
const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/view',databases:[],entries:[{entryId:"main",name:"Main",type:'bot',root:".",entry:"index.ts",databases:[]}], id: 'view', uri: 'file:///view', folderPath: '/view', name: 'View', projectType: 'bot', fields: [], entrypoints: [] };
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
  const receive = (sessions: ConversationSession[], activeId = 'running', conversationAccess: ConversationAccess = { readOnly: activeId === 'running' }) => {
    emit({ type: 'state', project, sessions, activeId, running: activeId === 'running', conversationAccess });
    const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0);
  };
  const requests = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'navigate');
  const savedState = () => host.setState.mock.calls.at(-1)?.[0];
  return { receive, emit, requests, savedState, input: document.querySelector<HTMLTextAreaElement>('#message')! };
}

it.each([false, true])('does not flash an ownership warning when leaving a populated conversation (readOnly=%s)', async readOnly => {
  const f = await fixture();
  const original: ConversationSession = { ...session('previous'), messages: [{ id: 'reply', role: 'assistant', content: 'Previous answer', status: 'success' }] };
  const blank = session('blank'), notice = document.querySelector<HTMLElement>('.conversation-access')!;
  f.receive([original, blank], original.id, { readOnly, reason: readOnly ? 'opened' : undefined });
  expect(notice.hidden).toBe(!readOnly);
  document.querySelector<HTMLButtonElement>('#new')!.click();
  expect(f.requests().at(-1)).toMatchObject({ id: blank.id });
  expect(document.querySelector('#transcript-content')!.textContent).not.toContain('Previous answer');
  expect(notice.hidden).toBe(true);
  f.receive([original, blank], original.id, { readOnly: true, reason: 'opened' });
  expect(notice.hidden).toBe(true);
  f.receive([original, blank], blank.id, { readOnly: true, reason: 'pending' });
  expect(notice.hidden).toBe(true); expect(f.input.disabled).toBe(true);
  f.receive([original, blank], blank.id, { readOnly: false });
  expect(notice.hidden).toBe(true); expect(f.input.disabled).toBe(false);
  f.receive([original, blank], blank.id, { readOnly: true, reason: 'opened' });
  expect(notice.hidden).toBe(false); expect(f.input.disabled).toBe(true);
});

it('restores a compact file reference but saves and submits its complete path after editing surrounding text', async () => {
  const f = await fixture(), source = '@file:/project/deeply/nested/package.json ';
  const entry = { ...session('file-draft'), draft: { text: source, attachments: [] } };
  f.receive([entry], entry.id);
  expect(f.input.value).toBe('@file:package.json ');
  expect(document.querySelector<HTMLElement>('.mention-highlights mark')!.title).toBe('/project/deeply/nested/package.json');
  f.input.value = `检查 ${f.input.value}`; f.input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(f.savedState().drafts[`${project.uri}:${entry.id}`]).toBe(`检查 ${source}`);
  document.querySelector<HTMLButtonElement>('#send')!.click();
  expect(host.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', text: `检查 ${source}` }));
});

it.each(['success', 'failed', 'aborted'])('keeps the final duration in the reply metadata after %s', async status => {
  const f = await fixture(), startedAt = Date.now();
  const entry: ConversationSession = { ...session('duration'), messages: [{ id: 'reply', role: 'assistant', content: 'Answer', status: 'running', createdAt: startedAt - 12_000 }] };
  f.receive([entry], entry.id);
  const metadata = () => document.querySelector('.assistant .message-metadata')!.textContent;
  expect(metadata()).toContain('Responding'); expect(metadata()).toContain('Duration 12s');
  entry.messages[0] = { ...entry.messages[0], status, durationMs: 12_000 };
  f.receive([entry], entry.id);
  expect(metadata()).toContain('Duration 12s'); expect(metadata()).not.toContain('Responding');
  vi.setSystemTime(startedAt + 70 * 60 * 60 * 1000); vi.advanceTimersByTime(1000);
  f.receive([structuredClone(entry)], entry.id);
  expect(metadata()).toContain('Duration 12s');
});

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

it('forwards file links in restored assistant replies with the current project and conversation', async () => {
  const f = await fixture();
  f.receive([{ ...session('running'), messages: [
    { id: 'reply', role: 'assistant', content: '[configuration](file:///work/a%20b.json#L12C3)', status: 'success' },
  ] }]);
  document.querySelector<HTMLAnchorElement>('.message-content a')!.click();
  expect(host.postMessage).toHaveBeenCalledWith({ type: 'open-path', path: '/work/a b.json', line: 12, column: 3, projectUri: project.uri, sessionId: 'running' });
});
