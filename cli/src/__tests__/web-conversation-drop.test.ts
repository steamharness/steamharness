// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { captureFileDrop } from '../web/ui/conversation-drop';
import type { ConversationSession, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} } }));
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
const project: Project = { id: 'drop', uri: 'file:///drop', folderPath: '/drop', name: 'Drop', projectType: 'conversation', fields: [], entrypoints: [] };
const session = (id: string): ConversationSession => ({ id, title: id, messages: [], draft: { text: '', attachments: [] } });
const references = [{ path: '/workspace/资料', name: '资料', kind: 'directory' }, { path: '/tmp/a b.txt', name: 'a b.txt', kind: 'file' }];
const transfer = (data: Record<string, string>, extra: object = {}) => ({ types: Object.keys(data), getData: (type: string) => data[type] ?? '', files: [], items: [], ...extra }) as unknown as DataTransfer;

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { target, type, listener, options } of listeners.splice(0)) target.removeEventListener(type, listener, options);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); document.documentElement.lang = 'en';
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

async function fixture(language = 'en') {
  vi.resetModules(); vi.useFakeTimers(); host.postMessage.mockReset(); host.getState.mockReturnValue(undefined); host.setState.mockReset();
  document.documentElement.lang = language;
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
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  document.body.innerHTML = '<div id="app"></div>'; await import('../web/ui/main');
  const emit = (message: object) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  const receive = (activeId = 'first', readOnly = false, sessions = [session('first'), session('second')]) => {
    emit({ type: 'state', project, sessions, activeId, running: false, conversationAccess: { readOnly } });
    for (const frame of frames.splice(0)) frame(0);
  };
  const requests = (type: string) => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === type);
  const drop = (data: DataTransfer) => {
    const event = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: data });
    document.querySelector('main')!.dispatchEvent(event); return event;
  };
  receive(); return { emit, receive, requests, drop };
}

it.each(['en', 'zh-CN'])('renders removable file/folder cards, persists a path-only draft and submits it (%s)', async language => {
  const f = await fixture(language);
  const event = f.drop(transfer({ ResourceURLs: JSON.stringify(['file:///workspace/%E8%B5%84%E6%96%99', 'file:///tmp/a%20b.txt']) }));
  expect(event.defaultPrevented).toBe(true);
  const request = f.requests('resolve-paths')[0]; expect(request.paths).toHaveLength(2);
  expect(document.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
  f.emit({ type: 'path-references', requestId: request.requestId, projectUri: project.uri, sessionId: 'first', references });
  const cards = document.querySelectorAll('#draft-attachments .path-reference'); expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toContain('/workspace/资料');
  expect(cards[0].querySelector('.path-reference-icon')?.getAttribute('title')).toBe(language === 'en' ? 'Folder' : '文件夹');
  expect(host.setState.mock.calls.at(-1)![0].navigation.updates[0].draft.references).toEqual(references);
  expect(document.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(false);
  cards[1].querySelector<HTMLButtonElement>('button')!.click();
  expect(document.querySelectorAll('#draft-attachments .path-reference')).toHaveLength(1);
  document.querySelector<HTMLButtonElement>('#send')!.click();
  expect(f.requests('send').at(-1)).toMatchObject({ text: '', references: [references[0]] });
  expect(document.querySelectorAll('.message .path-reference').length).toBe(1);
});

it('ignores a late drop result after switching away and back, and accepts a new drop for the current draft', async () => {
  const f = await fixture(); f.drop(transfer({ 'text/uri-list': 'file:///tmp/old' })); const old = f.requests('resolve-paths')[0];
  f.receive('second'); f.receive('first');
  f.emit({ type: 'path-references', requestId: old.requestId, projectUri: project.uri, sessionId: 'first', references });
  expect(document.querySelectorAll('.path-reference')).toHaveLength(0);
  const target = f.requests('drop-target').at(-1).target;
  f.emit({ type: 'paths-dropped', target, paths: ['file:///tmp/new'] }); const current = f.requests('resolve-paths').at(-1);
  expect(current.requestId).not.toBe(old.requestId);
  f.emit({ type: 'path-references', requestId: current.requestId, projectUri: project.uri, sessionId: 'first', references: [references[1]] });
  expect(document.querySelectorAll('.path-reference')).toHaveLength(1);
});

it('blocks drops into a duplicate read-only conversation and ignores obsolete native targets', async () => {
  const f = await fixture(); const old = f.requests('drop-target').at(-1).target;
  f.receive('first', true); f.drop(transfer({ CodeFiles: JSON.stringify(['/tmp/file']) }));
  f.emit({ type: 'paths-dropped', target: old, paths: ['/tmp/file'] });
  expect(f.requests('resolve-paths')).toEqual([]); expect(f.requests('import-drop')).toEqual([]);
});

it('captures VS Code editor URIs, Windows CodeFiles and URI lists without accepting web links', () => {
  expect(captureFileDrop(transfer({ CodeEditors: JSON.stringify([{ resource: { scheme: 'file', path: '/work/a #.ts' } }]) })).paths).toEqual(['file:///work/a%20%23.ts']);
  expect(captureFileDrop(transfer({ codefiles: JSON.stringify(['C:\\work\\file.ts']) })).paths).toEqual(['C:\\work\\file.ts']);
  expect(captureFileDrop(transfer({ 'text/uri-list': '# comment\r\nhttps://example.com\r\nfile:///work/folder' })).paths).toEqual(['file:///work/folder']);
});

it('reads every browser directory batch, preserves empty folders, and captures entries before the drag store closes', async () => {
  vi.useRealTimers();
  const file = new File(['nested content'], 'a.txt');
  const entry = { name: 'root', isDirectory: true, createReader: () => {
    const batches = [[{ name: 'empty', isDirectory: true, createReader: () => ({ readEntries: (done: (entries: object[]) => void) => done([]) }) }],
      [{ name: 'a.txt', isDirectory: false, file: (done: (file: File) => void) => done(file) }], []];
    return { readEntries: (done: (entries: object[]) => void) => done(batches.shift()!) };
  } };
  const data = transfer({ Files: '' }, { items: [{ kind: 'file', webkitGetAsEntry: () => entry }] });
  const drop = captureFileDrop(data); Object.assign(data, { items: [], files: [] });
  const entries = await drop.read(); expect(entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
    { name: 'root', kind: 'directory' }, { name: 'root/empty', kind: 'directory' }, { name: 'root/a.txt', kind: 'file' },
  ]);
  expect(atob(entries[2].data!)).toBe('nested content');
});
