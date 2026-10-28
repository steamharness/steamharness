import * as vscode from 'vscode';
import path from 'node:path';
import { configuredNodeRuntime, resetNodeRuntime } from './node-runtime-configuration';
import { nodeRuntimeEnvironment } from './node-runtime';
import { t } from './localization';

export async function activateNodeRuntime(context: vscode.ExtensionContext): Promise<void> {
  let epoch = 0;
  context.environmentVariableCollection.persistent = false;
  context.subscriptions.push(vscode.commands.registerCommand('studio.internalResolveNodeTask', async (command = 'node') => {
    const runtime = await configuredNodeRuntime(context.globalStorageUri.fsPath);
    if (runtime.source === 'host') return undefined;
    const manager = command.toLowerCase().replace(/\.(cmd|exe)$/, '');
    const cli = manager === 'pnpm' ? runtime.pnpmCli : manager === 'npx' && runtime.npmCli ? path.join(path.dirname(runtime.npmCli), 'npx-cli.js') : runtime.npmCli;
    if (manager !== 'node' && !cli) throw new Error(t('The selected Node.js has no package manager. Repair the bundled runtime or choose a local Node.js installation with npm.'));
    return { nodePath: runtime.nodePath, args: manager === 'node' ? [] : [cli!], env: { PATH: nodeRuntimeEnvironment(runtime).PATH } };
  }));
  context.subscriptions.push(vscode.commands.registerCommand('studio.internalGetNodeRuntime', async () => {
    try {
      const runtime = await configuredNodeRuntime(context.globalStorageUri.fsPath);
      return { source: runtime.source, version: runtime.version, path: runtime.nodePath };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }));
  const apply = async () => {
    const current = ++epoch;
    try {
      const runtime = await configuredNodeRuntime(context.globalStorageUri.fsPath);
      if (current !== epoch) return;
      context.environmentVariableCollection.clear();
      if (runtime.pathEntries.length) context.environmentVariableCollection.prepend('PATH', runtime.pathEntries.join(path.delimiter) + path.delimiter,
        { applyAtProcessCreation: true, applyAtShellIntegration: true });
    } catch (error) {
      if (current !== epoch) return;
      context.environmentVariableCollection.clear();
      const action = t('Open Settings');
      void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error), action).then(selected => {
        if (selected === action) void vscode.commands.executeCommand('studio.openSettings');
      });
    }
  };
  context.subscriptions.push({ dispose: () => { epoch++; } }, vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('studio.project.nodeSource') && !event.affectsConfiguration('studio.project.nodePath')) return;
    resetNodeRuntime(); void apply();
    void vscode.window.showInformationMessage(t('Node.js changes apply to new sessions. Restart existing project services and terminals to use the selected runtime.'));
  }));
  for (const type of ['node', 'pwa-node']) context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(type, {
    async resolveDebugConfigurationWithSubstitutedVariables(_folder, config) {
      if (config.request !== 'launch' || config.runtimeVersion || config.runtimeExecutable && config.runtimeExecutable !== 'node') return config;
      const runtime = await configuredNodeRuntime(context.globalStorageUri.fsPath);
      if (runtime.source === 'host') return config;
      return { ...config, runtimeExecutable: runtime.nodePath, env: nodeRuntimeEnvironment(runtime, { ...process.env, ...config.env }) };
    },
  }));
  await apply();
}
