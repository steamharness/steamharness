import { afterEach, expect, it, vi } from 'vitest';
import { pasteHostClipboard, selectedText } from '../web/ui/edit-commands';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const events: any[] = [], files: File[] = [], data = new Map<string, string>(), execCommand = vi.fn(() => true);
  let readonly = false, cancelled = false;
  class Input {
    matches(selector: string) { return selector === ':disabled, [readonly]' ? readonly : true; }
    dispatchEvent(event: Event) { events.push(event); if (cancelled) { event.preventDefault(); } return !event.defaultPrevented; }
  }
  class Transfer {
    setData(type: string, value: string) { data.set(type, value); }
    getData(type: string) { return data.get(type) ?? ''; }
    items = { add: (file: File) => files.push(file) };
  }
  class Paste extends Event {
    readonly clipboardData: Transfer;
    constructor(type: string, options: ClipboardEventInit) { super(type, options); this.clipboardData = options.clipboardData as unknown as Transfer; }
  }
  const document = { activeElement: new Input(), execCommand };
  vi.stubGlobal('HTMLElement', Input); vi.stubGlobal('DataTransfer', Transfer); vi.stubGlobal('ClipboardEvent', Paste); vi.stubGlobal('document', document);
  return { events, files, data, execCommand, document, readonly: () => { readonly = true; }, cancel: () => { cancelled = true; } };
}

it('native clipboard text uses the active input and preserves its native editing and undo path', () => {
  const { events, data, execCommand } = fixture();
  pasteHostClipboard({ text: 'First line\n\u4e2d\u6587' });
  expect(events[0].type).toBe('paste'); expect(data.get('text/plain')).toBe('First line\n\u4e2d\u6587');
  expect(execCommand).toHaveBeenCalledWith('insertText', false, 'First line\n\u4e2d\u6587');
});

it('mixed clipboard data retains both image bytes and text for the existing attachment handler', async () => {
  const { files, execCommand, data } = fixture();
  const bytes = new Uint8Array([9, 1, 2, 3, 9]);
  pasteHostClipboard({ text: 'mixed text', image: bytes.subarray(1, 4) });
  expect(files[0].type).toBe('image/png'); expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect(data.get('text/plain')).toBe('mixed text'); expect(execCommand).toHaveBeenCalledWith('insertText', false, 'mixed text');
});

it('image-only and cancelled paste never insert text or bypass the input paste handler', () => {
  const { files, execCommand, cancel } = fixture();
  pasteHostClipboard({ text: '', image: new Uint8Array([1, 2, 3]) });
  expect(files).toHaveLength(1); expect(execCommand).not.toHaveBeenCalled();
  cancel(); pasteHostClipboard({ text: 'cancelled' }); expect(execCommand).not.toHaveBeenCalled();
});

it('malformed data, readonly fields and focus outside an input cannot change the document', () => {
  const { events, readonly, document } = fixture();
  pasteHostClipboard({ text: 123 }); pasteHostClipboard({ text: 'invalid', image: 'not bytes' });
  readonly(); pasteHostClipboard({ text: 'readonly' });
  document.activeElement = {} as any; pasteHostClipboard({ text: 'outside' });
  expect(events).toEqual([]);
});

it('copy reads rendered selections and input selections, including readonly values, without copying password fields', () => {
  const input = { value: 'Before selected After', selectionStart: 7, selectionEnd: 15, matches: () => false };
  const target = { closest: () => input } as unknown as Element;
  vi.stubGlobal('window', { getSelection: () => ({ toString: () => 'Rendered response\nError and log' }) });
  expect(selectedText(target)).toBe('selected');
  input.selectionEnd = input.selectionStart; expect(selectedText(target)).toBe('');
  input.matches = () => true; expect(selectedText(target)).toBe('');
  expect(selectedText({ closest: () => null } as unknown as Element)).toBe('Rendered response\nError and log');
  vi.stubGlobal('window', { getSelection: () => null });
  expect(selectedText(null)).toBe('');
});
