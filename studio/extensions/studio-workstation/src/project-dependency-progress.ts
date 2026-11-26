import * as vscode from 'vscode';
import { t } from './localization';
import { dependencyProgressHtml } from './project-dependency-progress-html';

const viewType = 'studio.projectDependencyProgress';
const openCommand = 'studio.internalShowDependencyProgress';
const logLimit = 200_000;
const completedLimit = 5;

type State = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
interface Options {
  title: string;
  directory: string;
  signal: AbortSignal;
  describeError?: (error: unknown) => string;
  retry?: () => Thenable<unknown>;
}
interface Operation {
  id: number;
  options: Options;
  controller: AbortController;
  state: State;
  message?: string;
  log: string;
  truncated: boolean;
}
interface Progress {
  signal: AbortSignal;
  report(message: string): void;
  append(chunk: string): void;
}
interface ProgressView {
  panel: vscode.WebviewPanel;
  listeners: vscode.Disposable[];
  ready: boolean;
}

const active = ({ state }: Operation) => state === 'running' || state === 'cancelling';
const stateLabel = (state: State) => ({
  running: t('Dependencies in progress'), cancelling: t('Cancelling...'), completed: t('Dependencies completed'),
  failed: t('Dependency operation failed'), cancelled: t('Dependency operation cancelled'),
})[state];

export class ProjectDependencyProgress implements vscode.Disposable {
  private readonly operations = new Map<number, Operation>();
  private readonly lifetime = new AbortController();
  private entry?: { status: vscode.StatusBarItem; command: vscode.Disposable };
  private view?: ProgressView;
  private sequence = 0;
  private selected?: number;
  private publishTimer?: ReturnType<typeof setTimeout>;

  async run<T>(options: Options, task: (progress: Progress) => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted();
    options.signal.throwIfAborted();
    const operation: Operation = { id: ++this.sequence, options, controller: new AbortController(), state: 'running', log: '', truncated: false };
    const signal = AbortSignal.any([options.signal, operation.controller.signal, this.lifetime.signal]);
    if (options.retry) {
      for (const previous of this.operations.values()) {
        if (previous.options.directory === options.directory && previous.options.retry) previous.options = { ...previous.options, retry: undefined };
      }
    }
    this.operations.set(operation.id, operation);
    this.selected = operation.id;
    this.updateStatus();
    this.schedulePublish();
    try {
      const result = await task({
        signal,
        report: message => { if (operation.state === 'running') { operation.message = message; this.schedulePublish(); } },
        append: chunk => {
          if (!chunk || !active(operation)) return;
          operation.truncated ||= operation.log.length + chunk.length > logLimit;
          operation.log = (operation.log + chunk).slice(-logLimit);
          this.schedulePublish();
        },
      });
      operation.state = 'completed';
      return result;
    } catch (error) {
      operation.state = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
      if (operation.state === 'failed') {
        operation.message = options.describeError?.(error) ?? (error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      const completed = [...this.operations.values()].filter(item => !active(item));
      for (const item of completed.slice(0, Math.max(0, completed.length - completedLimit))) this.operations.delete(item.id);
      this.updateStatus();
      this.schedulePublish();
    }
  }

  private primary(): Operation | undefined {
    const runs = [...this.operations.values()].reverse();
    return runs.find(active) ?? runs[0];
  }

  private updateStatus(): void {
    const run = this.primary();
    if (!run || this.lifetime.signal.aborted) return;
    if (!this.entry) {
      const status = vscode.window.createStatusBarItem('projectDependencyProgress', vscode.StatusBarAlignment.Left, 111);
      status.name = t('Dependency Details');
      status.command = openCommand;
      this.entry = { status, command: vscode.commands.registerCommand(openCommand, () => this.open()) };
    }
    const { status } = this.entry;
    const count = [...this.operations.values()].filter(active).length;
    const label = count > 1 ? t('{0} dependency operations in progress', count) : stateLabel(run.state);
    const icon = active(run) ? 'loading~spin' : run.state === 'completed' ? 'check' : run.state === 'failed' ? 'error' : 'circle-slash';
    status.text = `$(${icon}) ${label}`;
    status.tooltip = `${run.options.title}\n${run.options.directory}\n${t('Show Dependency Details')}`;
    status.accessibilityInformation = { label: `${label}. ${t('Show Dependency Details')}`, role: 'button' };
    status.show();
  }

  private open(): void {
    this.selected = this.primary()?.id;
    if (this.selected === undefined) return;
    if (this.view) { this.view.panel.reveal(); this.publish(); return; }
    const panel = vscode.window.createWebviewPanel(viewType, t('Dependency Details'), vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [],
    });
    const view: ProgressView = { panel, listeners: [], ready: false };
    this.view = view;
    view.listeners.push(panel.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
      for (const listener of view.listeners) listener.dispose();
    }), panel.onDidChangeViewState(() => this.publish()), panel.webview.onDidReceiveMessage((message?: { type?: string; id?: number }) => {
      if (this.view !== view) return;
      if (message?.type === 'ready') { view.ready = true; this.publish(); return; }
      if (!view.ready || !panel.visible || typeof message?.id !== 'number') return;
      const run = this.operations.get(message.id);
      if (!run) return;
      if (message.type === 'select') { this.selected = run.id; this.publish(); return; }
      if (this.selected !== run.id) return;
      if (message.type === 'cancel' && run.state === 'running') {
        run.state = 'cancelling';
        run.controller.abort();
        this.updateStatus();
        this.publish();
      } else if (message.type === 'retry' && run.options.retry && (run.state === 'failed' || run.state === 'cancelled')) {
        void Promise.resolve().then(run.options.retry).catch(error => {
          run.message = run.options.describeError?.(error) ?? String(error);
          this.publish();
        });
      }
    }));
    panel.webview.html = dependencyProgressHtml(vscode.env.language);
  }

  private schedulePublish(): void {
    if (!this.view?.ready || this.publishTimer !== undefined) return;
    this.publishTimer = setTimeout(() => { this.publishTimer = undefined; this.publish(); }, 150);
  }

  private publish(): void {
    if (!this.view?.ready || !this.view.panel.visible) return;
    const run = (this.selected === undefined ? undefined : this.operations.get(this.selected)) ?? this.primary();
    if (!run) return;
    this.selected = run.id;
    void this.view.panel.webview.postMessage({ type: 'dependency-progress', id: run.id, title: run.options.title, directory: run.options.directory,
      state: stateLabel(run.state), message: run.state === 'running' || run.state === 'failed' ? run.message : undefined, log: run.log,
      truncated: run.truncated, active: active(run), canCancel: run.state === 'running',
      canRetry: !!run.options.retry && (run.state === 'failed' || run.state === 'cancelled'),
      operations: [...this.operations.values()].reverse().map(item => ({ id: item.id, title: item.options.title, directory: item.options.directory, state: stateLabel(item.state) })),
    });
  }

  dispose(): void {
    this.lifetime.abort();
    clearTimeout(this.publishTimer);
    this.operations.clear();
    this.view?.panel.dispose();
    this.entry?.command.dispose();
    this.entry?.status.dispose();
  }
}
