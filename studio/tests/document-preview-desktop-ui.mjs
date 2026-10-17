import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config, t } from '@vscode/l10n';
import * as XLSX from 'xlsx';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.STUDIO_TEST_PREVIEW_FILES;
assert.ok(source, 'Set STUDIO_TEST_PREVIEW_FILES to a folder containing PDF, DOCX, PPTX, XLSX, TEX and HEIC sample files.');
const language = process.env.STUDIO_TEST_UI_LANGUAGE ?? 'zh-cn'; assert.ok(['en', 'zh-cn'].includes(language));
config({ contents: language === 'en' ? {} : JSON.parse(await fs.readFile(path.join(root, 'extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json'), 'utf8')) });
const nls = JSON.parse(await fs.readFile(path.join(root, `extensions/studio-workstation/package.nls${language === 'en' ? '' : '.zh-cn'}.json`), 'utf8'));
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-preview-'));
const folder = path.join(data, 'files'); await fs.mkdir(folder);
const originals = new Map(), files = new Map();
for (const extension of ['pdf', 'docx', 'pptx', 'xlsx', 'tex', 'heic']) {
  const name = (await fs.readdir(source)).find(name => name.toLowerCase().endsWith(`.${extension}`)); assert.ok(name, extension);
  const bytes = await fs.readFile(path.join(source, name)); originals.set(name, createHash('sha256').update(bytes).digest('hex'));
  await fs.writeFile(path.join(folder, name), bytes); files.set(extension, name);
}
const proofDir = path.join(root, '.studio/document-preview', language); await fs.mkdir(proofDir, { recursive: true });
await fs.mkdir(path.join(data, 'User')); const settingsPath = path.join(data, 'User/settings.json');
const settings = theme => ({ 'workbench.colorTheme': theme, 'window.autoDetectColorScheme': false,
  'workbench.startupEditor': 'none', 'git.openRepositoryInParentFolders': 'never', 'workbench.secondarySideBar.defaultVisibility': 'hidden' });
await fs.writeFile(settingsPath, JSON.stringify(settings('Light Modern')));
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const log = await fs.open(path.join(proofDir, 'desktop.log'), 'w'), desktop = await desktopLocaleLaunch(language, data);
const child = spawn(desktop.executable, [...desktop.args, '--user-data-dir', data, '--extensions-dir', path.join(root, '.studio/desktop-extensions'),
  `--locale=${language}`, '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`, folder],
{ cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, WORKFLOW_SERVER_URL: '', WORKFLOW_SERVER_ADMIN_KEY: '' }, stdio: ['ignore', log.fd, log.fd] });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const proof = { language, checks: [], screenshots: [], errors: [] }; let browser, page;

async function command(name) {
  await page.locator('.part.titlebar').click({ position: { x: 300, y: 5 } }); await page.keyboard.press('F1');
  await page.locator('.quick-input-widget input').fill(`>${name}`);
  await page.locator('.quick-input-widget .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: name }) }).first().click();
  await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
}
async function preview(extension) {
  const name = files.get(extension);
  await page.locator('.part.sidebar .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: name }) }).first().dblclick();
  const kind = extension === 'tex' ? 'latex' : extension === 'heic' ? 'image' : extension;
  for (let attempt = 0; attempt < 450; attempt++) {
    for (const frame of page.frames()) {
      if (await frame.locator('#preview-app').isVisible().catch(() => false) && await frame.locator('.preview-status[role="alert"]').isVisible().catch(() => false)) {
        throw new Error(await frame.locator('.preview-status').innerText());
      }
      if (await frame.locator(`#preview-app[data-name="${name}"][data-kind="${kind}"]`).isVisible().catch(() => false)) {
        await frame.locator('.preview-status[role="alert"]').waitFor({ state: 'hidden' });
        if (extension === 'tex') { proof.checks.push('LaTeX opens in its read-only formula preview by default'); }
        return frame;
      }
    }
    await pause(100);
  }
  throw new Error(`Preview did not load: ${name}`);
}
async function pixels(canvas) {
  await canvas.waitFor();
  const stats = await canvas.evaluate(node => {
    const pixels = node.getContext('2d').getImageData(0, 0, node.width, node.height).data; let colored = 0;
    for (let index = 0; index < pixels.length; index += 64) { if (pixels[index + 3] && (pixels[index] < 240 || pixels[index + 1] < 240 || pixels[index + 2] < 240)) { colored++; } }
    return { width: node.width, height: node.height, colored };
  }); assert.ok(stats.width > 0 && stats.height > 0 && stats.colored > 10, JSON.stringify(stats)); return stats;
}
async function layout(frame) {
  const result = await frame.evaluate(() => {
    const toolbar = document.querySelector('.preview-toolbar'), rect = toolbar.getBoundingClientRect();
    return { width: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      height: rect.height, buttons: [...toolbar.querySelectorAll('button,input')].map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, bottom: box.bottom }; }) };
  }); assert.ok(result.overflow <= 1 && result.buttons.every(box => box.left >= 0 && box.right <= result.width + 1 && box.bottom <= result.height + 1), JSON.stringify(result));
}
async function screenshot(name) { await page.mouse.move(300, 20); await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name); }
async function atomicWrite(name, bytes) { const temporary = path.join(folder, `${name}.tmp`); await fs.writeFile(temporary, bytes); await fs.rename(temporary, path.join(folder, name)); }

