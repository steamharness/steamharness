// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationAccess } from '../web/conversation-ownership';
import type { ConversationSession, Project } from '../web/workflow-types';
import type { KanbanConversationUi } from '@steamharness/kanban-project';

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
  const receive = (sessions: ConversationSession[], activeId = 'running', conversationAccess: ConversationAccess = { readOnly: activeId === 'running' }, conversationUi?: KanbanConversationUi) => {
    emit({ type: 'state', project, sessions, activeId, running: activeId === 'running', conversationAccess, conversationUi });
    const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0);
  };
  const requests = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'navigate');
  const savedState = () => host.setState.mock.calls.at(-1)?.[0];
  return { receive, emit, requests, savedState, input: document.querySelector<HTMLTextAreaElement>('#message')! };
}

it('anchors project cards to their assistant turn and preserves drafts and history on UI updates', async () => {
  const f = await fixture(), entry: ConversationSession = { ...session('cards'), messages: [
    { id: 'question', sessionRequestId: 'turn-1', role: 'user', content: 'First request' },
    { id: 'answer-1', sessionRequestId: 'turn-1', role: 'assistant', content: 'First answer', status: 'success' },
    { id: 'answer-2', sessionRequestId: 'turn-2', role: 'assistant', content: 'Second answer', status: 'success' },
  ] };
  const card = { id: 'delivery', requestId: 'turn-1', title: '发送给执行员', text: '你好', status: { label: '等待发送' }, action: { label: '查看协作对话' } };
  f.receive([entry], entry.id, { readOnly: false }, { messageCards: [card, { ...card, id: 'unknown', requestId: 'other-turn' }] });
  const root = document.querySelector('[data-message-card-id="delivery"]')!;
  expect(root.closest('.message')?.getAttribute('data-message-id')).toBe('answer-1');
  expect(document.querySelector('.message.user .conversation-message-card')).toBeNull();
  expect(document.querySelector('[data-message-card-id="unknown"]')).toBeNull();
  f.input.value = '未发送草稿'; f.input.dispatchEvent(new Event('input', { bubbles: true }));
  f.receive([entry], entry.id, { readOnly: false }, { messageCards: [{ ...card, status: { label: '已发送', tone: 'success' } }] });
  expect(document.querySelector('[data-message-card-id="delivery"]')).toBe(root);
  expect(root.textContent).toContain('已发送'); expect(f.input.value).toBe('未发送草稿');
  root.querySelector<HTMLButtonElement>('button')!.click();
  expect(host.postMessage).toHaveBeenCalledWith({ type: 'view-message-card-action', id: 'delivery', requestId: 'turn-1' });
  expect(entry.messages.map(message => message.content)).toEqual(['First request', 'First answer', 'Second answer']);
});

it('renders current reference labels while preserving raw history, code, links and drafts', async () => {
  const f = await fixture(), entry: ConversationSession = { ...session('labels'), messages: [
    { id: 'question', role: 'user', content: '@bot:executor 你好，@bot:missing' },
    { id: 'answer', role: 'assistant', content: '已联系 @bot:executor。\n\n`@bot:executor`\n\n[查看 @bot:executor](https://example.com/@bot:executor)', status: 'success' },
  ] };
  const ui = (label: string) => ({ mentions: [{ kind: 'bot', label: 'Bot', items: [{ value: 'executor', label, suggest: false }] }] });
  f.receive([entry], entry.id, { readOnly: false }, ui('执行员'));
  const question = document.querySelector('.message.user .message-content')!;
  expect(question.textContent).toBe('@执行员 你好，@bot:missing');
  expect(document.querySelector('.message.assistant .message-content p')?.textContent).toBe('已联系 @执行员。');
  expect(document.querySelector('.message.assistant code')?.textContent).toBe('@bot:executor');
  expect(document.querySelector('.message.assistant a')?.getAttribute('href')).toBe('https://example.com/@bot:executor');
  f.input.value = '未发送草稿'; f.input.dispatchEvent(new Event('input', { bubbles: true })); f.input.setSelectionRange(1, 3);
  f.receive([entry], entry.id, { readOnly: false }, ui('执行小助手'));
  expect(question.textContent).toBe('@执行小助手 你好，@bot:missing');
  expect(f.input.value).toBe('未发送草稿'); expect(f.input.selectionStart).toBe(1); expect(f.input.selectionEnd).toBe(3);
  expect(entry.messages[0]!.content).toBe('@bot:executor 你好，@bot:missing');
});

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

