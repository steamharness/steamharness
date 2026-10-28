import { t } from './localization';
import * as vscode from 'vscode';
import { webviewContextMenu } from './webview-context-menu';
import { createAssistantProject, DEVELOPER_ASSISTANT_PROJECT_ID } from './assistant-workspace';
import { openProjectUserSettings } from './workflow-user-settings';
import type { AssistantWorkspaceFolder, Project } from './workflow-types';
import type { Launcher } from './workflow-cli-types';

export interface AssistantConversation { dispose(): Promise<void>; closed: Promise<void> }

export class AssistantViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private conversation?: AssistantConversation;
  private binding = Promise.resolve();
  private retrying?: Promise<void>;
  private closing = Promise.resolve();
  private epoch = 0;
  private key = '';
  private targetUri = '';
  private disposed = false;
  private bindTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: Launcher,
    private readonly output: vscode.OutputChannel,
    private readonly openConversation: (project: Project, view: vscode.WebviewView) => Promise<AssistantConversation>,
    private readonly register = true, subscriptions: vscode.Disposable[] = context.subscriptions,
  ) {
    subscriptions.push(this,
      ...(register ? [vscode.window.registerWebviewViewProvider('studio.developerAssistant', this, { webviewOptions: { retainContextWhenHidden: true } })] : []),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.bind()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.bind()),
      vscode.window.onDidChangeActiveTextEditor(() => { if (this.register) { this.scheduleBind(); } }),
      ...(register ? [vscode.commands.registerCommand('studio.openAssistant', () => this.show()),
      vscode.commands.registerCommand('studio.newAssistantConversation', () => this.command('new')),
      vscode.commands.registerCommand('studio.searchAssistantConversations', () => this.command('history'))] : []),
    );
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const listener = view.webview.onDidReceiveMessage((message) => {
      if (this.disposed || this.view !== view) { return; }
      if (message?.type === 'workflow-user-settings') {
        return openProjectUserSettings(message).catch(error => this.output.appendLine(`User settings: ${String(error)}`));
      }
      if (message?.type === 'assistant-retry') { return this.retry(view); }
      if (message?.type === 'assistant-open-folder') { void vscode.commands.executeCommand('studio.openFolder'); }
    });
    view.onDidDispose(() => {
      listener.dispose();
      if (this.view === view) { this.view = undefined; ++this.epoch; this.key = ''; void this.closeConversation(); }
    });
    await this.bind();
  }

  async showInitially(): Promise<void> {
    if (!this.context.workspaceState.get<boolean>('studio.assistant.initialized')) {
      await vscode.commands.executeCommand('workbench.view.extension.studio-assistant');
      await this.context.workspaceState.update('studio.assistant.initialized', true);
    }
  }

  private async show(): Promise<void> {
    await vscode.commands.executeCommand('studio.developerAssistant.focus');
    await this.bind();
    this.view?.show(false);
  }

  private async command(command: 'new' | 'history'): Promise<void> {
    await this.show();
    if (this.conversation) { await this.view?.webview.postMessage({ type: 'workflow-host', command }); }
  }

  private closeConversation(): Promise<void> {
    const conversation = this.conversation;
    this.conversation = undefined;
    if (conversation) { this.closing = this.closing.catch(() => undefined).then(() => conversation.dispose()); }
    return this.closing;
  }

  private async retry(view: vscode.WebviewView): Promise<void> {
    if (this.disposed || this.view !== view || this.retrying) { return; }
    this.key = '';
    view.webview.html = welcomeHtml(this.context, view, t("Retrying Assistant..."), 'assistant-retry', undefined, true);
    const pending = this.bind(true);
    this.retrying = pending;
    try { await pending; }
    finally { if (this.retrying === pending) { this.retrying = undefined; } }
  }

  private bind(retry = false): Promise<void> {
    clearTimeout(this.bindTimer); this.bindTimer = undefined;
    const epoch = ++this.epoch;
    this.binding = this.binding.catch(() => undefined).then(async () => {
      const view = this.view;
      if (this.disposed || !view || epoch !== this.epoch) { return; }
      const folders: AssistantWorkspaceFolder[] = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
        .map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name }));
      const active = vscode.window.activeTextEditor?.document.uri;
      const activeFolder = active && vscode.workspace.getWorkspaceFolder(active);
      const target = (this.register ? undefined : folders.find(folder => folder.uri === this.targetUri)) ?? folders.find(folder => folder.uri === activeFolder?.uri.toString())
        ?? folders.find(folder => folder.uri === this.targetUri) ?? folders[0];
      const key = JSON.stringify([this.runtime.available, vscode.workspace.isTrusted, target?.uri, folders]);
      if (key === this.key) { return; }
      await this.closeConversation();
      this.key = '';
      if (this.disposed || view !== this.view || epoch !== this.epoch) { return; }
      this.targetUri = target?.uri ?? '';
      view.description = target?.name;
      if (!this.runtime.available) {
        view.webview.html = welcomeHtml(this.context, view, t("Node extension host is unavailable"));
        this.key = key;
        return;
      }
      if (!target || !vscode.workspace.isTrusted) {
        view.webview.html = welcomeHtml(this.context, view,
          target ? t("Trust the current workspace first.") : t("Open a folder to use Assistant."), target ? undefined : 'assistant-open-folder');
        this.key = key;
        return;
      }
      const result = await this.runtime.inspectAssistant(target, folders);
      const project = result.projects.find((project) => project.id === DEVELOPER_ASSISTANT_PROJECT_ID && project.projectType === 'conversation' && project.assistant?.standalone);
      if (!project) { throw new Error(result.errors.join('\n') || t("The standalone Assistant project did not load correctly. Update its @steamharness/cli.")); }
      if (this.disposed || view !== this.view || epoch !== this.epoch) { return; }
      const conversation = await this.openConversation(createAssistantProject({ ...project, uri: '' }, target, folders), view);
      if (this.disposed || view !== this.view || epoch !== this.epoch) { await conversation.dispose(); return; }
      this.conversation = conversation;
      this.key = key;
      void conversation.closed.then(() => {
        if (this.disposed || this.conversation !== conversation) { return; }
        this.conversation = undefined; this.key = '';
      });
    }).catch((error) => {
      this.output.appendLine(`Project Assistant: ${String(error)}`);
      if (!this.disposed && this.view && epoch === this.epoch) {
        this.view.webview.html = welcomeHtml(this.context, this.view, retry ? t("Assistant retry failed") : t("Failed to load Assistant"), 'assistant-retry', error instanceof Error ? error.message : String(error));
      }
    });
    return this.binding;
  }

  private scheduleBind(): void {
    if (this.disposed) { return; }
    ++this.epoch;
    clearTimeout(this.bindTimer);
    this.bindTimer = setTimeout(() => { void this.bind(); }, 150);
  }

  dispose(): void { this.disposed = true; ++this.epoch; clearTimeout(this.bindTimer); void this.closeConversation(); }
}

