import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const workspace = await mkdtemp(path.join(tmpdir(), 'project-details-ui-'));
const project = path.join(workspace, 'project-with-a-long-location-'.repeat(4));
const id = 'ea017a70-447f-409e-8016-090f66352a06';
const names = { en: 'Project assistant', 'zh-CN': '项目助理' };
let browser, cli;
async function stopCli() {
  if (cli?.pid && cli.exitCode === null && cli.signalCode === null) {
    const exited = new Promise(resolve => cli.once('exit', resolve));
    cli.kill('SIGTERM');
    const timeout = setTimeout(() => cli.kill('SIGKILL'), 5_000);
    await exited; clearTimeout(timeout);
  }
}

async function startCli(language) {
  cli = spawn(process.execPath, [process.env.STEAMHARNESS_UI_CLI_ENTRY ?? path.join(repo, 'cli/dist/index.js'), '--locale', language, 'web', project,
    '--no-open', '--json', '--data-dir', path.join(workspace, language)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  cli.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: cli.stdout });
    const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${stderr}`)), 20_000);
    cli.once('error', error => { clearTimeout(timer); reject(error); });
    cli.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${stderr}`)); });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'ready') { clearTimeout(timer); resolve({ ...event, diagnostics: () => stderr }); }
    });
  });
}

try {
  const core = await realpath(path.join(repo, 'cli/node_modules/steamharness'));
  const { version } = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8'));
  await mkdir(path.join(project, 'node_modules'), { recursive: true });
  await symlink(core, path.join(project, 'node_modules/steamharness'), 'junction');
  await writeProjectFixture(path.join(project, 'package.json'), JSON.stringify({
    id, name: 'project-assistant', type: 'module', version: '1.2.3', description: 'Overview <em>as declared</em>',
    devDependencies: { steamharness: version, '@steamharness/cli': version },
    projectInfo: { localizedNames: names, declarations: ['multilingual'] }, defaultEntry: 'assistant',
    entries: [
      { entryId: 'assistant', name: 'Assistant', type: 'bot', root: 'assistant', entry: 'index.ts' },
      { entryId: 'control', name: 'Control', type: 'bot', root: 'control', entry: 'index.ts' },
    ],
  }));
  for (const entry of ['assistant', 'control']) await writeFile(path.join(project, entry, 'index.ts'), `
    export const executor = steamharness.defineBot({ engine: 'agent', name: '${entry}', agent: { systemPrompt: 'Test fixture' } });
  `);
  browser = await chromium.launch({ headless: true, channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome' });
  for (const [language, theme, width] of [['en', 'light', 1280], ['zh-CN', 'dark', 360]]) {
    const launch = await startCli(language);
    const page = await browser.newPage({ colorScheme: theme, viewport: { width, height: 768 } });
    const response = await page.goto(launch.url);
    try { await page.locator('#app[data-run-state]').waitFor({ state: 'attached', timeout: 5_000 }); }
    catch (error) {
      const retry = page.locator('body > main > button');
      if (await retry.isVisible()) {
        const pending = page.waitForResponse(result => new URL(result.url()).pathname.endsWith('/api/retry'), { timeout: 5_000 });
        await retry.click();
        throw new Error(`CLI entry did not start: ${await (await pending).text()}`, { cause: error });
      }
      throw new Error(`CLI Web did not start (${response?.status()}): ${launch.diagnostics()}`, { cause: error });
    }
    await page.locator('#project-info').click();
    const overview = page.locator('[data-section=overview] .lp-project-details');
    await overview.waitFor({ timeout: 5_000 });
    assert.equal(await overview.locator('.lp-detail-title').innerText(), names[language]);
    assert.equal(await overview.locator('.lp-detail-description').innerText(), 'Overview <em>as declared</em>');
    assert.equal(await overview.locator('.lp-detail-type').innerText(), language === 'en' ? 'Multi-entry' : '多入口');
    assert.equal(await overview.locator('.lp-entry-default').innerText(), language === 'en' ? 'Default' : '默认入口');
    assert.equal(await overview.locator('button, .lp-project-usage').count(), 0);
    assert.equal(await overview.locator('.lp-detail-entries li').count(), 2);
    const layout = await overview.evaluate(article => {
      const label = article.querySelector('.lp-detail-title'), path = article.querySelector('.lp-detail-location');
      const head = article.querySelector('.lp-detail-head'), panel = article.parentElement;
      return { selectable: getComputedStyle(label).userSelect, display: getComputedStyle(head).display,
        wrapped: path.scrollWidth <= path.clientWidth, fits: panel.scrollWidth <= panel.clientWidth, theme: document.documentElement.dataset.theme };
    });
    assert.deepEqual(layout, { selectable: 'text', display: 'flex', wrapped: true, fits: true, theme });
    if (process.env.STEAMHARNESS_UI_PROOF_DIR) {
      await mkdir(process.env.STEAMHARNESS_UI_PROOF_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.STEAMHARNESS_UI_PROOF_DIR, `${language}-${theme}-${width}.png`) });
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.project-information-dialog[open]').count(), 0);
    console.log(`CLI project details passed (${language}, ${theme}, ${width}px)`);
    await page.close();
    await stopCli();
  }
} finally {
  await browser?.close();
  await stopCli();
  await rm(workspace, { recursive: true, force: true });
}
