import * as vscode from 'vscode';
import { t } from './localization';
import { localizationHtml } from './localization-host';
import { webviewContextMenu } from './webview-context-menu';
import type { Launcher } from './workflow-cli-types';
import type { AccountController } from './workflow-auth';
import type { DatabaseTarget } from './workflow-databases-types';
import type { ResourceKind, ResourceRequest } from './workflow-resources-types';

/** The editor and bottom panel use the same data browser and request protocol. */
export class DatabaseDataPanel implements vscode.Disposable {
  private controller = new AbortController();
  private generation = 0;
  private busy = false;
  private connectionKey?: string;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly panel: vscode.WebviewPanel;
  constructor(context: vscode.ExtensionContext, private readonly launcher: Launcher, private readonly account: AccountController,
    private readonly target: DatabaseTarget, private readonly kind: ResourceKind, onClose: () => void) {
    this.connectionKey = JSON.stringify(account.getConnection());
    this.panel = vscode.window.createWebviewPanel('studio.databaseData', `${target.space.name} · ${kind === 'kv' ? 'KV' : t('Knowledge base')}`,
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] });
    this.panel.iconPath = new vscode.ThemeIcon(kind === 'kv' ? 'database' : 'book');
    const webview = this.panel.webview;
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', name)).toString();
    webview.html = `<!DOCTYPE html><html lang="${vscode.env.language}"><head>${webviewContextMenu(context, this.panel)}<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('resources-ui.css')}"></head>
      <body data-resource-kind="${kind}" data-database-panel="true"><div id="resources-app"></div>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('resources-ui.js')}"></script></body></html>`;
    this.subscriptions.push(webview.onDidReceiveMessage(message => void this.receive(message)),
      account.onDidChange(() => { const key = JSON.stringify(account.getConnection()); if (key === this.connectionKey) return; this.connectionKey = key; this.controller.abort(); this.controller = new AbortController(); this.generation++; this.busy = false; this.publish(); }),
      this.panel.onDidDispose(() => { this.dispose(); onClose(); }));
  }
  private publish() {
    if (!this.disposed) void this.panel.webview.postMessage({ type: 'resources-state', kind: this.kind, generation: this.generation,
      selected: this.target.key, projects: [{ uri: this.target.key, name: this.target.space.name, folderPath: this.target.space.spaceId }],
      source: this.target.space.host, authenticated: !!this.account.getConnection(), readOnly: false });
  }
  private async receive(message: any) {
    if (message?.type === 'ready') { this.publish(); return; }
    if (message?.type === 'login') { this.account.open(); return; }
    if (message?.generation !== this.generation || message.projectUri !== this.target.key) return;
    if (message.type === 'copy' && typeof message.text === 'string') { await vscode.env.clipboard.writeText(message.text); return; }
    const input = message.input as ResourceRequest;
    if (message.type !== 'request' || !Number.isSafeInteger(message.id) || !input) return;
    const generation = this.generation, signal = this.controller.signal;
    const mutation = ['save', 'delete'].includes(input.action);
    let acquired = false;
    try {
      if (!vscode.workspace.isTrusted) throw new Error(t('Trust the current workspace first.'));
      if (!['list', 'get', 'save', 'delete'].includes(input.action) || JSON.stringify(input).length > 1024 * 1024) throw new Error(t('Invalid resource operation.'));
      if (mutation && this.busy) throw new Error(t('A data operation is in progress.'));
      if (mutation) { this.busy = true; acquired = true; }
      if (input.action === 'delete') {
        const remove = t('Delete');
        if (await vscode.window.showWarningMessage(t('Delete "{0}"? This removes the stored data.', input.key ?? input.documentId ?? ''), { modal: true }, remove) !== remove) {
          await this.panel.webview.postMessage({ type: 'resources-result', id: message.id, generation, value: { cancelled: true } }); return;
        }
      }
      signal.throwIfAborted();
      const request = { ...input, kind: this.kind, source: undefined, expectedDatabaseId: undefined };
      const value = this.target.project && this.target.alias
        ? await this.launcher.resource!(this.target.project, { ...request, database: this.target.alias, expectedDatabaseId: this.target.space.spaceId, source: this.target.space.host }, signal)
        : await this.launcher.database!({ kind: 'host', action: 'resource', host: this.target.space.host, spaceId: this.target.space.spaceId, input: request }, signal);
      if (!this.disposed && generation === this.generation) await this.panel.webview.postMessage({ type: 'resources-result', id: message.id, generation, value });
    } catch (error) {
      if (!this.disposed && generation === this.generation) await this.panel.webview.postMessage({ type: 'resources-result', id: message.id, generation, error: error instanceof Error ? error.message : String(error) });
    } finally { if (acquired && generation === this.generation) this.busy = false; }
  }
  reveal() { this.panel.reveal(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.controller.abort(); for (const subscription of this.subscriptions) subscription.dispose();
    this.panel.dispose();
  }
}