function welcomeHtml(context: vscode.ExtensionContext, view: vscode.WebviewView, label: string, action?: string, detail?: string, busy = false): string {
  const webview = view.webview, extension = context.extensionUri;
  const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
  const escape = (text: string): string => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  return `<!doctype html><html lang="${vscode.env.language}"><head>${webviewContextMenu(context, view)}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${escape(webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist/scrollbars.css')).toString())}">
    <style nonce="${nonce}">body{padding:20px 16px;color:var(--vscode-descriptionForeground);font:var(--vscode-font-size) var(--vscode-font-family)}p{white-space:pre-wrap;overflow-wrap:anywhere}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 10px;cursor:pointer}button:disabled{cursor:wait;opacity:.7}button[aria-busy="true"]::before{content:'';display:inline-block;width:10px;height:10px;margin-right:6px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:-2px;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div role="status" aria-live="polite" aria-busy="${busy}"><p id="assistant-status">${escape(label)}</p>${detail ? `<p>${escape(detail)}</p>` : ''}${action ? `<button id="assistant-action" data-action="${escape(action)}" data-busy-label="${escape(t("Retrying..."))}" data-busy-status="${escape(t("Retrying Assistant..."))}" aria-busy="${busy}"${busy ? ' disabled' : ''}>${escape(action === 'assistant-open-folder' ? t("Open Folder") : busy ? t("Retrying...") : t("Retry"))}</button>` : ''}</div>
    <script nonce="${nonce}" src="${escape(webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist/welcome-ui.js')).toString())}"></script></body></html>`;
}
