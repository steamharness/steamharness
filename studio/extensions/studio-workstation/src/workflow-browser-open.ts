import * as vscode from 'vscode';
import { t } from './localization';

export const BROWSER_LINK_TARGET_SETTING = 'studio.browser.linkTarget';

/** Use the user's browser preference for website links, independent of project settings. */
export async function openBrowserLink(value: string): Promise<void> {
  let address: URL;
  try { address = new URL(value); }
  catch { throw new Error(t('Only HTTP and HTTPS links can be opened in the browser.')); }
  if (value.length > 4096 || /[\0-\x1f\x7f]/.test(value) || !['http:', 'https:'].includes(address.protocol)) {
    throw new Error(t('Only HTTP and HTTPS links can be opened in the browser.'));
  }
  const setting = vscode.workspace.getConfiguration().inspect<string>(BROWSER_LINK_TARGET_SETTING);
  if ((setting?.globalValue ?? setting?.defaultValue ?? 'internal') === 'external') {
    if (!await vscode.env.openExternal(vscode.Uri.parse(address.href))) throw new Error(t('Unable to open the website in the system browser.'));
    return;
  }
  const commands = await vscode.commands.getCommands(true);
  await vscode.commands.executeCommand(commands.includes('workbench.action.browser.open') ? 'workbench.action.browser.open' : 'simpleBrowser.show', address.href);
}

export function bindProjectBrowserOpen(webview: vscode.Webview): vscode.Disposable & { receive(message: Record<string, unknown> | undefined): boolean } {
  let disposed = false;
  const pending = new Set<string>();
  return {
    receive(message) {
      if (disposed || message?.type !== 'workflow-browser-open' || message.version !== 1
        || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128) return false;
      const { requestId, url } = message;
      if (pending.has(requestId)) return true;
      pending.add(requestId);
      void (async () => {
        let error: string | undefined;
        try {
          if (typeof url !== 'string') throw new Error(t('Only HTTP and HTTPS links can be opened in the browser.'));
          await openBrowserLink(url);
        } catch (cause) { error = t('Unable to open the website: {0}', cause instanceof Error ? cause.message : String(cause)); }
        finally {
          pending.delete(requestId);
          if (!disposed) await webview.postMessage({ type: 'workflow-host', browserOpened: { version: 1, requestId, ...(error ? { error } : {}) } });
        }
      })();
      return true;
    },
    dispose() { disposed = true; pending.clear(); },
  };
}
