import { afterEach, expect, it, vi } from 'vitest';
import { ClipboardBridge } from '../web/ui/clipboard-bridge';
import { acquireProjectHost } from '../web/ui/host';
import { pasteHostClipboard, selectedText } from '../web/ui/edit-commands';

vi.mock('../web/ui/account', () => ({ AccountPanel: class {} }));
vi.mock('../web/ui/connection', () => ({ BrowserConnection: class {}, ConnectionError: class extends Error {} }));
vi.mock('../web/ui/edit-commands', () => ({
  pasteHostClipboard: vi.fn(), selectedText: vi.fn(() => ''),
  editText: vi.fn((command: string) => document.execCommand(command)),
  textEditShortcut: vi.fn(() => undefined),
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  const sent: Record<string, any>[] = [], browserWrite = vi.fn(async () => {});
  const bridge = new ClipboardBridge(message => sent.push(message), browserWrite);
  return { bridge, sent, browserWrite };
}

it('a standalone browser uses its clipboard API', async () => {
  const { bridge, browserWrite, sent } = fixture();
  await bridge.writeText('browser text');
  expect(browserWrite).toHaveBeenCalledWith('browser text'); expect(sent).toEqual([]);
});

it('an embedding host confirms each copy, preserving text without using the browser clipboard', async () => {
  const { bridge, browserWrite, sent } = fixture(); bridge.enable(1);
  let copied = false;
  const pending = bridge.writeText('正文\nconst example = 1;').then(() => { copied = true; });
  expect(sent[0]).toMatchObject({ type: 'workflow-clipboard', version: 1, command: 'writeText', text: '正文\nconst example = 1;' });
  bridge.receive({ version: 2, requestId: sent[0].requestId, ok: true });
  bridge.receive({ version: 1, requestId: 'unrelated', ok: true });
  bridge.receive({ version: 1, requestId: sent[0].requestId, ok: 'true' });
  await Promise.resolve(); expect(copied).toBe(false);
  bridge.receive({ version: 1, requestId: sent[0].requestId, ok: true });
  await pending; expect(copied).toBe(true); expect(browserWrite).not.toHaveBeenCalled();
});

it('native copy failures, timeouts and closing the view settle pending requests', async () => {
  vi.useFakeTimers();
  const { bridge, sent } = fixture(); bridge.enable(1);
  let pending = bridge.writeText('denied');
  const denied = expect(pending).rejects.toThrow('native denied');
  bridge.receive({ version: 1, requestId: sent[0].requestId, ok: false, error: 'native denied' }); await denied;
  pending = bridge.writeText('timeout'); const timeout = expect(pending).rejects.toThrow('Copy timed out.');
  await vi.advanceTimersByTimeAsync(10_000); await timeout;
  pending = bridge.writeText('closing'); const closed = expect(pending).rejects.toThrow('Connection changed.');
  bridge.dispose(); await closed;
  expect(vi.getTimerCount()).toBe(0);
  pending = bridge.writeText('reopened'); bridge.receive({ version: 1, requestId: sent.at(-1)!.requestId, ok: true }); await pending;
});

it('Studio waits for host support instead of falling back to a denied iframe clipboard', async () => {
  const browserWrite = vi.fn(async () => {});
  const bridge = new ClipboardBridge(vi.fn(), browserWrite, true);
  await expect(bridge.writeText('hosted')).rejects.toThrow('Host clipboard is unavailable.');
  expect(browserWrite).not.toHaveBeenCalled();
});

it('the UI host accepts clipboard replies only from its parent and exposes the confirmed result', async () => {
  const listeners = new Map<string, (event: any) => void>(), sent: Record<string, any>[] = [], emitted: any[] = [];
  const parent = { postMessage: (message: Record<string, any>) => sent.push(message) };
  const browserWrite = vi.fn(async () => { throw new Error('iframe denied'); });
  const execCommand = vi.fn((_command: string) => true);
  class TargetElement { closest = vi.fn(); matches = vi.fn(() => true); }
  vi.stubGlobal('Element', TargetElement);
  vi.stubGlobal('HTMLElement', TargetElement);
  vi.stubGlobal('window', { parent, dispatchEvent: (event: MessageEvent) => emitted.push(event.data) });
  const document = { documentElement: { dataset: { theme: 'dark' } }, body: { dataset: { accountHost: 'true' } }, activeElement: undefined as unknown, querySelector: () => ({ content: 'project' }), execCommand };
  vi.stubGlobal('document', document);
  vi.stubGlobal('location', { pathname: '/' });
  vi.stubGlobal('navigator', { clipboard: { writeText: browserWrite } });
  vi.stubGlobal('acquireVsCodeApi', undefined);
  vi.stubGlobal('addEventListener', (type: string, listener: (event: any) => void) => listeners.set(type, listener));
  const host = acquireProjectHost();
  const receive = (source: unknown, extra: Record<string, any>) => listeners.get('message')!({ source, data: { type: 'workflow-host', ...extra } });
  receive({}, { editCommand: 'paste' });
  receive(parent, { editCommand: 'insertHTML' });
  expect(execCommand).not.toHaveBeenCalled();
  for (const editCommand of ['paste', 'copy', 'cut', 'selectAll', 'undo', 'redo']) { receive(parent, { editCommand }); }
  expect(execCommand.mock.calls.map(([command]) => command)).toEqual(['paste', 'cut', 'selectAll', 'undo', 'redo']);
  receive({}, { clipboardVersion: 1 });
  expect(await host.postMessage({ type: 'copy', text: 'before handshake' })).toBe(false);
  receive(parent, { clipboardVersion: 1 });
  expect(sent.shift()).toEqual({ type: 'workflow-edit', version: 1 });
  const input = { focus: vi.fn(), setSelectionRange: vi.fn(), matches: vi.fn((selector: string) => selector !== 'input[type=password]'), isConnected: true, value: 'Before selection After', selectionStart: 7, selectionEnd: 16, selectionDirection: 'forward' }, target = new TargetElement(), preventDefault = vi.fn();
  target.closest.mockReturnValue(null);
  const contextMenu = (defaultPrevented = false) => listeners.get('contextmenu')!({ target, defaultPrevented, preventDefault, clientX: 40, clientY: 50 });
  contextMenu(); expect(sent).toEqual([]); preventDefault.mockClear();
  target.closest.mockReturnValue(input); contextMenu(true); expect(sent).toEqual([]);
  contextMenu(); expect(preventDefault).toHaveBeenCalledOnce(); expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(sent.shift()).toEqual({ type: 'workflow-contextmenu', version: 1, x: 40, y: 50, editable: true, selection: false });
  Object.assign(input, { readOnly: true });
  vi.mocked(selectedText).mockReturnValue('readonly selection'); contextMenu();
  expect(sent.shift()).toEqual({ type: 'workflow-contextmenu', version: 1, x: 40, y: 50, editable: false, selection: true });
  vi.mocked(selectedText).mockReturnValue(''); contextMenu(); expect(sent).toEqual([]);
  Object.assign(input, { readOnly: false });
  const keydown = (extra: Record<string, unknown> = {}) => listeners.get('keydown')!({ target, key: 'v', ctrlKey: false, metaKey: true, preventDefault, stopPropagation: vi.fn(), ...extra });
  keydown(); expect(sent).toEqual([]);
  receive(parent, { nativePasteVersion: 1 });
  keydown({ defaultPrevented: true }); keydown({ altKey: true }); keydown({ shiftKey: true }); keydown({ key: 'c' }); keydown({ metaKey: false });
  expect(sent).toEqual([]);
  keydown(); expect(sent.shift()).toEqual({ type: 'workflow-edit', version: 1, command: 'paste' });
  const pending = host.postMessage({ type: 'copy', text: 'copied through VS Code' });
  expect(sent[0].text).toBe('copied through VS Code');
  receive({}, { clipboard: { version: 1, requestId: sent[0].requestId, ok: true } });
  receive(parent, { clipboard: { version: 1, requestId: sent[0].requestId, ok: true } });
  expect(await pending).toBe(true);
  const failed = host.postMessage({ type: 'copy', text: 'denied by native host' });
  receive(parent, { clipboard: { version: 1, requestId: sent[1].requestId, ok: false, error: 'native denied' } });
  expect(await failed).toBe(false); expect(emitted.at(-1)).toMatchObject({ type: 'error', message: 'native denied' });
  expect(browserWrite).not.toHaveBeenCalled();
  contextMenu(); receive(parent, { editCommand: 'paste', restoreFocus: true });
  expect(input.setSelectionRange).toHaveBeenCalledWith(7, 16, 'forward');
  contextMenu(); input.focus.mockClear(); input.setSelectionRange.mockClear();
  input.value = 'Changed while the menu was open';
  const commandsBefore = execCommand.mock.calls.length;
  receive(parent, { editCommand: 'paste', restoreFocus: true });
  expect(input.focus).not.toHaveBeenCalled(); expect(input.setSelectionRange).not.toHaveBeenCalled(); expect(execCommand).toHaveBeenCalledTimes(commandsBefore);
  contextMenu(); input.focus.mockClear(); const outside = new TargetElement(); outside.closest.mockReturnValue(null);
  listeners.get('pointerdown')!({ button: 0, target: outside });
  receive(parent, { editCommand: 'paste', restoreFocus: true }); expect(input.focus).not.toHaveBeenCalled();
  const recentInput = Object.assign(new TargetElement(), { ...input, value: 'Recent selection', selectionStart: 7, selectionEnd: 16, focus: vi.fn(), setSelectionRange: vi.fn() });
  document.activeElement = recentInput;
  listeners.get('focusin')!({ target: recentInput });
  recentInput.selectionStart = 0; recentInput.selectionEnd = 6;
  listeners.get('selectionchange')!({});
  document.activeElement = document.body;
  recentInput.selectionStart = 7; recentInput.selectionEnd = 16;
  listeners.get('input')!({ target: recentInput });
  listeners.get('selectionchange')!({ target: recentInput });
  const clipboardData = { text: 'Native menu text', image: new Uint8Array() };
  receive(parent, { editCommand: 'paste', clipboardData });
  expect(recentInput.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(recentInput.setSelectionRange).toHaveBeenCalledWith(7, 16, 'forward');
  expect(pasteHostClipboard).toHaveBeenCalledWith(clipboardData);
  receive(parent, { nativePasteVersion: 0 }); keydown();
  expect(sent.some(message => message.command === 'paste')).toBe(false);
  sent.length = 0;
  const acknowledgeCopy = (text: string) => {
    const request = sent.pop()!;
    expect(request).toMatchObject({ type: 'workflow-clipboard', version: 1, command: 'writeText', text });
    receive(parent, { clipboard: { version: 1, requestId: request.requestId, ok: true } });
  };
  vi.mocked(selectedText).mockReturnValue('Rendered text after input loses focus');
  receive(parent, { editCommand: 'copy' }); acknowledgeCopy('Rendered text after input loses focus');
  listeners.get('pointerdown')!({ button: 0, target: outside });
  document.activeElement = document.body;
  vi.mocked(selectedText).mockReturnValue('Selected response\n\u4e2d\u6587');
  keydown({ target: outside, key: 'c' }); acknowledgeCopy('Selected response\n\u4e2d\u6587');
  keydown({ target: outside, key: 'c', metaKey: false, ctrlKey: true }); acknowledgeCopy('Selected response\n\u4e2d\u6587');
  listeners.get('copy')!({ preventDefault }); acknowledgeCopy('Selected response\n\u4e2d\u6587');
  vi.mocked(selectedText).mockReturnValue('Database binding error\nDiagnostic log');
  target.closest.mockReturnValue(null); contextMenu(); sent.length = 0;
  vi.mocked(selectedText).mockReturnValue('');
  receive(parent, { editCommand: 'copy', restoreFocus: true }); acknowledgeCopy('Database binding error\nDiagnostic log');
  receive(parent, { editCommand: 'copy' }); expect(sent).toEqual([]);
  expect(execCommand.mock.calls.some(([command]) => command === 'copy')).toBe(false);
  target.closest.mockReturnValue(input); input.value = 'Before selection After'; contextMenu(); sent.length = 0;
  receive(parent, { editCommand: 'copy', restoreFocus: true }); acknowledgeCopy('selection');
  contextMenu(); sent.length = 0; input.value = 'Changed';
  receive(parent, { editCommand: 'copy', restoreFocus: true }); expect(sent).toEqual([]);
  await host.postMessage({ type: 'drop-target', target: 'conversation:2' });
  expect(sent.pop()).toEqual({ type: 'workflow-drop-target', version: 1, target: 'conversation:2' });
  const drop = { target: 'conversation:2', paths: ['file:///Desktop/folder'] };
  const beforeDrop = emitted.length;
  receive({}, { drop }); receive(parent, { drop: { ...drop, target: 'old-conversation' } });
  expect(emitted).toHaveLength(beforeDrop);
  receive(parent, { drop }); expect(emitted.at(-1)).toEqual({ type: 'paths-dropped', ...drop });
  await host.postMessage({ type: 'drop-target' }); receive(parent, { drop });
  expect(emitted).toHaveLength(beforeDrop + 1);
  await Promise.resolve();
});
