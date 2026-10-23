import * as vscode from 'vscode';
import { t } from './localization';
import type { Project } from './workflow-types';

const toolTitles = {
  kv: 'KV Storage', knowledge: 'Knowledge Base', info: 'Project Information',
  assistant: 'Assistant', versions: 'Versions', trace: 'Run Trace',
} as const;
export type InstanceTool = keyof typeof toolTitles;
export interface ToolInstance {
  update(projects: Project[], preferred?: Project): void | Promise<void>;
  resolve(view: vscode.WebviewView): void | Promise<void>;
  selectProject?(): Promise<void>;
}

/** Panels reuse the same tool controllers as IDE views, with a lifetime and selection per instance. */
export class ToolInstances implements vscode.Disposable {
  private projects: Project[] = [];
  private preferred?: Project;
  private readonly ordinals = new Map<InstanceTool, number>();
  private readonly panels = new Map<vscode.WebviewPanel, { tool: ToolInstance; preferred?: string; dispose(): void }>();

  constructor(context: vscode.ExtensionContext, private readonly factory: (kind: InstanceTool, subscriptions: vscode.Disposable[], restored: boolean) => ToolInstance) {
    context.subscriptions.push(this,
      vscode.commands.registerCommand('studio.createToolInstance', (kind: string) => this.open(kind)),
      vscode.commands.registerCommand('studio.selectToolInstanceProject', async (kind?: string) => {
        const active = [...this.panels].find(([panel]) => panel.active && (!kind || panel.viewType === `studio.tool.${kind}`))?.[1];
        if (active?.tool.selectProject) { await active.tool.selectProject(); }
        else { await vscode.commands.executeCommand(kind === 'versions' ? 'studio.selectVersionsProject' : 'studio.selectInfoProject'); }
      }),
      ...Object.keys(toolTitles).map(kind => vscode.window.registerWebviewPanelSerializer(`studio.tool.${kind}`, {
        deserializeWebviewPanel: (panel, state) => this.attach(kind as InstanceTool, panel,
          state && typeof state === 'object' && 'projectUri' in state && typeof state.projectUri === 'string' ? { projectUri: state.projectUri } : undefined, true),
      })),
    );
  }

  update(projects: Project[], preferred?: Project): void {
    this.projects = projects; this.preferred = preferred;
    for (const entry of this.panels.values()) {
      void entry.tool.update(projects, projects.find(project => project.uri === entry.preferred));
    }
  }

  async open(kind: string): Promise<void> {
    if (!Object.hasOwn(toolTitles, kind)) { return; }
    const tool = kind as InstanceTool;
    const ordinal = (this.ordinals.get(tool) ?? 1) + 1;
    this.ordinals.set(tool, ordinal);
    const panel = vscode.window.createWebviewPanel(`studio.tool.${kind}`, `${t(toolTitles[tool])} ${ordinal}`,
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    await this.attach(tool, panel);
  }

  private async attach(kind: InstanceTool, panel: vscode.WebviewPanel, state?: { projectUri?: string }, restored = false): Promise<void> {
    const ordinal = Number(/\s(\d+)$/.exec(panel.title)?.[1]) || 1;
    this.ordinals.set(kind, Math.max(this.ordinals.get(kind) ?? 1, ordinal));
    panel.title = `${t(toolTitles[kind])} ${ordinal}`;
    const subscriptions: vscode.Disposable[] = [];
    const controller = this.factory(kind, subscriptions, restored);
    const target = this.projects.find(project => project.uri === state?.projectUri) ?? this.preferred;
    let disposed = false;
    const entry = { tool: controller, preferred: state?.projectUri ?? target?.uri, dispose: () => {
      if (disposed) { return; }
      disposed = true; this.panels.delete(panel);
      for (const subscription of subscriptions.splice(0).reverse()) { subscription.dispose(); }
    } };
    this.panels.set(panel, entry);
    subscriptions.push(panel.onDidDispose(entry.dispose));
    // Adapt the public view surface instead of teaching every tool a second rendering path.
    const view: vscode.WebviewView = {
      viewType: panel.viewType, webview: panel.webview,
      get title() { return panel.title; }, set title(_value: string | undefined) {},
      description: undefined, badge: undefined,
      get visible() { return panel.visible; }, onDidDispose: panel.onDidDispose,
      onDidChangeVisibility: listener => panel.onDidChangeViewState(() => listener()),
      show: preserveFocus => panel.reveal(panel.viewColumn, preserveFocus),
    };
    try {
      await controller.update(this.projects, target);
      if (!disposed) { await controller.resolve(view); }
    } catch (error) { entry.dispose(); panel.dispose(); throw error; }
  }

  dispose(): void {
    for (const [panel, entry] of [...this.panels]) { entry.dispose(); panel.dispose(); }
  }
}
