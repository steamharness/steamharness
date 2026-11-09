import { afterEach, expect, it, vi } from 'vitest';
import { acquireProjectHost } from '../web/ui/host';

vi.mock('../web/ui/account', () => ({ AccountPanel: class {} }));
vi.mock('../web/ui/connection', () => ({ BrowserConnection: class {}, ConnectionError: class extends Error {} }));
afterEach(() => vi.unstubAllGlobals());

it('uses the browser host only after its handshake and correlates website errors to the conversation', async () => {
  const listeners = new Map<string, (event: any) => void>(), emitted: any[] = [];
  const parent = { postMessage: vi.fn() }, open = vi.fn();
  vi.stubGlobal('window', { parent, open, dispatchEvent: (event: MessageEvent) => emitted.push(event.data) });
  vi.stubGlobal('document', { documentElement: { dataset: { theme: 'dark' } }, body: { dataset: {} }, querySelector: () => ({ content: 'project' }) });
  vi.stubGlobal('location', { pathname: '/' }); vi.stubGlobal('acquireVsCodeApi', undefined);
  vi.stubGlobal('addEventListener', (type: string, fn: (event: any) => void) => listeners.set(type, fn));
  const host = acquireProjectHost(), message = { type: 'open-url', url: 'raw.communitydragon.org', projectUri: 'file:///project', sessionId: 'conversation' };
  await host.postMessage(message);
  expect(open).toHaveBeenLastCalledWith('https://raw.communitydragon.org/', '_blank', 'noopener,noreferrer');
  listeners.get('message')!({ source: {}, data: { type: 'workflow-host', browserOpenVersion: 1 } });
  await host.postMessage(message); expect(parent.postMessage).not.toHaveBeenCalled();
  listeners.get('message')!({ source: parent, data: { type: 'workflow-host', browserOpenVersion: 1 } });
  await host.postMessage(message);
  const forwarded = parent.postMessage.mock.calls.at(-1)![0];
  expect(forwarded).toMatchObject({ type: 'workflow-browser-open', version: 1, url: 'https://raw.communitydragon.org/' });
  listeners.get('message')!({ source: parent, data: { type: 'workflow-host', browserOpened: { version: 1, requestId: forwarded.requestId, error: 'Browser failed' } } });
  expect(emitted.at(-1)).toMatchObject({ type: 'error', requestType: 'open-url', projectUri: message.projectUri, sessionId: message.sessionId, message: 'Browser failed' });
  const count = parent.postMessage.mock.calls.length;
  await host.postMessage({ type: 'open-url', url: 'command:workbench.action.closeWindow' });
  expect(parent.postMessage).toHaveBeenCalledTimes(count);
});
