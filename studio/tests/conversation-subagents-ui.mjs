// Offline shared CLI component proof. Always uses an isolated headless browser.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

const studio = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(path.dirname(studio), 'cli');
const proof = path.join(studio, '.studio/conversation-subagents'); await mkdir(proof, { recursive: true });
const bundle = await build({ stdin: { resolveDir: path.join(cli, 'src/web/ui'), contents: `
  import { ConversationOutput } from './conversation-output';
  import { conversationSubagents } from './conversation-subagents';
  import './style.css';
  const frame = { ownerId: 'owner', conversationId: 1, conversations: [{ id: 1 }, { id: 2, parentId: 1 }], history: [], tasks: [] };
  for (let i = 0; i < 30; i++) {
    const status = i < 3 ? 'waiting' : i === 3 ? 'queued' : i === 4 ? 'failed' : 'completed';
    const task = { id: i + 10, conversationId: 1, kind: 'project.delegation', status, phase: i === 3 ? 'create' : 'wait',
      childConversationId: 2, label: i === 0 ? 'Research video: extraction routes and evidence' : 'Research video ' + (i + 1),
      agent: { taskId: i + 10, agentId: 'researcher', workId: 'video-' + i, label: i === 0 ? 'Research video: extraction routes and evidence' : 'Research video ' + (i + 1),
        status, attempt: 1, childConversationId: 2, progress: { completed: i < 3 ? 2 : 3, total: 3, phase: 'Evidence review' },
        ...(status === 'failed' ? { error: 'Provider unavailable. Research draft preserved.' } : status === 'completed' ? { result: 'Evidence saved and verified.' } : {}) } };
    (status === 'completed' || status === 'failed' ? frame.history : frame.tasks).push(task);
  }
  frame.tasks.push({ id: 60, conversationId: 2, kind: 'pi.tool', label: 'Read saved evidence', toolName: 'read', status: 'running' });
  const opened = [], root = document.querySelector('#output');
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {}, subagent: (id, owner) => opened.push({ id, owner }) });
  window.fixture = { frame, opened, render(status = 'running', connected = true) {
    output.update({ role: 'assistant', content: 'The coordinator has assigned research tasks. Results will be saved in sequence.', status }, 'project', 'agent', 'session', []);
    output.updateSubagents(conversationSubagents(frame, 1, connected));
  } }; window.fixture.render();
` }, outfile: 'subagents.js', bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).contents;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).contents;
const theme = await readFile(path.join(cli, 'src/web/theme.css'));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="${url.searchParams.get('locale') ?? 'en'}" data-theme="${url.searchParams.get('theme') ?? 'light'}"><head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/subagents.css"><link rel="stylesheet" href="/codicons/codicon.css">
        <style>body { padding: 20px; } main { max-width: 820px; margin: 0 auto; } #output { min-width: 0; } @media(max-width:400px) { body { padding: 12px; } }</style>
        </head><body><main><div id="output"></div></main><script type="module" src="/subagents.js"></script></body></html>`); return;
    }
    if (url.pathname === '/subagents.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); return; }
    if (url.pathname === '/subagents.css' || url.pathname === '/theme.css') { response.setHeader('Content-Type', 'text/css'); response.end(url.pathname === '/theme.css' ? theme : css); return; }
    if (/^\/codicons\/codicon\.(css|ttf)$/.test(url.pathname)) {
      response.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'font/ttf'); response.end(await readFile(path.join(cli, 'dist/web', url.pathname))); return;
    }
    response.writeHead(404).end();
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser; const errors = []; let cases = 0;
try {
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  for (const language of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) for (const width of [1000, 390, 320]) {
    await page.setViewportSize({ width, height: 780 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?locale=${language}&theme=${theme}`);
    const button = page.locator('.subagents-button'), panel = page.locator('.subagents-panel');
    await button.waitFor();
    assert.match(await button.innerText(), language === 'en' ? /Subagents.*3 Running.*1 Queued/ : /子 Agent.*3 个运行中.*1 个排队中/);
    assert.equal(await panel.isHidden(), true);
    if (width === 1000) {
      const pending = await page.locator('.pending-label').boundingBox(), entry = await button.boundingBox();
      assert.ok(entry.x >= pending.x + pending.width && Math.abs(entry.y - pending.y) < 10, 'entry sits to the right of Responding');
    }
    assert.equal(await button.locator(':scope > .codicon').evaluate(element => getComputedStyle(element).animationName), 'none');
    await button.click(); assert.equal(await page.locator('.subagent-task').count(), 30);
    const first = page.locator('[data-task-id="10"]'); await first.locator('summary').click();
    assert.ok((await first.innerText()).includes('researcher')); assert.ok((await first.innerText()).includes('2/3'));
    await first.locator('.subagent-open').focus();
    await page.evaluate(() => {
      const row = document.querySelector('[data-task-id="10"]'), list = document.querySelector('.subagents-list');
      list.scrollTop = 80; window.keptRow = row;
      for (let i = 0; i < 20; i++) { window.fixture.frame.tasks[0].agent.progress.completed = 3; window.fixture.render(); }
      if (document.querySelector('[data-task-id="10"]') !== row || !row.open || list.scrollTop !== 80) throw new Error('Streaming lost task view state');
    });
    assert.equal(await page.locator('.subagent-open').first().evaluate(element => document.activeElement === element), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('.subagents-list').evaluate(element => { element.scrollTop = 0; });
    if (width !== 390) await page.screenshot({ path: path.join(proof, `${language}-${theme}-${width}.png`) });
    await page.evaluate(() => window.fixture.render('success', false));
    assert.equal(await button.isVisible(), true); assert.equal(await page.locator('.pending').count(), 0);
    assert.equal(await first.locator('.subagent-open').isDisabled(), true); assert.equal(await page.locator('.subagents-connection').isVisible(), true);
    await page.evaluate(() => { window.fixture.frame.ownerId = 'new-owner'; window.fixture.render('success', true); });
    await first.locator('.subagent-open').click(); assert.deepEqual(await page.evaluate(() => window.fixture.opened.at(-1)), { id: 2, owner: 'new-owner' });
    await page.keyboard.press('Escape'); assert.equal(await panel.isHidden(), true); assert.equal(await button.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Space'); assert.equal(await panel.isVisible(), true);
    cases++;
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ headless: true, cases, languages: ['en', 'zh-CN'], themes: ['light', 'dark'], widths: [1000, 390, 320], proof,
    checks: ['30 tasks', 'response entry', 'live progress', 'scroll and focus', 'history', 'disconnect/reconnect', 'child navigation', 'keyboard', 'no overflow'] }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
