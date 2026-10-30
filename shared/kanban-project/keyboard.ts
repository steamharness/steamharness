export interface ProjectKeyboardEvent {
  type: 'keydown' | 'keyup';
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

/** Self-contained so the same handler can be injected into sandboxed Kanban pages. */
export function installProjectKeyboardBridge(target: Window, enabled: () => boolean, forward: (event: ProjectKeyboardEvent) => void): () => void {
  const pressed = new Set<string>();
  const pending = new Map<EventListener, number>();
  // Anonymous array elements keep serialized callbacks free of bundler naming helpers.
  const [capture] = [(event: KeyboardEvent) => {
    if (!['keydown', 'keyup'].includes(event.type) || !enabled() || event.isComposing || event.keyCode === 229 || event.key === 'Dead' || event.getModifierState('AltGraph')) return;
    const id = event.code || event.key;
    if (event.type === 'keyup' && !pressed.delete(id)) return;
    const key = event.key.toLowerCase();
    // Native editing belongs to the focused document, including readonly selections.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (
      !event.shiftKey && ['a', 'c', 'x'].includes(key) || ['v', 'z'].includes(key)
      || key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey
    )) return;
    const input = (event.composedPath()[0] as Element | undefined)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    if (input && /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Backspace|Delete)$/.test(event.key)) return;
    if (input && event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) return;

    // Add the fallback during capture so existing project/window handlers run first,
    // even when those handlers were registered after this bridge was installed.
    const [finish]: EventListener[] = [current => {
      if (current !== event) return;
      target.removeEventListener(event.type, finish);
      target.clearTimeout(pending.get(finish)); pending.delete(finish);
      if (!enabled() || event.defaultPrevented || event.cancelBubble) return;
      if (event.type === 'keydown') {
        pressed.add(id);
        if (event.ctrlKey || event.metaKey || event.altKey || /^F\d{1,2}$/.test(event.key)) event.preventDefault();
      }
      forward({ type: event.type as ProjectKeyboardEvent['type'], key: event.key, code: event.code, keyCode: event.keyCode,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat });
    }];
    target.addEventListener(event.type, finish);
    pending.set(finish, target.setTimeout(() => {
      target.removeEventListener(event.type, finish); pending.delete(finish);
    }, 0));
  }];
  target.addEventListener('keydown', capture, true);
  target.addEventListener('keyup', capture, true);
  return () => {
    target.removeEventListener('keydown', capture, true); target.removeEventListener('keyup', capture, true);
    for (const [finish, timer] of pending) {
      target.removeEventListener('keydown', finish); target.removeEventListener('keyup', finish); target.clearTimeout(timer);
    }
    pending.clear(); pressed.clear();
  };
}

export function isProjectKeyboardEvent(value: unknown): value is ProjectKeyboardEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as ProjectKeyboardEvent;
  return ['keydown', 'keyup'].includes(event.type) && typeof event.key === 'string' && event.key.length <= 64
    && typeof event.code === 'string' && event.code.length <= 64 && Number.isInteger(event.keyCode) && event.keyCode >= 0 && event.keyCode <= 255
    && ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat'].every(key => typeof (event as unknown as Record<string, unknown>)[key] === 'boolean');
}
