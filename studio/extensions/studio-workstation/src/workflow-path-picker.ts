import * as vscode from 'vscode';
import { t } from './localization';

export function bindProjectPathPicker(webview: vscode.Webview, defaultUri: vscode.Uri) {
  let disposed = false, pending: string | undefined;
  return {
    receive(message: Record<string, unknown> | undefined): boolean {
      if (disposed || message?.type !== 'workflow-path-picker' || message.version !== 1
        || message.kind !== 'files' && message.kind !== 'folders'
        || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128
        || typeof message.target !== 'string' || !message.target || message.target.length > 512) return false;
      const { requestId, target } = message, folders = message.kind === 'folders';
      const reply = (paths: string[], error?: string) => {
        if (!disposed) return webview.postMessage({ type: 'workflow-host', pathSelection: { version: 1, requestId, target, paths, error } });
      };
      // Avoid stacking native dialogs when another request is still open.
      if (pending) { if (pending !== requestId) void reply([]); return true; }
      pending = requestId;
      void (async () => {
        let paths: string[] = [], error: string | undefined;
        try {
          const selected = await vscode.window.showOpenDialog({
            canSelectFiles: !folders, canSelectFolders: folders, canSelectMany: true,
            defaultUri, title: folders ? t('Choose folders') : t('Choose files'),
          });
          if (selected?.some(uri => uri.scheme !== 'file')) throw new Error(t('Only local files and folders can be referenced.'));
          paths = selected?.map(uri => uri.toString()) ?? [];
        } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        finally { pending = undefined; }
        await reply(paths, error);
      })().catch(() => undefined);
      return true;
    },
    dispose(): void { disposed = true; },
  };
}
