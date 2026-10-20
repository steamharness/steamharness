import type { WebviewMenuAction } from '../src/webview-context-menu-types';

export interface ContextAction { id: WebviewMenuAction; run(): void | Promise<void> }
interface Host { postMessage(message: object): void }
export type ContextActions = (target: Element, copy: (text: string) => void) => ContextAction[];

/** Keep editable fields native; object menus and read-only selections never offer Cut/Paste. */
export function installContextMenu(host: Host, resolve: ContextActions, version: () => unknown = () => undefined,
  anchor: (target: Element) => Element = target => target): void {
  const id = document.querySelector<HTMLMetaElement>('meta[name="studio-context-menu"]')?.content;
  if (!id) { return; }
  let serial = 0;
  let current: { target: Element; attribute: string | null; request: number; version: unknown; selection?: string } | undefined;
  const restore = (): void => {
    if (!current) { return; }
    if (current.attribute === null) { current.target.removeAttribute('data-vscode-context'); }
    else { current.target.setAttribute('data-vscode-context', current.attribute); }
    current = undefined;
  };
  const copy = (text: string, request: number): void => host.postMessage({ type: 'studio-context-copy', menu: id, request, text });
  const actionsFor = (target: Element, request: number): ContextAction[] => {
    const field = target.closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    if (field) {
      if (field.disabled || field.matches('input[type="password"]')) { return []; }
      return field.value ? [{ id: 'copy', run: () => copy(field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? field.value.length) || field.value, request) }] : [];
    }
    return resolve(target, text => copy(text, request));
  };
  document.addEventListener('contextmenu', event => {
    restore();
    if (event.defaultPrevented || !(event.target instanceof Element)) { return; }
    const target = event.target;
    const field = target.closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    if (field && (field.disabled || ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(field.type))) { event.preventDefault(); return; }
    if (field ? !field.readOnly && !field.disabled : (target as HTMLElement).isContentEditable) { return; }
    if (field?.matches('input[type="password"]')) { event.preventDefault(); return; }
    const selected = field ? null : window.getSelection();
    const selection = field ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? field.value.length) || field.value || undefined
      : selected && Array.from({ length: selected.rangeCount }, (_, index) => selected.getRangeAt(index))
        .some(range => range.intersectsNode(target)) ? selected!.toString() || undefined : undefined;
    const request = ++serial;
    const menuTarget = anchor(target);
    const actions = selection ? [{ id: 'copy' as const, run() {} }] : actionsFor(menuTarget, request);
    if (!actions.length) { event.preventDefault(); return; }
    current = { target: menuTarget, attribute: menuTarget.getAttribute('data-vscode-context'), request, version: version(), selection };
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(current.attribute ?? '{}'); } catch { /* Ignore malformed third-party context attributes. */ }
    menuTarget.setAttribute('data-vscode-context', JSON.stringify({ ...existing, preventDefaultContextMenuItems: true,
      studioContextMenu: id, studioContextRequest: request,
      ...Object.fromEntries(actions.map(action => [`studioContextAction_${action.id}`, true])) }));
  });
  window.addEventListener('message', event => {
    const menu = current, message = event.data;
    if (message?.type !== 'studio-context-action' || message.menu !== id || !menu || message.request !== menu.request
      || !menu.target.isConnected || menu.version !== version()) { return; }
    if (menu.selection) {
      if (message.action === 'copy') { copy(menu.selection, menu.request); restore(); }
      return;
    }
    const action = actionsFor(menu.target, menu.request).find(action => action.id === message.action);
    if (action) { restore(); void action.run(); }
  });
  document.addEventListener('pointerdown', event => { if (event.button !== 2) { restore(); } });
  window.addEventListener('pagehide', restore);
}
