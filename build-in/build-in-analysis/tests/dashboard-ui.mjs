import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { validateProjectScriptSource } from 'steamharness';
import { translations } from '../src/locales.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'node_modules/@steamharness/cli/dist/index.js');
const { readLocalStudioAnalysis } = await import(new URL('../node_modules/@steamharness/cli/dist/web/local-analysis.mjs', import.meta.url));
const data = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-analysis-ui-')));
const storageDir = path.join(data, 'web'), proofDir = path.join(root, 'test-results'); await mkdir(proofDir, { recursive: true });
const children = new Set(), services = [];
const environment = { ...process.env, STEAMHARNESS_CLI_AUTH_DIR: path.join(data, 'auth'), STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '',
  STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: '', STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: '' };
const dependencies = await realpath(path.join(root, 'node_modules'));
const source = `
const output = steamharness.createOutputNode({ name: 'result', format() { return steamharness.createOutputPayload({ items: [{ content: 'Local result', contentType: 'text' }] }); } });
const approval = steamharness.createUserInputNode({ name: 'approval-node', title: 'Approval', params: [{ name: 'approved', type: 'boolean', required: true }] });
const task = steamharness.defineProject({ name: 'analysis-fixture', async run(input, context) {
  if (input.mode === 'failed') throw new Error('Expected local failure');
  if (input.mode === 'slow') await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 120000); context.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Stopped')); }, { once: true }); });
  if (input.mode === 'waiting') await steamharness.runNode(approval, input, context);
  return steamharness.runNode(output, input, context);
} });
export const executor = steamharness.defineExecutor({ projectType: 'workflow', defaultEntrypoint: 'success', entrypoints: [
  steamharness.defineEntrypoint({ id: 'success', title: 'success', workflow: task, createInput() { return { errCode: 0, errMessage: '', mode: 'success' }; } }),
  steamharness.defineEntrypoint({ id: 'failed', title: 'failed', workflow: task, createInput() { return { errCode: 0, errMessage: '', mode: 'failed' }; } }),
  steamharness.defineEntrypoint({ id: 'slow', title: 'slow', workflow: task, createInput() { return { errCode: 0, errMessage: '', mode: 'slow' }; } }),
  steamharness.defineEntrypoint({ id: 'waiting', title: 'waiting', workflow: task, createInput() { return { errCode: 0, errMessage: '', mode: 'waiting' }; } }),
] });
`;
async function project(name) {
  const directory = path.join(data, name); await mkdir(directory);
  const manifest = { id: randomUUID(), name, type: 'module', devDependencies: { 'steamharness': '0.1.2', '@steamharness/cli': '0.1.2' },
    steamHarness: { defaultEntry:'main',entries:[{entryId:'main',type:'workflow',name,root:'.',entry:'index.ts',databases:[]}] } };
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest)); await writeFile(path.join(directory, 'index.ts'), source);
  await symlink(dependencies, path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return { id: manifest.id, name, uri: pathToFileURL(directory).href, folderPath: directory, projectType: 'workflow', inWorkspace: true };
}
async function start(directory, locale = 'en', bridge) {
  const child = spawn(process.execPath, [cli, '--locale', locale, 'web', directory, '--no-open', '--json', '--host-stdio', '--data-dir', storageDir], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, ...(bridge ?? {}) },
  }); children.add(child);
  child.stdin.write(`${JSON.stringify({ type: 'configure', surface: 'editor', connection: null })}\n`);
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${stderr}`)), 30000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI stopped ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => { stdout += chunk; for (const line of stdout.split('\n')) { try { const message = JSON.parse(line); if (message.type === 'ready') { clearTimeout(timer); resolve(message); return; } } catch {} } });
  });
  const origin = new URL(ready.url).origin;
  const post = async message => {
    const response = await fetch(`${origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${new URL(ready.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).messages;
  };
  const service = { child, ready, post, state: async () => (await post({ type: 'ready' }))[0] }; services.push(service); return service;
}
async function waitFor(test, description) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await test(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${description}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer); children.delete(child);
}
let browser, bridge, failedRefresh = false, emptyScope = false, analysisNow;
const proof = { checks: [], screenshots: [], errors: [] };
try {
  assert.deepEqual(validateProjectScriptSource(source, 'index.ts'), [], 'The live fixture must satisfy Core script validation.');
  const tasks = await project('Local tasks'), prompts = await project('Local approvals');
  const taskService = await start(tasks.folderPath), promptService = await start(prompts.folderPath);
  for (const entrypointId of ['success', 'failed']) {
    await taskService.post({ type: 'workflow-run', entrypointId, params: {} });
    await waitFor(async () => {
      const state = await taskService.state(), run = state.runs.find(run => run.entrypointId === entrypointId);
      if (entrypointId === 'success' && run?.status === 'failed') throw new Error(JSON.stringify(state.run));
      return run?.status === (entrypointId === 'success' ? 'success' : 'failed');
    }, entrypointId);
  }
  await taskService.post({ type: 'workflow-run', entrypointId: 'slow', params: {} });
  await promptService.post({ type: 'workflow-run', entrypointId: 'waiting', params: {} });
  await waitFor(async () => (await promptService.state()).runs.some(run => run.status === 'waiting_for_input'), 'real user input');
  const dashboard = path.join(data, 'Analysis'); await mkdir(dashboard);
  for (const name of ['package.json', 'configuration.json', 'index.html', 'assets']) await cp(path.join(root, name), path.join(dashboard, name), { recursive: true });
  await symlink(dependencies, path.join(dashboard, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = JSON.parse(await readFile(path.join(dashboard, 'package.json'), 'utf8'));
  const coreVersion = JSON.parse(await readFile(path.join(dependencies, 'steamharness/package.json'), 'utf8')).version;
  const cliVersion = JSON.parse(await readFile(path.join(dependencies, '@steamharness/cli/package.json'), 'utf8')).version;
  await writeFile(path.join(dashboard, 'package.json'), JSON.stringify({ ...manifest,
    devDependencies: { 'steamharness': coreVersion, '@steamharness/cli': cliVersion } }));
  const projects = [tasks, prompts, { id: manifest.id, name: manifest.name, uri: pathToFileURL(dashboard).href, folderPath: dashboard, projectType: 'kanban' }];
  const token = randomBytes(32).toString('hex');
  bridge = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/studio-control' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end('{}'); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const call = JSON.parse(body);
    assert.deepEqual(call, { operation: 'studio.analysis.get', input: {}, permissionPolicy: 'read-only' });
    if (failedRefresh) { response.writeHead(503); response.end('{}'); return; }
    const value = await readLocalStudioAnalysis({ storageDir, projects: emptyScope ? [] : projects, now: analysisNow });
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, value }));
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const capability = { STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}/studio-control`, STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: token };
  await waitFor(async () => { const value = await readLocalStudioAnalysis({ storageDir, projects }); return value.projects.flatMap(project => project.runs).filter(run => run.status === 'running').length === 1; }, 'live CLI activity');
  proof.checks.push('real Core success, failure, active execution and resumable input persisted by CLI');
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  for (const locale of ['en', 'zh-CN']) {
    const t = translations(locale), analysis = await start(dashboard, locale, capability);
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } }), page = await context.newPage();
    page.on('pageerror', error => proof.errors.push(error.message)); await page.goto(analysis.ready.url);
    const frame = page.frameLocator('#kanban-preview'); await frame.getByRole('heading', { name: t.title, exact: true }).waitFor();
    await waitFor(async () => (await frame.locator('.stats dd').allTextContents())[0] === '3', 'real project total');
    assert.deepEqual((await frame.locator('.stats dd').allTextContents()).slice(0, 5), ['3', '1', '1', '0', '4']);
    assert.match(await frame.locator('#meta').textContent(), /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 980 });
      for (const mode of ['light', 'dark']) {
        await frame.locator('html').evaluate((node, theme) => { node.dataset.theme = theme; window.dispatchEvent(new CustomEvent('steamharness:kanban-theme-change')); }, mode);
        const contrast = await frame.locator('body').evaluate(() => {
          const rgb = value => value.match(/[\d.]+/g).map(Number);
          const surface = rgb(getComputedStyle(document.documentElement).backgroundColor);
          const luminance = values => values.slice(0, 3).map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; })
            .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
          return ['running', 'waiting_for_input', 'success', 'failed', 'timed_out', 'unknown'].map(status => {
            const badge = document.createElement('span'); badge.className = `badge ${status}`; document.body.append(badge);
            const style = getComputedStyle(badge), foreground = rgb(style.color), background = rgb(style.backgroundColor);
            const alpha = background[3] ?? 1, composed = surface.map((value, index) => value * (1 - alpha) + background[index] * alpha);
            const light = luminance(foreground), dark = luminance(composed); badge.remove();
            return { status, ratio: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05) };
          });
        });
        assert.ok(contrast.every(item => item.ratio >= 4.5), `${mode}: ${JSON.stringify(contrast)}`);
        const pixels = await frame.locator('canvas').evaluateAll(canvases => canvases.map(canvas => {
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let painted = 0;
          for (let index = 3; index < data.length; index += 4) if (data[index]) painted++; return painted;
        })); assert.ok(pixels.every(value => value > 100), JSON.stringify(pixels));
        const layout = await frame.locator('body').evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth,
          buttons: [...document.querySelectorAll('button')].filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect().right) }));
        assert.ok(layout.content <= layout.width + 1, JSON.stringify(layout)); assert.ok(layout.buttons.every(right => right <= layout.width + 1), JSON.stringify(layout));
        const filename = `${locale}-${width}-${mode}.png`; await page.screenshot({ path: path.join(proofDir, filename), fullPage: true }); proof.screenshots.push(filename);
      }
    }
    await page.setViewportSize({ width: 1440, height: 980 }); await frame.locator('[data-view="runs"]').click();
    await frame.getByLabel(t.allStatuses).selectOption('failed'); assert.equal(await frame.locator('tbody tr').count(), 1); assert.ok((await frame.locator('tbody').textContent()).includes('Local tasks'));
    const download = page.waitForEvent('download'); await frame.getByRole('button', { name: t.export, exact: true }).click();
    assert.ok((await readFile(await (await download).path(), 'utf8')).includes('Local tasks'));
    await frame.getByLabel(t.allStatuses).selectOption('');
    const search = frame.getByRole('searchbox'); await search.fill('Local tasks'); await search.focus();
    await waitFor(async () => (await frame.locator('#meta').textContent()) && await search.evaluate(node => document.activeElement === node), 'search focus');
    await page.waitForTimeout(5500);
    assert.equal(await search.evaluate(node => document.activeElement === node), true, 'Automatic refresh must preserve input focus.');
    await frame.getByRole('button', { name: t.refresh, exact: true }).click(); await search.focus();
    assert.equal(await search.inputValue(), 'Local tasks');
    failedRefresh = true; await frame.getByRole('button', { name: t.refresh, exact: true }).click();
    await frame.locator('#notice').filter({ hasText: t.stale }).waitFor();
    assert.equal(await search.inputValue(), 'Local tasks'); assert.equal(await frame.locator('tbody tr').count(), 3);
    failedRefresh = false; await frame.getByRole('button', { name: t.refresh, exact: true }).click();
    await frame.locator('#notice').waitFor({ state: 'hidden' });
    await frame.locator('[data-view="projects"]').click(); assert.equal(await frame.locator('tbody tr').count(), 1);
    await frame.getByRole('searchbox').fill('does not exist'); assert.ok((await frame.locator('tbody').textContent()).includes(t.noProjects));
    await frame.locator('[data-view="overview"]').click(); emptyScope = true;
    await frame.getByRole('button', { name: t.refresh, exact: true }).click();
    await waitFor(async () => (await frame.locator('.stats dd').allTextContents())[0] === '0', 'empty local scope');
    assert.deepEqual((await frame.locator('.stats dd').allTextContents()).slice(0, 7), ['0', '0', '0', '0', '0', '-', '-']);
    emptyScope = false; await frame.getByRole('button', { name: t.refresh, exact: true }).click();
    await waitFor(async () => (await frame.locator('.stats dd').allTextContents())[0] === '3', 'scope recovery');
    proof.checks.push(`${locale}: real bridge values, nonblank charts, three widths, two themes, filters, CSV, retained focus, failed refresh recovery and empty scope`);
    await context.close(); await stop(analysis.child);
  }
  await taskService.post({ type: 'workflow-stop' }); await promptService.post({ type: 'workflow-stop' });
  await waitFor(async () => { const value = await readLocalStudioAnalysis({ storageDir, projects }); return !value.projects.flatMap(project => project.runs).some(run => ['running', 'waiting_for_input'].includes(run.status)); }, 'cancelled activities');
  await stop(taskService.child); await stop(promptService.child);
  const after = await readLocalStudioAnalysis({ storageDir, projects }); assert.equal(after.projects.flatMap(project => project.runs).length, 4); assert.ok(after.projects.every(project => !project.live));
  const latest = Math.max(...after.projects.flatMap(project => project.runs.map(run => run.createdAt)));
  analysisNow = latest + 7 * 86_400_000 - 500;
  const boundaryService = await start(dashboard, 'en', capability);
  const boundaryPage = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  await boundaryPage.goto(boundaryService.ready.url);
  const boundaryFrame = boundaryPage.frameLocator('#kanban-preview'), en = translations('en');
  await waitFor(async () => (await boundaryFrame.locator('.stats dd').allTextContents())[0] === '3', 'time-window project data');
  await boundaryFrame.getByLabel(en.allTime).selectOption('7'); await boundaryFrame.locator('[data-view="runs"]').click();
  assert.equal(await boundaryFrame.locator('tbody td.empty').count(), 0);
  analysisNow += 1000;
  await boundaryFrame.getByRole('button', { name: en.refresh, exact: true }).click();
  await boundaryFrame.locator('tbody td.empty').waitFor({ timeout: 5000 });
  assert.ok((await boundaryFrame.locator('tbody').textContent()).includes(en.noRuns), 'Unchanged histories must still expire from a rolling time filter.');
  await boundaryPage.close(); await stop(boundaryService.child);
  proof.checks.push('rolling time filter updates when a persisted run crosses its boundary without a history change');
  proof.checks.push('cancellation, service close and retained historical records'); assert.deepEqual(proof.errors, []);
  console.log(JSON.stringify(proof, null, 2));
} finally {
  for (const child of children) await stop(child);
  await browser?.close(); if (bridge) await new Promise(resolve => bridge.close(resolve));
  await writeFile(path.join(proofDir, 'results.json'), JSON.stringify(proof, null, 2)); await rm(data, { recursive: true, force: true });
}
