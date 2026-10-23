// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { captureFileDrop, capturePickedFiles } from '../web/ui/conversation-drop';
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
  for (const name of ['scrollIntoView', 'showPopover', 'hidePopover']) Reflect.deleteProperty(HTMLElement.prototype, name);
});

async function fixture(language = 'en', currentProject = project) {
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
  const openPopovers = new Set<Element>(), matches = Element.prototype.matches;
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value(this: HTMLElement) { openPopovers.add(this); this.dispatchEvent(new Event('toggle')); } });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value(this: HTMLElement) { openPopovers.delete(this); this.dispatchEvent(new Event('toggle')); } });
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? openPopovers.has(this) : matches.call(this, selector); });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  document.body.innerHTML = '<div id="app"></div>'; await import('../web/ui/main');
  const emit = (message: object) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  const receive = (activeId = 'first', readOnly = false, sessions = [session('first'), session('second')]) => {
    emit({ type: 'state', project: currentProject, sessions, activeId, running: false, conversationAccess: { readOnly } });
    for (const frame of frames.splice(0)) frame(0);
  };
  const requests = (type: string) => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === type);
  const drop = (data: DataTransfer) => {
    const event = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: data });
    document.querySelector('main')!.dispatchEvent(event); return event;
  };
  const choose = (kind: 'files' | 'folders') => {
    document.querySelector<HTMLButtonElement>('#attach')!.click();
    document.querySelector<HTMLButtonElement>(`#conversation-file-menu [data-kind=${kind}]`)!.click();
    return requests('select-paths').at(-1);
  };
  const acknowledgeDraft = () => {
    const navigation = requests('navigate').at(-1);
    if (navigation) emit({ type: 'navigated', requestId: navigation.requestId, activeId: navigation.id });
  };
  receive(); return { emit, receive, requests, drop, choose, acknowledgeDraft };
}

it.each(['en', 'zh-CN'])('selects files and folders without an attachment declaration and reuses drop cards and submission (%s)', async language => {
  const f = await fixture(language), button = document.querySelector<HTMLButtonElement>('#attach')!;
  expect(button.hidden).toBe(false); expect(button.disabled).toBe(false);
  expect(button.ariaLabel).toBe(language === 'en' ? 'Add files or folders' : '添加文件或文件夹');
  expect(document.querySelector('[data-kind=folders]')!.textContent).toBe(language === 'en' ? 'Choose folders' : '选择文件夹');
  const selected = f.choose('folders');
  expect(f.requests('attach')).toEqual([]); expect(selected).toMatchObject({ kind: 'folders', projectUri: project.uri, sessionId: 'first' });
  f.emit({ ...selected, type: 'files-selected', selection: { paths: ['file:///workspace/folder'], read: async () => [] } });
  const resolved = f.requests('resolve-paths')[0]; expect(resolved.requestId).toBe(selected.requestId);
  f.emit({ type: 'path-references', requestId: resolved.requestId, projectUri: project.uri, sessionId: 'first', references });
  f.acknowledgeDraft();
  f.drop(transfer({ CodeFiles: JSON.stringify(['/workspace/资料']) }));
  expect(f.requests('resolve-paths').at(-1).requestId).not.toBe(selected.requestId);
  f.emit({ type: 'path-references', requestId: f.requests('resolve-paths').at(-1).requestId, projectUri: project.uri, sessionId: 'first', references: [references[0]] });
  expect(document.querySelectorAll('#draft-attachments .path-reference')).toHaveLength(2);
  document.querySelector<HTMLButtonElement>('#send')!.click();
  expect(f.requests('send').at(-1)).toMatchObject({ text: '', references });
});

it('uses the same browser import and directory paths for selection and dropping', async () => {
  const f = await fixture();
  const picked = f.choose('files');
  const entries = [{ name: 'folder', kind: 'directory' }, { name: 'folder/a.txt', kind: 'file', data: 'YQ==' }];
  f.emit({ ...picked, type: 'files-selected', selection: { paths: [], directories: true, read: async () => entries } });
  await Promise.resolve();
  expect(f.requests('import-drop')[0]).toMatchObject({ requestId: picked.requestId, entries });
  expect(document.querySelector<HTMLButtonElement>('#attach')!.disabled).toBe(true);
  f.emit({ type: 'path-references', requestId: picked.requestId, projectUri: project.uri, sessionId: 'first', references });
  f.acknowledgeDraft();
  expect(document.querySelectorAll('#draft-attachments .path-reference')).toHaveLength(2);
  expect(document.querySelector<HTMLButtonElement>('#attach')!.disabled).toBe(false);
});

