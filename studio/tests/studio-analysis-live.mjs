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
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const reference = { id: manifest.id, uri: pathToFileURL(source).href, folderPath: source, name: manifest.name, projectType: 'kanban' };
  const vscode = {
    env: { language: 'en' },
    Uri: { file: filename => ({ fsPath: filename, toString: () => pathToFileURL(filename).href }),
      parse: value => ({ scheme: new URL(value).protocol.slice(0, -1), fsPath: fileURLToPath(value) }) },
    workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: () => process.execPath }) },
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
    AbortController, AbortSignal, URL, Buffer, setTimeout, clearTimeout, queueMicrotask,
  }, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  let imports = [reference];
  runtime = module.exports.createWorkflowRuntime({ extensionUri: { fsPath: path.join(root, 'extensions/studio-workstation') },
    globalStorageUri: { fsPath: storage }, globalState: { get: () => imports } },
  { getConnection: () => undefined, onDidChange: () => ({ dispose() {} }) });
  runtime.updateAnalysisProjects([reference]);
  const project = await runtime.inspectAnalysis(); assert.equal(project.builtin, 'analysis');
  session = await runtime.start(project, 'editor');
  const url = new URL(session.ready.url), token = url.hash.slice('#session='.length);
  const post = async message => {
    const response = await fetch(`${url.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  console.log(JSON.stringify({ project: session.ready.project.name, projectType: session.ready.project.projectType,
    harnessVersion: session.ready.runtime.harnessVersion, analysisVersion: result.value.version, projects: result.value.projects.length,
    checks: ['built extension template', 'real independent Core and CLI', 'authenticated Studio query', 'scope changes'] }));
} finally {
  await session?.close(); runtime?.dispose(); await rm(storage, { recursive: true, force: true });
}
