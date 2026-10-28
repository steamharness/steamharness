import * as vscode from 'vscode';
import { DATABASE_IDENTIFIER_PATTERN, type DatabaseHost, type DatabasePermissions, type DatabaseRequest } from '@steamharness/database-spaces';
import type { DatabaseCatalogState } from '@steamharness/database-spaces/catalog';
import { t } from './localization';
import { localizationHtml } from './localization-host';
import { webviewContextMenu } from './webview-context-menu';
import { projectDisplayName, projectWindowKey, type Project } from './workflow-types';
import type { AccountController } from './workflow-auth';
import type { Launcher } from './workflow-cli-types';
import type { DatabaseTarget, HostDatabaseCatalog, HostDatabaseRequest } from './workflow-databases-types';
import type { ResourceKind } from './workflow-resources-types';
import { DatabaseDataPanel } from './database-data-panel';

export class DatabaseViews implements vscode.Disposable {
  private projects: Project[] = [];
  private preferred?: Project;
  private catalog?: HostDatabaseCatalog;
  private view?: vscode.WebviewView;
  private controller = new AbortController();
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private disposed = false;
  private connectionKey?: string;
  private error = '';
  private readonly panels = new Map<string, DatabaseDataPanel>();
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, private readonly launcher: Launcher,
    private readonly account: AccountController, private readonly output: vscode.OutputChannel, register = true, subscriptions = context.subscriptions) {
    this.connectionKey = JSON.stringify(account.getConnection());
    this.subscriptions.push(...(register ? [vscode.window.registerWebviewViewProvider('studio.databases', this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand('studio.openDatabases', () => vscode.commands.executeCommand('studio.databases.focus')),
      vscode.commands.registerCommand('studio.refreshDatabases', () => this.refresh())] : []),
      account.onDidChange(() => {
        const key = JSON.stringify(account.getConnection()); if (key === this.connectionKey) return;
        this.connectionKey = key; ++this.epoch; this.controller.abort(); this.controller = new AbortController(); this.catalog = undefined; this.busy = false; this.publish(); this.schedule();
      }));
    subscriptions.push(this);
  }
  update(projects: Project[], preferred?: Project) {
    const changed = JSON.stringify([projects.map(project => [projectWindowKey(project), project.databases]), preferred && projectWindowKey(preferred)]) !==
      JSON.stringify([this.projects.map(project => [projectWindowKey(project), project.databases]), this.preferred && projectWindowKey(this.preferred)]);
    this.projects = projects.filter(project => !project.assistant); this.preferred = preferred?.assistant ? undefined : preferred;
    if (changed) { this.publish(); this.schedule(); }
  }
  private schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { if (this.view?.visible) void this.refresh(); }, 100); }
  private async call(input: HostDatabaseRequest) {
    if (!vscode.workspace.isTrusted) throw new Error(t('Trust the current workspace first.'));
    if (!this.launcher.database) throw new Error(t('Database management is available in desktop Studio or Server Web.'));
    return this.launcher.database(input, this.controller.signal);
  }
  async refresh() {
    if (this.disposed) return;
    const epoch = ++this.epoch; this.busy = true; this.error = ''; this.publish();
    try { const catalog = await this.call({ kind: 'host', action: 'catalog' }); if (epoch === this.epoch) this.catalog = catalog; }
    catch (error) { if (epoch === this.epoch) this.error = error instanceof Error ? error.message : String(error); }
    finally { if (epoch === this.epoch) { this.busy = false; this.publish(); } }
  }
  private targets(): DatabaseTarget[] {
    const spaces = [...(this.catalog?.local.spaces ?? []), ...(this.catalog?.server?.spaces ?? [])];
    return spaces.map(space => ({ key: `${space.host}:${space.spaceId}`, space }));
  }
  private publish() {
    if (this.disposed) return;
    const preferred = this.preferred;
    const consumers = this.projects.filter(project => project.id === preferred?.id && project.uri === preferred?.uri);
    const usage = consumers.flatMap(project => project.databases.map(database => ({ ...database, entryId: project.entryId, name: projectDisplayName(project) })));
    const targets = this.targets();
    for (const database of usage) if (!targets.some(target => target.space.spaceId === database.databaseId)) targets.push({ key: `unavailable:${database.databaseId}`, space: { spaceId: database.databaseId, name: database.alias, host: 'local', ownerId: '', createdAt: '' } });
    void this.view?.webview.postMessage({ type: 'databases-state', loading: this.busy, error: this.error, serverError: this.catalog?.serverError,
      project: preferred && (preferred.aggregateName ?? preferred.name), authenticated: !!this.account.getConnection(),
      databases: targets.map(target => ({ key: target.key, ...target.space, available: !target.key.startsWith('unavailable:'), usage: usage.filter(item => item.databaseId === target.space.spaceId) })) });
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const asset = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    view.webview.html = `<!DOCTYPE html><html lang="${vscode.env.language}"><head>${webviewContextMenu(this.context, view)}<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('databases-ui.css')}"></head><body><div id="databases-app"></div>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('databases-ui.js')}"></script></body></html>`;
    const receive = view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready' || message?.type === 'refresh') { void this.refresh(); return; }
      if (message?.type === 'login') { this.account.open(); return; }
      if (message?.type === 'open' && typeof message.key === 'string' && ['kv', 'knowledge'].includes(message.kind)) {
        const target = this.targets().find(target => target.key === message.key); if (target) this.openData(message.filter === 'project' ? this.withConsumer(target) : target, message.kind); return;
      }
      if (this.busy) return;
      if (message?.type === 'request') void this.action(() => this.request());
      if (message?.type === 'review') void this.action(() => this.review());
      if (message?.type === 'grants') void this.action(() => this.manageGrants());
    });
    const visibility = view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(); });
    const disposal = view.onDidDispose(() => { receive.dispose(); visibility.dispose(); disposal.dispose(); if (this.view === view) this.view = undefined; });
    this.publish(); void this.refresh();
  }
  private withConsumer(target: DatabaseTarget): DatabaseTarget {
    const project = [this.preferred, ...this.projects.filter(project => project.id === this.preferred?.id && project.uri === this.preferred?.uri)].find(project => project?.databases.some(database => database.databaseId === target.space.spaceId));
    const alias = project?.databases.find(database => database.databaseId === target.space.spaceId)?.alias;
    return project && alias ? { ...target, project, alias } : target;
  }
  private openData(target: DatabaseTarget, kind: ResourceKind) {
    const key = `${target.key}:${kind}:${target.project ? projectWindowKey(target.project) : 'host'}`;
    const existing = this.panels.get(key); if (existing) { existing.reveal(); return; }
    const panel = new DatabaseDataPanel(this.context, this.launcher, this.account, target, kind, () => this.panels.delete(key)); this.panels.set(key, panel);
  }
  async openProjectDatabase(project: Project, alias: string) {
    const inspected = await this.launcher.inspect([project.folderPath]);
    const current = inspected.projects.find(item => item.id === project.id && item.entryId === project.entryId);
    const requirement = current?.databases.find(database => database.alias === alias);
    if (!current || !requirement) throw new Error(t('Select a declared database alias.'));
    await this.refresh();
    const target = this.targets().find(target => target.space.spaceId === requirement.databaseId);
    if (!target) throw new Error(t('This database is unavailable. Check the host connection and access grant.'));
    this.openData({ ...target, project: { ...current, uri: project.uri }, alias }, 'kv');
  }
  private async action(run: () => Promise<void>) {
    this.busy = true; this.error = ''; this.publish();
    try { await run(); }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); this.output.appendLine(`Database management: ${this.error}`); }
    finally { this.busy = false; this.publish(); }
  }
  private async host(): Promise<DatabaseHost | undefined> {
    return (await vscode.window.showQuickPick([{ label: t('Local'), value: 'local' as const }, { label: t('Server'), value: 'server' as const }], { title: t('Database host') }))?.value;
  }
  private async editPermissions(initial: DatabasePermissions): Promise<DatabasePermissions | undefined> {
    const value = structuredClone(initial);
    for (const resource of ['kv', 'knowledge'] as const) for (const operation of ['read', 'write'] as const) {
      const rule = value[resource][operation];
      const choice = await vscode.window.showQuickPick([...(rule.mode === 'all' ? [{ label: t('All data'), mode: 'all' as const }] : []), ...(rule.mode !== 'none' ? [{ label: t('Selected prefixes'), mode: 'prefixes' as const }] : []), { label: t('No access'), mode: 'none' as const }],
        { title: `${resource === 'kv' ? 'KV' : t('Knowledge base')} · ${operation === 'read' ? t('Read') : t('Write')}`, placeHolder: rule.mode === 'prefixes' ? rule.prefixes.join(', ') : rule.mode === 'all' ? t('All data') : t('No access') });
      if (!choice) return;
      if (choice.mode === 'prefixes') {
        const prefixes = await vscode.window.showInputBox({ title: t('Allowed prefixes, separated by commas'), value: rule.mode === 'prefixes' ? rule.prefixes.join(', ') : '', validateInput: value => value.split(',').some(prefix => !prefix.trim()) ? t('Enter at least one prefix.') : undefined });
        if (prefixes === undefined) return; value[resource][operation] = { mode: 'prefixes', prefixes: prefixes.split(',').map(prefix => prefix.trim()) };
      } else value[resource][operation] = { mode: choice.mode };
    }
    return value;
  }
  private async request() {
    const host = await this.host(); if (!host) return;
    const choices = [...this.projects].sort((a, b) => Number(projectWindowKey(b) === (this.preferred && projectWindowKey(this.preferred))) - Number(projectWindowKey(a) === (this.preferred && projectWindowKey(this.preferred))));
    const project = (await vscode.window.showQuickPick(choices.map(project => ({ label: projectDisplayName(project), description: project.id, project })), { title: t('Project entry') }))?.project; if (!project) return;
    const alias = await vscode.window.showInputBox({ title: t('Database alias'), value: project.databases[0]?.alias ?? 'data', validateInput: value => DATABASE_IDENTIFIER_PATTERN.test(value) ? undefined : t('Enter a valid database alias.') }); if (!alias) return;
    const kind = (await vscode.window.showQuickPick([{ label: t('Request a new database'), value: 'create' as const }, { label: t('Request an existing database'), value: 'access' as const }], { title: t('Database request') }))?.value; if (!kind) return;
    const target = kind === 'create' ? await vscode.window.showInputBox({ title: t('Database name'), validateInput: value => value.trim() ? undefined : t('Enter a database name.') })
      : (await vscode.window.showQuickPick(this.targets().filter(target => target.space.host === host).map(target => ({ label: target.space.name, description: target.space.spaceId, value: target.space.spaceId })), { title: t('Database') }))?.value;
    if (!target) return;
    const all = { mode: 'all' as const }, permissions = await this.editPermissions({ kv: { read: all, write: all }, knowledge: { read: all, write: all } }); if (!permissions) return;
    await this.call({ kind: 'host', action: 'request', host, request: { projectId: project.id, entryId: project.entryId, alias, permissions, target: kind === 'create' ? { kind, name: target } : { kind, spaceId: target } } });
    await this.refresh(); void vscode.window.showInformationMessage(t('Database request submitted. Review it in the host approvals.'));
  }
  private catalogs(): Array<{ host: DatabaseHost; catalog: DatabaseCatalogState }> { return [{ host: 'local', catalog: this.catalog?.local }, { host: 'server', catalog: this.catalog?.server }].filter(item => !!item.catalog) as Array<{ host: DatabaseHost; catalog: DatabaseCatalogState }>; }
  private async review() {
    const choices = this.catalogs().flatMap(({ host, catalog }) => catalog.requests.filter(request => request.status === 'pending').map(request => ({ label: request.target.kind === 'create' ? request.target.name : catalog.spaces.find(space => space.spaceId === (request.target as { spaceId: string }).spaceId)?.name ?? request.target.spaceId, description: `${host} · ${request.projectId} / ${request.entryId} / ${request.alias}`, host, request })));
    if (!choices.length) { void vscode.window.showInformationMessage(t('No pending database requests.')); return; }
    const selected = await vscode.window.showQuickPick(choices, { title: t('Database approvals') }); if (!selected) return;
    const decision = await vscode.window.showQuickPick([{ label: t('Approve requested permissions'), value: 'approve' }, { label: t('Adjust permissions and approve'), value: 'adjust' }, { label: t('Reject'), value: 'reject' }], { title: selected.label }); if (!decision) return;
    const permissions = decision.value === 'adjust' ? await this.editPermissions(selected.request.permissions) : selected.request.permissions; if (!permissions) return;
    const reason = await vscode.window.showInputBox({ title: t('Review reason (optional)') }); if (reason === undefined) return;
    const result: DatabaseRequest = await this.call({ kind: 'host', action: 'review', host: selected.host, requestId: selected.request.requestId, approve: decision.value !== 'reject', permissions, reason });
    await this.refresh();
    if (result.databaseId) void vscode.window.showInformationMessage(t('Database approved: {0}. Link this ID in the project database settings.', result.databaseId));
  }
  private async manageGrants() {
    const choices = this.catalogs().flatMap(({ host, catalog }) => catalog.grants.filter(grant => !grant.revokedAt).map(grant => ({ label: catalog.spaces.find(space => space.spaceId === grant.spaceId)?.name ?? grant.spaceId, description: `${host} · ${grant.projectId} / ${grant.entryId}`, host, grant })));
    const selected = await vscode.window.showQuickPick(choices, { title: t('Database permissions') }); if (!selected) return;
    const action = (await vscode.window.showQuickPick([{ label: t('Narrow permissions'), value: 'narrow' as const }, { label: t('Revoke access'), value: 'revoke' as const }, { label: t('Rotate credentials'), value: 'rotate' as const }], { title: selected.label }))?.value; if (!action) return;
    const permissions = action === 'narrow' ? await this.editPermissions(selected.grant.permissions) : undefined; if (action === 'narrow' && !permissions) return;
    if (action !== 'narrow' && await vscode.window.showWarningMessage(t('Change this access grant? Existing consumers may stop working. Stored data will be kept.'), { modal: true }, t('Confirm')) !== t('Confirm')) return;
    await this.call({ kind: 'host', action, host: selected.host, grantId: selected.grant.grantId, permissions }); await this.refresh();
  }
  dispose() { if (this.disposed) return; this.disposed = true; clearTimeout(this.timer); this.controller.abort(); ++this.epoch; for (const panel of this.panels.values()) panel.dispose(); this.panels.clear(); for (const subscription of this.subscriptions) subscription.dispose(); }
}
