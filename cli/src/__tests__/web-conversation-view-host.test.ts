// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { acquireProjectHost } from '../web/ui/host';

vi.mock('../web/ui/account', () => ({ AccountPanel: class {} }));
vi.mock('../web/ui/connection', () => ({ BrowserConnection: class {}, ConnectionError: class extends Error {} }));
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, '', '/'); });

it('stores navigation per tool view and reports only changed conversation identities to its parent', () => {
  vi.stubGlobal('addEventListener', vi.fn());
  vi.stubGlobal('acquireVsCodeApi', undefined);
  document.body.innerHTML = '<main></main><div id="project-menu"></div>';
  const parent = { postMessage: vi.fn() };
  vi.stubGlobal('window', { parent });
  const navigation = (id: string, create = false) => ({ navigation: { projectUri: 'project', activeId: id, updates: create ? [{ id, create }] : [] } });
  history.replaceState(null, '', '/?projectView=first'); const first = acquireProjectHost();
  first.setState(navigation('first-conversation', true));
  first.setState(navigation('first-conversation', true));
  expect(parent.postMessage).toHaveBeenCalledTimes(1);
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: 'workflow-navigation', version: 1, id: 'first-conversation', create: true }, '*');
  first.setState(navigation('first-conversation'));
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: 'workflow-navigation', version: 1, id: 'first-conversation', create: false }, '*');
  history.replaceState(null, '', '/?projectView=second'); const second = acquireProjectHost();
  expect(second.getState()).toBeNull(); second.setState(navigation('second-conversation'));
  expect(first.getState()).toEqual(navigation('first-conversation'));
  expect(second.getState()).toEqual(navigation('second-conversation'));
  history.replaceState(null, '', '/'); const ordinary = acquireProjectHost();
  expect(ordinary.getState()).toBeNull(); const calls = parent.postMessage.mock.calls.length;
  ordinary.setState(navigation('ordinary')); expect(parent.postMessage).toHaveBeenCalledTimes(calls);
});
