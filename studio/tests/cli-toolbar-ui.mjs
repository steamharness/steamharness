import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cliEntry = process.env.STEAMHARNESS_UI_CLI_ENTRY ?? path.join(root, 'examples/conversation/node_modules/@steamharness/cli/dist/index.js');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-cli-toolbar-'));
const projectDir = path.join(data, 'project'); await fs.mkdir(projectDir);
const proofDir = path.join(root, '.studio/cli-toolbar'); await fs.mkdir(proofDir, { recursive: true });
const exampleManifest = JSON.parse(await fs.readFile(path.join(root, 'examples/conversation/package.json'), 'utf8'));
const manifest = { id: '94b414b7-cdb4-491d-bc73-7282ebd74692', name: 'Default project name', version: '1.2.3', type: 'module',
  devDependencies: exampleManifest.devDependencies,
  description: 'Project description <img id="unsafe" src="invalid">', steamHarness: { projectInfo: {
    localizedNames: { en: 'Project information with a long display name', 'zh-CN': '\u9879\u76ee\u4fe1\u606f\u4e0e\u8f83\u957f\u7684\u5c55\u793a\u540d\u79f0' },
    declarations: ['multilingual'], platformSupport: { mode: 'specific', platforms: ['macos', 'web'] }, dataStorage: { mode: 'local' },
  } } };
