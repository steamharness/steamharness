import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';

// Isolated, headless fixture: no real project, account, remote storage or window.
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kanban-diagnostics-ui-')));
const directory = path.join(root, 'board'); await mkdir(directory);
const homedir = os.homedir;
os.homedir = () => root;
const environmentKeys = ['STEAMHARNESS_CLI_AUTH_DIR', 'STEAMHARNESS_SERVER_URL', 'STEAMHARNESS_SERVER_ADMIN_KEY', 'STEAMHARNESS_DATABASES_DIR'];
const environment = new Map(environmentKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, { STEAMHARNESS_CLI_AUTH_DIR: path.join(root, 'auth'), STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '', STEAMHARNESS_DATABASES_DIR: path.join(root, 'databases') });
register();
const { startAggregateWebServer } = await import('../../cli/src/web/aggregate-server.ts');
const { readStudioKanbanDiagnostics } = await import('../extensions/studio-workstation/src/studio-kanban.ts');
const { startStudioControlBridge } = await import('../extensions/studio-workstation/src/studio-control-bridge.ts');
const core = await import('../../harness/dist/index.js');
const controller = new AbortController();
let browser, app, bridge, mcp;
try {
  const projectId = '26cfe690-1aca-4a56-8904-51b93fc76cc5', entryId = 'map-2d';
  const entry = { entryId, name: 'Map', type: 'kanban', root: '.', entry: 'index.html', databases: [] };
  const version = JSON.parse(await readFile(new URL('../../harness/package.json', import.meta.url), 'utf8')).version;
  await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ name: 'diagnostic-fixture', type: 'module', version: '0.1.0', id: projectId, defaultEntry: entryId, entries: [entry], devDependencies: { steamharness: version } }));
  await writeFile(path.join(directory, 'configuration.json'), JSON.stringify({ version: 1, fields: [] }));
  await writeFile(path.join(directory, 'index.html'), `<!doctype html><html><head><title>Diagnostic fixture</title></head><body><p id="status">Loading</p><script>
    const info = { imageReady: false, error: null };
    steamHarnessKanban.methods.register({name:'map.getInfo',description:'Read image state',inputSchema:{type:'object'},readOnly:true},()=>info);
    steamHarnessKanban.methods.register({name:'map.pan',description:'Must never execute',inputSchema:{type:'object'},readOnly:false},()=>{throw new Error('Mutation executed');});
    steamHarnessKanban.databases.get('data').files.readFile('wf_ab12').catch(error=>{info.error=error.message;document.querySelector('#status').textContent='Image failed: '+error.message;});
  </script></body></html>`);
  const descriptor = { id: projectId, entryId, defaultEntry: entryId, aggregateName: 'Fixture', name: 'Map', folderPath: directory, entryRoot: directory, uri: '', projectType: 'kanban', entries: [entry], databases: [], fields: [], entrypoints: [], kanban: { artifactDir: '.', entry: 'index.html' } };
  const runtime = { available: true, inspect: async () => ({ projects: [descriptor], errors: [] }), dispose() {},
    kanbanBridge: async (_project, call) => { assert.equal(call.operation, 'files.readFile'); throw new Error('fixture-private-detail'); } };
  app = await startAggregateWebServer({ projectDir: directory, entryId, dataDir: path.join(root, 'web'), runtime });
  const session = { ready: { url: app.url, project: { id: projectId, entries: [entry] } } };
  const sessions = new Map([[session, { directory }]]);
  bridge = await startStudioControlBridge(async (operation, input) => {
    assert.equal(operation, 'studio.kanban.diagnostics');
    assert.equal(input.projectDir, directory); assert.equal(input.entryId, entryId);
    return readStudioKanbanDiagnostics(sessions, { ...input, projectId }, controller.signal);
  }, controller.signal);
  mcp = await core.connectMcpServer({ id: 'workflow-studio', command: [process.execPath,
    fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url)), 'mcp', fileURLToPath(new URL('../../build-in/build-in-developer-assistant', import.meta.url)),
    '--entry', 'studio-control', '--data-dir', path.join(root, 'mcp')],
    environment: { STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY: 'read-only' },
    inheritEnvironment: ['STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN'],
  }, { allowedInheritedEnvKeys: ['STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN'], env: {
    STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: bridge.url, STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: bridge.token,
  } });
  async function inspect(call) {
    const response = await mcp.callTool('get_kanban_diagnostics', { input: JSON.stringify({ projectDir: directory, entryId, ...(call ? { call } : {}) }) });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    const text = response.content.find(item => item.type === 'text').text;
    const parsed = JSON.parse(text);
    assert.equal(parsed.status, 'success');
    return parsed.output.value;
  }
  assert.deepEqual((await inspect()).instances, []);
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(app.url);
  await page.frameLocator('#kanban-preview').locator('#status').filter({ hasText: 'Image failed' }).waitFor();
  let diagnostics;
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 10; i++) {
      diagnostics = await inspect();
      if (diagnostics.instances.length) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('The real iframe did not publish its methods');
  });
  assert.equal(diagnostics.requests.at(-1).operation, 'files.readFile');
  assert.equal(diagnostics.requests.at(-1).ok, false);
  assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-private-detail/);
  const instance = diagnostics.instances[0];
  const call = { instanceId: instance.instanceId, configurationId: instance.configurationId, method: 'map.getInfo', args: {} };
  assert.equal((await inspect(call)).result.imageReady, false);
  const mutation = await mcp.callTool('get_kanban_diagnostics', { input: JSON.stringify({ projectDir: directory, entryId, call: { ...call, method: 'map.pan' } }) });
  assert.equal(mutation.isError, true);
  console.log('PASS: real iframe → CLI diagnostics → authenticated Studio bridge → stdio MCP; imageReady=false; mutation rejected.');

  // Reproduce a saved card in a separate assistant aggregate, with two nested
  // iframes and no separately opened workspace Kanban host.
  await page.close(); await app.close(); sessions.clear();
  const assistantDir = path.join(root, 'assistant'); await mkdir(assistantDir);
  const assistantId = '364764e9-ef0e-4e86-9e56-77d0410e1723';
  const assistantEntry = { entryId: 'main', name: 'Assistant', type: 'conversation', root: '.', entry: 'index.ts', databases: [] };
  await writeProjectFixture(path.join(assistantDir, 'package.json'), JSON.stringify({ name: 'assistant-fixture', version: '0.1.0', id: assistantId, defaultEntry: 'main', entries: [assistantEntry] }));
  await writeFile(path.join(assistantDir, 'index.ts'), 'export {};');
  await writeFile(path.join(directory, 'index.html'), `<!doctype html><html><head><title>Card fixture</title></head><body><img id="map"><p id="status">Loading</p><script>
    const info = { imageReady: false };
    steamHarnessKanban.methods.register({name:'map.getInfo',description:'Read image state',inputSchema:{type:'object'},readOnly:true},()=>info);
    steamHarnessKanban.methods.register({name:'map.pan',description:'Must never execute',inputSchema:{type:'object'},readOnly:false},()=>{throw new Error('Mutation executed');});
    steamHarnessKanban.databases.get('data').files.readFile('wf_ab12').then(async ({file,buffer})=>{
      const image=document.querySelector('#map');image.src=URL.createObjectURL(new Blob([buffer],{type:file.mimeType}));await image.decode();
      info.imageReady=true;document.querySelector('#status').textContent='Image ready';
    });
  </script></body></html>`);
  const assistantDescriptor = { ...descriptor, id: assistantId, entryId: 'main', defaultEntry: 'main', folderPath: assistantDir, entryRoot: assistantDir,
    projectType: 'conversation', entries: [assistantEntry], kanban: undefined };
  runtime.inspect = async roots => ({ projects: roots[0] === assistantDir ? [assistantDescriptor] : [descriptor], errors: [] });
  runtime.kanbanBridge = async (_project, call) => {
    assert.equal(call.operation, 'files.readFile');
    return { file: { id: 'wf_ab12', name: 'map.svg', mimeType: 'image/svg+xml' },
      base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="green"/></svg>').toString('base64') };
  };
  app = await startAggregateWebServer({ projectDir: assistantDir, entryId: 'main', dataDir: path.join(root, 'assistant-web'), runtime,
    host: { surface: 'assistant', assistantProjectDir: assistantDir,
      assistant: { standalone: true, workdir: directory, roots: [{ uri: 'file:///fixture', folderPath: directory, name: 'Fixture' }] } } });
  sessions.set({ ready: { url: app.url, project: { id: assistantId, entries: [assistantEntry] } } }, { directory, resourceEntryId: 'main' });
  app.controller.current.messages.push({ id: 'saved-answer', role: 'assistant', content: '', items: [{
    metadata: { kind: 'agent-part', partType: 'tool' }, content: { status: 'success', tool: 'workflow-ui_present_card', output: {
      action: 'upsert', cardId: 'saved-map', kind: 'kanban', title: 'Saved map', preview: true,
      target: { source: 'local', projectId, entryId, configurationId: instance.configurationId },
    } },
  }] });
  const cardPage = await browser.newPage(); cardPage.setDefaultTimeout(15_000);
  const errors = [], badRequests = [];
  cardPage.on('pageerror', error => errors.push(error.message));
  cardPage.on('response', response => { if (response.status() >= 400) badRequests.push({ status: response.status(), path: new URL(response.url()).pathname }); });
  await cardPage.goto(app.url);
  const cardFrame = cardPage.frameLocator('.resource-inline > iframe');
  try { await cardFrame.frameLocator('iframe').locator('#status').filter({ hasText: 'Image ready' }).waitFor(); }
  catch (error) {
    console.error(JSON.stringify({ errors, badRequests, frames: await Promise.all(cardPage.frames().map(async frame => ({
      path: new URL(frame.url()).pathname, text: (await frame.locator('body').innerText().catch(() => '')).slice(0, 1200),
    }))) }));
    throw error;
  }
  assert.match(await cardPage.locator('.resource-inline > iframe').getAttribute('src'), /\/entries\/main\/resource\//);
  assert.match(await cardFrame.locator('iframe').getAttribute('src'), /^\/entries\/main\/kanban\//);
  async function cardInstance(exclude) {
    for (let i = 0; i < 45; i++) {
      const value = await inspect();
      const found = value.instances.find(item => item.instanceId !== exclude && item.ready && item.methods.length);
      if (found) return { value, found };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('The nested card did not publish a current page instance');
  }
  const cardState = await cardInstance();
  assert.equal(cardState.found.presentation.mode, 'card');
  assert.equal(cardState.value.requests.at(-1).ok, true);
  assert.equal(cardState.value.requests.at(-1).operation, 'files.readFile');
  const cardCall = { ...call, instanceId: cardState.found.instanceId, configurationId: cardState.found.configurationId };
  assert.equal((await inspect(cardCall)).result.imageReady, true);
  assert.equal((await mcp.callTool('get_kanban_diagnostics', { input: JSON.stringify({ projectDir: directory, entryId, call: { ...cardCall, method: 'map.pan' } }) })).isError, true);
  await cardFrame.getByRole('button', { name: 'Refresh', exact: true }).click();
  await cardFrame.frameLocator('iframe').locator('#status').filter({ hasText: 'Image ready' }).waitFor();
  const refreshed = await cardInstance(cardCall.instanceId);
  assert.equal((await inspect({ ...cardCall, instanceId: refreshed.found.instanceId })).result.imageReady, true);
  assert.equal((await mcp.callTool('get_kanban_diagnostics', { input: JSON.stringify({ projectDir: directory, entryId, call: cardCall }) })).isError, true);
  assert.deepEqual(errors, []); assert.deepEqual(badRequests, []);
  console.log('PASS: saved assistant card → mounted nested iframe → image decode → Studio diagnostics → stdio MCP; imageReady=true; mutation and stale instance rejected; no HTTP errors.');
} finally {
  await browser?.close(); await mcp?.close(); await bridge?.close(); controller.abort(); await app?.close();
  os.homedir = homedir;
  for (const [key, value] of environment) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  await rm(root, { recursive: true, force: true });
}
