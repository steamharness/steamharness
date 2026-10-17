import * as vscode from 'vscode';

export function bindWorkflowClipboard(webview: vscode.Webview) {
  let disposed = false;
  let writing = Promise.resolve();
  return {
    receive(message: Record<string, unknown> | undefined): boolean {
      if (disposed || message?.type !== 'workflow-clipboard' || message.version !== 1 || message.command !== 'writeText'
        || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128 || typeof message.text !== 'string') { return false; }
      const requestId = message.requestId, text = message.text;
      writing = writing.then(async () => {
        if (disposed) { return; }
        let error: string | undefined;
        try { await vscode.env.clipboard.writeText(text); }
        catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        if (!disposed) { await webview.postMessage({ type: 'workflow-host', clipboard: { version: 1, requestId, ok: error === undefined, error } }); }
      }).catch(() => undefined);
      return true;
    },
    dispose(): void { disposed = true; },
  };
}
