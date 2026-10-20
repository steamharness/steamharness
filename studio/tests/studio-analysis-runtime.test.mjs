import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants, runInNewContext } from 'node:vm';
import { createAssistantDependencyFixture } from './assistant-dependency-fixture.mjs';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-runtime-node.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);

test('the built-in analysis prepares a runnable Kanban and connects its own CLI to the Studio project scope', async t => {
  const source = await createAssistantDependencyFixture(); t.after(source.dispose);
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-analysis-runtime-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const extension = path.join(directory, 'studio/extensions/studio-workstation'), storage = path.join(directory, 'storage');
  const assistant = path.join(extension, 'dist/developer-assistant'); await mkdir(assistant, { recursive: true });
  await writeFile(path.join(assistant, 'package.json'), JSON.stringify({ id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', type: 'module' }));
  const template = path.join(extension, 'dist/analysis');
  for (const name of ['package.json', 'configuration.json', 'index.html', 'assets']) {
    await cp(new URL(`../../build-in/build-in-analysis/${name}`, import.meta.url), path.join(template, name), { recursive: true });
  }
  const cli = path.join(source.projectDir, 'node_modules/@steamharness/cli/dist'); await mkdir(path.join(cli, 'web'));
  await writeFile(path.join(cli, 'web/local-analysis.mjs'), `
    let deferred;
    export function holdNextRead() {
      let started, release;
      const ready = new Promise(resolve => { started = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      deferred = { started, wait }; return { ready, release };
    }
    export async function readLocalStudioAnalysis(options) {
      const hold = deferred; deferred = undefined;
      if (hold) { hold.started(); await hold.wait; }
      return { version: 1, projects: options.projects, storageDir: options.storageDir, locale: options.locale };
    }
  `);
  await writeFile(path.join(cli, 'index.js'), `
    import { readFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    import { createInterface } from 'node:readline';
    import path from 'node:path';
    const args = process.argv.slice(2), folderPath = args[args.indexOf('web') + 1];
    const manifest = JSON.parse(readFileSync(path.join(folderPath, 'package.json'), 'utf8'));
    const project = { id: manifest.id, name: manifest.name, folderPath, projectType: 'kanban', fields: [], entrypoints: [] };
    if (args.includes('--inspect')) console.log(JSON.stringify({ projects: [project], errors: [] }));
    else {
      const input = createInterface({ input: process.stdin }); let server;
      input.on('line', line => {
        const message = JSON.parse(line);
        if (message.type === 'configure') {
          server = createServer(async (request, response) => {
            if (request.url === '/connection') { response.end(JSON.stringify({ url: process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL, assistant: message.assistant, mcp: process.env.STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER })); return; }
            const reply = await fetch(process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL, { method: 'POST',
              headers: { Authorization: 'Bearer ' + process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN, 'Content-Type': 'application/json' },
              body: JSON.stringify({ operation: request.url === '/mutate' ? 'studio.theme.set' : 'studio.analysis.get', input: {}, permissionPolicy: 'read-only' }) });
            response.writeHead(reply.status, { 'Content-Type': 'application/json' }); response.end(await reply.text());
          });
          server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ type: 'ready', protocolVersion: 1, hostProtocolVersion: 1, accountProtocolVersion: 1,
            url: 'http://127.0.0.1:' + server.address().port + '/#session=' + 'a'.repeat(64), project, runtime: { harnessVersion: '2.3.4', harnessPath: 'fixture' } })));
        } else if (message.type === 'close') { input.close(); process.stdin.pause(); server?.close(); }
      });
      input.on('close', () => { process.stdin.pause(); server?.close(); });
    }
  `);
  const current = { id: '8f6a6240-4860-4efc-bd07-932868be2b98', name: 'Current', uri: pathToFileURL(path.join(directory, 'current')).href, projectType: 'workflow' };
  let imports = [{ id: current.id, name: 'Imported', uri: current.uri }];
  const vscode = {
    env: { language: 'zh-cn' }, window: { activeColorTheme: { kind: 2 } }, ColorThemeKind: { Light: 1, HighContrastLight: 4 },
    Uri: { file: filename => ({ fsPath: filename, toString: () => pathToFileURL(filename).href }),
      parse: value => ({ scheme: new URL(value).protocol.slice(0, -1), fsPath: fileURLToPath(value) }) },
    workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: () => '' }) },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    process: { ...process, env: { ...process.env, STUDIO_STEAMHARNESS_SOURCE: source.root } }, AbortController, AbortSignal, URL, Buffer, setTimeout, clearTimeout, queueMicrotask,
  }, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  const runtime = module.exports.createProjectRuntime({ extensionUri: { fsPath: extension }, globalStorageUri: { fsPath: storage },
    globalState: { get: () => imports } }, { getConnection: () => undefined, onDidChange: () => ({ dispose() {} }) });
  t.after(() => runtime.dispose());
  runtime.updateAnalysisProjects([current]);
  const project = await runtime.inspectAnalysis(); assert.equal(project.builtin, 'analysis'); assert.equal(project.projectType, 'kanban');
  assert.notEqual(project.folderPath, template); assert.equal(await readFile(path.join(project.folderPath, 'index.html'), 'utf8'), await readFile(path.join(template, 'index.html'), 'utf8'));
  assert.ok((await readFile(path.join(project.folderPath, 'assets/analysis.js'))).length > 1000);
  const session = await runtime.start(project, 'editor'); t.after(() => session.close());
  const origin = new URL(session.ready.url).origin;
  const connection = await fetch(`${origin}/connection`).then(response => response.json()); assert.equal(connection.assistant, undefined); assert.equal(connection.mcp, undefined);
  let result = await fetch(`${origin}/analysis`).then(response => response.json());
  assert.equal(result.ok, true); assert.equal(result.value.projects.length, 1); assert.equal(result.value.projects[0].name, 'Current');
  assert.equal(result.value.storageDir, path.join(storage, 'workflow/web')); assert.equal(result.value.locale, 'zh-cn');
  assert.equal((await fetch(`${origin}/mutate`)).status, 400);
  const reader = await import(pathToFileURL(path.join(cli, 'web/local-analysis.mjs')).href);
  const heldWorkspace = reader.holdNextRead(), workspaceQuery = fetch(`${origin}/analysis`).then(response => response.json());
  await heldWorkspace.ready;
  runtime.updateAnalysisProjects([]); imports = [];
  heldWorkspace.release();
  assert.deepEqual((await workspaceQuery).value.projects, [], 'A pending read must not publish the previous workspace scope.');
  imports = [current];
  const heldImports = reader.holdNextRead(), importQuery = fetch(`${origin}/analysis`).then(response => response.json());
  await heldImports.ready; imports = []; heldImports.release();
  assert.deepEqual((await importQuery).value.projects, [], 'Removing an imported project must also invalidate a pending snapshot.');
  result = await fetch(`${origin}/analysis`).then(response => response.json()); assert.deepEqual(result.value.projects, []);
  vscode.workspace.isTrusted = false; assert.equal((await fetch(`${origin}/analysis`)).status, 400);
  await session.close(); await session.closed;
  await assert.rejects(fetch(connection.url, { signal: AbortSignal.timeout(2000) }));
});
