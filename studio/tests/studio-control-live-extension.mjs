import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { createStudioControlHandler } from '../extensions/studio-workstation/src/studio-control.ts';
import { startStudioControlBridge } from '../extensions/studio-workstation/src/studio-control-bridge.ts';
import { IMPORTED_PROJECTS_KEY } from '../extensions/studio-workstation/src/projects.ts';
import { prepareStudioControlApplication } from '../extensions/studio-workstation/src/assistant-application.ts';
import { createProjectRuntime } from '../extensions/studio-workstation/src/workflow-runtime-node.ts';

export function activate(context) {
  void run(context).then(report => writeFile(process.env.STUDIO_CONTROL_TEST_REPORT, JSON.stringify(report, null, 2)))
    .catch(error => writeFile(process.env.STUDIO_CONTROL_TEST_REPORT, JSON.stringify({ passed: false, error: error.stack })));
}

async function run(context) {
  const checks = [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.equal(folder?.uri.scheme, 'file', 'A real local Node extension host is required.');
  assert.equal(vscode.workspace.isTrusted, true);
  const workdir = folder.uri.fsPath;
  const outside = path.join(path.dirname(workdir), 'outside');
  const ids = ['294b1eec-23fa-42cf-9fd3-2417f71c0570', '615e6cf6-b40a-456a-8d19-b71c63454c7a'];
  await mkdir(outside, { recursive: true });
  const manifest = (id, relatedProjects = []) => ({ id, name: 'Control test', steamHarness: { projectInfo: { relatedProjects } } });
  await writeFile(path.join(workdir, 'package.json'), JSON.stringify(manifest(ids[0], [{ alias: 'notes', projectId: ids[1] }])));
  await writeFile(path.join(outside, 'package.json'), JSON.stringify(manifest(ids[1])));
  await writeFile(path.join(workdir, 'control.txt'), 'first\nsecond line\n');
  await writeFile(path.join(outside, 'control.txt'), 'external\n');
  await context.globalState.update(IMPORTED_PROJECTS_KEY, [{ id: ids[1], uri: vscode.Uri.file(outside).toString(), name: 'Notes' }]);
  const studio = vscode.extensions.getExtension('studio.studio-workstation');
  assert.ok(studio, 'The actual Studio extension must be installed.');
  await studio.activate();
  const application = await prepareStudioControlApplication({
    templateDir: process.env.STUDIO_CONTROL_TEST_TEMPLATE,
    storageDir: path.join(context.globalStorageUri.fsPath, 'control'),
    dependencySources: [process.env.STUDIO_CONTROL_TEST_ASSISTANT],
  });
  const controller = new AbortController();
  const bridge = await startStudioControlBridge(createStudioControlHandler({ workdir,
    roots: [{ folderPath: workdir, uri: folder.uri.toString(), name: folder.name }] }, controller.signal, context), controller.signal);
  const { installProjectRuntimeGlobal } = await import(process.env.STUDIO_CONTROL_TEST_RUNTIME_API);
  const runtime = installProjectRuntimeGlobal();
  const collection = vscode.languages.createDiagnosticCollection('studio-control-live');
  const terminals = new Set(vscode.window.terminals);
  const themeConfiguration = vscode.workspace.getConfiguration('workbench');
  const windowConfiguration = vscode.workspace.getConfiguration('window');
  const themeSettings = [[themeConfiguration, 'colorTheme'], [windowConfiguration, 'autoDetectColorScheme'],
    [windowConfiguration, 'autoDetectHighContrast']].map(([configuration, key]) => ({ configuration, key, original: configuration.inspect(key) }));
  let connection;
  let launcher, projectSession;
  const connect = async policy => runtime.connectMcpServer({
    id: 'workflow-studio', command: [process.env.STUDIO_CONTROL_TEST_NODE, process.env.STUDIO_CONTROL_TEST_CLI, 'mcp',
      application, '--data-dir', path.join(path.dirname(workdir), 'mcp', policy)],
    inheritEnvironment: ['STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN'],
    environment: { STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY: policy, STEAMHARNESS_CLI_AUTH_DIR: path.join(path.dirname(workdir), 'auth') },
  }, { allowedInheritedEnvKeys: ['STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN'],
    env: { STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: bridge.url, STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: bridge.token } });
  const call = async (name, input = {}) => {
    const result = await connection.callTool(name, input);
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
    const structured = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.equal(structured.status, 'success');
    assert.ok(structured.output && typeof structured.output === 'object', JSON.stringify(structured));
    return structured.output.value;
  };
  try {
    connection = await connect('auto');
    assert.deepEqual(connection.tools.map(tool => tool.name).sort(),
      ['studio_state', 'get_related_projects', 'open_file', 'get_diagnostics', 'set_theme', 'open_terminal', 'show_view'].sort());
    const opened = await call('open_file', { filePath: 'control.txt', line: 2, column: 4 });
    assert.equal(opened.line, 2); assert.equal(opened.column, 4);
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, await realpath(path.join(workdir, 'control.txt')));
    assert.equal(vscode.window.activeTextEditor.selection.active.character, 3);
    checks.push('open_file: actual editor and selection');
    const state = await call('studio_state');
    assert.equal(state.vscodeVersion, vscode.version); assert.equal(state.pathAccess, 'all');
    assert.equal(state.activeEditor.filePath, opened.filePath);
    checks.push('studio_state: actual host, editor, themes and auto scope');
    const related = await call('get_related_projects');
    assert.equal(related.projectId, ids[0]); assert.equal(related.projectDir, await realpath(workdir));
    assert.equal(related.relatedProjects[0].imported, true);
    assert.equal(related.relatedProjects[0].projectDir, await realpath(outside));
    assert.equal((await call('get_related_projects', { projectDir: outside })).projectId, ids[1]);
    await writeFile(path.join(outside, 'package.json'), JSON.stringify(manifest(ids[0])));
    assert.equal((await call('get_related_projects')).relatedProjects[0].imported, false);
    checks.push('get_related_projects: actual imports and UUID revalidation');
    const diagnostic = new vscode.Diagnostic(new vscode.Range(1, 2, 1, 5), 'Control diagnostic', vscode.DiagnosticSeverity.Error);
    collection.set(vscode.Uri.file(path.join(workdir, 'control.txt')), [diagnostic]);
    const diagnostics = await call('get_diagnostics', { filePath: 'control.txt' });
    assert.ok(diagnostics.diagnostics.some(entry => entry.message === diagnostic.message && entry.line === 2 && entry.column === 3));
    assert.ok((await call('get_diagnostics')).diagnostics.some(entry => entry.message === diagnostic.message));
    checks.push('get_diagnostics: actual diagnostic collection and one-based positions');
    const nextKind = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? vscode.ColorThemeKind.Dark : vscode.ColorThemeKind.Light;
    const uiTheme = nextKind === vscode.ColorThemeKind.Dark ? 'vs-dark' : 'vs';
    const themeEntry = vscode.extensions.all.flatMap(extension => extension.packageJSON?.contributes?.themes ?? [])
      .find(theme => theme.uiTheme === uiTheme);
    const theme = themeEntry?.id ?? themeEntry?.label;
    assert.ok(theme, 'An installed theme with a different color kind is required.');
    await themeConfiguration.update('colorTheme', state.theme, vscode.ConfigurationTarget.Workspace);
    await windowConfiguration.update('autoDetectColorScheme', true, vscode.ConfigurationTarget.Workspace);
    assert.equal((await call('set_theme', { theme })).theme, theme);
    assert.equal(vscode.workspace.getConfiguration('workbench').get('colorTheme'), theme);
    for (let attempt = 0; attempt < 100 && vscode.window.activeColorTheme.kind !== nextKind; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(vscode.window.activeColorTheme.kind, nextKind, 'The actual theme must change, not just the stored preference.');
    assert.equal((await connection.callTool('set_theme', { theme: 'studio-control-nonexistent-theme' })).isError, true);
    checks.push('set_theme: actual color kind, workspace overrides and invalid-theme rejection');
    const terminal = await call('open_terminal', { cwd: outside });
    assert.equal(terminal.cwd, await realpath(outside));
    const nativeTerminal = vscode.window.terminals.find(item => !terminals.has(item) && item.name === terminal.name);
    assert.ok(nativeTerminal); assert.ok((await nativeTerminal.processId) > 0);
    assert.equal(nativeTerminal.creationOptions.cwd, terminal.cwd);
    const defaultTerminal = await call('open_terminal');
    assert.equal(defaultTerminal.cwd, await realpath(workdir));
    checks.push('open_terminal: actual native terminal, external and default directories, no commands sent');
    for (const view of ['explorer', 'search', 'source-control', 'terminal', 'assistant']) {
      assert.equal((await call('show_view', { view })).view, view);
    }
    await assert.rejects(connection.callTool('show_view', { view: 'workbench.action.closeWindow' }), /Invalid arguments/);
    checks.push('show_view: all five actual registered views and arbitrary-command rejection');
    const external = path.join(outside, 'control.txt');
    assert.equal((await call('open_file', { filePath: external })).filePath, await realpath(external));
    for (const policy of ['workspace', 'read-only']) {
      await connection.close(); connection = await connect(policy);
      const state = await call('studio_state');
      assert.equal(state.permissionPolicy, policy); assert.equal(state.pathAccess, 'workspace');
      assert.equal((await connection.callTool('open_file', { filePath: external })).isError, true);
      assert.equal((await connection.callTool('get_related_projects', { projectDir: outside })).isError, true);
      assert.equal((await connection.callTool('open_terminal', { cwd: outside })).isError, true);
    }
    checks.push('permissions: auto allows external paths, workspace and read-only reject them');

    const projectDirectory = path.join(workdir, 'build-in', 'build-in-studio-control');
    await mkdir(projectDirectory, { recursive: true });
    for (const file of ['package.json', 'index.ts', 'interface.ts', 'host-bridge.ts', 'workflow-runtime.ts']) {
      await copyFile(path.join(process.env.STUDIO_CONTROL_TEST_PROJECT, file), path.join(projectDirectory, file));
    }
    await symlink(path.join(process.env.STUDIO_CONTROL_TEST_ASSISTANT, 'node_modules'), path.join(projectDirectory, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir');
    for (const [directory, dependency] of [['core', 'steamharness'], ['cli', '@steamharness/cli']]) {
      await symlink(await realpath(path.join(process.env.STUDIO_CONTROL_TEST_ASSISTANT, 'node_modules', dependency)), path.join(workdir, directory),
        process.platform === 'win32' ? 'junction' : 'dir');
    }
    await writeFile(path.join(projectDirectory, 'control.txt'), 'first\nsecond line\n');
    launcher = createProjectRuntime({ extensionUri: studio.extensionUri, globalStorageUri: context.globalStorageUri, globalState: context.globalState },
      { getConnection: () => undefined, onDidChange: () => ({ dispose() {} }) });
    const inspected = await launcher.inspect([projectDirectory]);
    assert.deepEqual(inspected.errors, []);
    const project = { ...inspected.projects[0], uri: vscode.Uri.file(projectDirectory).toString() };
    assert.equal(project.id, '09145339-e3dd-4bb2-ac9b-6c180ef51933');
    assert.equal(project.projectType, 'workflow'); assert.equal(project.assistant, undefined);
    assert.equal(project.entrypoints.length, 7);
    projectSession = await launcher.start(project, 'editor');
    assert.equal(projectSession.ready.project.projectType, 'workflow');
    const projectCall = async (id, params = {}) => {
      const run = await runProject(projectSession, id, params);
      assert.equal(run.status, 'success', `${id}: ${run.error ?? JSON.stringify(run.report)}`);
      return run.items[0].content;
    };
    const normalState = await projectCall('studio_state');
    assert.equal(normalState.workdir, projectDirectory);
    assert.equal(normalState.pathAccess, 'workspace');
    assert.equal((await projectCall('get_related_projects')).projectId, project.id);
    const projectFile = path.join(projectDirectory, 'control.txt');
    assert.equal((await projectCall('open_file', { filePath: 'control.txt', line: '2', column: '4' })).filePath, await realpath(projectFile));
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, await realpath(projectFile));
    collection.set(vscode.Uri.file(projectFile), [diagnostic]);
    assert.ok((await projectCall('get_diagnostics', { filePath: 'control.txt' })).diagnostics.some(entry => entry.message === diagnostic.message));
    assert.equal((await projectCall('set_theme', { theme: state.theme })).theme, state.theme);
    assert.equal(vscode.workspace.getConfiguration('workbench').get('colorTheme'), state.theme);
    assert.equal((await projectCall('open_terminal')).cwd, await realpath(projectDirectory));
    assert.equal((await projectCall('show_view', { view: 'explorer' })).view, 'explorer');
    const denied = await runProject(projectSession, 'open_file', { filePath: external });
    assert.equal(denied.status, 'failed'); assert.match(denied.error, /only access/);
    checks.push('normal Workflow: inspect and run all seven imported source entrypoints without an assistant, defaulting to the project directory and workspace scope');
    const projectUrl = projectSession.ready.url;
    await projectSession.close(); projectSession = undefined;
    await assert.rejects(fetch(projectUrl, { signal: AbortSignal.timeout(2_000) }));
    checks.push('normal Workflow lifecycle: closing the project closes its runtime');

    const otherManifest = JSON.parse(await readFile(path.join(projectDirectory, 'package.json'), 'utf8'));
    otherManifest.id = ids[0];
    await writeFile(path.join(projectDirectory, 'package.json'), JSON.stringify(otherManifest));
    const other = (await launcher.inspect([projectDirectory])).projects[0];
    projectSession = await launcher.start({ ...other, uri: project.uri }, 'editor');
    const unconnected = await runProject(projectSession, 'studio_state');
    assert.equal(unconnected.status, 'failed'); assert.match(unconnected.error, /available only inside SteamHarness Studio/);
    checks.push('normal Workflow isolation: another project receives no control connection');

    controller.abort(); await bridge.close();
    assert.equal((await connection.callTool('studio_state', {})).isError, true);
    checks.push('lifecycle: session cancellation revokes the endpoint');
    return { passed: true, mode: 'headless-web-with-real-node-extension-host', controlSource: ['packaged-template', 'imported-project-source'], vscodeVersion: vscode.version, checks };
  } finally {
    await projectSession?.close(); launcher?.dispose();
    collection.dispose();
    for (const terminal of vscode.window.terminals) { if (!terminals.has(terminal)) terminal.dispose(); }
    for (const { configuration, key, original } of themeSettings) {
      await configuration.update(key, original?.globalValue, vscode.ConfigurationTarget.Global);
      if (original?.workspaceValue !== undefined || configuration.inspect(key)?.workspaceValue !== undefined) {
        await configuration.update(key, original?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      }
    }
    await connection?.close(); await bridge.close();
  }
}

async function runProject(session, entrypointId, params = {}) {
  const url = new URL(session.ready.url);
  const capability = new URLSearchParams(url.hash.slice(1)).get('session');
  const post = async message => {
    const response = await fetch(new URL('/api/message', url), { method: 'POST',
      headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.messages;
  };
  const messages = await post({ type: 'workflow-run', entrypointId, params });
  const id = messages.find(message => message.type === 'workflow-started')?.id;
  assert.ok(id, 'The ordinary Workflow run must start.');
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = (await post({ type: 'workflow-trace', id })).find(message => message.type === 'trace-run')?.run;
    if (run && run.status !== 'running') {
      await waitForIdle(url, capability);
      return run;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Ordinary Workflow entrypoint timed out: ${entrypointId}`);
}

async function waitForIdle(url, capability) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(new URL('/api/events', url), { headers: { Authorization: `Bearer ${capability}` }, signal: AbortSignal.timeout(5_000) });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'The Workflow state stream must remain available.');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    } finally { await reader.cancel(); }
    const state = JSON.parse(buffer.slice(6, buffer.indexOf('\n\n')));
    if (!state.running) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('The ordinary Workflow controller must release the completed run.');
}
