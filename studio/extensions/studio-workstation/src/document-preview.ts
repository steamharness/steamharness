import * as vscode from 'vscode';
import { t } from './localization';
import { localizationHtml } from './localization-host';
import { DOCUMENT_PREVIEW_LIMIT, LATEX_PREVIEW_LIMIT, DOCUMENT_PREVIEW_VIEW, FORMULA_PREVIEW_VIEW,
  documentPreviewKind, documentPreviewView, type DocumentPreviewKind, type PreviewMessage } from './document-preview-types';

class PreviewDocument implements vscode.CustomDocument {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  revision = 0;

  constructor(readonly uri: vscode.Uri, readonly kind: DocumentPreviewKind, private readonly onDispose: () => void) {
    // Watch the parent so an editor's atomic rename/save does not detach the watch.
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*'));
    const invalidate = (changed: vscode.Uri): void => {
      if (changed.toString() !== uri.toString() || this.disposed) { return; }
      ++this.revision;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (!this.disposed) { this.changed.fire(); } }, 150);
    };
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidChange(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true; ++this.revision;
    clearTimeout(this.timer); this.watcher.dispose(); this.changed.dispose(); this.onDispose();
  }
}

interface PreviewSession {
  document: PreviewDocument;
  panel: vscode.WebviewPanel;
  refresh(): Promise<void>;
  dispose(): void;
}

export class DocumentPreviewProvider implements vscode.CustomReadonlyEditorProvider<PreviewDocument>, vscode.Disposable {
  private readonly documents = new Set<PreviewDocument>();
  private readonly sessions = new Set<PreviewSession>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri, _context: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<PreviewDocument> {
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    const kind = documentPreviewKind(uri.path);
    if (!kind) { throw new Error(t('This file format cannot be previewed.')); }
    const document = new PreviewDocument(uri, kind, () => this.documents.delete(document));
    this.documents.add(document);
    return document;
  }

  resolveCustomEditor(document: PreviewDocument, panel: vscode.WebviewPanel, token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) { return; }
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const asset = (name: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, name)).toString();
    panel.webview.html = `<!DOCTYPE html><html lang="${vscode.env.language}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data: blob:; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource} data:; script-src 'nonce-${nonce}' ${panel.webview.cspSource} 'wasm-unsafe-eval'; worker-src ${panel.webview.cspSource} blob:; connect-src ${panel.webview.cspSource} data: blob:; frame-src 'self' blob:;">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('document-preview/main.css')}">
      </head><body><div id="preview-app"></div>${localizationHtml(nonce)}<script type="module" nonce="${nonce}" src="${asset('document-preview/main.js')}"></script></body></html>`;

    let ready = false, disposed = false, generation = 0;
    let renderedRevision: number | undefined, loadingRevision: number | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners: vscode.Disposable[] = [];
    const send = (message: PreviewMessage): Thenable<boolean> => disposed ? Promise.resolve(false) : panel.webview.postMessage(message);
    const refresh = async (force = true): Promise<void> => {
      clearTimeout(refreshTimer); refreshTimer = undefined;
      if (!ready || disposed || !panel.visible) { return; }
      if (!force && (renderedRevision === document.revision || loadingRevision === document.revision)) { return; }
      const current = ++generation, revision = document.revision;
      loadingRevision = revision;
      void send({ type: 'loading', generation: current });
      try {
        const limit = document.kind === 'latex' ? LATEX_PREVIEW_LIMIT : DOCUMENT_PREVIEW_LIMIT;
        const stat = await vscode.workspace.fs.stat(document.uri);
        if (stat.type & vscode.FileType.Directory) { throw new Error(t('This resource is not a file.')); }
        if (stat.size > limit) { throw new Error(t('Preview is limited to {0}.', document.kind === 'latex' ? '200 KB' : '50 MB')); }
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        if (!bytes.length) { throw new Error(t('The file is empty.')); }
        if (bytes.length > limit) { throw new Error(t('Preview is limited to {0}.', document.kind === 'latex' ? '200 KB' : '50 MB')); }
        if (disposed || current !== generation || revision !== document.revision) { return; }
        const name = document.uri.path.split('/').pop() ?? '';
        const sent = await send({ type: 'document', generation: current, kind: document.kind, name, bytes: new Uint8Array(bytes) });
        if (sent && !disposed && current === generation && revision === document.revision) { renderedRevision = revision; }
      } catch (error) {
        if (disposed || current !== generation || revision !== document.revision) { return; }
        const message = error instanceof vscode.FileSystemError && error.code === 'FileNotFound' ? t('File does not exist.')
          : error instanceof Error ? error.message : String(error);
        const sent = await send({ type: 'error', generation: current, error: message });
        if (sent && !disposed && current === generation && revision === document.revision) { renderedRevision = revision; }
      } finally { if (current === generation) { loadingRevision = undefined; } }
    };
    const scheduleRefresh = (): void => {
      if (disposed) { return; }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refresh(false); }, 150);
    };
    const session: PreviewSession = { document, panel, refresh, dispose: () => {
      if (disposed) { return; }
      disposed = true; ++generation;
      clearTimeout(refreshTimer);
      for (const listener of listeners) { listener.dispose(); }
      this.sessions.delete(session);
    } };
    this.sessions.add(session);
    listeners.push(document.onDidChange(scheduleRefresh), panel.onDidDispose(session.dispose),
      token.onCancellationRequested(session.dispose),
      panel.onDidChangeViewState(() => { if (panel.visible && ready) { scheduleRefresh(); } }),
      panel.webview.onDidReceiveMessage(async (message: { type?: string; text?: unknown }) => {
        if (disposed) { return; }
        if (message.type === 'ready') {
          ready = true; ++generation; renderedRevision = loadingRevision = undefined;
          await refresh();
        }
        else if (message.type === 'refresh') { await refresh(); }
        else if (message.type === 'copy' && typeof message.text === 'string' && message.text.length <= 1024 * 1024) {
          try { await vscode.env.clipboard.writeText(message.text); }
          catch { await send({ type: 'error', generation, error: t('Unable to copy preview text.') }); }
        }
      }));
  }

  async refreshActive(): Promise<void> {
    await Promise.all([...this.sessions].filter(session => session.panel.active).map(session => session.refresh()));
  }

  dispose(): void {
    for (const session of [...this.sessions]) { session.dispose(); }
    for (const document of [...this.documents]) { document.dispose(); }
  }
}

export function activateDocumentPreviews(context: vscode.ExtensionContext): void {
  const provider = new DocumentPreviewProvider(context);
  const options = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true };
  context.subscriptions.push(provider,
    vscode.window.registerCustomEditorProvider(DOCUMENT_PREVIEW_VIEW, provider, options),
    vscode.window.registerCustomEditorProvider(FORMULA_PREVIEW_VIEW, provider, options),
    vscode.commands.registerCommand('studio.refreshDocumentPreview', () => provider.refreshActive()),
    vscode.commands.registerCommand('studio.openDocumentPreview', async (resource?: vscode.Uri) => {
      const uri = resource ?? vscode.window.activeTextEditor?.document.uri
        ?? (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined)?.uri;
      if (!uri || !documentPreviewKind(uri.path)) { await vscode.window.showInformationMessage(t('This file format cannot be previewed.')); return; }
      await vscode.commands.executeCommand('vscode.openWith', uri, documentPreviewView(uri.path));
    }));
}
