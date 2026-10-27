import { t } from './localization';
import { localizationHtml } from './localization-host';
import { webviewContextMenu } from './webview-context-menu';
import * as vscode from 'vscode';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { projectDisplayName, projectWindowKey, type Project } from './workflow-types';
import { projectInfoItems, type InfoItem, type InfoState } from './workflow-info';
import type { ProjectVersionStatus } from './steamharness-server-projects';

export class InfoView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private listeners: vscode.Disposable[] = [];
  private projects: Project[] = [];
  private selected?: Project;
  private preferredUri?: string;
  private items: InfoItem[] = [];
  private loading = Promise.resolve();
  private generation = 0;
  private loadedUri?: string;

  constructor(private readonly context: vscode.ExtensionContext, private readonly versions: {
    getVersionStatus(project: Project): ProjectVersionStatus; onDidChangeVersions: vscode.Event<void>;
  }, register = true, subscriptions: vscode.Disposable[] = context.subscriptions) {
    subscriptions.push(this,
      ...(register ? [
      vscode.window.registerWebviewViewProvider('studio.projectInfo', this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand('studio.selectInfoProject', () => this.selectProject()),
      vscode.commands.registerCommand('studio.openInfoProjectSource', () => this.selected && vscode.commands.executeCommand('studio.openProjectSource', this.selected)),
      vscode.commands.registerCommand('studio.copyProjectInfoValue', (item?: InfoItem) => this.copy(item?.id)),
      ] : []),
      versions.onDidChangeVersions(() => this.publish()),
    );
  }

  update(projects: Project[], preferred?: Project): Promise<void> {
    this.projects = projects.filter(project => !project.assistant && ['workflow', 'conversation', 'kanban'].includes(project.projectType));
    const changedPreferred = (preferred && projectWindowKey(preferred)) !== this.preferredUri;
    this.preferredUri = (preferred && projectWindowKey(preferred));
    const selected = this.projects.find(project => projectWindowKey(project) === (changedPreferred ? (preferred && projectWindowKey(preferred)) : (this.selected && projectWindowKey(this.selected)))) ?? this.projects[0];
    void vscode.commands.executeCommand('setContext', 'studio.projectInfoAvailable', this.projects.length > 0);
    void vscode.commands.executeCommand('setContext', 'studio.projectInfoMultipleProjects', this.projects.length > 1);
    if (selected !== this.selected) { this.selected = selected; return this.reload(); }
    return this.loading;
  }

  private reload(): Promise<void> {
    const generation = ++this.generation, project = this.selected;
    if (!project || projectWindowKey(project) !== this.loadedUri) {
      this.items = project ? [{ id: 'loading', label: t("Loading"), icon: 'loading~spin' }] : [];
    }
    this.loading = project ? this.load(project, generation) : Promise.resolve();
    this.publish();
    return this.loading;
  }

  private async load(project: Project, generation: number): Promise<void> {
    let items: InfoItem[];
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.Uri.parse(project.uri), 'package.json'));
      items = projectInfoItems(project, JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      items = [{ id: 'error', label: t("Unable to read project information"), value: error instanceof Error ? error.message : String(error), icon: 'warning' }];
    }
    if (generation !== this.generation) { return; }
    this.loadedUri = projectWindowKey(project);
    this.items = items;
    this.publish();
  }

  async selectProject(): Promise<void> {
    const picked = await vscode.window.showQuickPick(this.projects.map(project => ({
      label: projectDisplayName(project), iconPath: vscode.Uri.parse(projectAvatarDataUrl(project.projectCard, project.projectType)), description: project.projectType, detail: project.folderPath, project,
    })), { title: t("Select Project"), placeHolder: t("Project") });
    const selected = this.projects.find(project => projectWindowKey(project) === (picked && projectWindowKey(picked.project)));
    if (selected && selected !== this.selected) { this.selected = selected; await this.reload(); }
  }

  private publish(): void {
    if (!this.view) { return; }
    this.view.description = this.selected && projectDisplayName(this.selected);
    const state: InfoState = { type: 'info-state', generation: this.generation,
      project: this.selected && { uri: projectWindowKey(this.selected), name: this.selected.name, avatarUrl: projectAvatarDataUrl(this.selected.projectCard, this.selected.projectType) }, items: this.items,
      update: this.selected && !this.selected.builtin ? this.versions.getVersionStatus(this.selected) : undefined };
    void this.view.webview.postMessage(state);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const listener of this.listeners.splice(0)) { listener.dispose(); }
    this.view = view;
    view.title = t("Information");
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const asset = (name: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    view.webview.html = `<!DOCTYPE html><html lang="${vscode.env.language}"><head>${webviewContextMenu(this.context, view)}<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('info-ui.css')}">
      </head><body><main id="info-app"></main><div id="info-announcement" class="sr-only" role="status"></div>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('info-ui.js')}"></script></body></html>`;
    this.listeners.push(view.webview.onDidReceiveMessage(message => this.receive(message)),
      view.onDidChangeVisibility(() => { if (view.visible) { this.publish(); } }),
      view.onDidDispose(() => { if (this.view === view) { this.view = undefined; for (const listener of this.listeners.splice(0)) { listener.dispose(); } } }));
    this.publish();
  }

  private async receive(message: { type?: string; generation?: number; projectUri?: string; itemId?: string }): Promise<void> {
    if (message.type === 'ready') { this.publish(); return; }
    if (message.generation !== this.generation || message.projectUri !== (this.selected && projectWindowKey(this.selected))) { return; }
    if (message.type === 'source' && this.selected) { await vscode.commands.executeCommand('studio.openProjectSource', this.selected); return; }
    if (message.type === 'refresh') { await this.reload(); return; }
    if (message.type === 'upgrade' && message.generation === this.generation && message.projectUri === (this.selected && projectWindowKey(this.selected))) {
      await vscode.commands.executeCommand('studio.upgradeProject', this.selected); return;
    }
    if (message.type === 'copy' && message.generation === this.generation && message.projectUri === (this.selected && projectWindowKey(this.selected))) {
      if (await this.copy(message.itemId) && message.generation === this.generation) {
        void this.view?.webview.postMessage({ type: 'info-copied', generation: this.generation, itemId: message.itemId });
      }
    }
  }

  private async copy(id?: string): Promise<boolean> {
    const find = (items: InfoItem[]): InfoItem | undefined => {
      for (const item of items) {
        if (item.id === id) { return item; }
        const child = item.children && find(item.children);
        if (child) { return child; }
      }
    };
    const item = find(this.items);
    if (typeof item?.value !== 'string') { return false; }
    try { await vscode.env.clipboard.writeText(item.value); return true; }
    catch (error) { await vscode.window.showErrorMessage(t("Unable to copy value: {0}", error instanceof Error ? error.message : String(error))); return false; }
  }

  dispose(): void { ++this.generation; this.view = undefined; for (const listener of this.listeners.splice(0)) { listener.dispose(); } }
}
