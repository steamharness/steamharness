// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { captureFileDrop, capturePickedDirectory, capturePickedFiles, type PickedDirectory } from '../web/ui/conversation-drop';
import { chooseConversationFiles } from '../web/ui/conversation-file-picker';
import { acquireProjectHost } from '../web/ui/host';

vi.mock('../web/ui/account', () => ({ AccountPanel: class {} }));
vi.mock('../web/ui/connection', () => ({ BrowserConnection: class {}, ConnectionError: class extends Error {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const folder = (name: string, children: (PickedDirectory | { kind: 'file'; name: string; getFile(): Promise<File> })[] = []): PickedDirectory => ({
  kind: 'directory', name, async *values() { yield* children; },
});

it('reads selected files with the same encoding as a drop and preserves relative directory paths', async () => {
  const file = new File(['内容'], 'a.txt', { type: 'text/plain' });
  const data = { types: ['Files'], getData: () => '', files: [file], items: [] } as unknown as DataTransfer;
  expect(await capturePickedFiles([file]).read()).toEqual(await captureFileDrop(data).read());
  Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/nested/a.txt' });
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    expect(this.webkitdirectory).toBe(true); expect(this.accept).toBe('');
    Object.defineProperty(this, 'files', { value: [file] }); this.dispatchEvent(new Event('change'));
  });
  const selected = await chooseConversationFiles('folders');
  expect(selected?.directories).toBe(true);
  expect((await selected!.read())[0].name).toBe('folder/nested/a.txt');
  expect(document.querySelector('input')).toBeNull();
});

it('selects unrestricted multiple files and cleans up a cancelled chooser', async () => {
  const files = [new File(['a'], 'a.exe'), new File(['b'], 'b.txt')];
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    expect(this.multiple).toBe(true); expect(this.accept).toBe('');
    Object.defineProperty(this, 'files', { value: files }); this.dispatchEvent(new Event('change'));
  });
  expect((await chooseConversationFiles('files'))?.files).toEqual(files);
  click.mockImplementation(function (this: HTMLInputElement) { this.dispatchEvent(new Event('cancel')); });
  expect(await chooseConversationFiles('files')).toBeUndefined(); expect(document.querySelector('input')).toBeNull();
});

it('keeps empty directories and nested files through directory selection', async () => {
  const directory = folder('root', [folder('empty'), folder('nested', [{ kind: 'file', name: 'a.txt', getFile: async () => new File(['a'], 'a.txt') }])]);
  const picker = vi.fn(async () => directory); vi.stubGlobal('showDirectoryPicker', picker);
  const selected = await chooseConversationFiles('folders');
  expect(picker).toHaveBeenCalledWith({ mode: 'read' });
  expect(await selected!.read()).toEqual([
    { name: 'root', kind: 'directory' }, { name: 'root/empty', kind: 'directory' }, { name: 'root/nested', kind: 'directory' },
    { name: 'root/nested/a.txt', kind: 'file', data: 'YQ==' },
  ]);
  expect(await capturePickedDirectory(folder('empty')).read()).toEqual([{ name: 'empty', kind: 'directory' }]);
});

it('handles directory cancellation, falls back when the browser blocks the directory API, and reports read failures', async () => {
  const picker = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); }); vi.stubGlobal('showDirectoryPicker', picker);
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { this.dispatchEvent(new Event('cancel')); });
  expect(await chooseConversationFiles('folders')).toBeUndefined(); expect(click).not.toHaveBeenCalled();
  picker.mockRejectedValueOnce(new DOMException('blocked', 'SecurityError'));
  expect(await chooseConversationFiles('folders')).toBeUndefined(); expect(click).toHaveBeenCalledOnce();
  picker.mockRejectedValueOnce(new Error('unavailable'));
  await expect(chooseConversationFiles('folders')).rejects.toThrow('unavailable');
  const unreadable = folder('root', [{ kind: 'file', name: 'denied', getFile: async () => { throw new Error('denied'); } }]);
  await expect(capturePickedDirectory(unreadable).read()).rejects.toThrow('denied');
});

it('shares the drop entry limit and keeps mixed source selections from losing browser files', async () => {
  await expect(capturePickedDirectory(folder('root', Array.from({ length: 1000 }, (_, i) => folder(String(i))))).read()).rejects.toThrow('1,000');
  const native = Object.assign(new File(['a'], 'a.txt'), { path: '/a.txt' }), browser = new File(['b'], 'b.txt');
  expect(capturePickedFiles([native]).paths).toEqual(['/a.txt']);
  const mixed = capturePickedFiles([native, browser]); expect(mixed.paths).toEqual([]); expect(await mixed.read()).toHaveLength(2);
});

