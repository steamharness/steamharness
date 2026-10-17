export type TextEditCommand = 'selectAll' | 'undo' | 'redo';

export function textEditShortcut(event: KeyboardEvent): TextEditCommand | undefined {
  if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) { return; }
  const key = event.key.toLowerCase();
  if (key === 'a' && !event.shiftKey) { return 'selectAll'; }
  if (key === 'z') { return event.shiftKey ? 'redo' : 'undo'; }
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) { return 'redo'; }
}

export function editText(command: TextEditCommand, target: Element | null = document.activeElement): boolean {
  const input = target?.closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  const editable = input ?? target?.closest<HTMLElement>('[contenteditable=true]');
  if (!editable || editable.matches(':disabled')) { return false; }
  if (input) {
    if (input.selectionStart === null && !input.matches('input[type=email]')) { return false; }
    input.focus({ preventScroll: true });
    if (command === 'selectAll') { input.select(); return true; }
    if (input.readOnly) { return true; }
  } else {
    editable.focus({ preventScroll: true });
    if (command === 'selectAll') {
      const range = document.createRange(); range.selectNodeContents(editable);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return true;
    }
  }
  document.execCommand(command);
  return true;
}

export function selectedText(target: Element | null = document.activeElement): string {
  const input = target?.closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  if (input?.matches('input[type=password]')) { return ''; }
  if (input && typeof input.selectionStart === 'number' && typeof input.selectionEnd === 'number') {
    return input.value.slice(input.selectionStart, input.selectionEnd);
  }
  return window.getSelection()?.toString() ?? '';
}

export function pasteHostClipboard(clipboard: { text?: unknown; image?: unknown }): void {
  if (typeof clipboard.text !== 'string' || clipboard.image !== undefined && !ArrayBuffer.isView(clipboard.image)) { return; }
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || !target.matches('textarea, input, [contenteditable=true]') || target.matches(':disabled, [readonly]')) { return; }
  const transfer = new DataTransfer();
  transfer.setData('text/plain', clipboard.text);
  if (clipboard.image && clipboard.image.byteLength) {
    const image = new Uint8Array(clipboard.image.buffer, clipboard.image.byteOffset, clipboard.image.byteLength);
    transfer.items.add(new File([new Uint8Array(image)], 'clipboard.png', { type: 'image/png' }));
  }
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
  target.dispatchEvent(event);
  if (!event.defaultPrevented && clipboard.text) { document.execCommand('insertText', false, clipboard.text); }
}
