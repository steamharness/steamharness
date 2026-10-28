// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationSession, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.replaceChildren();
});

it('provides immediate Retry feedback and confirms or retries a scoped stop while disconnected', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':popover-open' ? false : matches.call(this, selector);
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  document.documentElement.lang = 'en';
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/assistant',databases:[],entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",databases:[]}], id: 'assistant', uri: 'studio-assistant:map', folderPath: '/assistant', name: 'Assistant', projectType: 'conversation',
    fields: [], entrypoints: [], conversation: { inputQueue: { enabled: true } } };
  const session: ConversationSession = { id: 'original', title: 'Map', activeRunId: 'run', messages: [
    { id: 'answer', role: 'assistant', content: 'Working', status: 'running' },
  ] };
  const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
  const render = async (sessions = [session], activeId = session.id, revision = {}) => {
    emit({ type: 'state', project, sessions, activeId, running: true, ...revision });
    await vi.advanceTimersByTimeAsync(1);
  };
  const stopMessages = () => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'stop' || message.command?.type === 'cancel');
  await render();
  const textarea = document.querySelector<HTMLTextAreaElement>('#message')!;
  const send = document.querySelector<HTMLButtonElement>('#send')!;
  const feedback = document.querySelector<HTMLElement>('#stop-feedback')!;
  textarea.value = 'Keep this next draft'; textarea.dispatchEvent(new Event('input'));
  emit({ type: 'connection', status: 'reconnecting' });
  expect(send.disabled).toBe(false); expect(send.ariaLabel).toBe('Stop');

  const connection = document.querySelector<HTMLElement>('.message-connection:not([hidden])')!;
  const retry = connection.querySelector<HTMLButtonElement>('.connection-retry')!;
  retry.click();
  expect(retry.disabled).toBe(true); expect(retry.getAttribute('aria-busy')).toBe('true');
  expect(retry.textContent).toBe('Reconnecting...');
  expect(host.postMessage).toHaveBeenCalledWith({ type: 'reconnect' });
  emit({ type: 'connection', status: 'reconnecting', manual: false, retryFailed: true });
  expect(retry.disabled).toBe(false); expect(retry.textContent).toBe('Retry');
  expect(connection.textContent).toContain('Reconnection failed.');
  host.postMessage.mockImplementationOnce(() => { throw new Error('Host unavailable'); });
  retry.click();
  expect(retry.disabled).toBe(false); expect(connection.textContent).toContain('Reconnection failed.');
  retry.click(); emit({ type: 'connection', status: 'connected' });
  expect(connection.hidden).toBe(true); expect(textarea.value).toBe('Keep this next draft');
  emit({ type: 'connection', status: 'reconnecting' });

  send.click(); send.click();
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(stopMessages()).toHaveLength(1);
  const first = stopMessages()[0];
  expect(first).toMatchObject({ type: 'stop', projectUri: project.uri, sessionId: session.id });
  expect(send.disabled).toBe(true); expect(send.getAttribute('aria-busy')).toBe('true');
  expect(feedback.textContent).toBe('Stopping...');
  emit({ ...first, type: 'stopped', sessionId: 'other' });
  expect(send.disabled).toBe(true);
  emit({ ...first, type: 'error', requestType: 'stop', silent: true, message: 'Connection interrupted.' });
  expect(send.disabled).toBe(false); expect(feedback.getAttribute('role')).toBe('alert');
  expect(feedback.textContent).toContain('Stop was not confirmed: Connection interrupted.');
  expect(document.querySelector<HTMLElement>('#error')!.hidden).toBe(true);
  send.click();
  const second = stopMessages()[1];
  expect(second.requestId).toBe(first.requestId);
  session.activeRunId = undefined; await render();
  emit({ ...second, type: 'stopped' });
  expect(send.getAttribute('aria-busy')).toBe('false'); expect(feedback.textContent).toBe('Stop request accepted.');
  expect(textarea.value).toBe('Keep this next draft');

  // A late stop result stays with the old conversation after local navigation.
  session.activeRunId = 'next-run'; await render();
  expect(feedback.hidden).toBe(true);
  send.click();
  const old = stopMessages()[2];
  document.querySelector<HTMLButtonElement>('#new')!.click();
  expect(feedback.hidden).toBe(true);
  emit({ ...old, type: 'error', requestType: 'stop', silent: true, message: 'Old stop failed' });
  expect(feedback.hidden).toBe(true); expect(document.querySelector<HTMLElement>('#error')!.hidden).toBe(true);
  expect(textarea.value).toBe('');

  // Durable cancellation keeps its foreground scope and owner identity.
  [...document.querySelectorAll<HTMLButtonElement>('#session-list button')].find(button => button.textContent?.includes('Map'))!.click();
  project.conversation!.durable = { enabled: true };
  session.agent = { version: 1, ownerId: 'owner', revision: 1, conversationId: 1, foreground: true, backgroundCount: 0, epoch: 0,
    configuration: { version: 0, provider: 'fixture', model: 'test', effort: 'off' }, prompt: { hash: 'digest', version: 1 }, plan: { version: 0, items: [] },
    conversations: [{ id: 1, title: 'Main', background: false }],
    tasks: [{ id: 42, conversationId: 1, kind: 'pi.generation', label: 'Model', status: 'running', background: false, stopping: false, blockedOn: [] }],
    history: [], turns: [], receipts: [], records: [], contexts: [], usage: [] };
  await render([session], session.id, { serverInstanceId: 'exited', stateRevision: 100 });
  send.click();
  const durable = stopMessages().at(-1)!;
  expect(durable).toMatchObject({ type: 'agent-command', projectUri: project.uri, sessionId: session.id, agentOwner: 'owner', taskIds: [42], runId: session.activeRunId,
    command: { type: 'cancel', scope: 'foreground', requestId: durable.requestId } });
  const restored = { ...session, agent: { ...session.agent, ownerId: 'replacement' } };
  await render([restored], session.id, { serverInstanceId: 'restored', stateRevision: 1 });
  expect(send.disabled).toBe(true); expect(feedback.textContent).toBe('Stopping...');
  await render([session], session.id, { serverInstanceId: 'exited', stateRevision: 101 });
  expect(send.disabled).toBe(true); expect(feedback.textContent).toBe('Stopping...');
  await vi.advanceTimersByTimeAsync(35_000);
  expect(send.disabled).toBe(true); expect(feedback.textContent).toBe('Stopping...');
  await vi.advanceTimersByTimeAsync(55_000);
  expect(send.disabled).toBe(false); expect(feedback.textContent).toContain('The server did not confirm the stop request.');
  send.click();
  const retried = stopMessages().at(-1)!;
  expect(retried.requestId).toBe(durable.requestId);
  expect(retried.agentOwner).toBe('replacement');
  emit({ type: 'agent-receipt', sessionId: session.id, receipt: { requestId: retried.requestId, status: 'accepted' } });
  expect(feedback.textContent).toBe('Stop request accepted.'); expect(send.getAttribute('aria-busy')).toBe('false');
});
