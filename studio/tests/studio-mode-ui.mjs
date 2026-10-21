import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { ROOT, assertRuntime, assertUpstream, exists } from '../scripts/distribution.mjs';

await assertRuntime();
const upstream = await assertUpstream();
const proof = path.join(ROOT, '.studio/studio-mode-ui');
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

for (const language of ['en', 'zh-cn']) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-mode-ui-')));
  const folder = path.join(directory, 'workspace'), extension = path.join(directory, 'extensions/mode-test');
  const readyFile = path.join(directory, 'ready.json'), token = randomBytes(24).toString('hex');
  let child, browser, page, log = '';
  try {
    await mkdir(folder); await mkdir(extension, { recursive: true }); await mkdir(path.join(folder, '.vscode'));
    await writeFile(path.join(folder, '.vscode/settings.json'), JSON.stringify({ 'editor.editContext': false,
      'window.autoDetectColorScheme': false, 'workbench.startupEditor': 'none', 'git.enabled': false }));
    await writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'mode-test', publisher: 'studio-test', version: '0.0.1',
      engines: { vscode: '^1.140.0' }, main: './extension.cjs', extensionKind: ['workspace'], activationEvents: ['onStartupFinished'] }));
    await build({ entryPoints: [path.join(ROOT, 'tests/start-page-ui-extension.mjs')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(extension, 'extension.cjs') });
    await useCachedLanguagePack(directory, language);
    child = spawn(process.execPath, [path.join(upstream.directory, 'scripts/code-server.js'), '--host', '127.0.0.1', '--port', '0',
      '--connection-token', token, '--server-data-dir', path.join(directory, 'server'), '--extensions-dir', path.join(directory, 'extensions'),
      '--builtin-extensions-dir', path.join(upstream.directory, 'extensions'), '--disable-workspace-trust', '--force-disable-user-env',
      '--telemetry-level', 'off', '--default-folder', folder], { cwd: upstream.directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_ENV: 'development', VSCODE_DEV: '1', STUDIO_STEAMHARNESS_SOURCE: path.resolve(ROOT, '..'),
      STEAMHARNESS_CLI_AUTH_DIR: path.join(directory, 'auth'), STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '',
      STUDIO_START_TEST_READY: readyFile, STUDIO_START_TEST_TOKEN: token,
      VSCODE_SKIP_BUILTIN_EXTENSIONS: 'vscode.vscode-api-tests,GitHub.copilot,GitHub.copilot-chat' } });
    for (const stream of [child.stdout, child.stderr]) { stream.on('data', chunk => { log += chunk.toString().replaceAll(token, '[redacted]'); }); }
    const address = await until(() => log, value => /Web UI available at http:\/\/[^:/\s]+:(\d+)/.test(value) || /Extension host agent listening on (\d+)/.test(value), 'Studio server startup timed out');
    const port = /Web UI available at http:\/\/[^:/\s]+:(\d+)/.exec(address)?.[1] ?? /Extension host agent listening on (\d+)/.exec(address)?.[1];
    browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: language === 'en' ? 'en-US' : 'zh-CN' });
    await context.addCookies([{ name: 'vscode.nls.locale', value: language, domain: '127.0.0.1', path: '/' }]);
    await context.addInitScript(language => { globalThis._VSCODE_NLS_LANGUAGE = language; }, language);
    await context.route(/https:\/\/[^/]+\.vscode-cdn\.net\/.*\/webview\/browser\/pre\/(?:index\.html|fake\.html|service-worker\.js)(?:\?|$)/, async route => {
      const filename = path.posix.basename(new URL(route.request().url()).pathname);
      await route.fulfill({ path: path.join(upstream.directory, 'out/vs/workbench/contrib/webview/browser/pre', filename), contentType: filename.endsWith('.js') ? 'application/javascript' : 'text/html' });
    });
    page = await context.newPage();
    page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
    page.on('pageerror', error => errors.push(`${language}: ${error.message}`));
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
    const steam = page.locator('.studio-mode-steam');
    await steam.waitFor(); assert.equal(await steam.isDisabled(), true);
    await command('studio.enterSteamMode'); assert.equal(await page.locator('.studio-steam-mode').count(), 0);
    check(`${language}: ordinary folder stays in IDE mode`);

    if (language === 'en') {
      const geometry = await page.locator('.studio-mode-switcher').evaluate(switcher => {
        const shell = document.createElement('div'); shell.className = 'monaco-workbench mac';
        shell.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:35px;';
        shell.innerHTML = '<div class="part titlebar"><div class="titlebar-container"><div class="titlebar-left"></div></div></div>';
        const titlebar = shell.querySelector('.titlebar-container');
        const left = shell.querySelector('.titlebar-left'); left.append(switcher.cloneNode(true));
        document.body.append(shell);
        const measurements = [];
        for (const zoom of [1, 1.5, .8]) {
          // Match Electron's zoomed content while its native window controls remain unscaled.
          shell.style.zoom = String(zoom); shell.style.setProperty('--zoom-factor', String(zoom));
          titlebar.classList.toggle('counter-zoom', zoom < 1);
          const rect = left.querySelector('.studio-mode-switcher').getBoundingClientRect();
          measurements.push(rect.left - left.getBoundingClientRect().left);
        }
        shell.style.zoom = '1'; shell.classList.add('fullscreen'); titlebar.classList.remove('counter-zoom');
        const fullscreen = left.querySelector('.studio-mode-switcher').getBoundingClientRect().left - left.getBoundingClientRect().left;
        shell.remove(); return { measurements, fullscreen };
      });
      assert.ok(geometry.measurements.every(inset => inset >= 70), JSON.stringify(geometry));
      assert.ok(geometry.fullscreen < 16);
      check('macOS: mode controls clear native window buttons at different zoom levels and reclaim the space in fullscreen');
    }

    const project = path.join(folder, 'conversation'); await mkdir(project);
    await mkdir(path.join(project, 'node_modules/@steamharness'), { recursive: true });
    await symlink(path.resolve(ROOT, '../harness'), path.join(project, 'node_modules/steamharness'), 'dir');
    await symlink(path.resolve(ROOT, '../cli'), path.join(project, 'node_modules/@steamharness/cli'), 'dir');
    await copyFile(path.join(ROOT, 'examples/conversation/index.ts'), path.join(project, 'index.ts'));
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'examples/conversation/package.json'), 'utf8'));
    manifest.devDependencies = {
      steamharness: JSON.parse(await readFile(path.resolve(ROOT, '../harness/package.json'), 'utf8')).version,
      '@steamharness/cli': JSON.parse(await readFile(path.resolve(ROOT, '../cli/package.json'), 'utf8')).version,
    };
    await writeFile(path.join(project, 'package.json'), JSON.stringify(manifest));
    await command('studio.refreshProjectView');
    await until(() => steam.isEnabled(), Boolean, 'Project mode did not become available');
    const documentUri = await call({ action: 'untitled', text: 'Preserve this unsaved document during mode switches.' });
    const partState = () => page.evaluate(() => Object.fromEntries(['activitybar', 'sidebar', 'panel', 'auxiliarybar'].map(part => {
      const element = document.querySelector(`.part.${part}`), rect = element?.getBoundingClientRect();
      return [part, { visible: !!rect?.width && !!rect?.height && getComputedStyle(element).display !== 'none', width: rect?.width }];
    })));
    const before = await partState();

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
      assert.equal(await page.locator('.studio-mode-switcher').getAttribute('aria-busy'), 'true');
      assert.equal(await page.locator('html.studio-mode-transition').count(), 0);
      await page.screenshot({ path: path.join(proof, `${language}-loading.png`) });
      await page.locator('.studio-mode-ide').click();
      await until(() => page.locator('.studio-mode-switcher').getAttribute('aria-busy'), value => value === 'false', 'IDE waited for the blocked project iframe');
      assert.equal(await steam.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('.studio-mode-loading').isVisible(), false);
      assert.equal((await call({ action: 'state' })).active, documentUri);
    } finally {
      releaseFrame(); await context.unroute(frameRoute);
    }
    check(`${language}: slow frame loading stays visible and returning to IDE cancels the wait`);

    await page.evaluate(() => {
      const start = document.startViewTransition.bind(document);
      window.studioModeTransitions = [];
      document.startViewTransition = callback => {
        const direction = document.documentElement.classList.contains('studio-mode-enter-steam') ? 'steam' : 'ide';
        const transition = start(callback);
        void transition.ready.then(() => {
          window.studioModeTransitions.push({ direction, animations: document.getAnimations().filter(animation =>
            ['studio-mode-in', 'studio-mode-out'].includes(animation.animationName)).map(animation => ({
            name: animation.animationName, transforms: animation.effect.getKeyframes().map(frame => frame.transform),
          })), titlebar: getComputedStyle(document.documentElement, '::view-transition-new(studio-mode-titlebar)').animationName });
        }, () => undefined);
        return transition;
      };
    });
    await steam.click(); await page.locator('.studio-steam-tools').waitFor({ timeout: 90_000 });
    await until(() => page.locator('.studio-mode-switcher').getAttribute('aria-busy'), value => value === 'false', 'Steam mode switch did not finish');
    const during = await partState();
    assert.equal(during.activitybar.visible, false); assert.equal(during.sidebar.visible, false); assert.equal(during.panel.visible, false);
    assert.equal(during.auxiliarybar.visible, true);
    const geometry = await page.locator('.part.editor').boundingBox(), toolsGeometry = await page.locator('.part.auxiliarybar').boundingBox();
    assert.ok(geometry.x < toolsGeometry.x && geometry.x + geometry.width <= toolsGeometry.x + 2);
    check(`${language}: Steam places project results on the left and tools on the right`);

    const frame = await until(async () => {
      for (const frame of page.frames()) {
        if (await frame.locator('#message').isVisible().catch(() => false)
          && await frame.locator('#app').getAttribute('data-project-uri').catch(() => undefined) === pathToFileURL(project).href) { return frame; }
      }
    }, Boolean, 'Project result frame did not open');
    await frame.locator('#message').fill(`mode-persistence-${language}`); await frame.locator('#send').click();
    await frame.locator('#app[data-run-state=idle]').waitFor();
    await until(() => frame.locator('.message.assistant').count(), value => value > 0, 'Local project did not produce a result');
    const resultUrl = frame.url();
    for (const tool of ['kv', 'knowledge', 'info', 'assistant', 'versions', 'trace']) {
      await command('studio.openSteamTools'); await page.locator(`.studio-steam-tool[data-tool="${tool}"]`).click();
      const selector = { kv: 'body[data-resource-kind=kv]', knowledge: 'body[data-resource-kind=knowledge]', info: '#info-app', assistant: '#app', versions: '#versions-app', trace: '#trace-app' }[tool];
      await until(async () => {
        for (const candidate of page.frames()) {
          if (candidate === frame || !await candidate.locator(selector).count().catch(() => 0)) { continue; }
          let current = candidate, visible = true;
          while (current.parentFrame()) {
            if (!await (await current.frameElement()).isVisible()) { visible = false; break; }
            current = current.parentFrame();
          }
          if (visible) { return candidate; }
        }
      }, Boolean, `Tool view did not open: ${tool}`);
      assert.equal((await partState()).panel.visible, false);
    }
    check(`${language}: all six tools open in the right sidebar`);

    for (const theme of ['Default Dark Modern', 'Default Light Modern']) {
      await call({ action: 'theme', theme }); await command('studio.openSteamTools');
      assert.equal(await page.locator('.studio-steam-tools h2').textContent(), language === 'en' ? 'Open Tools' : '打开工具');
      assert.equal(await page.locator('.part.auxiliarybar .action-item.checked[role=tab] .action-label').textContent(), language === 'en' ? 'Open Tools' : '打开工具');
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
    const transitions = await page.evaluate(() => window.studioModeTransitions);
    for (const direction of ['steam', 'ide']) {
      const transition = transitions.find(transition => transition.direction === direction && transition.animations.length === 2);
      assert.ok(transition, JSON.stringify(transitions));
      assert.equal(transition.titlebar, 'none');
      const incoming = transition.animations.find(animation => animation.name === 'studio-mode-in');
      assert.ok(incoming.transforms[0].includes(direction === 'steam' ? '100%' : '-100%'), JSON.stringify(incoming));
    }
    await writeFile(path.join(proof, `${language}-transitions.json`), JSON.stringify(transitions, null, 2));
    check(`${language}: the workspace slides in opposite directions while the titlebar stays fixed`);
    const after = await partState();
    for (const part of Object.keys(before)) {
      assert.equal(after[part].visible, before[part].visible, part);
      if (before[part].visible) { assert.ok(Math.abs(after[part].width - before[part].width) < 2, part); }
    }
    const state = await call({ action: 'state' });
    assert.equal(state.active, documentUri); assert.ok(state.documents.some(document => document.uri === documentUri && document.dirty));
    await command('studio.enterSteamMode');
    assert.equal(frame.isDetached(), false); assert.equal(frame.url(), resultUrl);
    assert.ok((await frame.locator('.message.assistant').allTextContents()).join('').includes(`mode-persistence-${language}`));
    check(`${language}: IDE layout, dirty documents and the running result frame survive repeated switches`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await command('studio.enterIdeMode'); await command('studio.enterSteamMode');
    assert.equal(await page.locator('html.studio-mode-transition').count(), 0);
    check(`${language}: reduced motion skips transition effects`);
    await rm(readyFile, { force: true });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    bridge = await until(readReady, value => value.port || value.error, 'Studio extension restart timed out', 120_000);
    assert.equal(bridge.error, undefined, bridge.error);
    await until(() => steam.getAttribute('aria-pressed').catch(() => undefined), value => value === 'true', 'Saved Steam mode was not restored after reload', 120_000);
    await command('studio.openSteamTools');
    assert.equal(await page.locator('.studio-steam-tools h2').textContent(), language === 'en' ? 'Open Tools' : '打开工具');
    check(`${language}: the workspace restores Steam mode after reload`);
    await command('studio.enterIdeMode');

    const source = await call({ action: 'untitled', text: 'Restore the maximized source group.' });
    const visibleGroups = () => page.locator('.part.editor .editor-group-container').evaluateAll(elements => elements.filter(element => {
      const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none';
    }).length);
    await command('workbench.action.splitEditorRight');
    await until(visibleGroups, value => value === 2, 'IDE did not open two editor groups');
    const groupWidths = () => page.locator('.part.editor .editor-group-container').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
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
    const editorVisible = () => page.locator('.part.editor').evaluate(element => {
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
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = callback => { const transition = start(callback); transition.skipTransition(); return transition; };
    });
    await command('studio.enterSteamMode'); await command('studio.enterIdeMode');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('html.studio-mode-transition').count(), 0);
    check(`${language}: skipped transition animations still finish without page errors`);
  } catch (error) {
    const logs = path.join(directory, 'server/data/logs');
    for (const file of await readdir(logs, { recursive: true })) {
      if (file.endsWith('-Studio.log') || file.endsWith('remoteexthost.log')) {
        log += `\n${file}\n${(await readFile(path.join(logs, file), 'utf8')).slice(-10_000)}`;
      }
    }
    await writeFile(path.join(proof, `${language}-server.log`), log);
    await writeFile(path.join(proof, `${language}-errors.json`), JSON.stringify({ errors,
      auxiliary: await page?.locator('.part.auxiliarybar').evaluate(element => element.innerHTML.slice(0, 15_000)).catch(() => ''),
      frames: page?.frames().map(frame => frame.url()),
    }, null, 2));
    await page?.screenshot({ path: path.join(proof, `${language}-failure.png`) }).catch(() => undefined);
    throw error;
  } finally {
    await browser?.close();
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
}
await writeFile(path.join(proof, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
assert.deepEqual(errors, []);