it('cancels pickers, reports their errors and ignores results after navigation or a read-only change', async () => {
  const f = await fixture(); let selected = f.choose('files');
  f.emit({ ...selected, type: 'files-selected' });
  expect(document.querySelector<HTMLButtonElement>('#attach')!.disabled).toBe(false);
  selected = f.choose('folders');
  f.emit({ ...selected, type: 'error', requestType: 'select-paths', message: 'Picker denied' });
  expect(document.querySelector('#error')!.textContent).toBe('Picker denied');
  selected = f.choose('files'); f.receive('second'); f.receive('first');
  f.emit({ ...selected, type: 'files-selected', selection: { paths: ['/old'], read: async () => [] } });
  f.emit({ ...selected, type: 'error', requestType: 'select-paths', message: 'Stale error' });
  expect(document.querySelector('#error')!.textContent).not.toBe('Stale error');
  selected = f.choose('folders'); f.receive('first', true);
  f.emit({ ...selected, type: 'files-selected', selection: { paths: ['/read-only'], read: async () => [] } });
  expect(f.requests('resolve-paths')).toEqual([]);
  f.receive('first'); expect(document.querySelector<HTMLButtonElement>('#attach')!.disabled).toBe(false);
});

it('supports keyboard file-menu selection and keeps native image choices as original path references', async () => {
  const f = await fixture('en', { ...project, conversation: { attachments: { images: true } } });
  const trigger = document.querySelector<HTMLButtonElement>('#attach')!;
  trigger.click(); expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const menu = document.querySelector<HTMLElement>('#conversation-file-menu')!;
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect((document.activeElement as HTMLElement).dataset.kind).toBe('folders');
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.activeElement).toBe(trigger); expect(trigger.getAttribute('aria-expanded')).toBe('false');
  const selected = f.choose('files');
  f.emit({ ...selected, type: 'files-selected', selection: { paths: ['file:///Desktop/image.png'], read: async () => [] } });
  expect(f.requests('resolve-paths')[0].paths).toEqual(['file:///Desktop/image.png']);
  expect(f.requests('upload')).toEqual([]);
});

it('keeps browser image selection and image drops on the same thumbnail upload path', async () => {
  const f = await fixture('en', { ...project, conversation: { attachments: { images: true } } });
  const file = new File(['image'], 'a.png', { type: 'image/png' });
  const pending: FileReader[] = [];
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) { pending.push(this); });
  const finish = async () => {
    const reader = pending.shift()!;
    Object.defineProperty(reader, 'result', { value: 'data:image/png;base64,aW1hZ2U=' }); reader.onload!(new ProgressEvent('load') as ProgressEvent<FileReader>);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  };
  const selected = f.choose('files');
  f.emit({ ...selected, type: 'files-selected', selection: capturePickedFiles([file]) });
  await finish();
  const upload = f.requests('upload')[0]; expect(upload.requestId).toBe(selected.requestId);
  expect(upload.files).toEqual([{ name: 'a.png', mimeType: 'image/png', data: 'aW1hZ2U=' }]);
  f.emit({ type: 'attachments', projectUri: project.uri, sessionId: 'first', requestId: upload.requestId, files: [] });
  f.acknowledgeDraft();
  f.drop(transfer({ Files: '' }, { files: [file] })); await finish();
  expect(f.requests('upload')[1].files).toEqual(upload.files);
  expect(f.requests('import-drop')).toEqual([]);
  const old = f.requests('upload')[1]; f.receive('second'); f.receive('first');
  f.emit({ type: 'attachments', projectUri: project.uri, sessionId: 'first', requestId: old.requestId, files: [{ id: 'late-image', kind: 'image', mimeType: 'image/png' }] });
  expect(document.querySelectorAll('#draft-attachments .attachment')).toHaveLength(0);
});

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
