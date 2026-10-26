const assert = require('node:assert/strict');
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

exports.run = async () => {
  assert.equal(vscode.workspace.isTrusted, true, 'Studio must trust the opened workspace by default.');
  const extension = vscode.extensions.getExtension('studio.studio-workstation');
  assert.ok(extension, 'Studio extension must be loaded by the workstation.');
  await extension.activate();
  assert.ok(extension.isActive, 'Studio extension must activate.');
  assert.equal(fs.existsSync(path.join(extension.extensionPath, 'dist/runtime')), false, 'The workstation must not bundle Core or the CLI.');
  assert.ok(fs.existsSync(path.join(extension.extensionPath, 'dist/developer-assistant/skills/workflow-generator/SKILL.md')), 'The dedicated assistant skill must be packaged.');
  assert.equal(vscode.extensions.getExtension('GitHub.copilot-chat'), undefined, 'Built-in Copilot must be excluded.');
  assert.equal(vscode.workspace.getConfiguration('chat').get('disableAIFeatures'), true, 'Default AI features must be hidden.');
  assert.equal(vscode.workspace.getConfiguration('workbench').get('iconTheme'), 'file-icons', 'Studio must default to File Icons.');
  assert.ok(vscode.extensions.getExtension('nextbook.file-and-folder-icons'), 'Default icon extension must be installed.');

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of extension.packageJSON.contributes.commands) {
    assert.ok(commands.has(command.command), `${command.command} must be registered.`);
  }
  await vscode.commands.executeCommand('workbench.view.extension.studio-info');
  await vscode.commands.executeCommand('studio.refreshProjects');
  await vscode.commands.executeCommand('studio.newFile');
  assert.ok(vscode.window.activeTextEditor?.document.isUntitled, 'New File must open an untitled editor.');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  const terminalsBefore = new Set(vscode.window.terminals);
  await vscode.commands.executeCommand('studio.openTerminal');
  const terminal = vscode.window.terminals.find((entry) => !terminalsBefore.has(entry));
  assert.ok(terminal, 'New Terminal must create a native terminal.');
  assert.equal(terminal.name, 'Studio');
  terminal.dispose();
  const accounts = await vscode.authentication.getAccounts('studio-steamharness');
  assert.ok(Array.isArray(accounts), 'Workflow authentication provider must be registered.');
  await vscode.commands.executeCommand('studio.openAccount');
  const findAccountTab = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputWebview && tab.label === (vscode.env.language.startsWith('zh') ? accounts.length ? '设置' : '登录' : accounts.length ? 'Settings' : 'Sign In'));
  await new Promise((resolve, reject) => {
    if (findAccountTab()) { resolve(); return; }
    const changed = vscode.window.tabGroups.onDidChangeTabs(() => {
      if (findAccountTab()) { clearTimeout(timeout); changed.dispose(); resolve(); }
    });
    const timeout = setTimeout(() => { changed.dispose(); reject(new Error('Workflow account must open as an editor tab.')); }, 5000);
  });
  await vscode.window.tabGroups.close(findAccountTab());
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-smoke-'));
  const projectId = '7e203f8c-ce8e-40bc-8cda-4cb26bf0f859';
  const demoName = 'Project CLI smoke';
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ id: projectId, name: demoName }));
  const cliDir = path.join(projectDir, 'node_modules/@steamharness/cli');
  fs.mkdirSync(path.join(cliDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '0.0.0', type: 'module', bin: { 'steamharness': 'dist/index.js' } }));
  fs.writeFileSync(path.join(cliDir, 'dist/index.js'), `
    import {createServer} from 'node:http';import {createInterface} from 'node:readline';import {writeFileSync,existsSync,readFileSync} from 'node:fs';import path from 'node:path';
    const project={id:${JSON.stringify(projectId)},name:${JSON.stringify(demoName)},folderPath:process.cwd(),projectType:'conversation',fields:[],entrypoints:[]};
    if(process.argv.includes('--inspect')&&!process.argv.includes('--host-stdio'))console.log(JSON.stringify({projects:[project],errors:[]}));
    else{const input=createInterface({input:process.stdin});let server;input.on('line',line=>{
      const message=JSON.parse(line);if(message.type==='configure'){
        const loaded=message.assistantProjectDir?{...project,id:JSON.parse(readFileSync(path.join(message.assistantProjectDir,'package.json'),'utf8')).id,name:'Project Assistant',folderPath:message.assistantProjectDir,tools:[{name:'skill'}]}:project;
        if(process.argv.includes('--inspect')){console.log(JSON.stringify({assistantProtocolVersion:1,projects:[loaded],errors:[]}));input.close();process.stdin.pause();return;}
        if(existsSync(path.join(process.cwd(),'startup.fail'))){console.error('Fixture startup failed.');process.exit(1);}
        server=createServer((request,response)=>response.end('<html><body>Project CLI</body></html>'));server.listen(0,'127.0.0.1',()=>{
          writeFileSync(path.join(process.cwd(),message.surface+'.pid'),String(process.pid));writeFileSync(path.join(process.cwd(),message.surface+'.json'),JSON.stringify(message));
          console.log(JSON.stringify({type:'ready',protocolVersion:1,hostProtocolVersion:1,accountProtocolVersion:1,assistantProtocolVersion:1,url:'http://127.0.0.1:'+server.address().port+'/#session='+'a'.repeat(64),project:loaded,runtime:{coreVersion:'project-version',corePath:process.cwd()+'/node_modules/steamharness'}}));
        });
      }else if(message.type==='close'){input.close();process.stdin.pause();server?.close();}
    });input.on('close',()=>{process.stdin.pause();server?.close();});}
  `);
  assert.ok(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(projectDir), name: demoName }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(vscode.workspace.isTrusted, true, 'Adding a new folder must preserve workspace trust.');
  await vscode.commands.executeCommand('studio.refreshProjects');
  await vscode.commands.executeCommand('studio.openProject', { uri: vscode.Uri.file(projectDir).toString() });
  const findProjectTab = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputWebview && tab.label === demoName);
  if (!findProjectTab()) {
    // Tab notifications can arrive after the command resolves.
    await new Promise((resolve, reject) => {
      const changed = vscode.window.tabGroups.onDidChangeTabs(() => {
        if (findProjectTab()) { clearTimeout(timeout); changed.dispose(); resolve(); }
      });
      const timeout = setTimeout(() => {
        changed.dispose(); reject(new Error('Workflow demo must open as a native editor webview.'));
      }, 5000);
    });
  }
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(projectDir, 'package.json')));
  await vscode.commands.executeCommand('studio.openAssistant');
  const assistantRecordDir = path.join(process.env.STUDIO_STEAMHARNESS_SOURCE, 'build-in', 'build-in-developer-assistant');
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(assistantRecordDir, 'assistant.json')); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(path.join(assistantRecordDir, 'assistant.json')), 'Opening the assistant must start its own CLI.');
  const assistantConfiguration = JSON.parse(fs.readFileSync(path.join(assistantRecordDir, 'assistant.json'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(assistantConfiguration.assistantProjectDir, 'package.json'), 'utf8')).id, 'a3aca697-b086-459b-84e4-d357ad2d9fb2');
  assert.equal(assistantConfiguration.assistant.standalone, true);
  assert.equal(assistantConfiguration.assistant.workdir, projectDir, 'Assistant tools must use the currently opened folder.');
  assert.equal(assistantConfiguration.assistant.roots[0].folderPath, projectDir);
  assert.equal(assistantConfiguration.corePath, path.join(assistantRecordDir, 'node_modules/steamharness/dist/index.js'), 'The assistant must use its own Core.');
  assert.equal(fs.existsSync(path.join(projectDir, 'assistant.json')), false, 'The opened project CLI must never host the assistant.');
  const assistantPid = Number(fs.readFileSync(path.join(assistantRecordDir, 'assistant.pid'), 'utf8'));
  const firstPid = Number(fs.readFileSync(path.join(projectDir, 'editor.pid'), 'utf8'));
  assert.notEqual(assistantPid, firstPid, 'The assistant and editor tab must have independent CLI sessions.');
  process.kill(firstPid);
  await new Promise(resolve => setTimeout(resolve, 250));
  await vscode.commands.executeCommand('studio.openProject', { uri: vscode.Uri.file(projectDir).toString() });
  assert.notEqual(Number(fs.readFileSync(path.join(projectDir, 'editor.pid'), 'utf8')), firstPid, 'Running again must replace an exited project CLI.');
  assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.label === demoName).length, 1, 'Restart must reuse the existing tab.');
  const secondPid = Number(fs.readFileSync(path.join(projectDir, 'editor.pid'), 'utf8'));
  process.kill(secondPid);
  await new Promise(resolve => setTimeout(resolve, 250));
  fs.writeFileSync(path.join(projectDir, 'startup.fail'), '');
  let failedRestartFinished = false;
  const failedRestart = vscode.commands.executeCommand('studio.openProject', { uri: vscode.Uri.file(projectDir).toString() }).then(() => { failedRestartFinished = true; });
  for (let attempt = 0; attempt < 100 && !failedRestartFinished; attempt++) {
    await vscode.commands.executeCommand('notifications.clearAll');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(failedRestartFinished, 'The failed restart command must finish after its notification is dismissed.');
  await failedRestart;
  assert.equal(findProjectTab(), undefined, 'A failed restart must dispose its disconnected tab.');
  fs.rmSync(path.join(projectDir, 'startup.fail'));
  await vscode.commands.executeCommand('studio.openProject', { uri: vscode.Uri.file(projectDir).toString() });
  assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.label === demoName).length, 1, 'Running after a failed restart must not leave a duplicate tab.');
  await vscode.commands.executeCommand('studio.openProjectSource');
  assert.ok(vscode.window.activeTextEditor.document.getText().includes(projectId), 'Workflow source action must open the selected project.');
  await vscode.commands.executeCommand('studio.openProjectCli');
  const cli = vscode.window.terminals.find((terminal) => terminal.name === 'SteamHarness CLI');
  assert.ok(cli, 'SteamHarness CLI must open a native terminal.');
  const closed = new Promise((resolve, reject) => {
    const listener = vscode.window.onDidCloseTerminal((terminal) => { if (terminal === cli) { clearTimeout(timeout); listener.dispose(); resolve(); } });
    const timeout = setTimeout(() => { listener.dispose(); reject(new Error('Logout must close the SteamHarness CLI terminal.')); }, 5000);
  });
  await vscode.commands.executeCommand('studio.logout'); await closed;
  await vscode.window.tabGroups.close(findProjectTab());
  const originalFolder = vscode.workspace.workspaceFolders.find(folder => folder.name !== demoName);
  await vscode.window.showTextDocument(vscode.Uri.joinPath(originalFolder.uri, 'package.json'));
  await vscode.commands.executeCommand('studio.openAssistant');
  assert.throws(() => process.kill(assistantPid, 0), 'Switching folders must stop and save the previous assistant CLI.');
  assert.notEqual(Number(fs.readFileSync(path.join(assistantRecordDir, 'assistant.pid'), 'utf8')), assistantPid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(assistantRecordDir, 'assistant.json'), 'utf8')).assistant.workdir, originalFolder.uri.fsPath);
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log('Studio desktop smoke passed: project-owned CLI tabs, folder-scoped assistant with its own Core, skills and saved sessions.');
};
