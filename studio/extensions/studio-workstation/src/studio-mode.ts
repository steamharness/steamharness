import * as vscode from 'vscode';
import { t } from './localization';

/** Publish inspected project availability and host-localized labels to the native workbench. */
export class StudioModeController {
  private available?: boolean;
  private projectUri?: string;
  private ready?: boolean;

  constructor(context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    for (const [command, native] of [
      ['studio.toggleMode', 'studio.internalToggleMode'],
      ['studio.enterIdeMode', 'studio.internalEnterIdeMode'],
      ['studio.enterSteamMode', 'studio.internalEnterSteamMode'],
      ['studio.openSteamTools', 'studio.internalOpenSteamTools'],
    ] as const) {
      context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
        try { await vscode.commands.executeCommand(native); }
        catch (error) {
          output.appendLine(`Studio mode: ${String(error)}`);
          void vscode.window.showErrorMessage(t('Studio: {0}', error instanceof Error ? error.message : String(error)));
        }
      }));
    }
  }

  update(available: boolean, projectUri?: string, ready = false): void {
    if (available === this.available && projectUri === this.projectUri && ready === this.ready) { return; }
    this.available = available;
    this.projectUri = projectUri;
    this.ready = ready;
    void Promise.resolve(vscode.commands.executeCommand('studio.internalUpdateModeState', { available, projectUri, ready, labels: {
      mode: t('Workspace Mode'), ide: 'IDE', steam: 'Steam',
      switchToIde: t('Switch to IDE Mode'), switchToSteam: t('Switch to Steam Mode'),
      loading: t('Loading project...'),
      unavailable: t('Steam Mode is available for SteamHarness projects.'),
      tools: t('Open Tools'), toolsHint: t('Everything you need for your project, in one place.'),
      kv: t('KV Storage'), kvHint: t('Browse and edit project data'),
      knowledge: t('Knowledge Base'), knowledgeHint: t('Manage documents and knowledge'),
      info: t('Project Information'), infoHint: t('View project details and configuration'),
      assistant: t('Assistant'), assistantHint: t('Work with your coding assistant'),
      versions: t('Versions'), versionsHint: t('Manage project versions and updates'),
      trace: t('Run Trace'), traceHint: t('Inspect execution history and logs'),
    } })).catch(error => { this.available = undefined; this.output.appendLine(`Studio mode: ${String(error)}`); });
  }
}
