// Exercise the registered extension and its native Webview transport in a
// headless workbench; renderer-only tests cannot detect extension identity loss.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, glob, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { ROOT, assertUpstream } from '../scripts/distribution.mjs';
import { serveLocalWebviewAssets } from './local-webview-assets.mjs';

const source = process.env.STUDIO_TEST_PREVIEW_FILES;
assert.ok(source, 'Set STUDIO_TEST_PREVIEW_FILES to a folder containing PDF, DOCX, PPTX, XLSX, TEX and HEIC samples.');
const languages = process.env.STUDIO_TEST_UI_LANGUAGE ? [process.env.STUDIO_TEST_UI_LANGUAGE] : ['en', 'zh-cn'];
assert.ok(languages.every(language => ['en', 'zh-cn'].includes(language)));
const upstream = await assertUpstream();
const proofDir = path.join(ROOT, '.studio/document-preview-web');
await mkdir(proofDir, { recursive: true });
const names = await readdir(source), originals = new Map(), proof = { checks: [], screenshots: [] };
for (const extension of ['pdf', 'docx', 'pptx', 'xlsx', 'tex', 'heic']) {
  const name = names.find(name => name.toLowerCase().endsWith(`.${extension}`));
  assert.ok(name, `Missing ${extension} sample`);
  const bytes = await readFile(path.join(source, name));
  originals.set(extension, { name, hash: createHash('sha256').update(bytes).digest('hex') });
}
async function until(read, message, timeout = 60_000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const result = await read(); if (result) return result;
    await delay(100);
  }
  throw new Error(message);
}
async function painted(canvas) {
  await canvas.waitFor();
  await canvas.evaluate(node => new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const inspect = () => {
      const bytes = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
      let colored = 0;
      for (let index = 0; index < bytes.length; index += 16) {
        if (bytes[index + 3] && Math.min(bytes[index], bytes[index + 1], bytes[index + 2]) < 240) ++colored;
      }
      if (colored > 10) resolve();
      else if (Date.now() > deadline) reject(new Error('Preview canvas remained empty'));
      else requestAnimationFrame(inspect);
    };
    inspect();
  }));
}