function hostFixture() {
  const listeners = new Map<string, (event: any) => void>(), hideListeners: (() => void)[] = [], sent: any[] = [];
  const parent = { postMessage: (message: unknown) => sent.push(message) };
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
  vi.stubGlobal('addEventListener', (type: string, listener: (event: any) => void) => { if (type === 'pagehide') hideListeners.push(() => listener({})); listeners.set(type, listener); });
  vi.stubGlobal('acquireVsCodeApi', undefined);
  document.documentElement.dataset.theme = 'dark'; document.body.innerHTML = '<div id="project-menu"></div>';
  const emitted = vi.spyOn(window, 'dispatchEvent');
  const host = acquireProjectHost();
  const receive = (extra: object, source: unknown = parent) => listeners.get('message')!({ source, data: { type: 'workflow-host', ...extra } });
  const messages = () => emitted.mock.calls.map(([event]) => (event as MessageEvent).data);
  const request = { type: 'select-paths', kind: 'folders', requestId: 'picker-1', target: 'conversation:1', projectUri: 'file:///project', sessionId: 'one' };
  return { host, receive, sent, messages, request, close: () => hideListeners.forEach(hide => hide()) };
}

it('routes browser selection through the local chooser without posting files to a parent', async () => {
  const f = hostFixture(); await f.host.postMessage({ type: 'drop-target', target: f.request.target });
  const files = [new File(['a'], 'a.txt')];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    Object.defineProperty(this, 'files', { value: files }); this.dispatchEvent(new Event('change'));
  });
  await f.host.postMessage({ ...f.request, kind: 'files' });
  const result = f.messages().at(-1);
  expect(result).toMatchObject({ type: 'files-selected', requestId: f.request.requestId, target: f.request.target, projectUri: f.request.projectUri, sessionId: 'one' });
  expect(await result.selection.read()).toEqual([{ name: 'a.txt', kind: 'file', data: 'YQ==' }]);
  expect(f.sent.some(message => message.type === 'workflow-path-picker')).toBe(false);
});

it('authenticates native picker replies, correlates requests, and drops obsolete targets and page results', async () => {
  const f = hostFixture(); await f.host.postMessage({ type: 'drop-target', target: f.request.target });
  f.receive({ pathPickerVersion: 1 }); await f.host.postMessage(f.request);
  expect(f.sent.at(-1)).toEqual({ type: 'workflow-path-picker', version: 1, kind: 'folders', requestId: 'picker-1', target: f.request.target });
  const selected = { version: 1, requestId: 'picker-1', target: f.request.target, paths: ['file:///Desktop/folder'] };
  f.receive({ pathSelection: selected }, {}); f.receive({ pathSelection: { ...selected, version: 2 } });
  f.receive({ pathSelection: { ...selected, target: 'other' } }); f.receive({ pathSelection: { ...selected, requestId: 'other' } });
  expect(f.messages()).toHaveLength(0);
  f.receive({ pathSelection: selected }); expect(f.messages()).toHaveLength(1);
  expect(f.messages()[0].selection.paths).toEqual(selected.paths);
  f.receive({ pathSelection: selected }); expect(f.messages()).toHaveLength(1);
  await f.host.postMessage({ ...f.request, requestId: 'draft-sync' });
  await f.host.postMessage({ type: 'drop-target' });
  await f.host.postMessage({ type: 'drop-target', target: f.request.target });
  f.receive({ pathSelection: { ...selected, requestId: 'draft-sync' } }); expect(f.messages()).toHaveLength(2);
  await f.host.postMessage({ ...f.request, requestId: 'late' });
  await f.host.postMessage({ type: 'drop-target', target: 'conversation:2' });
  f.receive({ pathSelection: { ...selected, requestId: 'late' } }); expect(f.messages()).toHaveLength(2);
  await f.host.postMessage({ ...f.request, requestId: 'closed', target: 'conversation:2' });
  f.close();
  f.receive({ pathSelection: { ...selected, requestId: 'closed', target: 'conversation:2' } }); expect(f.messages()).toHaveLength(2);
});

it('emits native cancellation and errors with the original project and conversation identity', async () => {
  const f = hostFixture(); await f.host.postMessage({ type: 'drop-target', target: f.request.target }); f.receive({ pathPickerVersion: 1 });
  await f.host.postMessage(f.request);
  f.receive({ pathSelection: { version: 1, ...f.request, paths: [] } });
  expect(f.messages().at(-1)).toMatchObject({ type: 'files-selected', requestId: f.request.requestId, selection: undefined });
  await f.host.postMessage(f.request);
  f.receive({ pathSelection: { version: 1, ...f.request, paths: [], error: 'Native denied' } });
  expect(f.messages().at(-1)).toMatchObject({ type: 'error', requestType: 'select-paths', projectUri: f.request.projectUri, sessionId: 'one', message: 'Native denied' });
});
