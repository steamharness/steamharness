import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';

const relative = 'src/vs/workbench/contrib/tasks/browser/';
const helper = await readFile(path.join(ROOT, 'upstream/vscode', relative, 'nodeTaskRuntime.ts'), 'utf8');
const helperJs = ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} }; runInNewContext(helperJs, { module, exports: module.exports });
const { resolveNodeTaskRuntime } = module.exports;
const source = await readFile(path.join(ROOT, 'upstream/vscode', relative, 'terminalTaskSystem.ts'), 'utf8');
const ast = ts.createSourceFile('terminalTaskSystem.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'TerminalTaskSystem');
const method = declaration.members.find(node => node.name?.getText(ast) === '_createShellLaunchConfig');
const javascript = ts.transpileModule(`class TerminalTaskSystem { static ProcessVarName='__process__'; ${method.getText(ast)} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const RuntimeType = { Shell: 1, Process: 2, CustomExecution: 3 };
const TaskSystem = runInNewContext(`${javascript}\nTerminalTaskSystem`, { resolveNodeTaskRuntime, RuntimeType,
  CommandString: { value: command => typeof command === 'string' ? command : command.value }, Types: { isString: value => typeof value === 'string' },
  WorkbenchState: { WORKSPACE: 3 }, TaskTerminalType: 'Task', path });

test('the first implicit Node task waits for optional runtime activation before resolving its executable', async () => {
  const constructor = declaration.members.find(ts.isConstructorDeclaration);
  const assignment = constructor.body.statements.find(node => ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(ast) === 'this._resolveNodeRuntime');
  const expression = ts.transpileModule(`(${assignment.expression.right.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let activated = false, provided = true;
  const runtime = { nodePath: process.execPath, env: { PATH: path.dirname(process.execPath) } };
  const resolver = runInNewContext(expression, {
    IExtensionService: 'extensions', ICommandService: 'commands',
    CommandsRegistry: { getCommand: () => activated && provided },
    instantiationService: { invokeFunction: callback => callback({ get: id => id === 'extensions'
      ? { activateByEvent: async event => { assert.equal(event, 'onCommand:studio.internalResolveNodeTask'); await Promise.resolve(); activated = true; } }
      : { executeCommand: async () => runtime } }) },
  });
  assert.equal(await resolver('node'), runtime);
  provided = false; assert.equal(await resolver('node'), undefined);
});

test('default process tasks replace previously resolved Node and launch real children with the selected runtime', async () => {
  const runtime = { nodePath: process.execPath, env: { PATH: path.dirname(process.execPath) } };
  const system = new TaskSystem();
  Object.assign(system, { _contextService: { getWorkbenchState: () => 1 }, _createTerminalName: () => 'Node task',
    _environmentService: {}, _resolveVariable: async () => '/stale/node', _resolveNodeRuntime: async () => runtime,
    taskShellIntegrationStartSequence: () => '', getTaskShellIntegrationOutputSequence: () => '' });
  const task = { command: { runtime: RuntimeType.Process, name: 'node' }, configurationProperties: {} };
  const args = ['-e', 'console.log(JSON.stringify({node:process.execPath,child:require("node:child_process").execFileSync("node",["-p","process.execPath"],{encoding:"utf8"}).trim()}))'];
  const config = await system._createShellLaunchConfig(task, undefined, undefined, undefined, { env: { CUSTOM: 'value' } }, 'node', args, false, {});
  assert.equal(config.executable, process.execPath); assert.equal(config.env.CUSTOM, 'value');
  assert.deepEqual(JSON.parse(execFileSync(config.executable, config.args, { env: config.env, encoding: 'utf8' })), { node: process.execPath, child: process.execPath });
  system._resolveNodeRuntime = async command => { assert.equal(command, 'pnpm.cmd'); return { ...runtime, args }; };
  const packageTask = await system._createShellLaunchConfig(task, undefined, undefined, undefined, {}, 'pnpm.cmd', [], false, {});
  assert.deepEqual(JSON.parse(execFileSync(packageTask.executable, packageTask.args, { env: packageTask.env, encoding: 'utf8' })), { node: process.execPath, child: process.execPath });
  for (const [command, env, remote] of [['/explicit/node', undefined, undefined], ['node', { Path: '/custom' }, undefined], ['node', undefined, 'ssh-remote+test'], ['python', undefined, undefined]]) {
    let called = false;
    assert.equal(await resolveNodeTaskRuntime(command, env, remote, async () => { called = true; return runtime; }), undefined);
    assert.equal(called, false);
  }
});

test('Node task patch replays twice without modifying the user index', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-node-task-patch-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const kernel = path.join(directory, 'vscode'), name = '0068-studio-node-task-runtime.patch';
  await mkdir(path.join(kernel, relative), { recursive: true }); await mkdir(path.join(directory, 'patches'));
  for (const file of ['terminalTaskSystem.ts', 'nodeTaskRuntime.ts']) await copyFile(path.join(ROOT, 'upstream/vscode', relative, file), path.join(kernel, relative, file));
  await copyFile(path.join(ROOT, 'patches', name), path.join(directory, 'patches', name));
  const git = args => execFileSync('git', args, { cwd: kernel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']); git(['apply', '--reverse', path.join(directory, 'patches', name)]); git(['add', '.']);
  git(['-c', 'user.name=Studio Test', '-c', 'user.email=studio@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const index = git(['write-tree']);
  for (let attempt = 0; attempt < 2; attempt++) {
    await applyPatches(directory, kernel);
    assert.equal(await readFile(path.join(kernel, relative, 'terminalTaskSystem.ts'), 'utf8'), source);
    assert.equal(await readFile(path.join(kernel, relative, 'nodeTaskRuntime.ts'), 'utf8'), helper);
    assert.equal(git(['write-tree']), index);
  }
});