for (const language of languages) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-preview-web-')));
  const folder = path.join(directory, 'files'), extensions = path.join(directory, 'extensions');
  const readyFile = path.join(directory, 'ready.json');
  const token = randomBytes(24).toString('hex');
  let browser, child, page, log = '';
  try {
    await mkdir(path.join(folder, '.vscode'), { recursive: true }); await mkdir(extensions);
    const companion = path.join(extensions, 'preview-test'); await mkdir(companion);
    await writeFile(path.join(companion, 'package.json'), JSON.stringify({ name: 'preview-test', publisher: 'studio-test',
      version: '0.0.1', engines: { vscode: '^1.140.0' }, main: './extension.cjs', extensionKind: ['workspace'], activationEvents: ['onStartupFinished'] }));
    await writeFile(path.join(companion, 'extension.cjs'), `const vscode=require('vscode'),fs=require('node:fs/promises');
      exports.activate=async()=>{let result;try{const extension=vscode.extensions.getExtension('studio.studio-workstation');
        if(!extension)throw new Error('Studio extension is unavailable');await extension.activate();result={ready:true,language:vscode.env.language};
      }catch(error){result={error:error.message};}await fs.writeFile(process.env.STUDIO_TEST_PREVIEW_READY,JSON.stringify(result));};`);
    for (const { name } of originals.values()) await copyFile(path.join(source, name), path.join(folder, name));
    await writeFile(path.join(folder, '.vscode/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none',
      'workbench.colorTheme': 'Light Modern', 'git.enabled': false, 'extensions.autoUpdate': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden' }));
    if (language !== 'en') {
      const data = path.join(directory, 'server/data'); await mkdir(data, { recursive: true });
      await writeFile(path.join(data, 'languagepacks.json'), JSON.stringify({ [language]: { hash: 'studio-test', label: language,
        extensions: [{ extensionIdentifier: { id: 'studio-test.localization' }, version: '1.0.0' }], translations: {} } }));
    }
    child = spawn(process.execPath, [path.join(upstream.directory, 'scripts/code-server.js'), '--host', '127.0.0.1', '--port', '0',
      '--connection-token', token, '--server-data-dir', path.join(directory, 'server'), '--extensions-dir', extensions,
      '--builtin-extensions-dir', path.join(upstream.directory, 'extensions'), '--disable-workspace-trust', '--force-disable-user-env',
      '--telemetry-level', 'off', '--default-folder', folder], {
      cwd: upstream.directory, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', STEAMHARNESS_STUDIO_INTERNAL: '',
        STUDIO_TEST_PREVIEW_READY: readyFile,
        STEAMHARNESS_CLI_AUTH_DIR: path.join(directory, 'auth'), STEAMHARNESS_DESKTOP_CONFIG_DIR: path.join(directory, 'desktop'),
        VSCODE_SKIP_BUILTIN_EXTENSIONS: 'vscode.vscode-api-tests,GitHub.copilot,GitHub.copilot-chat' },
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes.toString().replaceAll(token, '[redacted]'); });
    child.on('error', error => { log += `\n${error.message}`; });
    const port = await until(() => /(?:Web UI available at http:\/\/[^:/\s]+:|Extension host agent listening on )(\d+)/.exec(log)?.[1], 'Studio Web did not start');
    browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true,
      args: ['--disable-features=LocalNetworkAccessChecks'] });
    const context = await browser.newContext({ locale: language === 'zh-cn' ? 'zh-CN' : 'en-US', viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'vscode.nls.locale', value: language, domain: '127.0.0.1', path: '/' }]);
    await context.addInitScript(locale => { globalThis._VSCODE_NLS_LANGUAGE = locale; }, language);
    await serveLocalWebviewAssets(context, upstream);
    page = await context.newPage(); page.setDefaultTimeout(45_000);
    page.on('pageerror', error => { log += `\n[browser] ${error.message}`; });
    await page.goto(`http://127.0.0.1:${port}/?${new URLSearchParams({ tkn: token, folder })}`, { waitUntil: 'commit', timeout: 60_000 });
    const ready = await until(async () => JSON.parse(await readFile(readyFile, 'utf8').catch(() => 'null')), 'Studio extension did not activate', 120_000);
    assert.equal(ready.ready, true, ready.error); assert.equal(ready.language, language);
    for (const [extension, { name }] of originals) {
      const row = page.locator('.explorer-viewlet .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: name }) }).first();
      await row.dblclick();
      const frame = await until(async () => {
        for (const candidate of page.frames()) {
          if (!await candidate.locator('#preview-app').isVisible().catch(() => false)) continue;
          const error = candidate.locator('.preview-status[role=alert]:visible');
          if (await error.count()) throw new Error(`${name}: ${await error.innerText()}`);
          if (await candidate.locator('#preview-app').getAttribute('data-name') === name) return candidate;
        }
      }, `${name}: preview did not load`);
      const kind = extension === 'tex' ? 'latex' : extension === 'heic' ? 'image' : extension;
      assert.equal(await frame.locator('#preview-app').getAttribute('data-kind'), kind);
      assert.equal(await frame.locator('.preview-readonly').innerText(), language === 'en' ? 'Read-only' : '只读');
      assert.equal(await frame.locator('#preview-content [contenteditable=true]').count(), 0);
      if (extension === 'pdf') {
        await painted(frame.locator('.preview-page canvas').first());
        await frame.locator('.textLayer span').first().waitFor();
        assert.ok((await frame.locator('.textLayer').allTextContents()).join('').trim());
      } else if (extension === 'pptx') {
        await painted(frame.locator('.preview-slide canvas'));
      } else if (extension === 'docx') {
        const content = frame.frameLocator('.preview-frame').locator('section.docx').first();
        await content.waitFor(); assert.ok((await content.innerText()).trim());
      } else if (extension === 'xlsx') {
        await frame.locator('[data-cell]').first().waitFor();
        assert.ok((await frame.locator('[data-cell]').allTextContents()).join('').trim());
      } else if (extension === 'tex') {
        await frame.locator('.formula .katex').first().waitFor();
      } else {
        assert.ok(await frame.locator('.preview-image img').evaluate(image => image.naturalWidth > 0 && image.naturalHeight > 0));
      }
      const generation = Number(await frame.locator('#preview-app').getAttribute('data-generation'));
      await frame.locator('.preview-toolbar button').last().click();
      await frame.waitForFunction(previous => Number(document.querySelector('#preview-app').dataset.generation) > previous, generation);
      await frame.locator('.preview-status[role=alert]').waitFor({ state: 'hidden' });
      const screenshot = `${language}-${extension}.png`;
      await frame.locator('#preview-app').screenshot({ path: path.join(proofDir, screenshot) });
      proof.screenshots.push(screenshot); proof.checks.push(`${language}: ${extension} renders through the registered extension and refreshes`);
      console.log(`[OK] ${proof.checks.at(-1)}`);
    }
    for await (const filename of glob('server/logs/**/exthost.log', { cwd: directory })) {
      assert.doesNotMatch(await readFile(path.join(directory, filename), 'utf8'), /Could not identify extension for 'vscode' require call.*studio-workstation|No bundle location found for extension studio.studio-workstation/);
    }
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(proofDir, `${language}-failed.png`) }).catch(() => {});
    console.error(log.slice(-6000)); throw error;
  } finally {
    await writeFile(path.join(proofDir, `${language}.log`), log);
    await browser?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      const stopped = await Promise.race([exited.then(() => true), delay(10_000, false, { ref: false })]);
      if (!stopped) {
        try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        await exited;
      }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
for (const { name, hash } of originals.values()) assert.equal(createHash('sha256').update(await readFile(path.join(source, name))).digest('hex'), hash);
await writeFile(path.join(proofDir, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
