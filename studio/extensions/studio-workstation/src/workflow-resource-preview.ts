import * as vscode from 'vscode';

/** One reusable resource tab beside the conversation that requested it. */
export class SideResourcePreview implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;

  open(title: string, sourceColumn?: vscode.ViewColumn): vscode.WebviewPanel {
    const source = sourceColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
    const columns = vscode.window.tabGroups.all.map(group => group.viewColumn).sort((a, b) => a - b);
    const previous = this.panel?.viewColumn;
    const target = previous !== undefined && (sourceColumn === undefined || previous !== source) && columns.includes(previous) ? previous
      : columns.find(column => column > source) ?? columns.filter(column => column < source).at(-1) ?? vscode.ViewColumn.Beside;
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(target, false);
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel('studio.resourcePreview', title,
      { viewColumn: target, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    const listener = panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; listener.dispose(); });
    return panel;
  }

  dispose(): void { this.panel?.dispose(); this.panel = undefined; }
}
