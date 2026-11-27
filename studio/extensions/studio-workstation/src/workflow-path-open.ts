import * as vscode from 'vscode';
import { t } from './localization';
import { DOCUMENT_PREVIEW_LIMIT, LATEX_PREVIEW_LIMIT, documentPreviewKind, documentPreviewView } from './document-preview-types';

export function bindProjectPathOpen(webview: vscode.Webview, baseUri?: vscode.Uri) {
  let disposed = false;
  const pending = new Set<string>();
  return {
    receive(message: Record<string, unknown> | undefined): boolean {
      if (disposed || message?.type !== 'workflow-path-open' || message.version !== 1
        || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128) return false;
      const { requestId, path, line, column, attachment } = message;
      if (pending.has(requestId)) return true;
      pending.add(requestId);
      void (async () => {
        let error: string | undefined;
        try {
          if (typeof path !== 'string' || !path || path.length > 4096 || /[\0-\x1f\x7f]/.test(path)
            || !/^[a-z]:[\\/]/i.test(path) && /^[a-z][a-z\d+.-]*:/i.test(path)) {
            throw new Error(t('Only local file or folder paths can be opened.'));
          }
          const absolute = /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path);
          if (!absolute && !baseUri) throw new Error(t('Only absolute local file or folder paths can be opened.'));
          if (line !== undefined && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1)
            || column !== undefined && (line === undefined || typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1)) {
            throw new Error(t('Invalid file line or column.'));
          }
          const uri = absolute ? vscode.Uri.file(path) : vscode.Uri.joinPath(baseUri!, path.replaceAll('\\', '/'));
          const stat = await vscode.workspace.fs.stat(uri);
          if (disposed) return;
          if (stat.type & vscode.FileType.Directory) {
            if (!await vscode.env.openExternal(uri)) throw new Error(t('Unable to open the folder in the file manager.'));
          } else if (stat.type & vscode.FileType.File) {
            if (typeof line === 'number') {
              const position = new vscode.Position(line - 1, (typeof column === 'number' ? column : 1) - 1);
              await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position) });
            } else if (attachment === true) {
              const kind = documentPreviewKind(uri.path);
              let previewed = false;
              if (kind && stat.size <= (kind === 'latex' ? LATEX_PREVIEW_LIMIT : DOCUMENT_PREVIEW_LIMIT)) {
                try { await vscode.commands.executeCommand('vscode.openWith', uri, documentPreviewView(uri.path)); previewed = true; }
                catch { /* If the editor cannot open the attachment, reveal the original instead. */ }
              }
              if (!previewed && !disposed) await vscode.commands.executeCommand('revealFileInOS', uri);
            } else if (documentPreviewKind(uri.path)) await vscode.commands.executeCommand('vscode.openWith', uri, documentPreviewView(uri.path));
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
