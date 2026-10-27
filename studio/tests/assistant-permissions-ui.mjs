import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { inspectLocalProjectStructure } from '../../harness/dist/index.js';

const require = createRequire(import.meta.url);
const report = inspectLocalProjectStructure({ projectDir: fileURLToPath(new URL('../../build-in/build-in-developer-assistant/', import.meta.url)) });
assert.deepEqual(report.diagnostics.violations, []);
const [extension, frame, client] = await Promise.all([
  build({ entryPoints: ['extensions/studio-workstation/src/assistant-view.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }),
  build({ entryPoints: ['extensions/studio-workstation/src/workflow-webview.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }),
  build({ stdin: { contents: `
    import { ParameterActions } from '../cli/src/web/ui/parameter-actions';
    import { acquireProjectHost } from '../cli/src/web/ui/host';
    const host = acquireProjectHost();
    const parameters = ${JSON.stringify({ fields: report.params, paramLayout: report.paramLayout })};
    parameters.fields.find(field => field.name === 'permissionPolicy').userSettingValue = 'auto';
    parameters.fields.find(field => field.name === 'model').options = [{ value: 'user-model', label: 'User configured model' }];
    parameters.fields.find(field => field.name === 'model').userSettingValue = 'user-model';
    const actions = new ParameterActions(document.querySelector('#parameter-actions'), {
      current: () => ({ values: {}, states: {}, disabled: false, loading: false }),
      fieldRoot() { throw new Error('Permission shortcuts must not open a local field editor.'); },
      onChange() { throw new Error('Permission shortcuts must not override user settings.'); },
      onOpenUserSetting: key => host.postMessage({ type: 'open-user-setting', key })
    });
    actions.render(parameters);
    window.setAssistantModels = available => {
      const field = parameters.fields.find(field => field.name === 'model');
      field.options = available ? [{ value: 'user-model', label: 'User configured model' }] : [];
      field.userSettingValue = available ? 'user-model' : '';
      actions.render(parameters);
    };
  `, resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false, loader: { '.css': 'empty' },
    plugins: [{ name: 'offline-project-service', setup(build) {
      build.onLoad({ filter: /[\\/]ui[\\/]connection\.ts$/ }, () => ({ contents: 'export class BrowserConnection {} export class ConnectionError extends Error {}', loader: 'ts' }));
    } }] }),
]);
function load(bundle, vscode) {
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id), crypto: globalThis.crypto, URL, setTimeout, clearTimeout });
  return module.exports;
}
const { projectFrameHtml } = load(frame);
let html;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/assistant') { response.end(html); return; }
  if (request.url.startsWith('/conversation')) {
    response.end('<!doctype html><html><body><main><div id="project-menu"></div><div id="parameter-actions"></div></main><script src="/client.js"></script></body></html>'); return;
  }
  if (request.url === '/client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(client.outputFiles[0].text); return; }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [], checks = [];
try {
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  for (const register of [true, false]) {
    const page = await browser.newPage({ viewport: { width: register ? 360 : 1280, height: 700 } });
    page.setDefaultTimeout(5_000);
    page.on('pageerror', error => errors.push(error.message));
    const receivers = new Set(), commands = [];
    const disposable = { dispose() {} };
    const uri = { scheme: 'file', fsPath: '/workspace', toString: () => 'file:///workspace' };
    const vscode = {
      env: { language: 'en' }, Uri: { joinPath: root => root },
      commands: { registerCommand: () => disposable, executeCommand: async (...args) => { commands.push(JSON.parse(JSON.stringify(args))); } },
      workspace: { workspaceFolders: [{ uri, name: 'Workspace' }], isTrusted: true,
        onDidChangeWorkspaceFolders: () => disposable, onDidGrantWorkspaceTrust: () => disposable, onDidChangeConfiguration: () => disposable },
      window: { registerWebviewViewProvider: () => disposable, onDidChangeActiveTextEditor: () => disposable },
    };
    const { AssistantViewProvider } = load(extension, vscode);
    const runtime = { available: true, inspectAssistant: async () => ({ projects: [{ id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2',
      name: 'Assistant', folderPath: '/assistant', projectType: 'conversation', fields: report.params, assistant: { standalone: true } }], errors: [] }) };
    let finish;
    const closed = new Promise(resolve => { finish = resolve; });
    const provider = new AssistantViewProvider({ extensionUri: uri, subscriptions: [] }, runtime, { appendLine: line => errors.push(line) }, async (_project, view) => {
      const nonce = 'permission-test';
      view.webview.html = projectFrameHtml(`${origin}/conversation`, 'Assistant', 'studio-assistant:test', 'light', nonce)
        .replace(`<script nonce="${nonce}">`, `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage:message=>window.studioMessage(message)});</script><script nonce="${nonce}">`);
      return { closed, dispose: async () => finish() };
    }, register);
    const view = { webview: { onDidReceiveMessage: receive => { receivers.add(receive); return { dispose: () => receivers.delete(receive) }; } }, onDidDispose: () => disposable };
    try {
      await provider.resolveWebviewView(view);
      html = view.webview.html;
      await page.exposeFunction('studioMessage', async message => { await Promise.all([...receivers].map(receive => receive(message))); });
      await page.goto(`${origin}/assistant`);
      const permission = page.frameLocator('#workflow-frame').locator('[data-action-id=permission]');
      await permission.click();
      await assertEventually(() => commands.length === 1);
      assert.deepEqual(commands[0], ['studio.openSettings', { section: 'permissions', target: 'user' }]);
      assert.equal(await page.frameLocator('#workflow-frame').locator('.parameter-popover:not([hidden])').count(), 0);
      const model = page.frameLocator('#workflow-frame').locator('[data-action-id=ai]');
      await model.click();
      assert.equal(commands.length, 1, 'Model click must first open available choices');
      const popup = page.frameLocator('#workflow-frame').locator('.parameter-popover:not([hidden])');
      assert.equal(await popup.locator('[role=option]').first().textContent(), 'User configured model');
      await popup.locator('[data-focus-key=manage-models]').click();
      await assertEventually(() => commands.length === 2);
      assert.deepEqual(commands[1], ['studio.openSettings', { section: 'models', target: 'user' }]);
      await page.frameLocator('#workflow-frame').locator('body').evaluate(() => window.setAssistantModels(false));
      assert.equal(await model.innerText(), 'Configure model');
      assert.ok((await model.getAttribute('title')).includes('No available models. Open Settings to add a model.'));
      await model.click();
      await assertEventually(() => commands.length === 3);
      assert.deepEqual(commands[2], commands[1]);
      assert.equal(await popup.count(), 0, 'Empty models open settings without an empty popup');
      await model.press('Enter');
      await assertEventually(() => commands.length === 4);
      assert.deepEqual(commands[3], commands[1]);
      await page.frameLocator('#workflow-frame').locator('body').evaluate(() => window.setAssistantModels(true));
      await model.click();
      assert.equal(commands.length, 4, 'Adding a model restores choices before settings');
      assert.equal(await popup.locator('[role=option]').first().textContent(), 'User configured model');
      await page.keyboard.press('Escape');
      finish(); await closed;
      await permission.focus(); await permission.press('Enter');
      await assertEventually(() => commands.length === 5);
      assert.deepEqual(commands[4], commands[0]);
      checks.push(`${register ? 'Sidebar' : 'Standalone tool'}: pointer and keyboard open user permissions before and after the conversation exits.`);
      checks.push(`${register ? 'Sidebar' : 'Standalone tool'}: empty models show setup guidance and open model settings directly; saved models restore choices.`);
    } finally { provider.dispose(); await page.close(); }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }

async function assertEventually(read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (read()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The permission click did not reach Studio settings.');
}
