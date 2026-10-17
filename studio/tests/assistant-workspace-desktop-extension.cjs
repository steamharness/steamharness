const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.activate = context => {
  const directory = process.env.STUDIO_TEST_SCOPE_ROOT;
  for (const folder of ['A', 'B']) {
    context.subscriptions.push(vscode.commands.registerCommand(`studio.testFocus${folder}`, () =>
      vscode.window.showTextDocument(vscode.Uri.file(path.join(directory, folder, 'scope.txt')))));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('studio.testOpenAccount', () => vscode.commands.executeCommand('studio.openWorkflowAccount')),
    vscode.commands.registerCommand('studio.testReadClipboard', async () => {
      await fs.writeFile(path.join(directory, 'clipboard.json'), JSON.stringify(await vscode.env.clipboard.readText()));
    }),
    vscode.commands.registerCommand('studio.testSaveClipboard', async () => {
      await fs.writeFile(path.join(directory, 'original-clipboard.json'), JSON.stringify(await vscode.env.clipboard.readText()));
    }),
    vscode.commands.registerCommand('studio.testRestoreClipboard', async () => {
      await vscode.env.clipboard.writeText(JSON.parse(await fs.readFile(path.join(directory, 'original-clipboard.json'), 'utf8')));
    }),
    vscode.commands.registerCommand('studio.testEmptyWorkspace', () => vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders.length)),
  );
};
