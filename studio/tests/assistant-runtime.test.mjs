import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createAssistantDependencyFixture } from './assistant-dependency-fixture.mjs';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-runtime-node.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);

test('new projects apply for an ID using the current account and cancel when it changes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-allocation-account-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const allocatedId = 'a3aca697-b086-459b-84e4-d357ad2d9fb2';
  const allocationRuntime = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-runtime-node.ts'], bundle: true,
    platform: 'node', format: 'cjs', external: ['vscode'], write: false,
    plugins: [{ name: 'template-allocation-fixture', setup(build) {
      build.onLoad({ filter: /project-create-node\.ts$/ }, () => ({ contents: `
        export const defaultProjectParentDirectory = () => '/projects';
        export const installProjectDependencies = async () => {};
        export const projectTemplatesRuntime = () => ({ create: async (input, signal, allocate) => {
          const id = await allocate({ name: input.name, projectType: 'workflow', projectInfo: { platformSupport: { mode: 'agnostic' }, dataStorage: { mode: 'local' } } });
          signal.throwIfAborted(); return { ...input, id, projectType: 'workflow', directory: input.parentDirectory };
        } });` }));
    } }] });
  let connection = { serverUrl: 'https://server.example', accessToken: 'owner-token' }, userId = 'owner', requests = 0, changeDuringRequest = false;
  const listeners = new Set();
  const account = { getConnection: () => connection, getState: () => ({ user: { userId } }), onDidChange: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; } };
  const module = { exports: {} };
  const vscode = { env: { language: 'en' }, workspace: { isTrusted: true, getConfiguration: () => ({ get: () => '' }) } };
  runInNewContext(allocationRuntime.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    process, AbortController, AbortSignal, URL, Buffer, setTimeout, clearTimeout, queueMicrotask,
    fetch: async (_url, options) => {
      requests++; assert.equal(options.headers.Authorization, 'Bearer owner-token');
      assert.equal(Object.hasOwn(JSON.parse(options.body), 'projectId'), false);
      if (changeDuringRequest) { userId = 'other'; connection = { ...connection, accessToken: 'other-token' }; for (const listener of listeners) listener({ status: 'authenticated' }); }
      return Response.json({ errCode: 0, data: { projectId: allocatedId, projectType: 'workflow' } });
    },
  });
  const runtime = module.exports.createProjectRuntime({ extensionUri: { fsPath: directory }, globalStorageUri: { fsPath: directory } }, account); t.after(() => runtime.dispose());
  const input = { name: 'Created', templateId: 'workflow-starter', parentDirectory: directory };
  assert.equal((await runtime.createProject(input)).id, allocatedId); assert.equal(requests, 1);
  changeDuringRequest = true;
  await assert.rejects(runtime.createProject(input), error => error.name === 'AbortError' || /account used to create/.test(error.message));
  assert.equal(requests, 2); assert.equal(listeners.size, 1);
  connection = undefined;
  await assert.rejects(runtime.createProject(input), /Sign in before creating/); assert.equal(requests, 2);
});

