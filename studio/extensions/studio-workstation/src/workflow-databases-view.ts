import * as vscode from 'vscode';
import { t } from './localization';
import { localizationHtml } from './localization-host';
import { webviewContextMenu } from './webview-context-menu';
import { projectDisplayName, type Project } from './workflow-types';
import type { AccountController } from './workflow-auth';
import type { Launcher } from './workflow-cli-types';

/** Studio lists online resources; the authenticated Server owns model, table and access management. */
export class DatabaseViews implements vscode.Disposable {
  private projects: Project[] = [];
  private preferred?: Project;
  private resources: any[] = [];
  private bindings: { kind: string; resourceId: string; alias: string; name: string }[] = [];
  private projectKey = '';
  private view?: vscode.WebviewView;
  private controller = new AbortController();
  private epoch = 0;
  private busy = false;
  private error = '';
  private disposed = false;
  private connectionKey: string;
  private pending?: Promise<void>;
  private refreshedAt = 0;
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, private readonly launcher: Launcher, private readonly account: AccountController, private readonly output: vscode.OutputChannel, register = true, subscriptions = context.subscriptions) {
    this.connectionKey = JSON.stringify(account.getConnection());
    this.subscriptions.push(...(register ? [vscode.window.registerWebviewViewProvider('studio.databases', this, { webviewOptions: { retainContextWhenHidden: true } }), vscode.commands.registerCommand('studio.openDatabases', () => vscode.commands.executeCommand('studio.databases.focus')), vscode.commands.registerCommand('studio.refreshDatabases', () => this.refresh())] : []), account.onDidChange(() => {
      const key = JSON.stringify(account.getConnection()); if (key === this.connectionKey) return;
      this.connectionKey = key; this.controller.abort(); this.controller = new AbortController(); ++this.epoch; this.pending = undefined; this.refreshedAt = 0; this.resources = []; this.bindings = []; this.busy = false; this.error = ''; this.publish(); if (this.view?.visible) void this.refresh();
    })); subscriptions.push(this);
  }
  update(projects: Project[], preferred?: Project) {
    this.projects = projects.filter(project => !project.assistant); this.preferred = preferred;
    const key = JSON.stringify(this.projects.map(project => [project.id, project.entryId, project.uri, project.databases]));
    const changed = key !== this.projectKey; this.projectKey = key;
    if (changed) { this.bindings = []; this.refreshedAt = 0; this.pending = undefined; ++this.epoch; }
    this.publish(); if (changed && this.view?.visible) void this.refresh();
  }
  refresh(force = true): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && this.refreshedAt && Date.now() - this.refreshedAt < 5_000) return Promise.resolve();
    const pending = this.load().finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending; return pending;
  }
  private async load() {
    if (this.disposed) return; const epoch = ++this.epoch, signal = this.controller.signal; this.busy = true; this.error = ''; this.publish();
    try {
      if (!vscode.workspace.isTrusted) throw new Error(t('Trust the current workspace first.'));
      if (!this.account.getConnection() || !this.launcher.database) throw new Error(t('Sign in to SteamHarness Server to manage database resources.'));
      const catalog = await this.launcher.database({ kind: 'host', action: 'catalog' }, signal);
      const bindings = (await Promise.all(this.projects.filter(project => project.id === this.preferred?.id && project.uri === this.preferred?.uri && project.databases.length).map(async project => {
        const result = await this.launcher.database!({ kind: 'host', action: 'bindings', projectId: project.id, entryId: project.entryId }, signal);
        return (result.bindings ?? []).filter((binding: { alias: string }) => project.databases.includes(binding.alias)).map((binding: { alias: string; databaseId: string }) => ({ kind: 'databases', resourceId: binding.databaseId, alias: binding.alias, name: projectDisplayName(project) }));
      }))).flat();
      if (!signal.aborted && epoch === this.epoch) { this.resources = catalog.resources; this.bindings = bindings; this.refreshedAt = Date.now(); }
    } catch (error) { if (!signal.aborted && epoch === this.epoch) this.error = error instanceof Error ? error.message : String(error); }
    finally { if (!signal.aborted && epoch === this.epoch) { this.busy = false; this.publish(); } }
  }
  private publish() {
    if (this.disposed) return;
    const usage = [...this.bindings, ...this.projects.filter(project => project.id === this.preferred?.id && project.uri === this.preferred?.uri).flatMap(project => [

      ...(project.knowledgeBases ?? []).map(base => ({ kind: 'knowledge-bases', resourceId: base.knowledgeBaseId, alias: base.alias, name: projectDisplayName(project) })),
    ])];
    void this.view?.webview.postMessage({ type: 'databases-state', loading: this.busy, error: this.error, authenticated: !!this.account.getConnection(), project: this.preferred?.name,
      databases: this.resources.map(resource => ({ ...resource, key: `${resource.kind}:${resource.id}`, usage: usage.filter(item => item.kind === resource.kind && item.resourceId === resource.id) })) });
  }
  private async open(kind: string, id?: string) {
    const connection = this.account.getConnection(); if (!connection) { this.account.open(); return; }
    const url = new URL(connection.serverUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(t('Invalid Server address.'));
    const resource = id ? `${kind === 'knowledge-bases' ? 'knowledge:' : ''}${id}` : undefined;
    url.pathname = `${url.pathname.replace(/\/$/, '')}/databases${resource ? '/' + encodeURIComponent(resource) : ''}`;
    await vscode.commands.executeCommand('simpleBrowser.show', url.toString());
  }
  async openProjectDatabase(project: Project, alias: string) {
    if (!vscode.workspace.isTrusted) throw new Error(t('Trust the current workspace first.'));
    const inspected = await this.launcher.inspect([project.uri]), current = inspected.projects.find(item => item.id === project.id && item.entryId === project.entryId);
    const requirement = current?.databases.find(item => item === alias); if (!requirement) throw new Error(t('This database reference changed. Reopen the project.'));
    const result = await this.launcher.database!({ kind: 'host', action: 'bindings', projectId: project.id, entryId: project.entryId }, this.controller.signal);
    const binding = result.bindings?.find((item: { alias: string; databaseId: string }) => item.alias === alias); if (!binding) throw new Error(t('This database reference changed. Reopen the project.'));
    await this.open('databases', binding.databaseId);
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view; const nonce = crypto.randomUUID().replace(/-/g, '');
    const asset = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    view.webview.html = `<!DOCTYPE html><html lang="${vscode.env.language}"><head>${webviewContextMenu(this.context, view)}<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('databases-ui.css')}"></head><body><div id="databases-app"></div>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('databases-ui.js')}"></script></body></html>`;
    const receive = view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready' || message?.type === 'refresh') { void this.refresh(message.type === 'refresh'); return; }
      if (message?.type === 'login') { this.account.open(); return; }
      if (message?.type === 'manage') { void this.open('databases').catch(error => this.output.appendLine(String(error))); return; }
      if (message?.type === 'open' && typeof message.key === 'string') {
        const resource = this.resources.find(resource => `${resource.kind}:${resource.id}` === message.key);
        if (resource) void this.open(resource.kind, resource.id).catch(error => this.output.appendLine(String(error)));
      }
    });
    const visibility = view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(false); });
    const disposal = view.onDidDispose(() => { receive.dispose(); visibility.dispose(); disposal.dispose(); if (this.view === view) this.view = undefined; });
    this.publish(); void this.refresh(false);
  }
  dispose() { if (this.disposed) return; this.disposed = true; ++this.epoch; this.controller.abort(); for (const subscription of this.subscriptions) subscription.dispose(); }
}
