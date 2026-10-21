// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationMessage, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.replaceChildren();
});

it('keeps preview failures in their card through later messages and conversation changes', async () => {
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
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const project: Project = { id: 'assistant', uri: 'studio-assistant:map', folderPath: '/assistant', name: 'Assistant', projectType: 'conversation', fields: [], entrypoints: [] };
  const answer: ConversationMessage = { id: 'answer', role: 'assistant', content: '', status: 'success', items: [{
    id: 'map-card', metadata: { kind: 'agent-part', partType: 'tool' }, content: { tool: 'workflow-ui_present_card', status: 'success',
      output: { action: 'upsert', cardId: 'map', kind: 'kanban', title: 'Map', preview: true, target: { source: 'current' } } },
  }] };
  const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
  const render = async (messages: ConversationMessage[]) => {
    emit({ type: 'state', project, activeId: 'session', running: false,
      sessions: [{ id: 'session', title: 'Map', messages, createdAt: 1, updatedAt: 1 }] });
    await vi.advanceTimersByTimeAsync(1);
  };
  await render([answer]);
  const request = host.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'resource');
  expect(request).toMatchObject({ action: 'inline', cardId: 'map', messageId: 'answer', sessionId: 'session' });
  const error = { type: 'error', requestType: 'resource', requestId: request.requestId, sessionId: 'session', messageId: 'answer',
    message: 'This project does not provide a Kanban preview.' };
  const globalError = document.querySelector<HTMLElement>('#error')!;
  emit(error);
  expect(document.querySelector('.resource-inline[role="alert"]')?.textContent).toBe(error.message);
  expect(globalError.hidden).toBe(true);

  const textarea = document.querySelector<HTMLTextAreaElement>('#message')!;
  textarea.value = 'Continue editing the map'; textarea.dispatchEvent(new Event('input'));
  document.querySelector<HTMLButtonElement>('#send')!.click();
  expect(host.postMessage.mock.calls.some(([message]) => message.type === 'send')).toBe(true);
  emit(error);
  expect(globalError.hidden).toBe(true);
  await render([answer, { id: 'next-answer', role: 'assistant', content: 'Next response', status: 'success' }]);
  expect(document.querySelector('#transcript-content')?.textContent).toContain('Next response');
  expect(globalError.hidden).toBe(true);

  emit({ type: 'error', requestType: 'attach', message: 'Attachment failed' });
  expect(globalError.hidden).toBe(false);
  document.querySelector<HTMLButtonElement>('#new')!.click();
  expect(globalError.hidden).toBe(true);
  emit({ ...error, sessionId: undefined });
  expect(globalError.hidden).toBe(true);
  expect(document.querySelector('.resource-card')).toBeNull();
});