// The built-in projects live in the monorepo, so the extension resolves the
// assistant sources from the repository root rather than a vendored checkout.
test('an installed extension symlink uses monorepo dependencies with tools scoped to the opened folder', async t => {
  const source = await createAssistantDependencyFixture(); t.after(source.dispose);
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-assistant-runtime-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const studio = path.join(directory, 'studio');
  const extension = path.join(studio, 'extensions/studio-workstation');
  const template = path.join(extension, 'dist/developer-assistant');
  await mkdir(template, { recursive: true });
  const manifest = { id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', type: 'module' };
  await writeFile(path.join(template, 'package.json'), JSON.stringify({ ...manifest, testInspectionError: 'Workflow "Project Assistant" script validation failed.' }));
  await writeFile(path.join(template, 'index.ts'), 'export const executor = steamharness.defineExecutor({});');
  const controlTemplate = path.join(extension, 'dist/studio-control');
  await mkdir(controlTemplate);
  await writeFile(path.join(controlTemplate, 'package.json'), JSON.stringify({ id: '09145339-e3dd-4bb2-ac9b-6c180ef51933', type: 'module' }));
  await writeFile(path.join(controlTemplate, 'index.ts'), 'export const executor = steamharness.defineExecutor({});');
  const linked = path.join(directory, 'vscode/extensions/studio-workstation');
  await mkdir(path.dirname(linked), { recursive: true });
  await symlink(extension, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const storage = path.join(directory, 'storage');
  const workdir = path.join(directory, 'opened'); await mkdir(workdir);
  const target = { uri: pathToFileURL(workdir).href, folderPath: workdir, name: 'Opened folder' };
  const disposable = { dispose() {} };
  const vscode = {
    env: { language: 'en', appName: 'Studio' }, version: '1.140.0', extensions: { all: [] },
    Uri: { file: filename => ({ toString: () => pathToFileURL(filename).href }) },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: workdir, toString: () => target.uri }, name: target.name }], getConfiguration: () => ({ get: () => '' }) },
    window: { activeColorTheme: { kind: 2 } }, ColorThemeKind: { Light: 1, HighContrastLight: 4 },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
    require: name => name === 'vscode' ? vscode : require(name),
    process: { ...process, env: { ...process.env, STUDIO_STEAMHARNESS_SOURCE: source.root } },
    AbortController, AbortSignal, URL, Buffer, setTimeout, clearTimeout, queueMicrotask,
  });
  const runtime = module.exports.createProjectRuntime({ extensionUri: { fsPath: linked }, globalStorageUri: { fsPath: storage } },
    { getConnection: () => undefined, onDidChange: () => disposable });
  t.after(() => runtime.dispose());
  const failed = await runtime.inspectAssistant(target, [target]);
  assert.equal(failed.projects.length, 0); assert.match(failed.errors[0], /script validation failed/);
  const apps = path.join(storage, 'workflow/assistant/apps');
  const [failedApp] = await readdir(apps);
  await writeFile(path.join(template, 'package.json'), JSON.stringify({ ...manifest, testInspectionExit: true }));
  await assert.rejects(runtime.inspectAssistant(target, [target]), /Fixture inspection failed/);
  await writeFile(path.join(template, 'package.json'), JSON.stringify(manifest));
  const inspection = await runtime.inspectAssistant(target, [target]);
  assert.equal(inspection.projects.length, 1);
  const assistant = inspection.projects[0];
  assert.notEqual(assistant.folderPath, path.join(apps, failedApp), 'Retry must prepare the updated template after a failed inspection.');
  assert.equal(JSON.parse(await readFile(path.join(apps, failedApp, 'package.json'), 'utf8')).testInspectionError,
    'Workflow "Project Assistant" script validation failed.', 'Existing cached applications remain immutable.');
  assert.equal(assistant.id, 'a3aca697-b086-459b-84e4-d357ad2d9fb2');
  assert.equal(assistant.assistant.standalone, true);
  assert.equal(assistant.assistant.workdir, workdir);
  assert.notEqual(assistant.folderPath, workdir, 'The opened folder must never supply the assistant executor.');
  const session = await runtime.start(assistant, 'assistant');
  t.after(() => session.close());
  assert.equal(session.ready.project.id, assistant.id);
  const configuration = JSON.parse(await readFile(path.join(source.projectDir, 'assistant.json'), 'utf8'));
  assert.equal(configuration.assistant.workdir, workdir);
  assert.equal(configuration.assistant.roots[0].uri, target.uri);
  assert.equal(configuration.studioControl.hasToken, true);
  assert.equal(configuration.studioControl.mcpServer.id, 'workflow-studio');
  assert.deepEqual(configuration.studioControl.mcpServer.inheritEnvironment,
    ['STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN']);
  const command = configuration.studioControl.mcpServer.command;
  assert.equal(command[2], 'mcp');
  assert.ok(command[3].startsWith(path.join(storage, 'workflow', 'studio-control', 'apps')));
  assert.equal(JSON.parse(await readFile(path.join(command[3], 'package.json'), 'utf8')).id,
    '09145339-e3dd-4bb2-ac9b-6c180ef51933');
  const controlState = await fetch(new URL('/studio-control-state', session.ready.url));
  assert.equal(controlState.status, 200);
  assert.equal((await controlState.json()).value.workdir, workdir);
  await session.close();
  await assert.rejects(fetch(configuration.studioControl.bridgeUrl, { signal: AbortSignal.timeout(2_000) }));
  vscode.workspace.workspaceFolders = [];
  await assert.rejects(runtime.inspectAssistant(target, [target]), /workspace is no longer available/);
  await assert.rejects(runtime.start(assistant, 'assistant'), /workspace is no longer available/);
  vscode.workspace.isTrusted = false;
  await assert.rejects(runtime.inspectAssistant(target, [target]), /Trust the current workspace/);
});