try {
  for (let attempt = 0; attempt < 250; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch { /* Wait for Electron. */ }
    if (child.exitCode !== null) { throw new Error('Studio exited before startup'); } await pause(100);
  }
  await desktop.waitUntilReady(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(page => page.url().includes('workbench')); if (page) { break; } await pause(100); }
  assert.ok(page); page.setDefaultTimeout(30_000); page.on('pageerror', error => proof.errors.push(error.message));
  await page.bringToFront(); await page.setViewportSize({ width: 1440, height: 1000 }); await command('View: Show Explorer');
  for (const extension of ['pdf', 'docx', 'pptx', 'xlsx', 'tex', 'heic']) {
    const frame = await preview(extension); await layout(frame);
    assert.equal(await frame.locator('.preview-readonly').innerText(), t('Read-only'));
    assert.equal(await frame.locator('#preview-content [contenteditable=true]').count(), 0);
    if (extension === 'pdf') {
      await pixels(frame.locator('.preview-page canvas').first()); await frame.locator('.textLayer span').first().waitFor();
      assert.ok(await frame.locator('.textLayer span').first().evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString();
      }), 'PDF text must be selectable');
      const input = frame.getByRole('spinbutton', { name: t('Page') });
      if (Number(await input.getAttribute('max')) > 1) {
        await input.fill('2'); await input.dispatchEvent('change');
        const file = path.join(folder, files.get(extension));
        const before = Number(await frame.locator('#preview-app').getAttribute('data-generation'));
        await atomicWrite(files.get(extension), Buffer.concat([await fs.readFile(file), Buffer.from('\n% Studio refresh\n')]));
        await frame.waitForFunction(previous => Number(document.getElementById('preview-app').dataset.generation) > previous, before);
        await frame.waitForFunction(() => document.querySelector('.preview-pager input')?.value === '2');
        proof.checks.push('PDF text is selectable and refresh preserves the current page');
      }
    } else if (extension === 'pptx') {
      await pixels(frame.locator('canvas')); assert.equal(await frame.locator('.slide-text').count(), 0);
      await frame.getByRole('button', { name: t('Copy slide text'), exact: true }).waitFor();
    } else if (extension === 'docx') {
      const document = frame.childFrames()[0]; assert.ok(document); await document.locator('.docx-wrapper section').first().waitFor();
      assert.ok((await document.locator('body').innerText()).trim()); assert.equal(await document.locator('script:not([nonce]), iframe, object, input').count(), 0);
    } else if (extension === 'xlsx') {
      await frame.locator('.sheet-grid td[data-cell=A1]').waitFor(); assert.ok((await frame.locator('.sheet-grid').innerText()).trim());
      const tabs = frame.getByRole('tab'); if (await tabs.count() > 1) { await tabs.nth(1).click(); }
      const selected = await frame.getByRole('tab', { selected: true }).innerText();
      const file = path.join(folder, files.get(extension)), workbook = XLSX.read(await fs.readFile(file), { cellStyles: true, cellDates: true });
      workbook.Sheets[selected].A1 = { t: 's', v: 'Studio live preview update' };
      await atomicWrite(files.get(extension), XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
      await frame.locator('.sheet-grid td[data-cell=A1]').filter({ hasText: 'Studio live preview update' }).waitFor();
      assert.equal(await frame.getByRole('tab', { selected: true }).innerText(), selected);
      proof.checks.push('Excel refresh displays changed cells and preserves the selected worksheet');
      workbook.Sheets[selected].A5000 = { t: 's', v: 'Virtual row 5000' }; workbook.Sheets[selected]['!ref'] = 'A1:F5000';
      const previous = Number(await frame.locator('#preview-app').getAttribute('data-generation'));
      await atomicWrite(files.get(extension), XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
      await frame.waitForFunction(generation => Number(document.getElementById('preview-app').dataset.generation) > generation, previous);
      await frame.locator('.sheet-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
      await frame.locator('[data-cell=A5000]').filter({ hasText: 'Virtual row 5000' }).waitFor();
      assert.ok(await frame.locator('tbody tr').count() < 200, 'Large worksheets must virtualize rows');
      await frame.locator('.sheet-scroll').evaluate(node => { node.scrollTop = 0; }); await frame.locator('[data-cell=A1]').waitFor();
      proof.checks.push('A 5,000-row worksheet scrolls to its last row with a bounded DOM');
    } else if (extension === 'tex') {
      const count = await frame.locator('.formula').count(); assert.ok(count >= 5);
      const file = path.join(folder, files.get(extension)), before = await fs.readFile(file);
      await atomicWrite(files.get(extension), Buffer.concat([before, Buffer.from('\n$$z = 2026$$\n')]));
      await frame.waitForFunction(expected => document.querySelectorAll('.formula').length === expected, count + 1);
      const good = await fs.readFile(file); await fs.unlink(file);
      await frame.locator('.preview-status[role=alert]').filter({ hasText: t('File does not exist.') }).waitFor();
      assert.equal(await frame.locator('.formula').count(), count + 1); await atomicWrite(files.get(extension), good);
      await frame.locator('.preview-status[role=alert]').waitFor({ state: 'hidden' });
      proof.checks.push('LaTeX refresh follows atomic saves and recovers from deletion without closing its tab');
    } else {
      const image = frame.locator('img'); await image.waitFor(); assert.ok(await image.evaluate(node => node.naturalWidth > 0 && node.naturalHeight > 0));
      await frame.getByRole('button', { name: t('Zoom in'), exact: true }).click(); assert.equal(await frame.locator('.zoom-label').innerText(), '125%');
    }
    const revision = Number(await frame.locator('#preview-app').getAttribute('data-generation'));
    const original = await fs.readFile(path.join(folder, files.get(extension))); await atomicWrite(files.get(extension), original);
    await frame.waitForFunction(previous => Number(document.getElementById('preview-app').dataset.generation) > previous, revision);
    if (extension === 'heic') { assert.equal(await frame.locator('.zoom-label').innerText(), '125%'); }
    proof.checks.push(`${extension}: real file renders read-only and observes source replacement`); await screenshot(`${extension}-light.png`);
  }
  const frame = await preview('pdf'); await page.setViewportSize({ width: 960, height: 760 }); await layout(frame); await screenshot('pdf-narrow-light.png');
  await fs.writeFile(settingsPath, JSON.stringify(settings('Dark Modern'))); await page.locator('.monaco-workbench.vs-dark').waitFor();
  await layout(frame); await screenshot('pdf-narrow-dark.png'); proof.checks.push('Preview controls fit narrow editors and follow light/dark Studio themes');
  assert.deepEqual(proof.errors, []);
  assert.doesNotMatch(await fs.readFile(path.join(proofDir, 'desktop.log'), 'utf8'), /Executing inline script violates|Failed to fetch dynamically imported module|Refused to (?:load|execute)/);
  for (const [name, hash] of originals) { assert.equal(createHash('sha256').update(await fs.readFile(path.join(source, name))).digest('hex'), hash); }
  await fs.writeFile(path.join(proofDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n'); console.log(JSON.stringify(proof));
} catch (error) { if (page) { await page.screenshot({ path: path.join(proofDir, 'failed.png') }); } throw error; }
finally {
  await browser?.close(); if (child.exitCode === null) { child.kill('SIGTERM'); }
  await Promise.race([exited, pause(10_000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  await log.close(); await fs.rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
