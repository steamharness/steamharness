import { t } from './localization';
import { localizationHtml } from './localization-host';
import * as vscode from 'vscode';
import { projectVersion, projectDisplayName, type Project } from './workflow-types';
import type { Launcher } from './workflow-cli-types';
import type { AccountController } from './workflow-auth';
import type { ResourceKind, ResourceRequest } from './workflow-resources-types';

export class ResourceViews implements vscode.Disposable {
  private projects: Project[] = [];
  private selected?: Project;
  private preferredUri?: string;
  private generation = 0;
  private controller = new AbortController();
  private readonly views = new Map<ResourceKind, vscode.WebviewView>();
  private readonly published = new Map<ResourceKind, string>();
  private readonly busy = new Set<ResourceKind>();
  private connectionKey?: string;
  private workspaceUris = new Set<string>();
  private readonly external = new Map<string, { project: Project; runtime: Project; source: 'local' | 'server' }>();
  private readonly navigation = new Map<ResourceKind, Record<string, string>>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly launcher: Launcher,
    private readonly account: AccountController, private readonly output: vscode.OutputChannel) {
    this.connectionKey = JSON.stringify(account.getConnection());
    context.subscriptions.push(this,
      ...(['kv', 'knowledge'] as const).map(kind => vscode.window.registerWebviewViewProvider(`studio.${kind}`, {
        resolveWebviewView: view => this.resolve(kind, view),
      }, { webviewOptions: { retainContextWhenHidden: true } })),
      vscode.commands.registerCommand('studio.refreshResources', () => this.reset()),
      account.onDidChange(() => {
        const connectionKey = JSON.stringify(account.getConnection());
        if (connectionKey !== this.connectionKey) { this.connectionKey = connectionKey; this.reset(); }
      }),
    );
  }

  update(projects: Project[], preferred?: Project): void {
    this.workspaceUris = new Set(projects.filter(project => !project.assistant).map(project => project.uri));
    this.projects = [...projects.filter(project => !project.assistant), ...[...this.external.values()].map(entry => entry.project).filter(project => !projects.some(item => item.uri === project.uri))];
    const changedPreferred = preferred?.uri !== this.preferredUri;
    this.preferredUri = preferred?.uri;
    const next = changedPreferred ? this.projects.find(project => project.uri === preferred?.uri)
      : this.projects.find(project => project.uri === this.selected?.uri);
    const selected = next ?? this.projects[0];
    let restored = false;
    if (changedPreferred && selected && this.workspaceUris.has(selected.uri)) {
      restored = this.external.delete(selected.uri); this.navigation.clear();
    }
    const changed = restored || JSON.stringify(selected) !== JSON.stringify(this.selected);
    this.selected = selected;
    void vscode.commands.executeCommand('setContext', 'studio.projectResourcesAvailable', this.projects.length > 0);
    if (changed) { this.reset(); } else { this.publish(); }
  }

  async open(kind: ResourceKind, project: Project, target: Record<string, string>, owner: Project): Promise<void> {
    if (project.id.toLowerCase() === owner.id.toLowerCase()) {
      project = this.projects.find(item => item.uri === owner.uri) ?? owner;
      this.external.delete(project.uri);
    } else {
      this.external.set(project.uri, { project, runtime: target.source === 'server' ? owner : project, source: target.source === 'server' ? 'server' : 'local' });
    }
    if (!this.projects.some(item => item.uri === project.uri)) { this.projects.push(project); }
    this.selected = project;
    this.navigation.clear(); this.navigation.set(kind, target); this.reset();
    await vscode.commands.executeCommand('setContext', 'studio.projectResourcesAvailable', true);
    await vscode.commands.executeCommand(`studio.${kind}.focus`);
    this.views.get(kind)?.show(true); this.publish();
  }

  private reset(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.busy.clear();
    ++this.generation;
    this.publish();
  }

  private publish(forceKind?: ResourceKind): void {
    for (const [kind, view] of this.views) {
      view.description = this.selected && projectDisplayName(this.selected);
      const state = { type: 'resources-state', kind, generation: this.generation,
        selected: this.selected?.uri, projects: this.projects.map(project => ({ uri: project.uri, id: project.id, name: project.name,
          projectType: project.projectType, folderPath: project.folderPath, ...(projectVersion(project) ? { version: projectVersion(project) } : {}) })),
        authenticated: !!this.account.getConnection(), focus: this.navigation.get(kind)?.projectId === this.selected?.id ? this.navigation.get(kind) : undefined,
        readOnly: !!this.selected && this.external.has(this.selected.uri), source: this.selected && this.external.get(this.selected.uri)?.source };
      const signature = JSON.stringify(state);
      if (kind !== forceKind && signature === this.published.get(kind)) { continue; }
      this.published.set(kind, signature);
      void view.webview.postMessage(state);
    }
  }

  private resolve(kind: ResourceKind, view: vscode.WebviewView): void {
    this.views.set(kind, view);
    this.published.delete(kind);
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    view.webview.html = this.html(kind, view.webview);
    const listener = view.webview.onDidReceiveMessage(message => void this.receive(kind, view, message));
    const visibility = view.onDidChangeVisibility(() => { if (view.visible) { this.publish(kind); } });
    const disposal = view.onDidDispose(() => {
      listener.dispose(); visibility.dispose(); disposal.dispose();
      if (this.views.get(kind) === view) { this.views.delete(kind); this.published.delete(kind); }
    });
    this.publish();
  }

  private async receive(kind: ResourceKind, view: vscode.WebviewView, message: {
    type?: string; id?: number; generation?: number; projectUri?: string; input?: ResourceRequest; text?: string;
  }): Promise<void> {
    if (message.type === 'ready') { this.publish(kind); return; }
    if (message.type === 'login') { this.account.open(); return; }
    if (message.type === 'select') {
      const selected = this.projects.find(project => project.uri === message.projectUri);
      if (selected && selected.uri !== this.selected?.uri) {
        if (this.workspaceUris.has(selected.uri)) { this.external.delete(selected.uri); }
        this.selected = selected; this.navigation.clear(); this.reset();
      }
      return;
    }
    if (message.type === 'copy') {
      if (message.generation === this.generation && message.projectUri === this.selected?.uri && typeof message.text === 'string') {
        await vscode.env.clipboard.writeText(message.text);
      }
      return;
    }
    const project = this.selected;
    const input = message.input;
    if (message.type !== 'request' || !Number.isSafeInteger(message.id) || !input || !project
      || message.generation !== this.generation || message.projectUri !== project.uri) { return; }
    const generation = this.generation;
    const signal = this.controller.signal;
    const connection = this.account.getConnection();
    let mutation = false;
    try {
      if (!vscode.workspace.isTrusted || !this.projects.some(item => item.uri === project.uri)) { throw new Error('Workflow workspace is unavailable.'); }
      if (!['list', 'get', 'save', 'delete'].includes(input.action)) { throw new Error('Invalid resource operation.'); }
      if (!this.launcher.resource) { throw new Error('Node extension host is unavailable.'); }
      if (JSON.stringify(input).length > 1024 * 1024) { throw new Error(t("Content exceeds 1 MiB.")); }
      if (input.action === 'save' || input.action === 'delete') {
        if (this.external.has(project.uri)) { throw new Error(t('This resource preview is read-only.')); }
        if (this.busy.has(kind)) { throw new Error(t("A data operation is in progress.")); }
        mutation = true;
        this.busy.add(kind);
      }
      if (input.action === 'delete') {
        const label = input.key ?? input.title ?? input.documentId ?? '';
        const remove = t("Delete");
        const result = await vscode.window.showWarningMessage(t("Delete \"{0}\"?", label), { modal: true }, remove);
        if (result !== remove) {
          await view.webview.postMessage({ type: 'resources-result', id: message.id, generation, value: { cancelled: true } }); return;
        }
      }
      signal.throwIfAborted();
      const external = this.external.get(project.uri);
      const value = await this.launcher.resource(external?.runtime ?? project, { ...input, kind,
        ...(external ? { source: external.source, ...(external.source === 'server' ? { projectId: project.id } : {}) } : {}) }, signal);
      if (generation === this.generation) { await view.webview.postMessage({ type: 'resources-result', id: message.id, generation, value }); }
    } catch (error) {
      if (generation !== this.generation) { return; }
      const storage = error as { status?: number; source?: string; sources?: string[] };
      if (storage.status === 401 && connection) {
        await this.account.invalidate(connection);
        if (generation !== this.generation) { return; }
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Workflow ${kind}: ${detail}`);
      await view.webview.postMessage({ type: 'resources-result', id: message.id, generation, error: detail, source: storage.source, sources: storage.sources });
    } finally { if (mutation && generation === this.generation) { this.busy.delete(kind); } }
  }

  private html(kind: ResourceKind, webview: vscode.Webview): string {
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    return `<!DOCTYPE html><html lang="${vscode.env.language}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('resources-ui.css')}">
      </head><body data-resource-kind="${kind}"><div id="resources-app"></div>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('resources-ui.js')}"></script></body></html>`;
  }

  dispose(): void { this.controller.abort(); this.views.clear(); this.published.clear(); }
}
