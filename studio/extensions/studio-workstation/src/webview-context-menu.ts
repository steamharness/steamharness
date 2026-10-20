import * as vscode from 'vscode';
import { webviewMenuActions } from './webview-context-menu-types';
import { t } from './localization';

interface MenuOwner { webview: vscode.Webview; visible: boolean; onDidDispose: vscode.Event<void> }
interface Binding { owner: MenuOwner; request?: number }
const registries = new WeakMap<vscode.ExtensionContext, Map<string, Binding>>();
const ownerBindings = new WeakMap<MenuOwner, () => void>();

/** Native menus route back to the exact webview and the captured right-click target. */
export function webviewContextMenu(context: vscode.ExtensionContext, owner: MenuOwner): string {
  ownerBindings.get(owner)?.();
  let bindings = registries.get(context);
  if (!bindings) {
    bindings = new Map(); registries.set(context, bindings);
    const registry = bindings;
    for (const action of webviewMenuActions) {
      context.subscriptions.push(vscode.commands.registerCommand(`studio.context.${action}`, async (input?: Record<string, unknown>) => {
        const binding = typeof input?.studioContextMenu === 'string' && registry.get(input.studioContextMenu);
        if (!binding || binding.owner.visible === false || !Number.isSafeInteger(input?.studioContextRequest) || (input!.studioContextRequest as number) < 1) { return; }
        binding.request = input!.studioContextRequest as number;
        await binding.owner.webview.postMessage({ type: 'studio-context-action', menu: input!.studioContextMenu, request: binding.request, action });
      }));
    }
    context.subscriptions.push({ dispose: () => registry.clear() });
  }
  const id = globalThis.crypto.randomUUID();
  const binding: Binding = { owner };
  bindings.set(id, binding);
  const receive = owner.webview.onDidReceiveMessage(async message => {
    if (bindings!.get(id) !== binding || message?.type !== 'studio-context-copy' || message.menu !== id || binding.request === undefined || message.request !== binding.request
      || typeof message.text !== 'string' || owner.visible === false) { return; }
    binding.request = undefined;
    try { await vscode.env.clipboard.writeText(message.text); }
    catch (error) { await vscode.window.showErrorMessage(t('Unable to copy value: {0}', error instanceof Error ? error.message : String(error))); }
  });
  const cleanup = (): void => { bindings!.delete(id); receive.dispose(); dispose.dispose(); ownerBindings.delete(owner); };
  const dispose = owner.onDidDispose(cleanup);
  ownerBindings.set(owner, cleanup);
  return `<meta name="studio-context-menu" content="${id}">`;
}