it('folds the earlier reply before a correction and streams into a new section at that position', async () => {
  const f = await fixture();
  const input = { id: 'input', role: 'user' as const, content: 'Original task' };
  const answer = { id: 'reply', role: 'assistant' as const, content: 'Original output', status: 'running', createdAt: 10,
    items: [{ id: 'before', content: 'Original output', contentType: 'markdown', metadata: { startedAt: 10 } }] };
  const entry: ConversationSession = { ...session('queue-placement'), messages: [input, answer] };
  f.receive([entry], entry.id);
  const root = document.querySelector('[data-message-id="reply"]');
  const steer = { id: 'steer:correction', role: 'user' as const, content: 'Queued correction', status: 'steer', createdAt: 20 };
  // Also repair an already displayed bubble from an older host snapshot.
  entry.messages = [input, answer, steer]; f.receive([entry], entry.id);
  entry.messages = [input, steer, answer]; f.receive([entry], entry.id);
  const correction = document.querySelector('[data-message-id="steer:correction"]');
  const continuation = document.querySelector('[data-message-id="reply:after:correction"]');
  expect([...document.querySelectorAll('#transcript-content > .message')].map(node => (node as HTMLElement).dataset.messageId)).toEqual(['input', 'reply', 'steer:correction', 'reply:after:correction']);
  const previous = root?.querySelector<HTMLDetailsElement>('.conversation-segment');
  expect(previous?.open).toBe(false); expect(previous?.textContent).toContain('Original output');
  expect(correction?.previousElementSibling).toBe(root); expect(correction?.nextElementSibling).toBe(continuation);
  expect(document.querySelector('.pending')?.closest('.message')).toBe(continuation);
  previous!.open = true;
  answer.content = 'Reply after the queued correction'; f.receive([structuredClone(entry)], entry.id);
  answer.items.push({ id: 'after', content: answer.content, contentType: 'markdown', metadata: { startedAt: 30 } });
  f.receive([structuredClone(entry)], entry.id);
  expect(document.querySelector('[data-message-id="steer:correction"]')).toBe(correction);
  expect(document.querySelector('[data-message-id="reply"]')).toBe(root);
  expect(continuation?.textContent).toContain(answer.content); expect(previous?.open).toBe(true);
  expect(correction?.nextElementSibling).toBe(continuation);
  answer.status = 'success'; f.receive([entry], entry.id);
  expect(document.querySelector('.pending')).toBeNull();
  expect(correction?.nextElementSibling).toBe(continuation);
});

it('shows Send now in the transcript before confirmation, restores a failed action, and avoids duplicate input bubbles', async () => {
  const f = await fixture();
  const entry: ConversationSession = { ...session('chat'), activeRunId: 'worker', messages: [
    { id: 'input', role: 'user', content: 'Task', createdAt: 10 },
    { id: 'reply', role: 'assistant', content: 'Working', status: 'running', createdAt: 10 },
  ], queuedInputs: [{ id: 'correction', text: 'Correction', params: {}, attachments: [], createdAt: 20 }] };
  f.receive([entry], entry.id, { readOnly: false });
  document.querySelector<HTMLButtonElement>('#input-queue button[title="Send now"]')!.click();
  await Promise.resolve();
  const correction = document.querySelector('[data-message-id="steer:correction"]');
  expect(correction?.textContent).toContain('Correction');
  expect(document.querySelector('.conversation-segment')).not.toBeNull();
  expect(document.querySelector('#input-queue')?.textContent).not.toContain('Send requested');
  const action = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'queue-promote');
  f.emit({ ...action, type: 'error', requestType: 'queue-promote', message: 'Not accepted' });
  await Promise.resolve();
  expect(document.querySelector('[data-message-id="steer:correction"]')).toBeNull();
  expect(document.querySelector('.conversation-segment')).toBeNull();
  expect(document.querySelector('#input-queue')?.textContent).toContain('Not accepted');
});

it('keeps current task-plan progress beside the continuation after folding its earlier update', async () => {
  const f = await fixture();
  const entry: ConversationSession = { ...session('plan'), messages: [
    { id: 'input', role: 'user', content: 'Task', createdAt: 10 },
    { id: 'steer:correction', role: 'user', status: 'steer', content: 'Correction', createdAt: 20 },
    { id: 'reply', role: 'assistant', content: '', status: 'running', createdAt: 10, items: [{ id: 'plan', metadata: {
      kind: 'agent-part', partType: 'tool', status: 'success', startedAt: 10,
    }, content: { tool: 'update_plan', input: { items: [{ id: 'task', text: 'Keep working', status: 'in_progress' }] }, status: 'success' } }] },
  ] };
  f.receive([entry], entry.id);
  const current = document.querySelector('[data-message-id="reply:after:correction"]');
  expect(current?.querySelector('.plan-button')?.textContent).toContain('Keep working');
  expect(document.querySelector('.conversation-segment .plan-button')).toBeNull();
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
