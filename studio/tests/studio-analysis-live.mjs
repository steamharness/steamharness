import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants, runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = process.env.STUDIO_STEAMHARNESS_SOURCE ?? path.resolve(root, '..');
const storage = await mkdtemp(path.join(os.tmpdir(), 'studio-analysis-live-'));
const require = createRequire(path.join(root, 'package.json'));
const failures = [];
let runtime, session;
try {
  const compiled = await build({ absWorkingDir: root, entryPoints: ['extensions/studio-workstation/src/workflow-runtime-node.ts'],
    bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
  const source = path.join(workspace, 'build-in/build-in-analysis');
  const manifest = JSON.parse(await readFile(path.join(source, 'steamharness.json'), 'utf8'));
  const reference = { id: manifest.id, uri: pathToFileURL(source).href, folderPath: source, name: manifest.name, projectType: 'kanban' };
  const vscode = {
    env: { language: 'en', uiKind: 1 }, UIKind: { Desktop: 1 },
    Uri: { file: filename => ({ scheme: 'file', fsPath: filename, toString: () => pathToFileURL(filename).href }),
      parse: value => ({ scheme: new URL(value).protocol.slice(0, -1), fsPath: fileURLToPath(value) }) },
    workspace: { isTrusted: true, workspaceFolders: [], onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => ({ defaultValue: 'auto' }) }) },
    window: { activeColorTheme: { kind: 1 } }, ColorThemeKind: { Light: 1, HighContrastLight: 4 },
  };
  const tracedHttp = { ...http, createServer(handler) {
    return http.createServer((request, response) => {
      const end = response.end;
      response.end = function (body, ...args) {
        if (response.statusCode >= 400) failures.push({ status: response.statusCode, body: String(body) });
        return end.call(this, body, ...args);
      };
      handler(request, response);
    });
  } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
    require: name => name === 'vscode' ? vscode : name === 'node:http' ? tracedHttp : require(name),
    process: { ...process, env: { ...process.env, STUDIO_STEAMHARNESS_SOURCE: workspace, STEAMHARNESS_CLI_AUTH_DIR: path.join(storage, 'auth'),
      STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' } },
    AbortController, AbortSignal, URL, Buffer, TextDecoder, setTimeout, clearTimeout, queueMicrotask,
  }, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  let imports = [reference];
  runtime = module.exports.createProjectRuntime({ subscriptions: [], extensionUri: { fsPath: path.join(root, 'extensions/studio-workstation') },
    globalStorageUri: { fsPath: storage }, globalState: { get: () => imports } },
  { getConnection: () => undefined, onDidChange: () => ({ dispose() {} }) });
  runtime.updateAnalysisProjects([reference]);
  const project = await runtime.inspectAnalysis(); assert.equal(project.builtin, 'analysis');
  assert.equal(project.distribution, 'release');
  session = await runtime.start(project, 'editor');
  const post = async message => {
    const url = new URL(session.ready.url), token = url.hash.slice('#session='.length);
    const response = await fetch(new URL('api/message', url), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message) });
    assert.equal(response.status, 200); return (await response.json()).messages;
  };
  const state = (await post({ type: 'ready' }))[0];
  const query = async () => (await post({ type: 'kanban-bridge', nonce: state.kanban.preview.nonce, requestId: 'live-smoke',
    call: { requestId: 'snapshot', operation: 'studio.getLocalAnalysis', input: {} } }))[0];
  const result = await query(); assert.equal(result.ok, true, JSON.stringify({ result, failures }));
  assert.equal(result.value.projects.length, 1); assert.equal(result.value.projects[0].id, manifest.id);
  assert.equal(result.value.projects[0].availability, 'available'); assert.equal(result.value.serverExcluded, 0);
  runtime.updateAnalysisProjects([]); imports = [];
  assert.deepEqual((await query()).value.projects, []);
  console.log(JSON.stringify({ project: session.ready.project.name, projectType: project.projectType,
    harnessVersion: session.ready.runtime.harnessVersion, analysisVersion: result.value.version, projects: result.value.projects.length,
    checks: ['built extension template', 'real independent Core and CLI', 'authenticated Studio query', 'scope changes'] }));
  await session.close();
  const builtinDirectories = (await runtime.listBuiltinProjectDirectories()).directories;
  const assistantFolder = await runtime.localAssistantDirectory();
  assert.deepEqual([...builtinDirectories], [assistantFolder, project.folderPath]);
  assert.ok(builtinDirectories.every(directory => path.relative(storage, directory).startsWith(`workflow${path.sep}builtin-apps${path.sep}`)));
  const assistantManifest = JSON.parse(await readFile(path.join(assistantFolder, 'steamharness.json'), 'utf8'));
  assert.ok(assistantManifest.entries.every(entry => entry.root === `entries/${entry.entryId}`));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(assistantFolder), name: assistantManifest.name }];
  const inspected = await runtime.inspect([assistantFolder]);
  const assistant = inspected.projects.find(entry => entry.entryId === 'main');
  assert.ok(assistant, JSON.stringify(inspected.errors));
  assert.equal(assistant.distribution, 'release');
  session = await runtime.start(assistant, 'editor');
  assert.equal(session.ready.assistantProtocolVersion, 1);
  assert.ok(session.ready.project.entries.some(entry => entry.entryId === 'studio-control' && entry.type === 'workflow'));
  const [skills] = await post({ type: 'project-skills', requestId: 'builtin-skills' });
  assert.equal(skills.type, 'project-skills-result', JSON.stringify(skills));
  assert.match(JSON.stringify(skills.value), /steamharness-generator/);
  console.log('Compiled Assistant started in the built-in folder scope, with its generator skill and Studio Control entry.');
} finally {
  await session?.close(); runtime?.dispose(); await rm(storage, { recursive: true, force: true });
}
