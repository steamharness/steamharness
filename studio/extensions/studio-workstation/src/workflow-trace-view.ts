import * as vscode from 'vscode';
import { localizationHtml } from './localization-host';
import { webviewContextMenu } from './webview-context-menu';
import { TraceStore } from './workflow-trace-store';
import { projectWindowKey, type Project } from './workflow-types';
import type { TraceTarget } from './workflow-trace-types';
import type { TraceAgentAction } from './workflow-agent-types';

export class TraceView {
  private readonly store: TraceStore;
  private readonly changes = new vscode.EventEmitter<void>();
  private view?: vscode.WebviewView;
  private published = '';
  private available?: boolean;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly context: vscode.ExtensionContext, private readonly openProject: (project: Project) => Promise<void>,
    private readonly output: vscode.OutputChannel, source?: TraceView, subscriptions: vscode.Disposable[] = context.subscriptions) {
    this.store = source ? source.store.fork() : new TraceStore();
    subscriptions.push(this, ...(source ? [source.changes.event(() => this.publish())] : [vscode.window.registerWebviewViewProvider('studio.trace', {
      resolveWebviewView: view => this.resolve(view),
    }, { webviewOptions: { retainContextWhenHidden: true } })]));
  }
  update(projects: Project[], preferred?: Project): void { this.store.update(projects, preferred); this.publish(); }
  bind(project: Project, version: number | undefined, webview: vscode.Webview) {
    const binding = this.store.bind(project, version, message => void webview.postMessage(message));
    this.publish();
    return {
      receive: (message: Record<string, any>) => {
        const open = binding.receive(message); this.schedule();
        if (open) { void vscode.commands.executeCommand('studio.trace.focus'); }
      },
      dispose: () => { binding.dispose(); this.publish(); },
    };
  }
  private schedule(): void {
    if (this.timer) { return; }
    this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, 50);
  }
  private publish(force = false): void {
    this.changes.fire();
    const state = this.store.state();
    const available = state.projects.length > 0;
    if (available !== this.available) {
      this.available = available;
      void vscode.commands.executeCommand('setContext', 'studio.projectTraceAvailable', available);
    }
    // Retained hidden panels keep their last content. Publish the newest state
    // when revealed without serializing every background streaming frame.
    if (!this.view?.visible) { return; }
    const project = state.projects.find(project => project.uri === state.selection.projectUri);
    this.view.description = project && [project.name, project.version].filter(Boolean).join(' \u00b7 ');
    const signature = JSON.stringify(state);
    if (!force && signature === this.published) { return; }
    this.published = signature;
    void this.view.webview.postMessage(state);
  }
  resolve(view: vscode.WebviewView): void {
    this.view = view;
    this.published = '';
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const nonce = globalThis.crypto.randomUUID().replace(/-/g, '');
    const asset = (name: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name)).toString();
    view.webview.html = `<!DOCTYPE html><html lang="${vscode.env.language}"><head>${webviewContextMenu(this.context, view)}<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; img-src ${view.webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('trace-ui.css')}">
      </head><body><div id="trace-app"></div>${localizationHtml(nonce)}<script nonce="${nonce}" src="${asset('trace-ui.js')}"></script></body></html>`;
    const receive = view.webview.onDidReceiveMessage(message => void this.receive(message));
    const visibility = view.onDidChangeVisibility(() => { if (view.visible) { this.publish(true); } });
    const dispose = view.onDidDispose(() => { receive.dispose(); visibility.dispose(); dispose.dispose(); if (this.view === view) { this.view = undefined; this.published = ''; } });
    this.publish();
  }
  private async receive(message: { type?: string; generation?: number; projectUri?: string; target?: TraceTarget; text?: string; action?: TraceAgentAction }): Promise<void> {
    if (message.type === 'ready') { this.publish(true); return; }
    if (message.generation !== this.store.generation) { return; }
    try {
      if (message.type === 'select') {
        const project = this.store.availableProjects().find(project => projectWindowKey(project) === message.projectUri);
        if (!project) { return; }
        this.store.select(projectWindowKey(project), message.target); this.publish();
        const selection = this.store.selection;
        if (!this.store.hasConnection(projectWindowKey(project))) { await this.openProject(project); }
        if (this.store.selection === selection && message.target?.runId) { this.store.request('run', message.target.runId); this.publish(); }
      } else if (message.projectUri === this.store.selection.projectUri) {
        if (message.type === 'agent-action' && message.action) {
          if (this.store.action(message.action)) {
            this.publish();
            if (message.action.type !== 'agent') {
              const project = this.store.availableProjects().find(project => projectWindowKey(project) === message.projectUri);
              if (project?.assistant) { await vscode.commands.executeCommand('studio.developerAssistant.focus'); }
              else if (project) { await this.openProject(project); }
            }
          }
        }
        if (message.type === 'more') { this.store.request('more'); }
        if (message.type === 'copy' && typeof message.text === 'string') { await vscode.env.clipboard.writeText(message.text); }
        if (message.type === 'connect') {
          const project = this.store.availableProjects().find(project => projectWindowKey(project) === message.projectUri);
          if (project) { await this.openProject(project); }
        }
      }
    } catch (error) { this.output.appendLine(`Workflow trace: ${String(error)}`); await vscode.window.showErrorMessage(String(error)); }
  }
  dispose(): void { clearTimeout(this.timer); this.changes.dispose(); this.view = undefined; }
}
