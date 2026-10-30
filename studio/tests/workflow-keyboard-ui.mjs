import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'tsx/esm/api';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { writeProjectFixture } from '../../cli/scripts/test-project-fixture.mjs';
register();
const { startWebServer } = await import('../../cli/src/web/server.ts');
const { projectFrameHtml } = await import('../extensions/studio-workstation/src/workflow-webview.ts');

const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-keyboard-ui-'));
const previousAuth = process.env.STEAMHARNESS_CLI_AUTH_DIR;
process.env.STEAMHARNESS_CLI_AUTH_DIR = path.join(directory, 'auth');
const entries = ['workflow', 'conversation', 'kanban'].map(type => ({ entryId: type, type, name: type, root: type, entry: type === 'kanban' ? 'index.html' : 'index.ts', configuration: 'configuration.json', databases: [] }));
const id = randomUUID();
let app, browser;
const errors = [];
const shell = createServer((request, response) => {
  const entryId = new URL(request.url, 'http://localhost').pathname.slice(1);
  const bootstrap = `<script nonce="keyboard">window.studioKeys=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState(){},postMessage(){}});for(const type of ['keydown','keyup'])addEventListener(type,event=>window.studioKeys.push({type:event.type,key:event.key,code:event.code,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey,keyCode:event.keyCode}));</script>`;
  response.setHeader('Content-Type', 'text/html');
  response.end(projectFrameHtml(app.entryUrl(entryId), entryId, directory, 'light', 'keyboard').replace('</head>', `${bootstrap}</head>`));
});
try {
  await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id, name: 'Keyboard regression', version: '0.1.0', entries, defaultEntry: 'conversation' }));
  for (const entry of entries) {
    await mkdir(path.join(directory, entry.root), { recursive: true });
    await writeFile(path.join(directory, entry.root, entry.entry), entry.type === 'kanban' ? '<!doctype html><title>Board</title><input id="board-input"><button id="board-action">Board</button>' : 'export {};');
    await writeFile(path.join(directory, entry.root, 'configuration.json'), JSON.stringify({ version: 1, fields: [] }));
  }
  const projects = entries.map(entry => ({ id, name: entry.name, aggregateName: 'Keyboard regression', entries, entryId: entry.entryId, defaultEntry: 'conversation', entryRoot: path.join(directory, entry.root), databases: [], folderPath: directory, uri: '', projectType: entry.type, fields: [], entrypoints: entry.type === 'workflow' ? [{ id: 'main', title: 'Main', fields: [] }] : [] }));
  const runtime = { available: true, inspect: async () => ({ projects, errors: [] }), resolveParams: async () => ({}), run: async () => ({ status: 'success' }), cancel() {}, dispose() {}, uploadFiles: async () => [], readFile() {}, deleteFiles() {}, readResource() {}, cancelConversation() {}, deleteConversation() {} };
  app = await startWebServer({ projectDir: directory, dataDir: path.join(directory, 'history'), runtime, host: { surface: 'editor' } });
  await new Promise(resolve => shell.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(10_000); page.on('pageerror', error => errors.push(error.message));
  const count = () => page.evaluate(() => window.studioKeys.filter(event => event.type === 'keydown').length);
  const press = async (target, shortcut, expected) => {
    const before = await count(); await target.press(shortcut);
    await page.waitForFunction(value => window.studioKeys.filter(event => event.type === 'keydown').length >= value, before + expected);
    // Read after a cross-frame message round trip, including the keyup.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const keys = await page.evaluate(() => window.studioKeys.filter(event => event.type === 'keydown'));
    assert.equal(keys.length, before + expected, shortcut);
    return keys;
  };
  for (const entry of entries) {
    await page.goto(`http://127.0.0.1:${shell.address().port}/${entry.entryId}`);
    const project = page.frameLocator('#workflow-frame');
    await project.locator(entry.type === 'conversation' ? '#app[data-project-uri]' : '#app[data-connection="connected"]').waitFor();
    const target = entry.type === 'kanban' ? project.frameLocator('#kanban-preview').locator('#board-input')
      : project.locator(entry.type === 'conversation' ? '#message' : '#run').first();
    await target.waitFor();
    // A modifier key itself is forwarded too; check the requested key below.
    await target.press('Control+p');
    await page.waitForFunction(() => window.studioKeys.some(event => event.type === 'keydown' && event.key === 'p' && event.ctrlKey && event.keyCode === 80));
    await page.evaluate(() => { window.studioKeys = []; });
    await press(target, 'F1', 1);
    if (entry.type !== 'workflow') {
      await page.evaluate(() => { window.studioKeys = []; });
      await target.fill(''); await target.press('a');
      assert.equal(await target.inputValue(), 'a');
      await target.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a'); await target.press('Backspace'); assert.equal(await target.inputValue(), '');
    }
    if (entry.type === 'kanban') {
      await target.evaluate(element => {
        window.addEventListener('keydown', event => { if (event.key === 'p' || event.key === 'F2') { event.preventDefault(); window.claimed = (window.claimed ?? 0) + 1; } });
        element.addEventListener('keydown', event => { if (event.key === 'F3') event.stopPropagation(); });
      });
      await page.evaluate(() => { window.studioKeys = []; });
      await press(target, 'F2', 0); await press(target, 'F3', 0);
      await target.press('Control+p');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await target.evaluate(() => window.claimed), 2);
      assert.equal(await page.evaluate(() => window.studioKeys.some(event => event.key === 'p')), false);
      await page.evaluate(() => { window.studioKeys = []; });
      await target.press('Control+k'); await target.press('m');
      await page.waitForFunction(() => window.studioKeys.some(event => event.key === 'm'));
    }
    console.log(`${entry.type}: keyboard fallback and project/native input priority passed`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); await new Promise(resolve => shell.close(resolve)); await app?.close();
  if (previousAuth === undefined) delete process.env.STEAMHARNESS_CLI_AUTH_DIR; else process.env.STEAMHARNESS_CLI_AUTH_DIR = previousAuth;
  await rm(directory, { recursive: true, force: true });
}
