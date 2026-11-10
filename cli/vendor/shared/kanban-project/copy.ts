export type ProjectEditCommand = 'copy' | 'cut' | 'paste' | 'selectAll' | 'undo' | 'redo';
export interface ProjectCopyBridgeOptions {
  enabled(): boolean;
  writeText(text: string): Promise<boolean>;
  delegate?(command: ProjectEditCommand, restoreFocus: boolean, clipboard?: { text?: string; image?: unknown }): boolean;
  contextMenu?(value: { x: number; y: number; selection: boolean; editable: boolean }): void;
}

/** Self-contained for injection into opaque project and Conversation frames. */
export function installProjectCopyBridge(target: Window, options: ProjectCopyBridgeOptions) {
  const doc = target.document;
  let dispatching = false;
  let context: { text: string; field?: HTMLInputElement | HTMLTextAreaElement; value?: string; start?: number; end?: number } | undefined;
  let pointer: { x: number; y: number; interactive: Element | null } | undefined;
  // Array elements avoid bundler naming helpers in the serialized function.
  const [read] = [(): string => {
    const field = doc.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    if (field?.matches('input[type=password]')) return '';
    if (field?.matches('input,textarea') && typeof field.selectionStart === 'number' && typeof field.selectionEnd === 'number') return field.value.slice(field.selectionStart, field.selectionEnd);
    if (field?.matches('input[type=number],input[type=email]')) return field.value;
    return target.getSelection()?.toString() ?? '';
  }];
  const [write] = [async (text: string): Promise<boolean> => { try { return await options.writeText(text); } catch { return false; } }];
  const [command] = [(value: ProjectEditCommand, restoreFocus = false, clipboard?: { text?: string; image?: unknown }): boolean => {
    if (options.delegate?.(value, restoreFocus, clipboard)) return true;
    const saved = restoreFocus ? context : undefined; context = undefined;
    if (saved?.field) {
      if (!saved.field.isConnected || saved.field.value !== saved.value) return false;
      saved.field.focus({ preventScroll: true }); saved.field.setSelectionRange(saved.start!, saved.end!);
    }
    const field = doc.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    if (value === 'selectAll') {
      if (field?.matches('input,textarea') && typeof field.selectionStart === 'number') field.select();
      else { const range = doc.createRange(); range.selectNodeContents(doc.body); const selection = target.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      return true;
    }
    if (value === 'undo' || value === 'redo') {
      if (!field?.matches('input,textarea,[contenteditable=true]') || field.matches(':disabled,[readonly]')) return false;
      doc.execCommand(value); return true;
    }
    if (value === 'paste') {
      if (typeof clipboard?.text !== 'string' || !field?.matches('input,textarea,[contenteditable=true]') || field.matches(':disabled,[readonly]')) return false;
      const event = doc.createEvent('Event'); event.initEvent('paste', true, true);
      const [getData] = [(type: string) => type === 'text/plain' ? clipboard!.text! : ''];
      let data: { getData(type: string): string; files: File[] | FileList } = { getData, files: [] };
      const browser = target as Window & typeof globalThis;
      if (typeof browser.DataTransfer === 'function') {
        const transfer = new browser.DataTransfer(); transfer.setData('text/plain', clipboard.text);
        if (ArrayBuffer.isView(clipboard.image)) {
          const bytes = new Uint8Array(clipboard.image.buffer, clipboard.image.byteOffset, clipboard.image.byteLength);
          transfer.items.add(new browser.File([new Uint8Array(bytes)], 'clipboard.png', { type: 'image/png' }));
        }
        data = transfer;
      }
      Object.defineProperty(event, 'clipboardData', { value: data });
      field.dispatchEvent(event);
      if (!event.defaultPrevented) doc.execCommand('insertText', false, clipboard.text);
      return true;
    }
    if (field?.matches('input[type=password]')) return false;
    // Give editor-specific handlers a chance to serialize compact references.
    const values = new Map<string, string>();
    const [getData, setData, clearData] = [
      (type: string) => values.get(type) ?? '',
      (type: string, text: string) => { values.set(type, text); },
      () => values.clear(),
    ] as const;
    const data = { getData, setData, clearData };
    const event = doc.createEvent('Event'); event.initEvent('copy', true, true);
    Object.defineProperty(event, 'clipboardData', { value: data });
    dispatching = true;
    try { (doc.activeElement ?? doc.body).dispatchEvent(event); } finally { dispatching = false; }
    const text = event.defaultPrevented ? data.getData('text/plain') : saved?.text ?? read();
    if (!text) return false;
    if (value === 'cut') {
      if (!field?.matches('input,textarea') || field.readOnly || field.disabled || typeof field.selectionStart !== 'number') return false;
      const original = field.value, start = field.selectionStart, end = field.selectionEnd;
      void write(text).then(ok => {
        if (ok && field.isConnected && doc.activeElement === field && field.value === original && field.selectionStart === start && field.selectionEnd === end) doc.execCommand('delete');
      });
    } else void write(text);
    return true;
  }];
  const [onCopy] = [(event: Event): void => {
    if (dispatching || !options.enabled() || doc.activeElement?.matches('input[type=password]')) return;
    const custom = (event as ClipboardEvent).clipboardData?.getData('text/plain');
    const text = event.defaultPrevented ? custom : custom || read();
    if (!text) return;
    event.preventDefault(); void write(text);
  }];
  const [onCut] = [(event: Event): void => {
    if (!options.enabled() || event.defaultPrevented || !doc.activeElement?.matches('input:not([readonly]):not(:disabled),textarea:not([readonly]):not(:disabled)') || !read()) return;
    event.preventDefault(); command('cut');
  }];
  const [onMenu] = [(event: MouseEvent): void => {
    if (!options.enabled() || !options.contextMenu || event.defaultPrevented) return;
    const field = (event.target as Element | null)?.closest<HTMLInputElement | HTMLTextAreaElement>('input,textarea');
    if (field?.matches('input[type=password]')) return;
    if (field) field.focus({ preventScroll: true });
    const text = read(), editable = !!field && !field.readOnly && !field.disabled;
    if (!text && !editable) return;
    context = { text, ...(field && typeof field.selectionStart === 'number' ? { field, value: field.value, start: field.selectionStart, end: field.selectionEnd! } : {}) };
    event.preventDefault(); options.contextMenu({ x: event.clientX, y: event.clientY, selection: !!text, editable });
  }];
  const [onDown] = [(event: PointerEvent): void => {
    context = undefined;
    pointer = { x: event.clientX, y: event.clientY, interactive: (event.target as Element | null)?.closest('button,a,[role=button]') ?? null };
  }];
  const [onClick] = [(event: MouseEvent): void => {
    const start = pointer; pointer = undefined;
    if (!event.detail || !start?.interactive || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
    const selection = target.getSelection();
    if (selection && !selection.isCollapsed && (start.interactive.contains(selection.anchorNode) || start.interactive.contains(selection.focusNode))) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }];
  target.addEventListener('copy', onCopy); target.addEventListener('cut', onCut); target.addEventListener('contextmenu', onMenu);
  doc.addEventListener('pointerdown', onDown, true); doc.addEventListener('click', onClick, true);
  const [dispose] = [(): void => {
    target.removeEventListener('copy', onCopy); target.removeEventListener('cut', onCut); target.removeEventListener('contextmenu', onMenu);
    doc.removeEventListener('pointerdown', onDown, true); doc.removeEventListener('click', onClick, true);
    context = undefined; pointer = undefined;
  }];
  return { command, dispose };
}
