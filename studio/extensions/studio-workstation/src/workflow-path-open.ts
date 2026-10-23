import * as vscode from 'vscode';
import { t } from './localization';
import { documentPreviewKind, documentPreviewView } from './document-preview-types';

export function bindProjectPathOpen(webview: vscode.Webview) {
  let disposed = false;
  const pending = new Set<string>();
  return {
    receive(message: Record<string, unknown> | undefined): boolean {
      if (disposed || message?.type !== 'workflow-path-open' || message.version !== 1
        || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128) return false;
      const { requestId, path } = message;
      if (pending.has(requestId)) return true;
      pending.add(requestId);
      void (async () => {
        let error: string | undefined;
        try {
          if (typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/.test(path) || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) {
            throw new Error(t('Only absolute local file or folder paths can be opened.'));
          }
          const uri = vscode.Uri.file(path), stat = await vscode.workspace.fs.stat(uri);
          if (disposed) return;
          if (stat.type & vscode.FileType.Directory) {
            if (!await vscode.env.openExternal(uri)) throw new Error(t('Unable to open the folder in the file manager.'));
          } else if (stat.type & vscode.FileType.File) {
            if (documentPreviewKind(uri.path)) await vscode.commands.executeCommand('vscode.openWith', uri, documentPreviewView(uri.path));
            else await vscode.commands.executeCommand('vscode.open', uri);
          } else throw new Error(t('Only files and folders can be opened.'));
        } catch (failure) { error = t('Unable to open the file or folder: {0}', failure instanceof Error ? failure.message : String(failure)); }
        finally { pending.delete(requestId); }
        if (!disposed) await webview.postMessage({ type: 'workflow-host', pathOpened: { version: 1, requestId, ...(error ? { error } : {}) } });
      })().catch(() => undefined);
      return true;
    },
    dispose(): void { disposed = true; pending.clear(); },
  };
}
