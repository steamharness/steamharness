import { t } from './localization';
import * as vscode from 'vscode';
import { createAssistantProject, DEVELOPER_ASSISTANT_PROJECT_ID } from './assistant-workspace';
import type { AssistantWorkspaceFolder, Project } from './workflow-types';
import type { Launcher } from './workflow-cli-types';

export interface AssistantConversation { dispose(): Promise<void>; closed: Promise<void> }

export class AssistantViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private conversation?: AssistantConversation;
  private binding = Promise.resolve();
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
  ) {
    context.subscriptions.push(this,
      vscode.window.registerWebviewViewProvider('studio.developerAssistant', this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.bind()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.bind()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleBind()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('studio.project.nodePath')) { this.key = ''; void this.bind(); }
      }),
      vscode.commands.registerCommand('studio.openAssistant', () => this.show()),
      vscode.commands.registerCommand('studio.newAssistantConversation', () => this.command('new')),
      vscode.commands.registerCommand('studio.searchAssistantConversations', () => this.command('history')),
    );
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const listener = view.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'assistant-retry') { this.key = ''; void this.bind(); }
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

  private bind(): Promise<void> {
    clearTimeout(this.bindTimer); this.bindTimer = undefined;
    const epoch = ++this.epoch;
    this.binding = this.binding.catch(() => undefined).then(async () => {
      const view = this.view;
      if (this.disposed || !view || epoch !== this.epoch) { return; }
      const folders: AssistantWorkspaceFolder[] = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
        .map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name }));
      const active = vscode.window.activeTextEditor?.document.uri;
      const activeFolder = active && vscode.workspace.getWorkspaceFolder(active);
      const target = folders.find(folder => folder.uri === activeFolder?.uri.toString())
        ?? folders.find(folder => folder.uri === this.targetUri) ?? folders[0];
      const key = JSON.stringify([this.runtime.available, vscode.workspace.isTrusted, target?.uri, folders]);
      if (key === this.key) { return; }
      await this.closeConversation();
      this.key = '';
      if (this.disposed || view !== this.view || epoch !== this.epoch) { return; }
      this.targetUri = target?.uri ?? '';
      view.description = target?.name;
      if (!this.runtime.available) {
        view.webview.html = welcomeHtml(view.webview, this.context.extensionUri, t("Node extension host is unavailable"));
        this.key = key;
        return;
      }
      if (!target || !vscode.workspace.isTrusted) {
        view.webview.html = welcomeHtml(view.webview, this.context.extensionUri,
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
        this.view.webview.html = welcomeHtml(this.view.webview, this.context.extensionUri, t("Failed to load Assistant"), 'assistant-retry', error instanceof Error ? error.message : String(error));
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

function welcomeHtml(webview: vscode.Webview, extension: vscode.Uri, label: string, action?: string, detail?: string): string {
  const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
  const escape = (text: string): string => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  return `<!doctype html><html lang="${vscode.env.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${escape(webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist/scrollbars.css')).toString())}">
    <style nonce="${nonce}">body{padding:20px 16px;color:var(--vscode-descriptionForeground);font:var(--vscode-font-size) var(--vscode-font-family)}p{white-space:pre-wrap;overflow-wrap:anywhere}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 10px;cursor:pointer}</style></head><body><div role="status"><p>${escape(label)}</p>${detail ? `<p>${escape(detail)}</p>` : ''}${action ? `<button id="assistant-action">${escape(action === 'assistant-open-folder' ? t("Open Folder") : t("Retry"))}</button>` : ''}</div>
    ${action ? `<script nonce="${nonce}">const vscode = acquireVsCodeApi(); document.getElementById('assistant-action').onclick = () => vscode.postMessage({type:${JSON.stringify(action)}});</script>` : ''}</body></html>`;
}
