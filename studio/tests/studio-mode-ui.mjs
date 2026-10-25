import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { ROOT, assertRuntime, assertUpstream, exists } from '../scripts/distribution.mjs';

await assertRuntime();
const upstream = await assertUpstream();
const sourceRoot = path.resolve(process.env.STUDIO_STEAMHARNESS_SOURCE ?? path.join(ROOT, '..'));
const proof = path.resolve(ROOT, process.env.STEAMHARNESS_UI_PROOF ?? '.studio/studio-mode-ui');
await mkdir(proof, { recursive: true });
const checks = [], errors = [];
const check = message => { checks.push(message); console.log(`[OK] ${message}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function useCachedLanguagePack(directory, language) {
  if (language === 'en' || !process.env.STEAMHARNESS_UI_LANGUAGE_PACK) { return; }
  const location = await realpath(process.env.STEAMHARNESS_UI_LANGUAGE_PACK);
  const contents = await readFile(path.join(location, 'package.json'), 'utf8');
  const manifest = JSON.parse(contents);
  const localization = manifest.contributes?.localizations?.find(entry => entry.languageId === language);
  assert.ok(localization, `The cached language pack does not support ${language}`);
  // Seed only this isolated server's normal language-pack cache, using real translations.
  const data = path.join(directory, 'server/data');
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, 'languagepacks.json'), JSON.stringify({ [language]: {
    hash: createHash('sha256').update(contents).digest('hex'), label: localization.localizedLanguageName,
    extensions: [{ extensionIdentifier: { id: `${manifest.publisher}.${manifest.name}` }, version: manifest.version }],
    translations: Object.fromEntries(localization.translations.map(entry => [entry.id, path.resolve(location, entry.path)])),
  } }));
}
async function until(read, accept, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) { return value; } await pause(100); }
  throw new Error(message);
}

for (const language of process.env.STEAMHARNESS_UI_LANGUAGES?.split(',') ?? ['en', 'zh-cn']) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-mode-ui-')));
  const folder = path.join(directory, 'workspace'), extension = path.join(directory, 'extensions/mode-test');
  const readyFile = path.join(directory, 'ready.json'), token = randomBytes(24).toString('hex');
  let child, browser, page, log = '';
  const consoleMessages = [];
  try {
    await mkdir(folder); await mkdir(extension, { recursive: true }); await mkdir(path.join(folder, '.vscode'));
    await writeFile(path.join(folder, '.vscode/settings.json'), JSON.stringify({ 'editor.editContext': false,
      'window.autoDetectColorScheme': false, 'workbench.startupEditor': 'none', 'files.autoSave': 'off', 'git.enabled': false }));
    await writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'mode-test', publisher: 'studio-test', version: '0.0.1',
      engines: { vscode: '^1.140.0' }, main: './extension.cjs', extensionKind: ['workspace'], activationEvents: ['onStartupFinished'] }));
    await build({ entryPoints: [path.join(ROOT, 'tests/start-page-ui-extension.mjs')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(extension, 'extension.cjs') });
    let workstation;
    if (process.env.STEAMHARNESS_UI_FOCUS === 'new-tool-content') {
      // Use the actual extension and CLI, with a deterministic offline executor
      // installed only in this isolated workbench's Assistant template.
      workstation = path.join(directory, 'extensions/studio-workstation');
      await mkdir(workstation);
      for (const name of ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'l10n', 'dist']) {
        await cp(path.join(ROOT, 'extensions/studio-workstation', name), path.join(workstation, name), { recursive: true });
      }
      // VS Code gives a built-in copy precedence when versions are equal.
      const metadata = JSON.parse(await readFile(path.join(workstation, 'package.json'), 'utf8'));
      const version = metadata.version.split('.'); version[2] = String(Number(version[2]) + 1); metadata.version = version.join('.');
      await writeFile(path.join(workstation, 'package.json'), JSON.stringify(metadata));
      const template = path.join(workstation, 'dist/developer-assistant');
      await rm(template, { recursive: true, force: true }); await mkdir(template);
      await writeFile(path.join(template, 'package.json'), JSON.stringify({ id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', name: 'Offline Assistant', type: 'module',
        steamHarness: { projectInfo: { dataStorage: { mode: 'local' } } } }));
      await copyFile(path.join(ROOT, 'tests/fixtures/assistant-new-tab/index.ts'), path.join(template, 'index.ts'));
    }
    await useCachedLanguagePack(directory, language);
    child = spawn(process.execPath, [path.join(upstream.directory, 'scripts/code-server.js'), '--host', '127.0.0.1', '--port', '0',
      '--connection-token', token, '--server-data-dir', path.join(directory, 'server'), '--extensions-dir', path.join(directory, 'extensions'),
      '--builtin-extensions-dir', path.join(upstream.directory, 'extensions'), '--disable-workspace-trust', '--force-disable-user-env',
      '--telemetry-level', 'off', '--default-folder', folder], { cwd: upstream.directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_ENV: 'development', VSCODE_DEV: '1', STUDIO_STEAMHARNESS_SOURCE: sourceRoot,
      STEAMHARNESS_CLI_AUTH_DIR: path.join(directory, 'auth'), STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '',
      STUDIO_START_TEST_READY: readyFile, STUDIO_START_TEST_TOKEN: token,
      VSCODE_SKIP_BUILTIN_EXTENSIONS: 'vscode.vscode-api-tests,GitHub.copilot,GitHub.copilot-chat' } });
    for (const stream of [child.stdout, child.stderr]) { stream.on('data', chunk => { log += chunk.toString().replaceAll(token, '[redacted]'); }); }
    const address = await until(() => log, value => /Web UI available at http:\/\/[^:/\s]+:(\d+)/.test(value) || /Extension host agent listening on (\d+)/.test(value), 'Studio server startup timed out');
    const port = /Web UI available at http:\/\/[^:/\s]+:(\d+)/.exec(address)?.[1] ?? /Extension host agent listening on (\d+)/.exec(address)?.[1];
    const executablePath = process.env.STEAMHARNESS_UI_BROWSER_PATH;
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome' }),
      headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: language === 'en' ? 'en-US' : 'zh-CN' });
    await context.addCookies([{ name: 'vscode.nls.locale', value: language, domain: '127.0.0.1', path: '/' }]);
    await context.addInitScript(language => { globalThis._VSCODE_NLS_LANGUAGE = language; }, language);
    await context.addInitScript(() => {
      if (location.pathname.endsWith('/webview/browser/pre/index.html')) {
        const url = new URL(location.href);
        url.searchParams.set('disableServiceWorker', 'true');
        history.replaceState(null, '', url);
      }
    });
    await context.route(/https:\/\/[^/]+\.vscode-cdn\.net\/.*\/webview\/browser\/pre\/(?:index\.html|fake\.html|service-worker\.js)(?:\?|$)/, async route => {
      const filename = path.posix.basename(new URL(route.request().url()).pathname);
      await route.fulfill({ path: path.join(upstream.directory, 'out/vs/workbench/contrib/webview/browser/pre', filename), contentType: filename.endsWith('.js') ? 'application/javascript' : 'text/html' });
    });
    // Serve the real extension assets alongside the local source webview bootstrap.
    // The isolated browser must not depend on the remote CDN's resource worker.
    await context.route(/https:\/\/[^/]+\.vscode-resource\.vscode-cdn\.net\/.*\/extensions\/studio-workstation\/dist\//, async route => {
      const relative = decodeURIComponent(new URL(route.request().url()).pathname.split('/extensions/studio-workstation/dist/')[1]);
      const assets = path.join(ROOT, 'extensions/studio-workstation/dist'), filename = path.resolve(assets, relative);
      assert.ok(filename.startsWith(assets + path.sep));
      await route.fulfill({ path: filename, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await context.route(/https:\/\/[^/]+\.vscode-resource\.vscode-cdn\.net\/.*\/extensions\/simple-browser\/media\//, async route => {
      const relative = decodeURIComponent(new URL(route.request().url()).pathname.split('/extensions/simple-browser/media/')[1]);
      const assets = path.join(upstream.directory, 'extensions/simple-browser/media'), filename = path.resolve(assets, relative);
      assert.ok(filename.startsWith(assets + path.sep));
      await route.fulfill({ path: filename, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    page = await context.newPage();
    page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
    page.on('pageerror', error => errors.push(`${language}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') { consoleMessages.push(message.text()); } });
    page.on('requestfailed', request => { consoleMessages.push(`${request.failure()?.errorText}: ${request.url()}`); });
    await page.goto(`http://127.0.0.1:${port}/?tkn=${token}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const readReady = async () => await exists(readyFile) ? JSON.parse(await readFile(readyFile, 'utf8')) : {};
    let bridge = await until(readReady, value => value.port || value.error, 'Studio extension startup timed out', 120_000);
    assert.equal(bridge.error, undefined, bridge.error);
    const call = async input => {
      const response = await fetch(`http://127.0.0.1:${bridge.port}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(90_000) });
      const body = await response.json(); assert.equal(response.status, 200, body.error); return body.result;
    };
    const command = (command, ...args) => call({ action: 'command', command, args });
    assert.equal((await call({ action: 'state' })).language, language);
    if (workstation) { assert.equal((await call({ action: 'state' })).extensionPath, workstation); }
    const steam = page.locator('.studio-mode-toggle');
    await steam.waitFor(); assert.equal(await steam.isDisabled(), true);
    await command('studio.enterSteamMode'); assert.equal(await page.locator('.studio-steam-mode').count(), 0);
    check(`${language}: ordinary folder stays in IDE mode`);

    if (language === 'en') {
      const geometry = await page.locator('.studio-mode-switcher').evaluate(switcher => {
        const shell = document.createElement('div'); shell.className = 'monaco-workbench mac';
        shell.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:35px;';
        shell.innerHTML = '<div class="part titlebar"><div class="titlebar-container"><div class="titlebar-left"></div></div></div>';
        const titlebar = shell.querySelector('.titlebar-container');
        const left = shell.querySelector('.titlebar-left'); const slot = document.createElement('div'); slot.className = 'studio-mode-slot'; left.append(slot);
        document.body.append(shell);
        const measurements = [];
        for (const zoom of [1, 1.5, .8]) {
          // Match Electron's zoomed content while its native window controls remain unscaled.
          shell.style.zoom = String(zoom); shell.style.setProperty('--zoom-factor', String(zoom));
          titlebar.classList.toggle('counter-zoom', zoom < 1);
          const rect = left.querySelector('.studio-mode-slot').getBoundingClientRect();
          measurements.push(rect.left - left.getBoundingClientRect().left);
        }
        shell.style.zoom = '1'; shell.classList.add('fullscreen'); titlebar.classList.remove('counter-zoom');
        const fullscreen = left.querySelector('.studio-mode-slot').getBoundingClientRect().left - left.getBoundingClientRect().left;
        shell.remove(); return { measurements, fullscreen };
      });
      assert.ok(geometry.measurements.every(inset => inset >= 70), JSON.stringify(geometry));
      assert.ok(geometry.fullscreen < 16);
      check('macOS: mode controls clear native window buttons at different zoom levels and reclaim the space in fullscreen');
    }

    const project = path.join(folder, 'conversation'); await mkdir(project);
    await mkdir(path.join(project, 'node_modules/@steamharness'), { recursive: true });
    await symlink(path.join(sourceRoot, 'harness'), path.join(project, 'node_modules/steamharness'), 'dir');
    await symlink(path.join(sourceRoot, 'cli'), path.join(project, 'node_modules/@steamharness/cli'), 'dir');
    await copyFile(path.join(ROOT, 'examples/conversation/index.ts'), path.join(project, 'index.ts'));
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'examples/conversation/package.json'), 'utf8'));
    manifest.devDependencies = {
      steamharness: JSON.parse(await readFile(path.join(sourceRoot, 'harness/package.json'), 'utf8')).version,
      '@steamharness/cli': JSON.parse(await readFile(path.join(sourceRoot, 'cli/package.json'), 'utf8')).version,
    };
    await writeFile(path.join(project, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(project, 'configuration.json'), JSON.stringify({ version: 1,
      fields: Array.from({ length: 17 }, (_, index) => ({ name: `field_${index}`, type: 'string',
        description: 'A project configuration field used to verify scrolling in a short window.', defaultValue: `Value ${index}` })),
    }));
    await command('studio.refreshProjectView');
    await until(() => steam.isEnabled(), Boolean, 'Project mode did not become available');
    const documentUri = await call({ action: 'untitled', text: 'Preserve this unsaved document during mode switches.' });
    const partState = () => page.evaluate(() => Object.fromEntries(['activitybar', 'sidebar', 'panel', 'auxiliarybar', 'titlebar', 'statusbar'].map(part => {
      const element = document.querySelector(`.part.${part}`), rect = element?.getBoundingClientRect();
      return [part, { visible: !!rect?.width && !!rect?.height && getComputedStyle(element).display !== 'none', width: rect?.width }];
    })));
    const before = await partState();
    const layoutButtons = page.locator('.titlebar-right .action-toolbar-container :is([class*="codicon-panel-"], [class*="codicon-auxiliarybar-"][class*="layout-icon"], .codicon-configure-layout-icon)');
    const ideLayoutButtons = await layoutButtons.count(); assert.ok(ideLayoutButtons > 0);

    if (process.env.STEAMHARNESS_UI_FOCUS === 'panel-state') {
      const roundTrip = async name => {
        const initial = await partState();
        const panel = await page.locator('.part.panel').boundingBox();
        const terminals = (await call({ action: 'state' })).terminals;
        await command('studio.enterSteamMode');
        await until(() => page.locator('.studio-mode-switcher').getAttribute('aria-busy'), value => value === 'false', 'Steam mode did not finish');
        assert.equal((await partState()).panel.visible, false);
        await command('studio.enterIdeMode');
        await until(() => page.locator('.studio-mode-switcher').getAttribute('aria-busy'), value => value === 'false', 'IDE mode did not finish');
        await pause(300);
        const restored = await partState();
        assert.deepEqual(Object.values(restored).map(part => part.visible), Object.values(initial).map(part => part.visible), `${language}: ${name} must restore the original IDE parts`);
        if (initial.panel.visible) {
          assert.ok(Math.abs((await page.locator('.part.panel').boundingBox()).height - panel.height) <= 1, `${name} must restore the original panel height`);
        }
        assert.deepEqual((await call({ action: 'state' })).terminals, terminals, 'Switching modes must retain terminal sessions');
        check(`${language}: ${name} preserves IDE panel visibility and terminal sessions`);
      };
      await command('workbench.action.terminal.killAll');
      await command('workbench.action.closePanel');
      await roundTrip('closed panel without terminals');
      await command('workbench.action.terminal.new');
      await page.locator('.part.panel .integrated-terminal').waitFor();
      await until(() => call({ action: 'state' }), state => state.terminals.length === 1 && !!state.terminals[0], 'The terminal did not finish starting');
      await command('workbench.action.closePanel');
      await roundTrip('closed panel with an existing terminal');
      await roundTrip('repeated round trip with a closed terminal panel');
      await command('workbench.action.terminal.focus');
      await page.locator('.part.panel .integrated-terminal').waitFor();
      await roundTrip('open terminal panel');
      await command('workbench.action.toggleMaximizedPanel');
      await roundTrip('maximized terminal panel');
      continue;
    }

    // Hold the real result iframe so startup and cancellation cannot pass on an already loaded page.
    let releaseFrame, frameHeld = false;
    const frameGate = new Promise(resolve => { releaseFrame = resolve; });
    const frameRoute = url => url.searchParams.has('projectLocale');
    const projectNames = new Set([manifest.name, ...Object.values(manifest.steamHarness.projectInfo.localizedNames)]);
    await context.route(frameRoute, async route => {
      const title = await route.request().frame().parentFrame()?.locator('#workflow-frame').getAttribute('title').catch(() => undefined);
      if (!frameHeld && projectNames.has(title)) { frameHeld = true; await frameGate; }
      await route.continue();
    });
    try {
      await steam.click();
      await page.locator('.studio-mode-loading').waitFor();
      assert.equal(await page.locator('.studio-mode-loading').innerText(), language === 'en' ? 'Loading project...' : '正在加载项目…');
      await until(() => frameHeld, Boolean, 'The project iframe was not requested', 90_000);
      const loadingBounds = await page.locator('.studio-mode-loading').boundingBox();
      const editorBounds = await page.locator('.part.editor:not(.studio-steam-editors)').boundingBox();
      for (const axis of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(loadingBounds[axis] - editorBounds[axis]) <= 1,
          `Loading overlay must follow the settled editor layout: ${JSON.stringify({ loadingBounds, editorBounds })}`);
      }
      assert.equal(await page.locator('.studio-mode-switcher').getAttribute('aria-busy'), 'true');
      assert.equal(await page.locator('html.studio-mode-transition').count(), 0);
      await page.screenshot({ path: path.join(proof, `${language}-loading.png`) });
      await page.locator('.studio-mode-toggle').click();
      await until(() => page.locator('.studio-mode-switcher').getAttribute('aria-busy'), value => value === 'false', 'IDE waited for the blocked project iframe');
      assert.equal(await steam.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('.studio-mode-loading').isVisible(), false);
      assert.equal((await call({ action: 'state' })).active, documentUri);
    } finally {
      releaseFrame(); await context.unroute(frameRoute);
    }
    check(`${language}: slow frame loading stays visible and returning to IDE cancels the wait`);

    await page.evaluate(() => {
      window.studioModeTransitions = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (Array.isArray(frames) && frames.length === 2 && options?.fill === 'both') {
          window.studioModeTransitions.push({ frames, part: this.className, duration: options.duration });
        }
        return animate.call(this, frames, options);
      };
    });
    await steam.click(); await page.locator('.studio-steam-tools').waitFor({ timeout: 90_000 });
    await until(() => page.locator('.studio-mode-switcher').getAttribute('aria-busy'), value => value === 'false', 'Steam mode switch did not finish');
    assert.equal(await page.locator('.studio-steam-tool').count(), 10);
    const during = await partState();
    assert.equal(during.activitybar.visible, false); assert.equal(during.sidebar.visible, false); assert.equal(during.panel.visible, false);
    assert.equal(during.auxiliarybar.visible, true);
    assert.equal(during.titlebar.visible, false); assert.equal(during.statusbar.visible, false);
    assert.equal(await layoutButtons.count(), 0);
    const toggleTools = page.locator('.studio-steam-toggle-tools');
    await toggleTools.waitFor();
    assert.equal(await toggleTools.getAttribute('aria-label'), language === 'en' ? 'Hide Tools' : '隐藏工具区');
    assert.equal(await toggleTools.getAttribute('aria-expanded'), 'true');
    const trailingControl = await toggleTools.evaluate(toggle => {
      const rect = toggle.getBoundingClientRect();
      const siblings = [...toggle.parentElement.children].filter(element => element !== toggle && !element.classList.contains('window-controls-container'));
      return siblings.every(element => !element.getBoundingClientRect().width || element.getBoundingClientRect().right <= rect.left + 1);
    });
    assert.equal(trailingControl, true, 'Tool visibility control must follow the other titlebar actions');
    assert.equal(await page.locator('.titlebar-right .action-toolbar-container :is(.codicon-close, .codicon-split-editor, .codicon-split-editor-vertical)').count(), 0);
    check(`${language}: Steam keeps only the trailing tools visibility control and removes other layout and runtime editor actions`);
    const geometry = await page.locator('.part.editor:not(.studio-steam-editors)').boundingBox(), toolsGeometry = await page.locator('.part.auxiliarybar').boundingBox();
    assert.ok(geometry.x < toolsGeometry.x && geometry.x + geometry.width <= toolsGeometry.x + 2);
    for (const rect of [geometry, toolsGeometry]) {
      assert.ok(rect.y <= 1 && Math.abs(rect.height - 960) <= 1, JSON.stringify(rect));
    }
    check(`${language}: Steam fills the window with project results and tools and removes the title and status bars`);
    const toolsWidth = async () => (await partState()).auxiliarybar.width;
    const assertToolsWidth = expected => until(toolsWidth, width => Math.abs(width - expected) < 2, `Expected tools width ${expected}`);
    const resizeTools = async width => {
      const bounds = await page.locator('.part.auxiliarybar').boundingBox();
      const sashes = page.locator('.monaco-workbench > .monaco-grid-view .monaco-sash.vertical');
      const index = await sashes.evaluateAll((elements, bounds) => elements.findIndex(element => {
        const rect = element.getBoundingClientRect();
        return !element.classList.contains('disabled') && rect.height > bounds.height / 2 && Math.abs(rect.x + rect.width / 2 - bounds.x) < 4;
      }), bounds);
      assert.ok(index >= 0, 'The outer tools divider must be draggable');
      const sash = await sashes.nth(index).boundingBox();
      await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - width, sash.y + sash.height / 2, { steps: 12 });
      await page.mouse.up();
      return assertToolsWidth(width);
    };
    for (const width of [1440, 1200, 1800, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await assertToolsWidth(Math.round(width / 3));
    }
    check(`${language}: tools initially use one third of the window and follow window resizing before a manual adjustment`);
    assert.equal(await page.locator('.studio-steam-empty-tabs, .studio-steam-tools-action').count(), 0);
    const cleanHeader = await page.locator('.part.auxiliarybar > .title').evaluate(title => {
      const add = title.querySelector('.studio-steam-add-tab'), list = title.querySelector('.studio-steam-tab-list');
      return { addAfter: list.nextElementSibling === add, drag: getComputedStyle(title).getPropertyValue('-webkit-app-region'),
        addDrag: getComputedStyle(add).getPropertyValue('-webkit-app-region'), controls: title.querySelectorAll('.studio-steam-tools-chrome button').length };
    });
    assert.deepEqual(cleanHeader, { addAfter: true, drag: 'drag', addDrag: 'no-drag', controls: 1 });
    check(`${language}: New follows the tool tab list and the visibility toggle stays on the right`);

    const frame = await until(async () => {
      for (const frame of page.frames()) {
        if (await frame.locator('#message').isVisible().catch(() => false)
          && await frame.locator('#app').getAttribute('data-project-uri').catch(() => undefined) === pathToFileURL(project).href) { return frame; }
      }
    }, Boolean, 'Project result frame did not open');
    await frame.locator('#app[data-studio-window-chrome]').waitFor();
    const assertDragRegions = async () => {
      await until(() => page.locator('.studio-project-drag-region').count(), count => count > 0, 'Project header drag regions did not reach the native renderer');
      const offset = await (await frame.frameElement()).boundingBox();
      const excluded = await frame.locator('.toolbar :is(button, .project-heading, h1, .project-name, .running-count, .studio-window-controls-slot)').evaluateAll(elements => elements
        .map(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })
        .filter(rect => rect.width > 0 && rect.height > 0));
      await until(() => page.locator('.studio-project-drag-region').evaluateAll(elements => elements.map(element => {
        const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
      })), regions => regions.length > 0 && regions.every(region => excluded.every(control =>
        region.x + region.width <= offset.x + control.x + .5 || region.x >= offset.x + control.x + control.width - .5
        || region.y + region.height <= offset.y + control.y + .5 || region.y >= offset.y + control.y + control.height - .5)),
      'Native project drag regions covered an interactive control or selectable title');
    };
    const assertChromeSlot = async parent => {
      await until(() => frame.locator('.studio-window-controls-slot').evaluate((slot, parent) => slot.parentElement.matches(parent), parent), Boolean, `Native controls slot did not move to ${parent}`);
      const slot = await frame.locator('.studio-window-controls-slot').boundingBox();
      const controls = await page.locator('.studio-steam-window-chrome').boundingBox();
      assert.ok(Math.abs(slot.x - controls.x) <= 1 && Math.abs(slot.y - controls.y) <= 1 && slot.width >= controls.width - 1, JSON.stringify({ slot, controls }));
      await assertDragRegions();
    };
    if (await frame.locator('#hide-menu').isVisible()) { await frame.locator('#hide-menu').click(); }
    await assertChromeSlot('.project-title');
    await page.screenshot({ path: path.join(proof, `${language}-steam-title-chrome.png`) });
    await frame.locator('#menu-toggle').click();
    await assertChromeSlot('#project-menu');
    await page.screenshot({ path: path.join(proof, `${language}-steam-menu-chrome.png`) });
    await frame.locator('#hide-menu').click();
    await assertChromeSlot('.project-title');
    check(`${language}: native mode controls integrate with the project menu or title and stay clear in narrow layouts`);
    if (process.env.STEAMHARNESS_UI_FOCUS === 'native-tabs') {
      const native = tool => page.locator(`.studio-steam-editors[data-tool="${tool}"]:visible`);
      const visibleTool = selector => until(async () => {
        for (const candidate of page.frames()) {
          if (!await candidate.locator(selector).isVisible().catch(() => false)) { continue; }
          let current = candidate, visible = true;
          while (current.parentFrame()) {
            if (!await (await current.frameElement()).isVisible()) { visible = false; break; }
            current = current.parentFrame();
          }
          if (visible) { return candidate; }
        }
      }, Boolean, `Native tool did not become visible: ${selector}`);
      const contextMenu = async target => {
        await target.click({ button: 'right' });
        const menu = page.locator('.context-view .monaco-menu');
        await menu.waitFor(); await page.waitForTimeout(180);
        return menu;
      };
      const firstFile = path.join(project, 'first.ts'), secondFile = path.join(project, 'second.ts');
      await writeFile(firstFile, 'export const first = 1;\n'); await writeFile(secondFile, 'export const second = 2;\n');
      await call({ action: 'file', path: firstFile, column: 1, preview: false });
      await call({ action: 'file', path: secondFile, column: 1, preview: false });
      await native('editor').locator('.tab').filter({ hasText: 'second.ts' }).waitFor();
      assert.equal(await page.locator('.studio-steam-instances').count(), 0);
      assert.ok(await native('editor').locator('.tabs-container .tab').count() >= 2);
      await writeFile(path.join(proof, `${language}-native-state.json`), JSON.stringify({ state: await call({ action: 'state' }), tabs: await native('editor').locator('.tab').allTextContents() }, null, 2));
      const firstTab = native('editor').locator('.tab').filter({ hasText: 'first.ts' });
      const secondTab = native('editor').locator('.tab').filter({ hasText: 'second.ts' });
      const menu = await contextMenu(firstTab);
      const items = await menu.innerText();
      // Source builds keep native VS Code NLS in English. Studio menu labels still follow the host locale.
      const coreLabel = (english, chinese) => items.includes('Close Others') ? english : chinese;
      assert.ok(items.includes(coreLabel('Close Others', '关闭其他')), items);
      assert.ok(items.includes(coreLabel('Copy Path', '复制路径')), items);
      assert.ok(!items.includes('Secondary Side Bar'), items);
      await page.screenshot({ path: path.join(proof, `${language}-native-editor-menu.png`) });
      await menu.getByText(coreLabel('Close to the Right', '关闭右侧标签页'), { exact: true }).click();
      await until(() => secondTab.count(), count => count === 0, 'Native Close Right targeted the wrong file');
      assert.equal(await firstTab.count(), 1);
      await contextMenu(firstTab);
      await menu.getByText(coreLabel('Close Others', '关闭其他'), { exact: true }).click();
      const saveDialog = page.locator('.monaco-dialog-box');
      await saveDialog.waitFor(); await page.keyboard.press('Escape'); await saveDialog.waitFor({ state: 'detached' });
      assert.ok((await call({ action: 'state' })).documents.some(document => document.uri === documentUri && document.dirty));
      await contextMenu(firstTab);
      await menu.getByText(coreLabel('Pin', '固定'), { exact: true }).click();
      await until(() => firstTab.getAttribute('class'), value => value.includes('sticky'), 'Native Pin did not pin the right-clicked file');
      await contextMenu(firstTab);
      await menu.getByText(coreLabel('Unpin', '取消固定'), { exact: true }).click();
      await contextMenu(firstTab);
      await menu.getByText(coreLabel('Split Right', '向右拆分'), { exact: true }).click();
      await until(() => native('editor').locator('.editor-group-container').count(), count => count === 2, 'Native Split Right did not split the tool workspace');
      assert.equal(await firstTab.count(), 2);
      await firstTab.last().locator('.tab-actions .action-label').click();
      await until(() => native('editor').locator('.editor-group-container').count(), count => count === 1, 'The empty native split did not close');
      await call({ action: 'file', path: secondFile, column: 1, preview: true });
      assert.equal(await secondTab.locator('.label-name').evaluate(element => getComputedStyle(element).fontStyle), 'italic');
      await secondTab.dblclick();
      await until(() => secondTab.locator('.label-name').evaluate(element => getComputedStyle(element).fontStyle), value => value !== 'italic', 'Double clicking did not keep the native preview open');
      check(`${language}: native file menu targets the right-clicked tab, honors dirty-close cancellation, pins, splits and keeps previews open`);
      await command('studio.internalOpenSteamTool', 'kv');
      await native('kv').locator('.tab').waitFor();
      const original = await visibleTool('body[data-resource-kind=kv] #resource-search');
      await original.locator('#resource-search').fill('original-query');
      await native('kv').locator('.editor-actions .codicon-add').click();
      await until(() => native('kv').locator('.tab').count(), count => count === 2, 'The KV instances did not share a native tab group');
      const second = await visibleTool('body[data-resource-kind=kv] #resource-search');
      assert.notEqual(second, original);
      assert.equal(await second.locator('#resource-search').inputValue(), '');
      await second.locator('#resource-search').fill('second-query');
      const originalKvTab = native('kv').locator('.tab:not([data-resource-name])');
      await originalKvTab.click();
      assert.equal(await original.locator('#resource-search').inputValue(), 'original-query');
      const kvLabels = await native('kv').locator('.tab').allTextContents();
      assert.equal(kvLabels.some(label => label.includes('first.ts') || label.includes('second.ts')), false);
      await command('studio.internalOpenSteamTool', 'editor');
      assert.equal(await native('editor').locator('.tab').filter({ hasText: 'first.ts' }).count(), 1);
      assert.equal(await native('editor').locator('.tab').filter({ hasText: 'second.ts' }).count(), 1);
      await contextMenu(page.locator('.studio-steam-tab[data-tab="kv"]'));
      const categoryMenu = await menu.innerText();
      for (const label of language === 'en' ? ['Close', 'Close Others', 'Close All'] : ['关闭', '关闭其他', '全部关闭']) { assert.ok(categoryMenu.includes(label), categoryMenu); }
      assert.equal(categoryMenu.includes('Activity Bar'), false);
      await page.screenshot({ path: path.join(proof, `${language}-tool-category-menu.png`) });
      await page.keyboard.press('Escape');
      check(`${language}: tool categories have useful close actions and native instance tabs stay inside their category`);
      await command('studio.internalOpenSteamTool', 'kv');
      for (const [theme, width] of [['Default Light Modern', 1440], ['Default Dark Modern', 1024]]) {
        await call({ action: 'theme', theme }); await page.setViewportSize({ width, height: 760 });
        await original.locator('#resource-search').click({ trial: true });
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(proof, `${language}-native-tool-tabs-${width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 960 });
      await command('studio.enterIdeMode'); await command('studio.enterSteamMode');
      await until(() => native('kv').locator('.tab').count(), count => count === 2, 'Mode switching lost a native tool tab');
      assert.equal(await native('kv').locator('.tab.active').getAttribute('data-resource-name'), null);
      const returnedOriginal = await visibleTool('body[data-resource-kind=kv] #resource-search');
      assert.equal(await returnedOriginal.locator('#resource-search').inputValue(), 'original-query');
      await returnedOriginal.locator('#resource-search').click({ trial: true });
      await native('kv').locator('.tab[data-resource-name]').click();
      assert.equal(await second.locator('#resource-search').inputValue(), 'second-query');
      await rm(readyFile, { force: true }); await call({ action: 'reload' });
      bridge = await until(readReady, value => value.port || value.error, 'Reloaded test bridge did not start', 120_000);
      assert.equal(bridge.error, undefined);
      await until(() => native('kv').locator('.tab').count(), count => count === 2, 'Reload lost a native tool tab', 120_000);
      const restoredSecond = await visibleTool('body[data-resource-kind=kv] #resource-search');
      assert.equal(await restoredSecond.locator('#resource-search').inputValue(), 'second-query');
      await originalKvTab.click();
      const restoredOriginal = await visibleTool('body[data-resource-kind=kv] #resource-search');
      assert.equal(await restoredOriginal.locator('#resource-search').inputValue(), 'original-query');
      check(`${language}: native tools preserve independent queries and selection across themes, narrow windows, IDE round trips and reload`);
      await command('studio.internalOpenSteamTool', 'knowledge');
      await visibleTool('body[data-resource-kind=knowledge] #resource-search');
      await contextMenu(page.locator('.studio-steam-tab[data-tab=knowledge]'));
      await menu.getByText(language === 'en' ? 'Close' : '关闭', { exact: true }).click();
      await until(() => page.locator('.studio-steam-tab[data-tab=knowledge]').count(), count => count === 0, 'Category Close did not remove its tool');
      await contextMenu(page.locator('.studio-steam-tab[data-tab=kv]'));
      await menu.getByText(language === 'en' ? 'Close Others' : '关闭其他', { exact: true }).click();
      await saveDialog.waitFor(); await page.keyboard.press('Escape'); await saveDialog.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.studio-steam-tab[data-tab=editor]').count(), 1);
      assert.equal(await page.locator('.studio-steam-tab[data-tab=kv]').count(), 1);
      check(`${language}: category Close executes and Close Others stops on a native unsaved-file cancellation`);
      await contextMenu(page.locator('.studio-steam-tab[data-tab=editor]'));
      await menu.getByText(language === 'en' ? 'Close' : '关闭', { exact: true }).click();
      await saveDialog.waitFor();
      await saveDialog.getByRole('button', { name: coreLabel("Don't Save", '不保存'), exact: true }).click();
      await until(() => page.locator('.studio-steam-tab[data-tab=editor]').count(), count => count === 0, 'Discarding the temporary dirty document did not close its category');
      await command('studio.internalOpenSteamTool', 'knowledge');
      await contextMenu(page.locator('.studio-steam-tab[data-tab=kv]'));
      await menu.getByText(language === 'en' ? 'Close Others' : '关闭其他', { exact: true }).click();
      await until(() => page.locator('.studio-steam-tab').count(), count => count === 1, 'Category Close Others did not leave only the clicked tool');
      await contextMenu(page.locator('.studio-steam-tab[data-tab=kv]'));
      await menu.getByText(language === 'en' ? 'Close All' : '全部关闭', { exact: true }).click();
      await until(() => page.locator('.studio-steam-tab').count(), count => count === 0, 'Category Close All did not remove every tool');
      await page.locator('.studio-steam-tools h2').waitFor();
      await command('studio.internalOpenSteamTool', 'knowledge');
      await visibleTool('body[data-resource-kind=knowledge] #resource-search');
      await native('knowledge').locator('.tab-actions .action-label').click();
      await page.locator('.studio-steam-tools h2').waitFor();
      assert.equal(await page.locator('.studio-steam-tab').count(), 0);
      check(`${language}: all category close actions execute, and closing the final native child returns to Open Tools`);
      continue;
    }
    if (process.env.STEAMHARNESS_UI_FOCUS === 'native-runtime') {
      const native = tool => page.locator(`.studio-steam-editors[data-tool="${tool}"]:visible`);
      await command('studio.enterIdeMode');
      await command('workbench.action.terminal.killAll');
      await until(async () => (await call({ action: 'state' })).terminals.length, count => count === 0, 'The shell regression must start without existing terminals');
      await command('workbench.action.terminal.new');
      await page.locator('.part.panel .integrated-terminal').waitFor();
      await call({ action: 'terminalInput', text: `export STEAMHARNESS_MODE_TEST='native-${language}'` });
      await command('studio.enterSteamMode'); await command('studio.internalOpenSteamTool', 'terminal');
      await native('terminal').locator('.terminal-editor').waitFor();
      await until(() => native('terminal').locator('.tab').count(), count => count === 1, 'The panel terminal did not become a native tool tab');
      await native('terminal').locator('.editor-actions .codicon-plus').click();
      await until(() => native('terminal').locator('.tab').count(), count => count === 2, 'The native terminal add button did not create a new session');
      await native('terminal').locator('.tab.active .tab-actions .action-label').click();
      await until(() => native('terminal').locator('.tab').count(), count => count === 1, 'Closing a terminal child did not end its session');
      await command('studio.internalCloseSteamTab', 'terminal');
      await until(() => page.locator('.studio-steam-tab[data-tab=terminal]').count(), count => count === 0, 'The terminal category reopened during close');
      await page.waitForTimeout(150);
      assert.equal(await page.locator('.studio-steam-tab[data-tab=terminal]').count(), 0);
      await command('workbench.action.terminal.focus');
      await native('terminal').locator('.terminal-editor').waitFor();
      await command('studio.enterIdeMode'); await command('workbench.action.terminal.focus');
      await page.locator('.part.panel .integrated-terminal').waitFor();
      const terminalProbe = path.join(directory, 'native-terminal.txt');
      const quotedProbe = `'${terminalProbe.replaceAll("'", "'\\''")}'`;
      await call({ action: 'terminalInput', text: `printf '%s' "$STEAMHARNESS_MODE_TEST" > ${quotedProbe}` });
      await until(async () => await exists(terminalProbe) ? readFile(terminalProbe, 'utf8') : undefined, value => value === `native-${language}`, 'Native tool tabs lost the existing shell session');
      await command('workbench.action.terminal.killAll');
      check(`${language}: native terminal children create and end sessions while category close and IDE round trips retain the original shell`);
      await command('studio.enterSteamMode');
      const browserUrl = 'https://steam-browser.example.test/';
      await context.route(url => url.origin === new URL(browserUrl).origin, route => route.fulfill({ contentType: 'text/html', body: '<input id="browser-tool-probe" value="Browser tool">' }));
      const browserFrame = () => until(async () => {
        for (const candidate of page.frames()) {
          if (!await candidate.locator('#browser-tool-probe').isVisible().catch(() => false)) { continue; }
          let current = candidate, visible = true;
          while (current.parentFrame()) {
            if (!await (await current.frameElement()).isVisible()) { visible = false; break; }
            current = current.parentFrame();
          }
          if (visible) { return candidate; }
        }
      }, Boolean, 'The browser tool did not load its page');
      const openingBrowser = command('studio.internalOpenSteamTool', 'browser');
      const urlPicker = page.locator('.quick-input-widget input'); await urlPicker.fill(browserUrl); await urlPicker.press('Enter');
      await openingBrowser;
      const first = await browserFrame(); await first.locator('#browser-tool-probe').fill('First browser state');
      await native('browser').locator('.editor-actions .codicon-add').click();
      await urlPicker.fill(`${browserUrl}second`); await urlPicker.press('Enter');
      await until(() => native('browser').locator('.tab').count(), count => count === 2, 'The browser add button reused its existing page');
      const second = await browserFrame(); assert.notEqual(first, second);
      await second.locator('#browser-tool-probe').fill('Second browser state');
      await native('browser').locator('.tab').first().click();
      assert.equal(await first.locator('#browser-tool-probe').inputValue(), 'First browser state');
      await native('browser').locator('.tab').last().click();
      assert.equal(await second.locator('#browser-tool-probe').inputValue(), 'Second browser state');
      await native('browser').locator('.tab.active .tab-actions .action-label').click();
      await first.locator('#browser-tool-probe').click({ trial: true });
      assert.equal(await native('browser').locator('.tab').count(), 1);
      check(`${language}: native browser tabs create independent pages, retain input and close independently`);
      continue;
    }
    if (process.env.STEAMHARNESS_UI_FOCUS === 'mode-motion') {
      await frame.locator('#message').fill(`Retain this draft ${language}`);
      await page.evaluate(() => {
        const button = document.querySelector('.studio-mode-toggle'), parent = button.parentElement.parentElement;
        window.modeControlSamples = [];
        window.monitorModeControl = true;
        const sample = () => {
          window.modeControlSamples.push({ visible: button.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
            same: button === document.querySelector('.studio-mode-toggle') && parent === button.parentElement.parentElement });
          if (window.monitorModeControl) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const assertControl = async active => {
        assert.equal(await page.locator('.studio-mode-changing-layout').count(), 0, 'A finished switch must release its layout mask');
        assert.equal(await steam.getAttribute('aria-pressed'), String(active));
        assert.equal(await steam.getAttribute('aria-label'), language === 'en'
          ? active ? 'Switch to IDE Mode' : 'Switch to Steam Mode'
          : active ? '切换到 IDE 模式' : '切换到 Steam 模式');
        const geometry = await page.locator('.studio-mode-switcher').evaluate(element => {
          const rect = element.getBoundingClientRect(), thumb = element.querySelector('.studio-mode-thumb').getBoundingClientRect();
          return { width: rect.width, left: rect.left, right: rect.right, thumb: thumb.left - rect.left };
        });
        assert.ok(geometry.width < 110 && geometry.left >= 0 && geometry.right <= 800, JSON.stringify(geometry));
        assert.ok(active ? geometry.thumb > 40 : geometry.thumb < 8, JSON.stringify(geometry));
      };
      for (const theme of ['Default Dark Modern', 'Default Light Modern']) {
        assert.equal(await call({ action: 'theme', theme }), theme);
        await page.locator(`.monaco-workbench.${theme.includes('Dark') ? 'vs-dark' : 'vs'}`).waitFor();
        for (const active of [false, true, false, true]) {
          await steam.click();
          await until(() => page.locator('.studio-mode-switcher').getAttribute('aria-busy'), value => value === 'false', 'Mode animation did not finish');
          await assertControl(active);
          if (active) assert.equal(await frame.locator('#message').inputValue(), `Retain this draft ${language}`);
          await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-${active ? 'steam' : 'ide'}.png`) });
        }
      }
      await command('studio.enterIdeMode');
      const transitions = await page.evaluate(() => window.studioModeTransitions);
      for (const distance of ['translateX(32px)', 'translateX(-32px)']) {
        assert.ok(transitions.some(effect => effect.frames[0].transform === distance && effect.frames[0].opacity === 0));
      }
      for (const part of ['titlebar', 'statusbar', 'sidebar', 'activitybar', 'webview-overlay-content']) {
        assert.ok(transitions.some(effect => effect.part.includes(part) && effect.frames[1].opacity === 0), `${part} must exit before it is hidden`);
      }
      await writeFile(path.join(proof, `${language}-transitions.json`), JSON.stringify(transitions, null, 2));
      const samples = await page.evaluate(() => { window.monitorModeControl = false; return window.modeControlSamples; });
      assert.ok(samples.length > 30); assert.ok(samples.every(sample => sample.visible && sample.same), JSON.stringify(samples));
      check(`${language}: the compact switch keeps its live control visible during every frame and animates both directions, including webviews and outgoing chrome`);
      await page.setViewportSize({ width: 800, height: 700 });
      await assertControl(false);
      const assertReversal = async active => {
        await page.evaluate(() => {
          window.modeChanges = [];
          window.modeObserver = new MutationObserver(records => {
            for (const record of records) window.modeChanges.push(record.oldValue.split(' ').includes('studio-steam-mode'));
          });
          window.modeObserver.observe(document.querySelector('.monaco-workbench'), { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
        });
        const switching = command(active ? 'studio.enterIdeMode' : 'studio.enterSteamMode');
        await page.waitForFunction(() => document.querySelector('.studio-mode-switcher').getAttribute('aria-busy') === 'true');
        await page.waitForTimeout(20);
        const reverting = command(active ? 'studio.enterSteamMode' : 'studio.enterIdeMode');
        await Promise.all([switching, reverting]); await assertControl(active);
        const modes = await page.evaluate(() => { window.modeObserver.disconnect(); return window.modeChanges; });
        assert.ok(modes.every(mode => mode === active), 'A cancelled exit must not briefly enter the obsolete layout');
      };
      await assertReversal(false);
      await command('studio.enterSteamMode'); await assertControl(true);
      await assertReversal(true);
      assert.equal(await frame.locator('#message').inputValue(), `Retain this draft ${language}`);
      check(`${language}: narrow layouts and rapid reversals preserve the latest mode and the project draft`);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const count = await page.evaluate(() => window.studioModeTransitions.length);
      await command('studio.enterIdeMode'); await command('studio.enterSteamMode');
      assert.equal(await page.evaluate(() => window.studioModeTransitions.length), count);
      check(`${language}: reduced motion changes modes without workspace animations`);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.locator('.monaco-workbench.monaco-enable-motion').waitFor();
      assert.equal(await call({ action: 'configure', key: 'workbench.reduceMotion', value: 'on' }), 'on');
      await page.locator('.monaco-workbench.monaco-reduce-motion').waitFor();
      await command('studio.enterIdeMode'); await command('studio.enterSteamMode');
      assert.equal(await page.evaluate(() => window.studioModeTransitions.length), count);
      check(`${language}: the workbench reduced-motion setting also skips the switch effects`);
      continue;
    }
    if (process.env.STEAMHARNESS_UI_FOCUS !== 'new-tool-content') {
      await frame.locator('#message').fill(`mode-persistence-${language}`); await frame.locator('#send').press('Enter');
      await frame.locator('#app[data-run-state=idle]').waitFor();
      await until(() => frame.locator('.message.assistant').count(), value => value > 0, 'Local project did not produce a result');
      await frame.locator('#project-info').click();
      await frame.locator('dialog[open]').waitFor();
      await until(() => page.locator('.studio-project-drag-region').count(), count => count === 0, 'Modal dialogs must suspend native project dragging');
      await page.keyboard.press('Escape');
      await frame.locator('dialog[open]').waitFor({ state: 'detached' });
      await assertDragRegions();
      check(`${language}: project header drag regions exclude controls and text, follow menu layout and suspend for dialogs`);
    }
    if (process.env.STEAMHARNESS_UI_FOCUS === 'new-tool-content') {
      const instances = page.locator('.studio-steam-editors[data-tool=assistant]:visible .tabs-container');
      const newAssistant = () => page.locator('.studio-steam-editors[data-tool=assistant]:visible .editor-actions .codicon-add').click();
      const originalTab = instances.locator('.tab:not([data-resource-name])');
      const assistantFrame = () => until(async () => {
        for (const candidate of page.frames()) {
          if (!await candidate.locator('body[data-surface=assistant] #message').count().catch(() => 0)) { continue; }
          let current = candidate, visible = true;
          while (current.parentFrame()) {
            if (!await (await current.frameElement()).isVisible()) { visible = false; break; }
            current = current.parentFrame();
          }
          if (visible) return candidate;
        }
      }, Boolean, 'Assistant did not become visible', 90_000);
      await command('studio.internalOpenSteamTool', 'assistant');
      const original = await assistantFrame();
      await original.locator('#message').fill('slow'); await original.locator('#send').press('Enter');
      await original.locator('#app[data-run-state=running]').waitFor();
      await original.locator('#message').fill('Original next turn');
      await newAssistant();
      await until(() => instances.locator('.tab').count(), count => count === 2, 'New Assistant tab was not created');
      const secondLabel = await instances.locator('.tab.active .label-name').innerText();
      const secondTab = instances.locator('.tab').filter({ hasText: secondLabel });
      const second = await assistantFrame();
      assert.notEqual(second, original);
      await second.locator('#app[data-run-state=idle]').waitFor();
      assert.equal(await second.locator('.message').count(), 0); assert.equal(await second.locator('#message').inputValue(), '');
      await second.locator('#message').fill('Second tab draft');
      await originalTab.click();
      assert.equal(await original.locator('#app').getAttribute('data-run-state'), 'running');
      assert.equal(await original.locator('#message').inputValue(), 'Original next turn');
      await newAssistant();
      await until(() => instances.locator('.tab').count(), count => count === 3, 'Third Assistant tab was not created');
      const third = await assistantFrame();
      await third.locator('#app[data-run-state=idle]').waitFor();
      assert.equal(await third.locator('.message').count(), 0); assert.equal(await third.locator('#message').inputValue(), '');
      assert.notEqual(new URL(third.url()).searchParams.get('conversationId'), new URL(second.url()).searchParams.get('conversationId'));
      await page.screenshot({ path: path.join(proof, `${language}-new-assistant.png`) });
      await instances.locator('.tab.active .tab-actions .action-label').click();
      await secondTab.click();
      assert.equal(await second.locator('#message').inputValue(), 'Second tab draft');
      await second.locator('#send').press('Enter'); await second.locator('#app[data-run-state=idle]').waitFor();
      await until(() => second.locator('.message.assistant').allTextContents(), values => values.join('').includes('Second tab draft'), 'Second Assistant did not run independently');
      await second.locator('#message').fill('Second next turn');
      await originalTab.click();
      assert.equal(await original.locator('#app').getAttribute('data-run-state'), 'running');
      assert.equal(await original.locator('#message').inputValue(), 'Original next turn');
      check(`${language}: repeated child-tab additions open distinct blank conversations while the original keeps running and each tab retains its draft`);
      await original.locator('#message').fill(''); await original.locator('#send').press('Enter');
      await original.locator('#app[data-run-state=idle]').waitFor(); await original.locator('#message').fill('Original next turn');
      // Switch before reloading so the two restored selections cannot both
      // accidentally pass by opening the shared last-selected conversation.
      await secondTab.click();
      await page.waitForTimeout(500);
      await rm(readyFile, { force: true }); await call({ action: 'reload' });
      bridge = await until(readReady, value => value.port || value.error, 'Reloaded test bridge did not start', 120_000);
      await until(() => instances.locator('.tab').count(), count => count === 2, 'Assistant tabs did not restore', 120_000);
      const restoredSecond = await assistantFrame();
      assert.equal(await restoredSecond.locator('#message').inputValue(), 'Second next turn');
      assert.ok((await restoredSecond.locator('.message.assistant').allTextContents()).join('').includes('Second tab draft'));
      await originalTab.click();
      const restoredOriginal = await assistantFrame();
      assert.equal(await restoredOriginal.locator('#message').inputValue(), 'Original next turn');
      assert.ok((await restoredOriginal.locator('.message.user').allTextContents()).join('').includes('slow'));
      assert.equal((await restoredOriginal.locator('.message.user').allTextContents()).join('').includes('Second tab draft'), false);
      check(`${language}: workbench reload restores both Assistant tabs to their own conversations and drafts`);
      continue;
    }
    if (process.env.STEAMHARNESS_UI_FOCUS === 'tools-width') {
      const toggleWidth = async expected => {
        await toggleTools.click(); await until(partState, state => !state.auxiliarybar.visible, 'Tools did not collapse');
        await toggleTools.click(); await until(partState, state => state.auxiliarybar.visible, 'Tools did not reopen');
        await assertToolsWidth(expected);
      };
      await resizeTools(600); await toggleWidth(600);
      await page.setViewportSize({ width: 800, height: 960 }); await assertToolsWidth(480);
      await toggleTools.click(); await until(partState, state => !state.auxiliarybar.visible, 'Narrow tools did not collapse');
      await page.setViewportSize({ width: 1440, height: 960 });
      await toggleTools.click(); await assertToolsWidth(600);
      check(`${language}: the actual outer divider saves its width across hiding and temporary window constraints`);
      for (const tool of ['kv', 'info', 'terminal']) {
        await command('studio.internalOpenSteamTool', tool); await assertToolsWidth(600);
      }
      const widthFile = path.join(project, 'width-check.txt'); await writeFile(widthFile, 'Tools width regression.');
      await call({ action: 'file', path: widthFile, column: 1 }); await assertToolsWidth(600);
      assert.equal(frame.isDetached(), false);
      await command('studio.enterIdeMode');
      const restored = await partState();
      for (const part of Object.keys(before)) {
        assert.equal(restored[part].visible, before[part].visible, part);
        if (before[part].visible) { assert.ok(Math.abs(restored[part].width - before[part].width) < 2, part); }
      }
      await command('studio.enterSteamMode'); await assertToolsWidth(600);
      await toggleTools.click(); await until(partState, state => !state.auxiliarybar.visible, 'Tools did not collapse before leaving Steam');
      await command('studio.enterIdeMode'); await command('studio.enterSteamMode'); await assertToolsWidth(600);
      check(`${language}: opening tools and files or switching modes preserves both the Steam preference and the separate IDE layout`);
      for (const [preferred, narrow, hidden] of [[630, false, false], [700, true, true]]) {
        await resizeTools(preferred);
        if (narrow) { await page.setViewportSize({ width: 800, height: 960 }); await assertToolsWidth(480); }
        if (hidden) { await toggleTools.click(); await until(partState, state => !state.auxiliarybar.visible, 'Tools did not hide before reload'); }
        await rm(readyFile, { force: true });
        const reloaded = page.waitForEvent('domcontentloaded', { timeout: 60_000 });
        await call({ action: 'reload' }); await reloaded;
        bridge = await until(readReady, value => value.port || value.error, 'Extension restart timed out', 120_000);
        assert.equal(bridge.error, undefined);
        await until(() => steam.getAttribute('aria-pressed').catch(() => undefined), value => value === 'true', 'Steam was not restored', 120_000);
        await command('studio.openSteamTools'); await assertToolsWidth(narrow ? 480 : preferred);
        if (narrow) { await page.setViewportSize({ width: 1440, height: 960 }); await assertToolsWidth(preferred); }
        await toggleWidth(preferred);
      }
      await page.screenshot({ path: path.join(proof, `${language}-tools-width.png`) });
      check(`${language}: reload directly from Steam restores the last dragged width even with tools hidden in a narrow window`);
      continue;
    }
    const assertDialogFits = async dialog => {
      await dialog.waitFor();
      const offset = await (await frame.frameElement()).boundingBox();
      const chrome = await page.locator('.studio-steam-window-chrome').boundingBox();
      const bounds = await dialog.boundingBox(), header = await dialog.locator(':scope > header').boundingBox();
      const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.ok(bounds.y >= chrome.y + chrome.height + 8 - 1, JSON.stringify({ bounds, chrome }));
      assert.ok(bounds.x >= offset.x && bounds.x + bounds.width <= offset.x + viewport.width + 1, JSON.stringify({ bounds, offset, viewport }));
      assert.ok(bounds.y + bounds.height <= offset.y + viewport.height - 8 + 1, JSON.stringify({ bounds, offset, viewport }));
      assert.ok(header.y >= bounds.y && header.y + header.height <= bounds.y + bounds.height);
      assert.equal(await dialog.evaluate(element => element.scrollTop), 0, 'The dialog header must stay fixed while its body scrolls');
      await dialog.locator(':scope > header > button').last().click({ trial: true });
      const footer = dialog.locator('.configuration-footer').last();
      if (await footer.count()) {
        const rect = await footer.boundingBox();
        assert.ok(rect.y >= bounds.y + header.height && rect.y + rect.height <= bounds.y + bounds.height, JSON.stringify({ rect, bounds }));
        await footer.locator('button:enabled').first().click({ trial: true });
      }
    };
    const configurations = frame.locator('dialog.project-configurations:not(.configuration-field-editor)');
    const closeDialog = async dialog => { await dialog.locator(':scope > header > button').last().click(); await dialog.waitFor({ state: 'hidden' }); };
    for (const viewport of [{ width: 1440, height: 960 }, { width: 1100, height: 600 }, { width: 800, height: 360 }, { width: 1440, height: 320 }]) {
      await page.setViewportSize(viewport);
      for (const toolsVisible of [true, false]) {
        if ((await toggleTools.getAttribute('aria-expanded') === 'true') !== toolsVisible) { await toggleTools.click(); }
        for (const menuOpen of [false, true]) {
          if ((await frame.locator('#hide-menu').isVisible()) !== menuOpen) { await frame.locator(menuOpen ? '#menu-toggle' : '#hide-menu').click(); }
          await frame.locator('#project-configurations').click();
          await until(() => configurations.locator('.configuration-field').count(), count => count === 17, 'Project configuration fields did not load');
          await assertDialogFits(configurations);
          const body = configurations.locator(':scope > .dialog-body:visible');
          assert.ok(await body.evaluate(element => element.scrollHeight > element.clientHeight));
          await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
          await assertDialogFits(configurations);
          if (viewport.height === 320 && toolsVisible && !menuOpen) { await page.screenshot({ path: path.join(proof, `${language}-steam-dialog-safe-area.png`) }); }
          const lastField = await configurations.locator('.configuration-field').last().boundingBox(), bodyRect = await body.boundingBox();
          assert.ok(lastField.y + lastField.height <= bodyRect.y + bodyRect.height + 1);
          await body.evaluate(element => { element.scrollTop = 0; });
          await configurations.locator('.configuration-add-field').click();
          const fieldEditor = frame.locator('.configuration-field-editor');
          await assertDialogFits(fieldEditor);
          await fieldEditor.locator('.dialog-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
          await assertDialogFits(fieldEditor); await closeDialog(fieldEditor);
          await configurations.getByRole('button', { name: language === 'en' ? 'Configuration actions' : '配置操作', exact: true }).click();
          await configurations.getByRole('menuitem', { name: language === 'en' ? 'Rename' : '重命名', exact: true }).click();
          const rename = frame.locator('.action-dialog'); await assertDialogFits(rename); await closeDialog(rename);
          await closeDialog(configurations);
        }
      }
      for (const selector of ['#project-info', '#tools']) {
        await frame.locator(selector).click();
        const dialog = frame.locator('dialog[open]'); await assertDialogFits(dialog); await closeDialog(dialog);
      }
    }
    check(`${language}: configurations, nested field editors, rename, information and permissions clear window controls with menus and tools open or closed at short and narrow sizes`);
    await page.setViewportSize({ width: 1440, height: 960 });
    if (await toggleTools.getAttribute('aria-expanded') !== 'true') { await toggleTools.click(); }
    if (await frame.locator('#hide-menu').isVisible()) { await frame.locator('#hide-menu').click(); }
    await page.setViewportSize({ width: 1100, height: 960 });
    await frame.locator('#menu-toggle').click();
    await assertChromeSlot('.project-title');
    await page.setViewportSize({ width: 1440, height: 960 });
    await assertChromeSlot('#project-menu');
    await frame.locator('#hide-menu').click();
    const resultUrl = frame.url();
    const mainGroups = () => page.locator('.part.editor:not(.studio-steam-editors) .editor-group-container').count();
    const initialGroups = await mainGroups();
    for (const action of ['splitEditorRight', 'splitEditorDown', 'newGroupRight', 'newGroupBelow',
      'editorLayoutTwoColumns', 'editorLayoutTwoRows', 'moveEditorToNextGroup', 'splitEditorToLastGroup', 'joinAllGroups']) {
      await command('workbench.action.focusFirstEditorGroup');
      await command(`workbench.action.${action}`);
      assert.equal(await mainGroups(), initialGroups, `Steam project must not create a split: ${action}`);
      assert.equal(frame.isDetached(), false);
    }
    check(`${language}: split, new group, layout, move, copy and join commands preserve the runtime surface`);
    const toolSelectors = { kv: 'body[data-resource-kind=kv]', knowledge: 'body[data-resource-kind=knowledge]', info: '#info-app', assistant: '#app', versions: '#versions-app', trace: '#trace-app' };
    const visibleToolFrame = selector => until(async () => {
      for (const candidate of page.frames()) {
        if (candidate === frame || !await candidate.locator(selector).count().catch(() => 0)) { continue; }
        let current = candidate, visible = true;
        while (current.parentFrame()) {
          if (!await (await current.frameElement()).isVisible()) { visible = false; break; }
          current = current.parentFrame();
        }
        if (visible) { return candidate; }
      }
    }, Boolean, `Tool view did not open: ${selector}`);
    const assertAssistantFits = async (assistant, instance) => {
      const message = assistant.locator('#message');
      const draft = await message.inputValue();
      for (const text of ['', Array.from({ length: 30 }, (_, index) => `Draft line ${index}`).join('\n')]) {
        await message.fill(text);
        for (const [width, height] of [[1440, 960], [1440, 760], [1440, 600], [1440, 480], [1440, 360], [1440, 280], [1000, 480], [800, 360]]) {
          await page.setViewportSize({ width, height });
          // Nested cross-origin frames receive their viewport after the host layout.
          await until(async () => {
            const tools = await page.locator('.part.auxiliarybar').boundingBox();
            const app = await assistant.locator('#app').boundingBox();
            return Math.abs(app.y + await assistant.evaluate(() => innerHeight) - tools.y - tools.height) < 1;
          }, Boolean, `Assistant viewport did not follow the tools: ${instance} at ${height}`);
          const geometry = await assistant.evaluate(() => ({ viewport: innerHeight,
            composer: document.querySelector('.composer-area').getBoundingClientRect().toJSON(),
            input: document.querySelector('#message').getBoundingClientRect().toJSON(),
          }));
          assert.ok(geometry.composer.bottom <= geometry.viewport + 1, JSON.stringify({ instance, height, geometry }));
          assert.ok(geometry.input.height >= 24 && geometry.input.bottom <= geometry.viewport + 1, JSON.stringify({ instance, height, geometry }));
          assert.ok(await assistant.locator('#send').evaluate(button => {
            const rect = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 2));
          }), `Assistant send button is clipped: ${instance} at ${height}`);
          assert.equal(await message.inputValue(), text);
        }
      }
      await page.screenshot({ path: path.join(proof, `${language}-assistant-${instance}-short.png`) });
      await message.fill(draft);
      await page.setViewportSize({ width: 1440, height: 960 });
      check(`${language}: ${instance} Assistant keeps the input and Send visible across eight window sizes with empty and multiline drafts`);
    };
    for (const tool of ['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace', 'terminal']) {
      await command('studio.openSteamTools'); await page.locator(`.studio-steam-tool[data-tool="${tool}"]`).click();
      if (tool === 'terminal') {
        const terminal = page.locator('.studio-steam-editors[data-tool=terminal]:visible .terminal-editor').first();
        await terminal.waitFor();
        const rect = await terminal.boundingBox(); assert.ok(rect.x >= toolsGeometry.x && rect.width > 100);
        assert.equal(await page.locator('.studio-steam-tab[data-tab=terminal] .studio-steam-tab-select').innerText(), language === 'en' ? 'Terminal' : '终端');
        assert.equal((await partState()).panel.visible, false);
        continue;
      }
      const toolFrame = await visibleToolFrame(toolSelectors[tool]);
      if (tool === 'assistant') { await assertAssistantFits(toolFrame, 'default'); }
      assert.equal((await partState()).panel.visible, false);
    }
    check(`${language}: all seven tools including the native terminal open in the right sidebar`);

    const tabList = page.locator('.studio-steam-tab-list');
    const toolTabs = tabList.locator('.studio-steam-tab:not([data-tab^="editor:"])');
    assert.equal(await toolTabs.count(), 8);
    await page.locator('.studio-steam-tab[data-tab=kv] .studio-steam-tab-select').click();
    await page.locator('.studio-steam-tab[data-tab=info] .studio-steam-tab-close').click();
    assert.equal(await toolTabs.count(), 7);
    await page.locator('.studio-steam-add-tab').click();
    // Native menus suppress mouse-up for their first 100ms to avoid accidental selections.
    await page.waitForTimeout(150);
    await page.locator('.context-view').getByText(language === 'en' ? 'Project Information' : '项目信息', { exact: true }).click();
    await until(() => toolTabs.count(), value => value === 8, 'Add menu did not restore the closed tool tab');
    await command('studio.internalOpenSteamTool', 'kv');
    assert.equal(await toolTabs.count(), 8);
    check(`${language}: tools use dynamic closable tabs and the add menu reopens tools without duplicate tabs`);

    const instanceList = page.locator('.studio-steam-editors:visible .tabs-container');
    const newInstanceButton = page.locator('.studio-steam-editors:visible .editor-group-container.active .editor-actions .codicon-add');
    for (const tool of ['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace']) {
      await command('studio.internalOpenSteamTool', tool);
      const original = await visibleToolFrame(toolSelectors[tool]);
      if (['kv', 'knowledge'].includes(tool)) { await original.locator('#resource-search').fill(`${tool}-first`); }
      await newInstanceButton.click();
      await until(() => instanceList.locator('.tab').count(), value => value === 2, `Missing second ${tool} instance`);
      const created = await visibleToolFrame(toolSelectors[tool]); assert.notEqual(created, original);
      if (tool === 'assistant') { await assertAssistantFits(created, 'new'); }
      const createdTab = instanceList.locator('.tab').nth(1);
      if (['kv', 'knowledge'].includes(tool)) { await created.locator('#resource-search').fill(`${tool}-second`); }
      assert.equal(await tabList.locator(`.studio-steam-tab[data-tab=${tool}]`).count(), 1);
      await instanceList.locator('.tab').first().click();
      if (['kv', 'knowledge'].includes(tool)) { assert.equal(await original.locator('#resource-search').inputValue(), `${tool}-first`); }
      await createdTab.click();
      if (['kv', 'knowledge'].includes(tool)) { assert.equal(await created.locator('#resource-search').inputValue(), `${tool}-second`); }
      const row = await instanceList.boundingBox();
      const primary = await page.locator('.studio-steam-tabs').boundingBox();
      assert.ok(row.y >= primary.y + primary.height - 1);
      await createdTab.locator('.tab-actions .action-label').click();
      await until(() => instanceList.locator('.tab').count(), value => value === 1, `${tool} instance did not close`);
      assert.equal(await page.locator('.studio-steam-tab.active').getAttribute('data-tab'), tool);
      assert.equal(frame.isDetached(), false);
      assert.ok((await call({ action: 'state' })).groups.find(group => group.column === 1).tabs.some(tab => tab.active && tab.viewType?.endsWith('studio.project')));
    }
    await command('studio.internalOpenSteamTool', 'kv');
    check(`${language}: KV, knowledge, information, assistant, versions and trace each create independent child tabs with working selection and close`);

    const savedTabLabels = await tabList.locator('[role=tab]').allTextContents();
    const assertToolsToggle = async () => {
      const width = await toolsWidth();
      await toggleTools.click();
      await until(partState, state => !state.auxiliarybar.visible, 'Tools did not collapse');
      assert.equal(await toggleTools.getAttribute('aria-expanded'), 'false');
      assert.equal(await toggleTools.getAttribute('aria-label'), language === 'en' ? 'Show Tools' : '显示工具区');
      assert.ok((await page.locator('.part.editor:not(.studio-steam-editors)').boundingBox()).width > geometry.width);
      assert.equal(frame.isDetached(), false); assert.equal(frame.url(), resultUrl);
      await until(() => frame.locator('#app').evaluate(app => Number.parseFloat(getComputedStyle(app).getPropertyValue('--studio-window-chrome-right'))), value => value > 0, 'Hidden tool controls were not reserved by the project header');
      await toggleTools.click();
      await until(partState, state => state.auxiliarybar.visible, 'Tools did not expand');
      assert.equal(await toggleTools.getAttribute('aria-expanded'), 'true');
      await assertToolsWidth(width);
    };
    await assertToolsToggle();
    assert.deepEqual(await tabList.locator('[role=tab]').allTextContents(), savedTabLabels);
    assert.equal(await page.locator('.studio-steam-tab.active').getAttribute('data-tab'), 'kv');
    check(`${language}: the trailing toggle hides and restores tools without losing tabs, the selected tool or the live runtime`);

    const tabStyle = await toolTabs.first().evaluate(element => {
      const style = getComputedStyle(element), next = element.nextElementSibling;
      return { radius: parseFloat(style.borderRadius), gap: next.getBoundingClientRect().left - element.getBoundingClientRect().right,
        filled: style.backgroundColor !== 'rgba(0, 0, 0, 0)', height: element.getBoundingClientRect().height };
    });
    assert.ok(tabStyle.radius >= 4 && tabStyle.gap >= 6 && tabStyle.filled && tabStyle.height >= 24, JSON.stringify(tabStyle));
    const headerSpace = await page.locator('.part.auxiliarybar > .title').evaluate(element => ({
      width: element.clientWidth, tabs: element.querySelector('.studio-steam-tabs').getBoundingClientRect().width,
      actions: element.querySelector('.title-actions').getBoundingClientRect().width,
      controls: element.querySelector('.studio-steam-tools-chrome').getBoundingClientRect().width,
    }));
    assert.ok(headerSpace.tabs + headerSpace.actions + headerSpace.controls >= headerSpace.width - 24, JSON.stringify(headerSpace));
    const tabIds = await tabList.locator('.studio-steam-tab').evaluateAll(elements => elements.map(element => element.dataset.tab));
    for (const width of [1024, 800]) {
      await page.setViewportSize({ width, height: 960 });
      const labels = await tabList.locator('.studio-steam-tab-label').evaluateAll(elements => elements.map(element => ({
        width: element.clientWidth, scroll: element.scrollWidth, overflow: getComputedStyle(element).textOverflow,
      })));
      assert.ok(labels.some(label => label.scroll > label.width && label.overflow === 'ellipsis'), JSON.stringify(labels));
      await until(() => page.locator('.part.auxiliarybar').evaluate(sidebar => {
        const add = sidebar.querySelector('.studio-steam-add-tab').getBoundingClientRect();
        const chrome = sidebar.querySelector('.studio-steam-tools-chrome').getBoundingClientRect();
        const rect = sidebar.getBoundingClientRect();
        return { left: rect.left, right: rect.right, addLeft: add.left, addRight: add.right, chromeLeft: chrome.left, width: innerWidth };
      }), rect => Math.abs(rect.right - rect.width) < 1 && rect.addLeft >= rect.left && rect.addRight <= rect.chromeLeft + 1, 'Native tool controls must remain after the add button while the workbench resizes');
      await tabList.locator('.studio-steam-tab.active [role=tab]').press('End');
      await until(() => page.locator('.studio-steam-tab.active').getAttribute('data-tab'), value => value === tabIds.at(-1), 'Keyboard navigation did not reach the last tab');
      await tabList.locator('.studio-steam-tab.active [role=tab]').press('Home');
      await until(() => page.locator('.studio-steam-tab.active').getAttribute('data-tab'), value => value === tabIds[0], 'Keyboard navigation did not return to the first tab');
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await command('studio.internalOpenSteamTool', 'kv');
    await page.screenshot({ path: path.join(proof, `${language}-rounded-tabs.png`) });
    check(`${language}: rounded tool tabs retain spacing, truncate dense labels and keep the add button and keyboard navigation usable`);

    const projectGroupBefore = (await call({ action: 'state' })).groups.find(group => group.column === 1);
    assert.ok(projectGroupBefore.tabs.some(tab => tab.active && tab.viewType?.endsWith('studio.project')));
    const assertProjectKept = async () => {
      const state = await call({ action: 'state' });
      assert.deepEqual(state.groups.find(group => group.column === 1).tabs, projectGroupBefore.tabs);
      assert.equal(frame.isDetached(), false); assert.equal(frame.url(), resultUrl);
      assert.ok((await frame.locator('.message.assistant').allTextContents()).join('').includes(`mode-persistence-${language}`));
      assert.equal(await page.locator('.studio-steam-editors:visible').isVisible(), true);
      await until(() => page.locator('.studio-steam-editors:visible').evaluate(element => {
        const rect = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect();
        return getComputedStyle(element).position === 'absolute' && rect.width > 200 && rect.height > 300
          && rect.left >= parent.left && rect.right <= parent.right + 1
          && rect.top >= parent.top && rect.bottom <= parent.bottom + 1;
      }), Boolean, 'The tool editor must fill the visible right workspace below its tabs');
      return state;
    };
    await command('studio.openAccount');
    const accountTab = tabList.getByRole('tab', { name: language === 'en' ? 'SteamHarness Account' : 'SteamHarness 账号', exact: true });
    await accountTab.waitFor(); await assertProjectKept();
    const accountFrame = await until(async () => {
      for (const candidate of page.frames()) { if (await candidate.locator('#login-email').isVisible().catch(() => false)) { return candidate; } }
    }, Boolean, 'Account content did not open in the tool workspace', 15_000);
    await accountFrame.locator('#login-email').click({ trial: true });
    await page.screenshot({ path: path.join(proof, `${language}-workspace-account.png`) });
    const toolsFile = path.join(project, 'tools-only.txt'); await writeFile(toolsFile, 'Opened explicitly in the first editor column.');
    await call({ action: 'file', path: toolsFile, column: 1 });
    const fileState = await assertProjectKept();
    await page.locator('.studio-steam-editors:visible .view-line').first().click({ trial: true });
    assert.ok(fileState.groups.filter(group => group.column !== 1).some(group => group.tabs.some(tab => tab.uri === pathToFileURL(toolsFile).href)));
    const toolsGroups = () => page.locator('.studio-steam-editors:visible .editor-group-container').count();
    const fileTabs = instanceList.locator('.tab').filter({ hasText: 'tools-only.txt' });
    const editorTab = tabList.locator('.studio-steam-tab[data-tab=editor]');
    assert.equal(await editorTab.count(), 1);
    assert.equal(await editorTab.getByRole('tab').innerText(), language === 'en' ? 'Editor' : '编辑器');
    const codeSidebar = page.locator('.studio-steam-code-sidebar .part.sidebar');
    await codeSidebar.waitFor();
    await until(async () => {
      const sidebar = await codeSidebar.boundingBox(), editor = await page.locator('.studio-steam-editors:visible').boundingBox();
      return sidebar && editor && sidebar.x >= editor.x + editor.width - 1 && sidebar.width >= 140 && sidebar.height > 600;
    }, Boolean, 'Native Explorer must sit to the right of the code editor inside the tool workspace');
    assert.ok(await codeSidebar.locator('.composite-bar-container .action-item').count() > 0);
    const divider = page.locator('.studio-steam-editor-workspace > .monaco-split-view2 > .sash-container .monaco-sash.vertical');
    const dividerRect = await divider.boundingBox(), originalSidebar = await codeSidebar.boundingBox();
    await page.mouse.move(dividerRect.x + dividerRect.width / 2, dividerRect.y + dividerRect.height / 2);
    await page.mouse.down(); await page.mouse.move(dividerRect.x - 40, dividerRect.y + dividerRect.height / 2, { steps: 8 }); await page.mouse.up();
    await until(() => codeSidebar.boundingBox(), rect => rect.width > originalSidebar.width + 30, 'The native sidebar divider did not resize');
    const sidebarWidth = (await codeSidebar.boundingBox()).width;
    await command('workbench.files.action.showActiveFileInExplorer');
    const explorerFile = codeSidebar.locator('.explorer-folders-view').getByText('tools-only.txt', { exact: true });
    await explorerFile.waitFor();
    await fileTabs.locator('.tab-actions .action-label').click();
    await until(() => fileTabs.count(), count => count === 0, 'The file did not close');
    await frame.locator('#message').click();
    await explorerFile.click();
    await fileTabs.waitFor(); await assertProjectKept();
    await until(() => fileTabs.getAttribute('class'), value => value.includes('active'), 'A single Explorer click must show its file even when the runtime had focus');
    await fileTabs.click();
    await until(async () => (await call({ action: 'state' })).active, value => value === pathToFileURL(toolsFile).href, 'Explorer did not activate the opened file in the extension host');
    await call({ action: 'replace', text: 'Edited and saved from the Steam Editor.' });
    await until(async () => (await call({ action: 'state' })).documents.find(document => document.uri === pathToFileURL(toolsFile).href), document => document?.dirty && document.text === 'Edited and saved from the Steam Editor.', 'The project file did not retain the unsaved edit');
    const closingDirtyFile = fileTabs.locator('.tab-actions .action-label').click();
    const saveConfirmation = page.locator('.monaco-dialog-box');
    await saveConfirmation.waitFor(); await page.keyboard.press('Escape'); await closingDirtyFile;
    await saveConfirmation.waitFor({ state: 'detached' });
    assert.equal(await fileTabs.count(), 1);
    await command('workbench.action.files.save');
    assert.equal(await readFile(toolsFile, 'utf8'), 'Edited and saved from the Steam Editor.');
    await command('studio.internalOpenSteamTool', 'kv');
    await command('workbench.action.findInFiles');
    const searchInput = codeSidebar.locator('.search-widget .search-container textarea');
    await until(() => searchInput.evaluate(input => input === document.activeElement), Boolean, 'The native Search command must retain focus inside the right sidebar');
    await searchInput.fill('Edited and saved from the Steam Editor.'); await searchInput.press('Enter');
    const searchFile = codeSidebar.locator('.results .filematch').getByText('tools-only.txt', { exact: true });
    await searchFile.waitFor();
    await fileTabs.locator('.tab-actions .action-label').click();
    await until(() => fileTabs.count(), count => count === 0, 'The file did not close before opening a search result');
    await codeSidebar.locator('.results a.match').first().click();
    await fileTabs.waitFor(); await assertProjectKept();
    await command('workbench.files.action.showActiveFileInExplorer');
    await page.locator('.studio-steam-tab[data-tab=kv] [role=tab]').click();
    assert.equal(await codeSidebar.isVisible(), false);
    await editorTab.getByRole('tab').click();
    await fileTabs.waitFor(); await codeSidebar.waitFor();
    await assertToolsToggle(); await codeSidebar.waitFor();
    await until(() => codeSidebar.boundingBox(), rect => Math.abs(rect.width - sidebarWidth) < 2, `Hiding tools must preserve the resized sidebar width (${sidebarWidth})`);
    await page.screenshot({ path: path.join(proof, `${language}-editor-explorer.png`) });
    check(`${language}: Editor groups file tabs, opens project files from native Explorer and Search, saves edits, honors dirty-close cancellation and retains the sidebar across tools`);
    await fileTabs.click();
    await until(async () => (await call({ action: 'state' })).active, value => value === pathToFileURL(toolsFile).href, 'The source tab must have focus before editor commands');
    for (const action of ['splitEditorRight', 'splitEditorDown']) {
      await command(`workbench.action.${action}`);
      await until(toolsGroups, value => value === 2, 'Tool workspace did not split');
      await until(() => fileTabs.count(), value => value === 2, 'Split copies must have independent tabs');
      await fileTabs.last().locator('.tab-actions .action-label').click();
      await until(toolsGroups, value => value === 1, 'Closing the split tab did not remove its empty group');
      await until(() => fileTabs.count(), value => value === 1, 'Closing a split removed the surviving file tab');
      await assertProjectKept();
      await fileTabs.click();
    }
    for (const action of ['moveEditorToFirstGroup', 'splitEditorToFirstGroup']) {
      await command(`workbench.action.${action}`); await assertProjectKept();
      assert.equal(await fileTabs.count(), 1);
    }
    check(`${language}: right and down tool splits close cleanly; moves and copies into the first column preserve the runtime`);
    await command('workbench.action.openSettings'); await assertProjectKept();
    await call({ action: 'diff' }); await assertProjectKept();
    await call({ action: 'webview' });
    await tabList.getByRole('tab', { name: 'Workspace Probe', exact: true }).waitFor();
    await assertProjectKept();
    const probe = await until(async () => {
      for (const candidate of page.frames()) { if (await candidate.locator('#workspace-probe').isVisible().catch(() => false)) { return candidate; } }
    }, Boolean, 'Generic webview did not open in the tool workspace');
    await probe.locator('#workspace-probe').fill('Preserve this tab state');
    await page.locator('.studio-steam-tab[data-tab=kv] .studio-steam-tab-select').click();
    await tabList.getByRole('tab', { name: 'Workspace Probe', exact: true }).click();
    assert.equal(await probe.locator('#workspace-probe').inputValue(), 'Preserve this tab state');
    await assertProjectKept();
    const probeRect = await probe.locator('#workspace-probe').boundingBox(), rightRect = await page.locator('.part.auxiliarybar').boundingBox();
    assert.ok(probeRect.x >= rightRect.x && probeRect.x + probeRect.width <= rightRect.x + rightRect.width);
    assert.ok(probeRect.y >= rightRect.y && probeRect.y + probeRect.height <= rightRect.y + rightRect.height);
    // This checks hit testing across webview overlays as well as DOM visibility.
    await probe.locator('#workspace-probe').click({ trial: true });
    const activeProbeTab = await page.locator('.studio-steam-tab.active').getAttribute('data-tab');
    await assertToolsToggle();
    assert.equal(await page.locator('.studio-steam-tab.active').getAttribute('data-tab'), activeProbeTab);
    await probe.locator('#workspace-probe').click({ trial: true });
    await page.screenshot({ path: path.join(proof, `${language}-workspace-tabs.png`) });
    check(`${language}: account status, explicit first-column files, settings, diffs and generic webviews open on the right while the live project and its result stay intact`);
    await call({ action: 'webview', viewType: 'studio.project', title: 'Secondary Project Probe' });
    const secondary = tabList.locator('.studio-steam-tab').filter({ has: page.getByRole('tab', { name: 'Secondary Project Probe', exact: true }) });
    await secondary.waitFor(); await assertProjectKept();
    await secondary.locator('.studio-steam-tab-close').click();
    await secondary.waitFor({ state: 'detached' });
    check(`${language}: a second uninitialized project panel uses tools without replacing the selected runtime`);
    const rightDocument = await call({ action: 'untitled', text: 'Keep this unsaved tool workspace document.' });
    await assertProjectKept();

    for (const theme of ['Default Dark Modern', 'Default Light Modern']) {
      await call({ action: 'theme', theme }); await command('studio.openSteamTools');
      assert.equal(await page.locator('.studio-steam-tools h2').textContent(), language === 'en' ? 'Open Tools' : '打开工具');
      assert.equal(await page.locator('.studio-steam-tab-list').getAttribute('aria-label'), language === 'en' ? 'Tool Workspace' : '工具工作区');
      // Configuration writes finish before asynchronous theme loading and CSS transitions.
      await until(() => page.locator('.studio-steam-tool').first().evaluate(button => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const luminance = color => {
          context.fillStyle = color; context.fillRect(0, 0, 1, 1);
          const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
            const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
          });
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        };
        const background = luminance(getComputedStyle(button).backgroundColor);
        const foreground = luminance(getComputedStyle(button.querySelector('.studio-steam-tool-label')).color);
        return { background, contrast: (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05) };
      }), value => value.contrast >= 4.5 && (theme.includes('Dark') ? value.background < .2 : value.background > .6), 'Tool cards did not finish applying the theme');
      await page.locator('.studio-steam-tools').evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
      });
      for (const width of [1440, 1024, 800]) {
        await page.setViewportSize({ width, height: 960 });
        const overflow = await page.locator('.studio-steam-tools').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
        assert.ok(overflow.scroll <= overflow.width + 1);
      }
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}.png`) });
    }
    check(`${language}: tools render in light/dark themes from 800 to 1440px without overflow`);
    await command('studio.enterIdeMode');
    await frame.locator('html:not([data-studio-window-chrome])').waitFor({ state: 'attached' });
    const transitions = await page.evaluate(() => window.studioModeTransitions);
    for (const distance of ['translateX(32px)', 'translateX(-32px)']) {
      assert.ok(transitions.some(effect => effect.frames[0].transform === distance && effect.frames[0].opacity === 0), JSON.stringify(transitions));
    }
    for (const part of ['titlebar', 'statusbar', 'sidebar', 'activitybar']) {
      assert.ok(transitions.some(effect => effect.part.includes(part) && effect.frames[1].opacity === 0), `${part} exits smoothly`);
    }
    await writeFile(path.join(proof, `${language}-transitions.json`), JSON.stringify(transitions, null, 2));
    check(`${language}: the workspace slides in opposite directions while the mode controls remain accessible`);
    const after = await partState();
    assert.equal(await layoutButtons.count(), ideLayoutButtons);
    assert.equal(await toggleTools.isVisible(), false);
    for (const part of Object.keys(before)) {
      assert.equal(after[part].visible, before[part].visible, part);
      if (before[part].visible) { assert.ok(Math.abs(after[part].width - before[part].width) < 2, part); }
    }
    const state = await call({ action: 'state' });
    assert.equal(state.active, documentUri); assert.ok(state.documents.some(document => document.uri === documentUri && document.dirty));
    assert.ok(state.groups.find(group => group.column === 1).tabs.some(tab => tab.uri === rightDocument && tab.dirty));
    await command('studio.enterSteamMode');
    assert.equal(frame.isDetached(), false); assert.equal(frame.url(), resultUrl);
    assert.ok((await frame.locator('.message.assistant').allTextContents()).join('').includes(`mode-persistence-${language}`));
    check(`${language}: IDE layout, dirty documents and the running result frame survive repeated switches`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await command('studio.enterIdeMode'); await command('studio.enterSteamMode');
    assert.equal(await page.locator('html.studio-mode-transition').count(), 0);
    check(`${language}: reduced motion skips transition effects`);
    await call({ action: 'file', path: toolsFile, column: 1 });
    await instanceList.locator('.tab').filter({ hasText: 'tools-only.txt' }).waitFor();
    await page.locator('.studio-steam-editors:visible .view-line').first().click({ trial: true });
    assert.equal(await call({ action: 'closeTab', column: 1, viewType: 'studio.project' }), true);
    await until(() => page.frames().includes(frame), value => !value, 'Closing the runtime did not dispose its frame');
    assert.equal(await mainGroups(), initialGroups);
    await command('studio.enterSteamMode');
    await until(async () => {
      const state = await call({ action: 'state' });
      return state.groups.find(group => group.column === 1)?.tabs.some(tab => tab.active && tab.viewType?.endsWith('studio.project'));
    }, Boolean, 'Reopening the project must use the left runtime group');
    const reopenedFrame = await until(async () => {
      for (const candidate of page.frames()) {
        if (await candidate.locator('#message').isVisible().catch(() => false)
          && await candidate.locator('#app').getAttribute('data-project-uri').catch(() => undefined) === pathToFileURL(project).href) { return candidate; }
      }
    }, Boolean, 'Reopened runtime did not load');
    const reopenedRect = await reopenedFrame.locator('#message').boundingBox(), runtimeRect = await page.locator('.part.editor:not(.studio-steam-editors)').boundingBox();
    assert.ok(reopenedRect.x >= runtimeRect.x && reopenedRect.x < runtimeRect.x + runtimeRect.width);
    assert.ok(!(await call({ action: 'state' })).groups.filter(group => group.column !== 1).some(group => group.tabs.some(tab => tab.viewType?.endsWith('studio.project'))));
    check(`${language}: closing and reopening the runtime keeps the project on the left with working content`);
    await command('studio.internalOpenSteamTool', 'kv'); await newInstanceButton.click();
    await until(() => instanceList.locator('.tab').count(), value => value === 2, 'The KV panel did not open before saving its query');
    await instanceList.locator('.tab.active').nth(0).waitFor();
    const persistedKv = await visibleToolFrame(toolSelectors.kv);
    await persistedKv.locator('#resource-search').fill(`kv-reload-${language}`);
    await call({ action: 'file', path: toolsFile, column: 1 });
    await rm(readyFile, { force: true });
    const reloaded = page.waitForEvent('domcontentloaded', { timeout: 60_000 });
    // The native reload path flushes editor mementos before unloading the workbench.
    await call({ action: 'reload' });
    await reloaded;
    bridge = await until(readReady, value => value.port || value.error, 'Studio extension restart timed out', 120_000);
    assert.equal(bridge.error, undefined, bridge.error);
    await until(() => steam.getAttribute('aria-pressed').catch(() => undefined), value => value === 'true', 'Saved Steam mode was not restored after reload', 120_000);
    await instanceList.locator('.tab').filter({ hasText: 'tools-only.txt' }).waitFor();
    await page.locator('.studio-steam-editors:visible .view-line').first().click({ trial: true });
    await command('studio.internalOpenSteamTool', 'kv');
    await until(() => instanceList.locator('.tab').count(), value => value === 2, 'Reload did not restore the KV instance');
    await instanceList.locator('.tab').nth(1).click();
    const restoredKv = await visibleToolFrame(toolSelectors.kv);
    assert.equal(await restoredKv.locator('#resource-search').inputValue(), `kv-reload-${language}`);
    check(`${language}: tool instances and their independent KV query survive workbench reload`);
    await command('studio.openSteamTools');
    assert.equal(await page.locator('.studio-steam-tools h2').textContent(), language === 'en' ? 'Open Tools' : '打开工具');
    check(`${language}: the workspace restores Steam mode after reload`);
    await command('studio.enterIdeMode');

    const source = await call({ action: 'untitled', text: 'Restore the maximized source group.' });
    const visibleGroups = () => page.locator('.part.editor:not(.studio-steam-editors) .editor-group-container').evaluateAll(elements => elements.filter(element => {
      const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none';
    }).length);
    await command('workbench.action.splitEditorRight');
    await until(visibleGroups, value => value === 2, 'IDE did not open two editor groups');
    const groupWidths = () => page.locator('.part.editor:not(.studio-steam-editors) .editor-group-container').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    const originalWidths = await groupWidths();
    await command('workbench.action.toggleMaximizeEditorGroup');
    await until(visibleGroups, value => value === 1, 'Editor group did not maximize');
    for (const reducedMotion of ['reduce', 'no-preference']) {
      await page.emulateMedia({ reducedMotion });
      for (let attempt = 0; attempt < 3; attempt++) {
        await command('studio.enterSteamMode'); await command('studio.enterIdeMode');
        await until(visibleGroups, value => value === 1, 'Original maximized editor group was not restored');
        assert.equal((await call({ action: 'state' })).active, source);
        await page.waitForTimeout(100);
        assert.equal(await visibleGroups(), 1);
      }
    }
    await command('workbench.action.toggleMaximizeEditorGroup');
    await until(visibleGroups, value => value === 2, 'Restored editor group could not unmaximize');
    const restoredWidths = await groupWidths();
    assert.ok(restoredWidths.every((width, index) => Math.abs(width - originalWidths[index]) < 2), JSON.stringify({ originalWidths, restoredWidths }));
    check(`${language}: maximized editor groups and their active source restore correctly`);

    if (!(await partState()).panel.visible) { await command('workbench.action.togglePanel'); }
    await command('workbench.action.toggleEditorVisibility');
    const editorVisible = () => page.locator('.part.editor:not(.studio-steam-editors)').evaluate(element => {
      const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none';
    });
    await until(editorVisible, value => !value, 'Panel did not maximize');
    await command('studio.enterSteamMode'); assert.equal(await editorVisible(), true);
    await command('studio.enterIdeMode'); assert.equal(await editorVisible(), false);
    assert.equal((await partState()).panel.visible, true);
    await command('workbench.action.toggleEditorVisibility');
    check(`${language}: a maximized panel restores after returning from Steam mode`);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        const effect = animate.call(this, frames, options);
        if (options?.fill === 'both') queueMicrotask(() => effect.cancel());
        return effect;
      };
    });
    await command('studio.enterSteamMode'); await command('studio.enterIdeMode');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('html.studio-mode-transition').count(), 0);
    check(`${language}: cancelled transition animations still finish without page errors`);

    await command('workbench.action.terminal.focus');
    await page.locator('.part.panel .integrated-terminal').waitFor();
    await call({ action: 'terminalInput', text: `export STEAMHARNESS_MODE_TEST='mode-${language}'` });
    await command('studio.enterSteamMode');
    await command('workbench.action.terminal.focus');
    await page.locator('.studio-steam-editors[data-tool=terminal]:visible .terminal-editor').first().waitFor();
    await command('workbench.action.terminal.new');
    await command('workbench.action.terminal.split');
    await until(() => instanceList.locator('.tab').count(), value => value >= 3, 'Terminal sessions did not appear in the child tab row');
    assert.equal(await page.locator('.part.auxiliarybar > .title > .title-actions').isVisible(), false);
    assert.ok(await instanceList.count() > 0);
    await instanceList.locator('.tab').first().click();
    assert.equal(await instanceList.locator('.tab').first().getAttribute('aria-selected'), 'true');
    const terminalsBeforeNew = await instanceList.locator('.tab').count();
    await page.locator('.studio-steam-editors[data-tool=terminal]:visible .editor-group-container.active .codicon-plus').click();
    await until(() => instanceList.locator('.tab').count(), value => value === terminalsBeforeNew + 1, 'The child-row add button did not create a shell session');
    const createdTerminal = page.locator('.studio-steam-editors:visible .editor-group-container.active .tab.active');
    await createdTerminal.locator('.tab-actions .action-label').click();
    await until(() => instanceList.locator('.tab').count(), value => value === terminalsBeforeNew, 'Terminal child close did not dispose its session');
    assert.equal((await partState()).panel.visible, false);
    assert.equal(await page.locator('.studio-steam-tab[data-tab=terminal]').count(), 1);
    await page.locator('.studio-steam-tab[data-tab=terminal] .studio-steam-tab-close').click();
    await until(() => page.locator('.studio-steam-tab[data-tab=terminal]').count(), value => value === 0, 'Closing the terminal category immediately reopened it');
    await command('workbench.action.terminal.focus');
    await page.locator('.studio-steam-editors[data-tool=terminal]:visible .terminal-editor').first().waitFor();
    assert.equal(await page.locator('.studio-steam-tab[data-tab=terminal]').count(), 1);
    assert.equal((await partState()).panel.visible, false);
    await command('studio.enterIdeMode');
    await command('workbench.action.terminal.focus');
    await page.locator('.part.panel .integrated-terminal').waitFor();
    const terminalProbe = path.join(directory, 'terminal-session.txt');
    const quotedProbe = `'${terminalProbe.replaceAll("'", "'\\''")}'`;
    await call({ action: 'terminalInput', text: `printf '%s' "$STEAMHARNESS_MODE_TEST" > ${quotedProbe}` });
    await until(async () => await exists(terminalProbe) ? readFile(terminalProbe, 'utf8') : undefined,
      value => value === `mode-${language}`, 'Mode changes lost the existing shell session');
    await command('workbench.action.terminal.killAll');
    check(`${language}: terminal commands, new sessions and splits use tools; closing its tab and returning to IDE retain the shell session`);

    await command('studio.enterSteamMode'); await command('studio.openSteamTools');
    const browserUrl = 'https://steam-browser.example.test/';
    await context.route(url => url.origin === new URL(browserUrl).origin, route => route.fulfill({ contentType: 'text/html', body: '<input id="browser-tool-probe" value="Browser tool">' }));
    await page.locator('.studio-steam-tool[data-tool=browser]').click();
    const urlPicker = page.locator('.quick-input-widget input'); await urlPicker.fill(browserUrl); await urlPicker.press('Enter');
    const browserFrame = await until(async () => {
      for (const candidate of page.frames()) { if (await candidate.locator('#browser-tool-probe').isVisible().catch(() => false)) { return candidate; } }
    }, Boolean, 'Browser did not open a working page in the tool workspace');
    const browserTabId = await page.locator('.studio-steam-tab.active').getAttribute('data-tab');
    await browserFrame.locator('#browser-tool-probe').fill('Retain this browser state');
    const browserRect = await browserFrame.locator('#browser-tool-probe').boundingBox(), browserToolsRect = await page.locator('.part.auxiliarybar').boundingBox();
    assert.ok(browserRect.x >= browserToolsRect.x && browserRect.x + browserRect.width <= browserToolsRect.x + browserToolsRect.width);
    await command('studio.openSteamTools');
    await page.locator(`.studio-steam-tab[data-tab="${browserTabId}"] .studio-steam-tab-select`).click();
    assert.equal(await browserFrame.locator('#browser-tool-probe').inputValue(), 'Retain this browser state');
    await browserFrame.locator('#browser-tool-probe').click({ trial: true });
    check(`${language}: the browser tool loads an interactive page on the right and retains its tab state`);
    const firstBrowserId = await instanceList.locator('.tab.active').getAttribute('data-resource-name');
    await newInstanceButton.click();
    await urlPicker.fill(`${browserUrl}second`); await urlPicker.press('Enter');
    await until(() => instanceList.locator('.tab').count(), value => value === 2, 'The browser did not create an independent page');
    const secondBrowser = await visibleToolFrame('#browser-tool-probe'); assert.notEqual(secondBrowser, browserFrame);
    const secondBrowserId = await instanceList.locator('.tab.active').getAttribute('data-resource-name');
    await secondBrowser.locator('#browser-tool-probe').fill('Second browser state');
    await instanceList.locator(`[data-resource-name="${firstBrowserId}"]`).click();
    assert.equal(await browserFrame.locator('#browser-tool-probe').inputValue(), 'Retain this browser state');
    await instanceList.locator(`[data-resource-name="${secondBrowserId}"]`).click();
    assert.equal(await secondBrowser.locator('#browser-tool-probe').inputValue(), 'Second browser state');
    await instanceList.locator(`[data-resource-name="${secondBrowserId}"] .tab-actions .action-label`).click();
    await browserFrame.locator('#browser-tool-probe').click({ trial: true });
    assert.equal(await instanceList.locator('.tab').count(), 1);
    assert.ok((await call({ action: 'state' })).groups.find(group => group.column === 1).tabs.some(tab => tab.active && tab.viewType?.endsWith('studio.project')));
    check(`${language}: browser child tabs keep separate interactive pages and closing one preserves the other`);

    await command('studio.openSteamTools'); await page.locator('.studio-steam-tool[data-tool=project]').click();
    await page.locator('.quick-input-widget').waitFor(); await page.locator('.quick-input-widget input').press('Escape');
    const otherProject = path.join(directory, 'external-project'); await mkdir(otherProject);
    await mkdir(path.join(otherProject, 'node_modules/@steamharness'), { recursive: true });
    await symlink(path.join(sourceRoot, 'harness'), path.join(otherProject, 'node_modules/steamharness'), 'dir');
    await symlink(path.join(sourceRoot, 'cli'), path.join(otherProject, 'node_modules/@steamharness/cli'), 'dir');
    await copyFile(path.join(project, 'index.ts'), path.join(otherProject, 'index.ts'));
    const otherManifest = structuredClone(manifest); otherManifest.id = '71d1bc8c-7701-4a75-9ab0-1e301c353239'; otherManifest.name = 'external-tool-project';
    otherManifest.steamHarness.projectInfo.localizedNames = { en: 'External Tool Project', 'zh-cn': '工具区外部项目' };
    await writeFile(path.join(otherProject, 'package.json'), JSON.stringify(otherManifest));
    const foldersBeforeOther = (await call({ action: 'state' })).folders;
    await command('studio.openProjectInTab', otherProject);
    const findProjectFrame = uri => until(async () => {
      for (const candidate of page.frames()) {
        if (await candidate.locator('#message').isVisible().catch(() => false)
          && await candidate.locator('#app').getAttribute('data-project-uri').catch(() => undefined) === uri) { return candidate; }
      }
    }, Boolean, `Project frame did not open: ${uri}`);
    const otherFrame = await findProjectFrame(pathToFileURL(otherProject).href);
    await otherFrame.locator('#message').fill(`other-project-${language}`); await otherFrame.locator('#send').click();
    await until(() => otherFrame.locator('.message.assistant').allTextContents(), values => values.join('').includes(`other-project-${language}`), 'The other project did not run');
    const otherRect = await otherFrame.locator('#message').boundingBox(); assert.ok(otherRect.x >= browserToolsRect.x);
    const leftProjectFrame = await findProjectFrame(pathToFileURL(project).href);
    const leftRect = await leftProjectFrame.locator('#message').boundingBox(); assert.ok(leftRect.x < browserToolsRect.x);
    await command('studio.openProjectInTab', otherProject);
    assert.deepEqual((await call({ action: 'state' })).folders, foldersBeforeOther);
    await rm(readyFile, { force: true });
    const otherReloaded = page.waitForEvent('domcontentloaded', { timeout: 60_000 }); await call({ action: 'reload' }); await otherReloaded;
    bridge = await until(readReady, value => value.port || value.error, 'Studio extension restart timed out', 120_000); assert.equal(bridge.error, undefined);
    await until(() => steam.getAttribute('aria-pressed').catch(() => undefined), value => value === 'true', 'Steam mode did not restore', 120_000);
    const restoredOther = await findProjectFrame(pathToFileURL(otherProject).href), restoredLeft = await findProjectFrame(pathToFileURL(project).href);
    const restoredToolsRect = await page.locator('.part.auxiliarybar').boundingBox();
    assert.equal(await restoredOther.locator('#app').getAttribute('data-studio-window-chrome'), null);
    await restoredLeft.locator('#app[data-studio-window-chrome]').waitFor();
    assert.ok((await restoredOther.locator('#message').boundingBox()).x >= restoredToolsRect.x);
    assert.ok((await restoredLeft.locator('#message').boundingBox()).x < restoredToolsRect.x);
    assert.deepEqual((await call({ action: 'state' })).folders, foldersBeforeOther);
    check(`${language}: another real project runs in a right-hand tab and reload preserves both project surfaces and the original workspace`);
  } catch (error) {
    console.error(error.stack ?? error);
    const logs = path.join(directory, 'server/data/logs');
    for (const file of await readdir(logs, { recursive: true })) {
      if (file.endsWith('-Studio.log') || file.endsWith('remoteexthost.log')) {
        log += `\n${file}\n${(await readFile(path.join(logs, file), 'utf8')).slice(-10_000)}`;
      }
    }
    await writeFile(path.join(proof, `${language}-server.log`), log);
    await writeFile(path.join(proof, `${language}-errors.json`), JSON.stringify({ errors, consoleMessages,
      nativeTabs: await page?.locator('.studio-steam-editors:visible .tab').evaluateAll(elements => elements.map(element => element.outerHTML)),
      auxiliary: await page?.locator('.part.auxiliarybar').evaluate(element => element.innerHTML.slice(0, 15_000)).catch(() => ''),
      frames: page?.frames().map(frame => frame.url()),
      frameContents: await Promise.all((page?.frames() ?? []).map(async frame => ({
        url: frame.url(), body: await frame.locator('body').innerText({ timeout: 500 }).catch(() => ''),
        html: await frame.locator('body').innerHTML({ timeout: 500 }).then(value => value.slice(-2000)).catch(() => ''),
      }))),
      layout: await page?.evaluate(() => [...document.querySelectorAll('.part.auxiliarybar, .part.editor, .part.editor .editor-container, .monaco-grid-view, .webview-overlay-content, .webview-overlay-content > iframe')].map(element => ({
        computed: {height: getComputedStyle(element).height, margin: getComputedStyle(element).margin, padding: getComputedStyle(element).padding, border: getComputedStyle(element).border, box: getComputedStyle(element).boxSizing}, class: element.className, style: element.getAttribute('style'), parentStyle: element.parentElement.getAttribute('style'),
        rect: element.getBoundingClientRect().toJSON(), parentRect: element.parentElement.getBoundingClientRect().toJSON(), visibility: getComputedStyle(element).visibility,
      }))).catch(() => []),
    }, null, 2));
    await page?.screenshot({ path: path.join(proof, `${language}-failure.png`) }).catch(() => undefined);
    throw error;
  } finally {
    await writeFile(path.join(proof, `${language}-console.json`), JSON.stringify({ consoleMessages }, null, 2));
    await browser?.close();
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
await writeFile(path.join(proof, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
assert.deepEqual(errors, []);
