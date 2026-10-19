import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { durableTraceState } from './fixtures/trace-agent.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'extensions/studio-workstation/dist');
const proof = path.join(root, '.studio/trace-agent'); await mkdir(proof, { recursive: true });
const catalogs = Object.fromEntries(await Promise.all(['en', 'zh-cn'].map(async language => [language,
  JSON.parse(await readFile(path.join(root, `extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`), 'utf8'))])));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      const language = url.searchParams.get('locale') ?? 'en', theme = url.searchParams.get('theme') ?? 'dark';
      const dark = theme === 'dark';
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="${language}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/trace-ui.css"><link rel="stylesheet" href="/codicons/codicon.css">
        <style>:root { --vscode-font-family: system-ui; --vscode-font-size: 13px; --vscode-editor-background: ${dark ? '#1f1f1f' : '#fff'}; --vscode-panel-background: ${dark ? '#181818' : '#fff'}; --vscode-foreground: ${dark ? '#ccc' : '#333'}; --vscode-descriptionForeground: ${dark ? '#aaa' : '#616161'}; --vscode-widget-border: ${dark ? '#454545' : '#ccc'}; --vscode-panel-border: ${dark ? '#333' : '#ddd'}; --vscode-input-background: ${dark ? '#313131' : '#fff'}; --vscode-input-foreground: ${dark ? '#ccc' : '#333'}; --vscode-dropdown-background: ${dark ? '#313131' : '#fff'}; --vscode-focusBorder: #007acc; --vscode-list-hoverBackground: ${dark ? '#2a2d2e' : '#eee'}; --vscode-list-inactiveSelectionBackground: ${dark ? '#37373d' : '#e8e8e8'}; --vscode-editorWidget-background: ${dark ? '#252526' : '#fff'}; --vscode-menu-background: ${dark ? '#252526' : '#fff'}; --vscode-errorForeground: ${dark ? '#f48771' : '#a1260d'}; } </style>
        </head><body class="vscode-${theme}"><div id="trace-app"></div><script id="studio-localization" type="application/json">${JSON.stringify({ bundle: catalogs[language], locale: language })}</script>
        <script>window.requests=[];window.preferences={};window.acquireVsCodeApi=()=>({postMessage:value=>window.requests.push(value),getState:()=>window.preferences,setState:value=>window.preferences=value});</script><script src="/trace-ui.js"></script></body></html>`);
    } else if (/^\/(trace-ui\.(js|css)|codicons\/(codicon\.css|codicon\.ttf))$/.test(url.pathname)) {
      response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'font/ttf');
      response.end(await readFile(path.join(dist, url.pathname.slice(1))));
    } else { response.writeHead(404).end(); }
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
let state;
async function publish() { await page.evaluate(value => window.postMessage(value, '*'), state); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function selectTab(id) { await page.locator(`#trace-tab-${id}`).click(); await page.locator(id === 'trace' ? '#trace-execution' : '#trace-agent').waitFor({ state: 'visible' }); }
async function lastAction() { return page.evaluate(() => window.requests.filter(request => request.type === 'agent-action').at(-1)); }
try {
  let screenshots = 0;
  for (const language of ['en', 'zh-cn']) for (const theme of ['dark', 'light']) {
    const label = key => catalogs[language][key] ?? key;
    for (const [width, height] of [[1280, 500], [700, 400], [390, 600], [320, 460]]) {
      await page.setViewportSize({ width, height }); await page.goto(`${origin}/?locale=${language}&theme=${theme}`);
      state = durableTraceState(); await publish();
      for (const tab of ['trace', 'tasks', 'plan', 'records', 'usage']) {
        await selectTab(tab);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${language} ${theme} ${width} ${tab}: no document overflow`);
        assert.equal(await page.locator(`#trace-tab-${tab}`).getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator(`#trace-tab-${tab} > span:not(.codicon)`).innerText(), label(({ trace: 'Trace', tasks: 'Tasks', plan: 'Plan', records: 'Records', usage: 'Usage' })[tab]));
        if (tab === 'tasks') {
          const halves = await page.locator('.trace-task-section').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
          assert.ok(halves[0] > 50 && Math.abs(halves[0] - halves[1]) < 2, 'independent equal-height task sections');
          assert.equal(await page.locator('.trace-agent-conversation[aria-current=true]').count(), 1);
          assert.equal(await page.locator('[data-scroll=history] .trace-task-select').count(), 65);
          assert.ok(!(await page.locator('[data-scroll=history]').innerText()).includes(label('Stopping')));
        }
        if (tab === 'plan') { assert.match(await page.locator('.trace-plan-document').innerText(), /Implementation plan/); assert.equal(await page.locator('#trace-agent button').count(), 0); }
        if (tab === 'records') assert.match(await page.locator('#trace-agent').innerText(), /sqlite/);
        if (tab === 'usage') assert.match(await page.locator('#trace-agent').innerText(), /3755/);
        await page.screenshot({ path: path.join(proof, `${language}-${theme}-${width}-${tab}.png`) }); screenshots++;
      }
    }
  }
  await page.setViewportSize({ width: 1100, height: 500 }); await page.goto(origin); state = durableTraceState(); await publish(); await selectTab('tasks');
  await selectTab('trace'); await page.locator('#trace-run').selectOption('reply');
  const selection = await page.evaluate(() => window.requests.filter(request => request.type === 'select').at(-1));
  assert.equal(selection.target.sessionId, undefined); assert.equal(selection.target.messageId, 'reply');
  state.selection = { ...state.selection, ...selection.target }; state.generation++; await publish();
  assert.ok(await page.locator('.trace-row').count() > 0, 'choosing a turn retains the current conversation');
  await selectTab('tasks');
  await page.locator('[data-focus=task-164]').click(); assert.match(await page.locator('#trace-task-164').innerText(), /Fixture failure/);
  await page.locator('[data-scroll=history]').evaluate(element => { element.scrollTop = 90; });
  const position = await page.locator('[data-scroll=history]').evaluate(element => element.scrollTop);
  await page.locator('[data-focus=task-164]').focus();
  state.snapshot.agents.main.history.at(-1).attempt++; await publish();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.focus), 'task-164');
  assert.equal(await page.locator('[data-scroll=history]').evaluate(element => element.scrollTop), position);
  await selectTab('plan'); await selectTab('tasks');
  assert.equal(await page.locator('[data-focus=task-164]').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('[data-scroll=history]').evaluate(element => element.scrollTop), position);
  await selectTab('records'); await page.locator('[data-record=catalog-studio-control] summary').click();
  state.snapshot.agents.main.configuration.version++; await publish(); assert.equal(await page.locator('[data-record=catalog-studio-control]').getAttribute('open'), '');
  await selectTab('tasks'); await selectTab('records'); assert.equal(await page.locator('[data-record=catalog-studio-control]').getAttribute('open'), '');
  await selectTab('plan'); await page.locator('[data-focus=plan-read]').check();
  let action = await lastAction(); assert.deepEqual(action.action.command, { type: 'plan', expectedVersion: 5, items: [{ id: 'read', text: 'Read the project', status: 'completed' }, { id: 'verify', text: 'Verify the implementation', status: 'pending' }] });
  assert.equal(action.action.sessionId, 'main'); assert.equal(action.action.ownerId, 'owner-instance');
  state.pending = true; await publish(); assert.equal(await page.locator('[data-focus=plan-read]').isDisabled(), true);
  state.pending = false; state.error = 'Plan conflict'; await publish(); assert.match(await page.locator('#trace-notice').innerText(), /Plan conflict/); state.error = undefined;
  await page.locator('#trace-agent-actions').click(); await page.locator('[data-action=reset]').click();
  await page.locator('.trace-reset-dialog textarea').fill('Keep notes\nContinue next step'); await page.locator('.trace-reset-dialog button.primary').click();
  assert.equal((await lastAction()).action.command.handoff, 'Keep notes\nContinue next step');
  state.selection.sessionId = 'child'; state.generation++; await publish(); await selectTab('tasks');
  assert.equal(await page.locator('.trace-agent-conversation[aria-current=true]').innerText(), 'Main');
  assert.match(await page.locator('.trace-agent-conversation[data-selected=true]').innerText(), /subagent/);
  await page.locator('[data-focus=conversation-3]').click(); action = await lastAction(); assert.equal(action.action.targetId, 3); assert.equal(action.action.conversationId, 2);
  await selectTab('records'); assert.match(await page.locator('#trace-agent').innerText(), /steamharness.plan/); assert.doesNotMatch(await page.locator('#trace-agent').innerText(), /steamharness.reset/);
  state.selection.sessionId = 'fork'; state.generation++; await publish(); await selectTab('tasks'); await page.locator('[data-focus=fork-source]').click();
  assert.equal((await lastAction()).action.targetSessionId, 'main');
  await page.locator('#trace-agent-actions').click(); assert.equal(await page.locator('[data-action=foreground]').isVisible(), false); assert.equal(await page.locator('[data-action=all]').isVisible(), false); await page.keyboard.press('Escape');
  state.selection.sessionId = undefined; state.generation++; await publish();
  await page.locator('#trace-agent-actions').click(); await page.locator('[data-action=foreground]').click(); assert.equal((await lastAction()).action.command.scope, 'foreground');
  await page.locator('[data-focus=stop-11]').click(); assert.deepEqual((await lastAction()).action.command, { type: 'cancel', scope: 'task', taskId: 11, targetId: 2 });
  state.status = 'offline'; await publish(); assert.equal(await page.locator('#trace-agent-actions').isDisabled(), true); assert.equal(await page.locator('[data-focus=stop-11]').isDisabled(), true);
  if (await page.locator('[data-focus=task-164]').getAttribute('aria-expanded') !== 'true') await page.locator('[data-focus=task-164]').click();
  assert.match(await page.locator('[data-scroll=history]').innerText(), /Fixture failure/);
  state.status = 'connected'; state.reveal++; state.selection.messageId = 'reply'; await publish(); assert.equal(await page.locator('#trace-tab-trace').getAttribute('aria-selected'), 'true');
  await selectTab('tasks'); await page.locator('#trace-tab-tasks').focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#trace-tab-plan').getAttribute('aria-selected'), 'true');
  state.snapshot.durable = false; await publish(); assert.equal(await page.locator('#trace-tabs').isVisible(), false); assert.equal(await page.locator('#trace-execution').isVisible(), true);
  assert.deepEqual(errors, []); console.log(JSON.stringify({ headless: true, screenshots, languages: ['en', 'zh-cn'], themes: ['dark', 'light'], checks: ['all-views', 'responsive', 'equal-task-sections', 'completed-details', 'scroll-focus-expansion', 'plan-CAS', 'handoff', 'scoped-navigation', 'current-conversation', 'scoped-cancel', 'disconnect', 'keyboard', 'original-trace'], proof }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