await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify(manifest));
await fs.symlink(await fs.realpath(path.join(root, 'examples/conversation/node_modules')), path.join(projectDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await fs.writeFile(path.join(projectDir, 'index.ts'), `
  const task = steamharness.defineProject({ name: 'toolbar-test', run(input) {
    return steamharness.createOutputPayload({ items: [{ id: 'answer', contentType: 'text', content: input.message }] });
  } });
  function credentialsMarker() { return steamharness.getServerLLMCredentials(); }
  export const executor = steamharness.defineExecutor({ projectType: 'conversation', workflow: task,
    params: [{ kind: 'quick', id: 'ai', label: 'AI configuration with a very long display name', icon: 'sparkle', summary: ['model', 'effort'], fields: [
      { name: 'model', type: 'string', flag: '--model', label: 'Model', defaultValue: 'long-model', control: 'select', options: [
        { value: 'long-model', label: 'Long model name to verify compact AI configuration' }, { value: 'alternate', label: 'Alternate model' } ] },
      { name: 'effort', type: 'string', flag: '--effort', label: 'Effort', defaultValue: 'high', control: 'select', options: [{ value: 'high', label: 'High' }] }
    ] }], createInput(context) { return { message: steamharness.parseConversationDefaultInputArgs(context.args).message }; }
  });
`);
let catalogMode = 'success', delay = 0, copyHostHtml;
const catalog = { balance: 12.34, groups: [{ groupId: 1, name: 'Active plan <text>', subscriptionType: 'subscription',
  subscription: { status: 'active', dailyLimitUsd: 10, dailyUsageUsd: 8, weeklyLimitUsd: 20, weeklyUsageUsd: 25, monthlyLimitUsd: null, monthlyUsageUsd: 30 } },
  { groupId: 2, name: 'Expired plan', subscriptionType: 'subscription', subscription: { status: 'expired' } }] };
const server = createServer(async (request, response) => {
  if (request.url === '/copy-host' && copyHostHtml) { response.setHeader('Content-Type', 'text/html'); response.end(copyHostHtml); return; }
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/api/auth/me') {
    response.end(JSON.stringify({ errCode: 0, data: { profile: { userId: 'toolbar-test', email: 'ui@example.com', displayName: 'Toolbar test' }, principal: { expiresAt: '2030-01-01T00:00:00Z' } } }));
  } else if (request.url === '/api/ai/usage') {
    if (delay) { await new Promise(resolve => setTimeout(resolve, delay)); }
    response.end(JSON.stringify(catalogMode === 'error' ? { errCode: 1, errMessage: 'Catalog unavailable' }
      : { errCode: 0, data: catalogMode === 'missing' ? null : catalogMode === 'empty' ? { balance: 0, groups: [] } : catalog }));
  } else { response.writeHead(404); response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const connection = { serverUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'offline-toolbar-test' };
let child, browser, page;
const proof = { checks: [], screenshots: [], errors: [] };
async function stop() {
  if (!child || child.exitCode !== null) { return; }
  const previous = child, exited = new Promise(resolve => previous.once('exit', resolve));
  previous.stdin.end(); const timer = setTimeout(() => previous.kill('SIGKILL'), 10_000);
  await exited; clearTimeout(timer);
}
async function start(language) {
  child = spawn(process.execPath, [cliEntry, '--locale', language, 'web', projectDir, '--no-open', '--json', '--host-stdio', '--data-dir', path.join(data, language)], {
    env: { ...process.env, STEAMHARNESS_CLI_AUTH_DIR: path.join(data, 'auth'), STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(`${JSON.stringify({ type: 'configure', surface: 'editor', connection })}\n`);
  let output = '', error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI startup timed out: ${error}`)), 30_000);
    child.once('error', failure => { clearTimeout(timeout); reject(failure); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`CLI exited ${code}: ${error}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      for (const line of output.split('\n')) {
        try { const value = JSON.parse(line); if (value.type === 'ready') { clearTimeout(timeout); resolve(value); return; } } catch { /* Wait for a full JSON line. */ }
      }
    });
  });
}
async function ready() { await page.locator('#parameters[aria-busy=false]').waitFor(); }
async function closeDialog() { await page.locator('.conversation-dialog[open] header button').last().click(); }
async function layout(selector = '.toolbar') {
  const bounds = await page.locator(selector).evaluate(element => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
    boxes: [element, ...element.querySelectorAll('button, h1, dt, dd')].filter(node => node.getClientRects().length).map(node => {
      const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width };
    }) }));
  assert.ok(bounds.document <= bounds.viewport, JSON.stringify(bounds));
  assert.ok(bounds.boxes.every(box => box.left >= 0 && box.right <= bounds.viewport + 1 && box.width > 0), JSON.stringify(bounds));
}
async function screenshot(name) { await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }
async function usageRequestLifecycle() {
  await page.evaluate(() => {
    window.__toolbarUsageReplies = 0;
    window.addEventListener('message', event => {
      if (event.data?.type === 'usage' || event.data?.type === 'error' && event.data.requestType === 'usage') { window.__toolbarUsageReplies++; }
    });
  });
  let capture, delivered = 0;
  const handler = route => route.request().postDataJSON().type === 'usage' ? capture(route) : route.continue();
  await page.route('**/api/message', handler);
  const request = async () => {
    let timer;
    const pending = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Usage request was not sent')), 15_000);
      capture = route => { clearTimeout(timer); resolve(route); };
    });
    try { await page.locator('#usage').click(); return await pending; } finally { clearTimeout(timer); }
  };
  const reply = async (route, balance, error = false) => {
    const message = route.request().postDataJSON();
    await route.fulfill({ status: error ? 400 : 200, contentType: 'application/json', body: JSON.stringify(error ? { message: 'Obsolete usage error' }
      : { messages: [{ type: 'usage', requestId: message.requestId, sessionId: message.sessionId, usage: { balance, groups: [] } }] }) });
    await page.waitForFunction(count => window.__toolbarUsageReplies === count, ++delivered);
  };
  try {
    for (const error of [false, true]) {
      const old = await request(); await page.keyboard.press('Escape');
      const current = await request(); await reply(current, 22); await reply(old, 11, error);
      assert.equal(await page.locator('.usage-balance strong').innerText(), '$22.00', 'An obsolete usage reply must not replace the current balance');
      assert.equal(await page.locator('#error').isVisible(), false);
      await closeDialog();
    }
    const old = await request(); child.stdin.write(`${JSON.stringify({ type: 'auth', connection: null })}\n`);
    await page.locator('#usage').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.conversation-dialog[open]').count(), 0, 'Account changes must dismiss the previous usage panel');
    await reply(old, 11); assert.equal(await page.locator('.conversation-dialog[open]').count(), 0);
    child.stdin.write(`${JSON.stringify({ type: 'auth', connection })}\n`);
    await page.locator('#usage:not([hidden])').waitFor(); await ready();
  } finally { await page.unroute('**/api/message', handler); }
}
async function selectionCopies(url, language) {
  const copyKey = process.platform === 'darwin' ? 'Meta+c' : 'Control+c';
  const select = async (frame, selector) => frame.locator(selector).first().evaluate(element => {
    element.tabIndex = -1; element.focus({ preventScroll: true });
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { window.__browserCopies = []; addEventListener('copy', () => window.__browserCopies.push(getSelection().toString())); });
  const response = await select(page, '.assistant .message-content');
  await page.keyboard.press(copyKey);
  assert.deepEqual(await page.evaluate(() => window.__browserCopies), [response]);
  const hostUrl = `http://127.0.0.1:${server.address().port}/copy-host`;
  copyHostHtml = `<!doctype html><body style="margin:0"><iframe style="width:100vw;height:100vh;border:0"></iframe><script>
    const frame=document.querySelector('iframe'),origin=${JSON.stringify(new URL(url).origin)};window.__copies=[];window.__menus=[];
    frame.onload=()=>frame.contentWindow.postMessage({type:'workflow-host',clipboardVersion:1},origin);
    addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!==origin)return;
      if(event.data.type==='workflow-clipboard'){window.__copies.push(event.data.text);frame.contentWindow.postMessage({type:'workflow-host',clipboard:{version:1,requestId:event.data.requestId,ok:true}},origin);}
      if(event.data.type==='workflow-contextmenu')window.__menus.push(event.data);
    });frame.src=${JSON.stringify(new URL('/', url).href)};</script>`;
  await page.goto(hostUrl);
  await page.frameLocator('iframe').locator('#message').waitFor();
  const frame = page.frames().find(frame => frame.url().startsWith(`${new URL(url).origin}/`)); assert.ok(frame);
  await frame.locator('#parameters[aria-busy=false]').waitFor(); await frame.locator('.assistant .message-content').waitFor();
  await frame.evaluate(() => {
    window.__browserWriteAttempts = 0;
    navigator.clipboard.writeText = async () => { window.__browserWriteAttempts++; throw new Error('Iframe clipboard permission denied'); };
  });
  let copyCount = 0;
  const copied = async expected => {
    await page.waitForFunction(count => window.__copies.length === count, ++copyCount);
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), expected);
  };
  const embeddedResponse = await select(frame, '.assistant .message-content');
  await page.keyboard.press(copyKey); await copied(embeddedResponse);
  await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Related project error\nDiagnostic log: failed request' } })));
  const error = await select(frame, '#error'); await page.keyboard.press(copyKey); await copied(error);
  await frame.locator('#error').click({ button: 'right' });
  await page.waitForFunction(() => window.__menus.length === 1);
  await frame.evaluate(() => getSelection().removeAllRanges());
  await page.evaluate(origin => document.querySelector('iframe').contentWindow.postMessage({ type: 'workflow-host', editCommand: 'copy', restoreFocus: true }, origin), new URL(url).origin);
  await copied(error);
  await frame.locator('#project-info').click();
  for (const selector of ['.project-information-name', '.project-information-section[open] dt', '.project-information-section[open] dd', '.project-information-section[open] summary']) {
    const text = await select(frame, selector);
    assert.equal(await frame.locator(selector).first().evaluate(element => getComputedStyle(element).userSelect), 'text');
    await page.keyboard.press(copyKey); await copied(text);
  }
  await frame.locator('.conversation-dialog[open] header button').last().click();
  await frame.locator('#message').fill('Before selected After');
  await frame.locator('#message').evaluate(input => input.setSelectionRange(7, 15));
  await page.keyboard.press(copyKey); await copied('selected');
  assert.equal(await frame.evaluate(() => window.__browserWriteAttempts), 0);
  assert.equal(await frame.locator('#error').innerText(), error);
  proof.checks.push(`${language}: standalone selection copy and embedded keyboard/context-menu copy cover responses, multiline errors/logs, information labels and input selections without iframe clipboard permission`);
  copyHostHtml = undefined;
}
try {
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  for (const language of ['en', 'zh-CN']) {
    const launch = await start(language);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', error => proof.errors.push(error.message));
    await page.goto(launch.url); await ready(); await page.locator('#usage:not([hidden])').waitFor();
    assert.equal(await page.locator('.toolbar-actions #new').count(), 1);
    assert.equal(await page.locator('#project-menu #new').count(), 0);
    assert.equal(await page.locator('#usage > span:last-child').innerText(), language === 'en' ? 'AI usage' : 'AI \u7528\u91cf');
    const buttonPositions = await page.locator('.toolbar-actions').evaluate(element => [...element.querySelectorAll('button')].map(button => button.id));
    assert.deepEqual(buttonPositions, ['new', 'usage', 'tools']);
    await page.locator('[data-action-id=ai]').click(); await page.locator('.quick-param-row[data-param=model]').click();
    await page.getByRole('option', { name: 'Alternate model', exact: true }).click(); await ready();
    assert.match(await page.locator('.param-action-summary').innerText(), /Alternate model/);
    assert.equal(await page.locator('[data-action-id=ai] > .codicon-sparkle').count(), 1);
    await page.locator('#project-info').click();
    assert.equal(await page.locator('.project-information-name').innerText(), manifest.steamHarness.projectInfo.localizedNames[language]);
    assert.equal(await page.locator('.project-information-description').innerText(), manifest.description);
    assert.equal(await page.locator('#unsafe').count(), 0);
    const values = await page.locator('.project-information-section[open] dd').allTextContents();
    assert.ok(values.includes(manifest.name) && values.includes(manifest.version) && values.includes(manifest.id) && values.includes(await fs.realpath(projectDir)));
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.conversation-dialog[open]').count(), 0);
    await page.locator('#message').fill('Conversation before starting a new one'); await page.locator('#send').click();
    await page.locator('.assistant .message-content').waitFor(); await page.locator('#app[data-run-state=idle]').waitFor();
    await page.locator('#message').fill('Preserved draft'); await page.locator('#new').click(); await ready();
    await page.locator('.transcript .empty').waitFor(); assert.equal(await page.locator('#message').inputValue(), '');
    assert.equal(await page.locator('#session-list .session').count(), 2);
    const prior = page.locator('#session-list .session').filter({ hasText: 'Conversation before' }); await prior.click();
    await page.waitForFunction(() => document.querySelector('#message').value === 'Preserved draft'); await ready();
    assert.equal(await page.locator('#message').inputValue(), 'Preserved draft');
    proof.checks.push(`${language}: toolbar order, project metadata, escaped content, model selection, new conversation and draft preservation`);
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme }); await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      for (const width of [1280, 760, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const menuOpen of [false, true]) {
          if (await page.locator(menuOpen ? '#menu-toggle' : '#hide-menu').isVisible()) { await page.locator(menuOpen ? '#menu-toggle' : '#hide-menu').click(); }
          await layout(); assert.equal(await page.locator('.toolbar-actions #new').isVisible(), true); assert.equal(await page.locator('#project-info').isVisible(), true);
        }
        await screenshot(`${language}-${theme}-${width}-toolbar.png`);
        await page.locator('#project-info').click(); await layout('.conversation-dialog[open]'); await closeDialog();
        await page.locator('#usage').click(); await page.locator('.usage-balance strong').waitFor();
        assert.equal(await page.locator('.usage-balance strong').innerText(), '$12.34');
        assert.equal(await page.locator('.usage-plan').count(), 1);
        assert.equal(await page.locator('.usage-plan h3').innerText(), 'Active plan <text>');
        assert.equal(await page.locator('.usage-period[data-status=near-limit] .usage-period-heading strong').innerText(), '80%');
        assert.equal(await page.locator('.usage-period[data-status=exhausted] .usage-period-heading strong').innerText(), '125%');
        assert.equal(await page.locator('.usage-period progress').count(), 2);
        await layout('.conversation-dialog[open]'); await screenshot(`${language}-${theme}-${width}-usage.png`); await closeDialog();
        proof.checks.push(`${language}, ${theme}, ${width}: visible toolbar with either sidebar state, information and usage fit viewport`);
      }
    }
    await usageRequestLifecycle(); proof.checks.push(`${language}: obsolete usage results and errors are ignored, account changes dismiss usage`);
    delay = 500; await page.locator('#usage').click(); await page.locator('.usage-status .codicon-loading').waitFor();
    assert.equal(await page.locator('.conversation-dialog header button').first().isDisabled(), true);
    await page.locator('.usage-balance').waitFor(); delay = 0;
    for (const mode of ['error', 'missing', 'empty', 'success']) {
      catalogMode = mode; await page.locator('.conversation-dialog header button').first().click();
      if (mode === 'error') { await page.locator('.usage-status[role=alert]').waitFor(); assert.match(await page.locator('.usage-status').innerText(), /Catalog unavailable/); assert.equal(await page.locator('#error').isVisible(), false); }
      else if (mode === 'missing') { await page.locator('.dialog-body[aria-busy=false]').waitFor(); assert.equal(await page.locator('.usage-status').innerText(), language === 'en' ? 'Usage unavailable' : '\u6682\u65f6\u65e0\u6cd5\u83b7\u53d6\u7528\u91cf'); }
      else { await page.locator('.usage-balance').waitFor(); assert.equal(await page.locator('.usage-plan').count(), mode === 'empty' ? 0 : 1); }
    }
    await page.keyboard.press('Escape'); await page.locator('#project-info').click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'usage', sessionId: 'unrelated', usage: { balance: 999, groups: [] } } })));
    assert.equal(await page.locator('.project-information-name').isVisible(), true);
    await closeDialog(); proof.checks.push(`${language}: loading, refresh, errors, missing data, no subscriptions and Escape cleanup`);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const action = await page.locator('[data-action-id=ai]').evaluate(button => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right, children: [...button.children].filter(child => child.getClientRects().length).map(child => {
          const bounds = child.getBoundingClientRect(); return { left: bounds.left, right: bounds.right };
        }) };
      });
      assert.ok(action.children.every(child => child.left >= action.left && child.right <= action.right + 1), JSON.stringify(action));
    }
    proof.checks.push(`${language}: long AI configuration labels and selected models stay within the button`);
    await selectionCopies(launch.url, language);
    await context.close(); await stop();
  }
  assert.deepEqual(proof.errors, []);
  console.log(JSON.stringify({ checks: proof.checks, errors: proof.errors }));
} catch (error) {
  proof.failure = error.message; if (page && !page.isClosed()) { await screenshot('failure.png').catch(() => {}); } throw error;
} finally {
  await fs.writeFile(path.join(proofDir, 'proof.json'), JSON.stringify(proof, null, 2));
  await browser?.close(); await stop(); await new Promise(resolve => server.close(resolve)); await fs.rm(data, { recursive: true, force: true });
}
