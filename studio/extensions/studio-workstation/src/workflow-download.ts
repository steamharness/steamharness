import * as vscode from 'vscode';
import { t } from './localization';

export function bindProjectDownload(defaultUri: vscode.Uri) {
  let disposed = false, queue = Promise.resolve();
  const pending = new Set<string>();
  return {
    receive(message: Record<string, unknown> | undefined): boolean {
      if (disposed || message?.type !== 'workflow-download' || message.version !== 1
        || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128
        || typeof message.name !== 'string' || !message.name || message.name === '.' || message.name === '..'
        || /[<>:"/\\|?*\u0000-\u001f]/.test(message.name) || typeof message.content !== 'string') return false;
      const { requestId, name, content } = message;
      if (pending.has(requestId)) return true;
      pending.add(requestId);
      // Keep each export while presenting only one native save dialog at a time.
      queue = queue.then(async () => {
        if (disposed) return;
        try {
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(defaultUri, name), title: t('Export file'), saveLabel: t('Export'),
          });
          if (!target || disposed) return;
          await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
          if (!disposed) void vscode.window.showInformationMessage(t('Exported to {0}.', target.fsPath));
        } catch (error) {
          if (!disposed) void vscode.window.showErrorMessage(t('Unable to export: {0}', error instanceof Error ? error.message : String(error)));
        }
      }).finally(() => { pending.delete(requestId); });
      return true;
    },
    dispose(): void { disposed = true; pending.clear(); },
  };
}
