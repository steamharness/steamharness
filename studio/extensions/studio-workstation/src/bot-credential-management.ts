import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { t } from './localization';
import type { BotCredentialTarget } from './bot-credential-list';
import { resolveBotCredentialNamespaces } from './bot-credential-vault';

/** The extension authorizes the scope. All credential input and storage stay in the browser. */
export function registerWebBotCredentialManagement(context: vscode.ExtensionContext, currentOwner: () => string | null) {
  let generation = 0;
  let session: { id: string; dispose(): void; authorized(): Promise<boolean>; prefix: string } | undefined;
  const close = (id?: unknown) => {
    if (!session || id !== undefined && session.id !== id) return;
    const active = session;
    session = undefined;
    active.dispose();
  };
  context.subscriptions.push({ dispose: () => close() }, vscode.commands.registerCommand('studio.internalWebBotCredentialScope', async (id: unknown) => {
    const active = session;
    if (active && active.id === id && await active.authorized() && session === active) return active.prefix;
  }), vscode.commands.registerCommand('studio.internalCloseWebBotCredentials', (id: unknown) => {
    if (typeof id === 'string') close(id);
  }));

  return async (target: BotCredentialTarget, owner: string | null, lifetime: AbortSignal): Promise<void> => {
    const opening = ++generation;
    const controller = new AbortController(), signal = AbortSignal.any([lifetime, controller.signal]);
    const allowed = () => !signal.aborted && vscode.workspace.isTrusted && currentOwner() === owner;
    const authorized = async () => allowed() && await target.recheck() && allowed();
    if (!await authorized() || !await vscode.commands.executeCommand<boolean>('studio.internalCanPersistWebBotCredentials')) {
      throw new Error(t('System-protected credential storage is unavailable. No credential was saved.'));
    }
    const profile = context.globalStorageUri.fsPath;
    const [primary] = await resolveBotCredentialNamespaces(profile, target.scope);
    const prefix = `web-bot-credentials:v1:${createHash('sha256').update(JSON.stringify([owner, primary])).digest('hex')}:`;
    const id = randomUUID();
    if (!allowed() || opening !== generation) return;
    // Only the dialog id and a display label enter the browser command, not a filesystem target.
    close();
    const revoke = () => {
      if (session?.id !== id) return;
      close(id);
      void Promise.resolve(vscode.commands.executeCommand('studio.internalDismissWebBotCredentials', id)).catch(() => undefined);
    };
    signal.addEventListener('abort', revoke, { once: true });
    session = { id, authorized, prefix, dispose() { signal.removeEventListener('abort', revoke); controller.abort(); } };
    try { await vscode.commands.executeCommand('studio.internalShowWebBotCredentials', id, target.name); }
    catch (error) { close(id); throw error; }
  };
}
