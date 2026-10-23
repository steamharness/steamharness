import * as vscode from 'vscode';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

export async function activate(context) {
  try {
    await vscode.extensions.getExtension('studio.studio-workstation').activate();
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.headers.authorization !== `Bearer ${process.env.STUDIO_START_TEST_TOKEN}`) { response.writeHead(403).end('{}'); return; }
      try {
        let body = ''; for await (const chunk of request) { body += chunk; }
        const input = body ? JSON.parse(body) : {};
        let result;
        if (input.action === 'command') { result = await vscode.commands.executeCommand(input.command, ...(input.args ?? [])); }
        else if (input.action === 'recent' || input.action === 'nativeRecent') {
          const folders = input.paths.map(path => ({ uri: vscode.Uri.file(path) }));
          for (const folder of folders) { await vscode.commands.executeCommand('_workbench.addToRecentlyOpened', { uri: folder.uri, type: 'folder' }); }
          if (input.workspace) { await vscode.commands.executeCommand('_workbench.addToRecentlyOpened', { uri: vscode.Uri.file(input.workspace), type: 'workspace' }); }
          if (input.action === 'recent') { vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0, ...folders); }
        } else if (input.action === 'removeFolders') {
          vscode.workspace.updateWorkspaceFolders(1, vscode.workspace.workspaceFolders.length - 1);
          await vscode.workspace.getConfiguration('editor').update('editContext', false, vscode.ConfigurationTarget.Global);
        }
        else if (input.action === 'untitled') {
          const document = await vscode.workspace.openTextDocument({ content: input.text ?? '' }); await vscode.window.showTextDocument(document);
          result = document.uri.toString();
        } else if (input.action === 'file') { await vscode.window.showTextDocument(vscode.Uri.file(input.path), { viewColumn: input.column }); }
        else if (input.action === 'webview') {
          const panel = vscode.window.createWebviewPanel(input.viewType ?? 'studio-test.generic', input.title ?? 'Workspace Probe', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
          panel.webview.html = '<html><body><input id="workspace-probe" value="retained-tool-state"></body></html>';
          context.subscriptions.push(panel);
        }
        else if (input.action === 'closeTab') {
          const group = vscode.window.tabGroups.all.find(group => group.viewColumn === input.column);
          const tab = group?.tabs.find(tab => input.viewType ? tab.input?.viewType?.endsWith(input.viewType) : tab.label === input.label);
          if (!tab) { throw new Error(`Missing tab in column ${input.column}`); }
          result = await vscode.window.tabGroups.close(tab);
        }
        else if (input.action === 'reload') {
          // Acknowledge before the extension host is restarted by the native command.
          setTimeout(() => { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }, 50);
        }
        else if (input.action === 'terminalInput') {
          const terminal = vscode.window.terminals[input.index ?? 0];
          if (!terminal) { throw new Error('Missing test terminal'); }
          terminal.sendText(input.text);
        }
        else if (input.action === 'diff') {
          const a = await vscode.workspace.openTextDocument({ content: '' }), b = await vscode.workspace.openTextDocument({ content: '' });
          await vscode.commands.executeCommand('vscode.diff', a.uri, b.uri, 'Empty diff');
        } else if (input.action === 'theme') {
          await vscode.workspace.getConfiguration('window').update('autoDetectColorScheme', false, vscode.ConfigurationTarget.Global);
          await vscode.workspace.getConfiguration('workbench').update('colorTheme', input.theme, vscode.ConfigurationTarget.Global);
          result = vscode.workspace.getConfiguration('workbench').get('colorTheme');
        } else if (input.action === 'configure') {
          await vscode.workspace.getConfiguration().update(input.key, input.value, vscode.ConfigurationTarget.Global);
          result = vscode.workspace.getConfiguration().get(input.key);
        } else if (input.action === 'replace') {
          const editor = vscode.window.activeTextEditor, document = editor.document;
          await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), input.text));
        } else if (input.action === 'installationLog') {
          await vscode.commands.executeCommand('studio.showProjectSetupLog');
          result = vscode.window.activeTextEditor?.document.getText();
        } else if (input.action === 'state') {
          result = { language: vscode.env.language, extensionPath: vscode.extensions.getExtension('studio.studio-workstation').extensionPath,
            start: await vscode.commands.executeCommand('studio.internalGetStartState'),
            folders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath),
            active: vscode.window.activeTextEditor?.document.uri.toString(),
            documents: vscode.workspace.textDocuments.map(document => ({ uri: document.uri.toString(), text: document.getText(), dirty: document.isDirty })),
            groups: vscode.window.tabGroups.all.map(group => ({ column: group.viewColumn, active: group.isActive, tabs: group.tabs.map(tab => ({ label: tab.label, active: tab.isActive, dirty: tab.isDirty, uri: tab.input?.uri?.toString(), viewType: tab.input?.viewType })) })) };
        } else { throw new Error(`Unknown test action: ${input.action}`); }
        response.end(JSON.stringify({ ok: true, result }));
      } catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.stack })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.subscriptions.push({ dispose: () => server.close() });
    await writeFile(process.env.STUDIO_START_TEST_READY, JSON.stringify({ port: server.address().port,
      folders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) }));
  } catch (error) { await writeFile(process.env.STUDIO_START_TEST_READY, JSON.stringify({ error: error.stack })); }
}
