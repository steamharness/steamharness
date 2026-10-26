import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { ROOT, assertRuntime, assertUpstream, exists } from '../scripts/distribution.mjs';

await assertRuntime();
const upstream = await assertUpstream();
const layoutOnly = process.argv.includes('--layout-only');
const proof = path.join(ROOT, layoutOnly ? '.studio/start-page-layout-ui' : '.studio/start-page-ui'); await mkdir(proof, { recursive: true });
const { createProjectFromTemplate, listProjectTemplates } = await import('../extensions/studio-workstation/dist/project-templates.mjs');
const versions = JSON.parse(await readFile(path.join(ROOT, 'extensions/studio-workstation/dist/project-template-versions.json'), 'utf8'));
const checks = [], errors = [];
const check = message => { checks.push(message); console.log(`[OK] ${message}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) { return value; } await pause(100); }
  throw new Error(message);
}
for (const language of ['en', 'zh-cn']) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-start-ui-')));
  const workdir = path.join(directory, 'projects'), extension = path.join(directory, 'extensions/start-test');
  const readyFile = path.join(directory, 'ready.json'), token = randomBytes(24).toString('hex');
  let browser, child, page, log = '';
  try {
    await mkdir(workdir, { recursive: true }); await mkdir(extension, { recursive: true });
    if (language === 'zh-cn' && process.env.STEAMHARNESS_UI_LANGUAGE_PACK) {
      const location = await realpath(process.env.STEAMHARNESS_UI_LANGUAGE_PACK);
      const contents = await readFile(path.join(location, 'package.json'), 'utf8'), manifest = JSON.parse(contents);
      const localization = manifest.contributes?.localizations?.find(entry => entry.languageId === language);
      assert.ok(localization, `The cached language pack does not support ${language}`);
      const data = path.join(directory, 'server/data'); await mkdir(data, { recursive: true });
      await writeFile(path.join(data, 'languagepacks.json'), JSON.stringify({ [language]: {
        hash: createHash('sha256').update(contents).digest('hex'), label: localization.localizedLanguageName,
        extensions: [{ extensionIdentifier: { id: `${manifest.publisher}.${manifest.name}` }, version: manifest.version }],
        translations: Object.fromEntries(localization.translations.map(entry => [entry.id, path.resolve(location, entry.path)])),
      } }));
    }
    const bin = path.join(directory, 'bin'); await mkdir(bin);
    const installer = path.join(ROOT, 'tests/start-page-ui-install.cjs');
    await writeFile(path.join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), process.platform === 'win32'
      ? `@"${process.execPath}" "${installer}" %*\r\n` : `#!${process.execPath}\nrequire(${JSON.stringify(installer)});\n`, { mode: 0o755 });
    const projects = [];
    for (const template of await listProjectTemplates()) {
      const project = await createProjectFromTemplate({ templateId: template.id, name: template.id, parentDirectory: workdir, versions });
      await symlink(path.join(ROOT, 'examples/conversation/node_modules'), path.join(project.directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      projects.push(project);
    }
    const emptyFile = path.join(workdir, 'empty.txt'); await writeFile(emptyFile, '');
    await mkdir(path.join(workdir, '.vscode'));
    await writeFile(path.join(workdir, '.vscode/settings.json'), JSON.stringify({ 'editor.editContext': false, 'window.autoDetectColorScheme': false,
      'editor.minimap.enabled': true, 'editor.minimap.autohide': 'none',
      'workbench.startupEditor': 'none', 'git.enabled': false, 'files.simpleDialog.enable': true }));
    await writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'start-test', publisher: 'studio-test', version: '0.0.1',
      engines: { vscode: '^1.140.0' }, main: './extension.cjs', extensionKind: ['workspace'], activationEvents: ['onStartupFinished'] }));
    await build({ entryPoints: [path.join(ROOT, 'tests/start-page-ui-extension.mjs')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(extension, 'extension.cjs') });
    child = spawn(process.execPath, [path.join(upstream.directory, 'scripts/code-server.js'), '--host', '127.0.0.1', '--port', '0',
      '--connection-token', token, '--server-data-dir', path.join(directory, 'server'), '--extensions-dir', path.join(directory, 'extensions'),
      '--builtin-extensions-dir', path.join(upstream.directory, 'extensions'), '--disable-workspace-trust', '--force-disable-user-env', '--telemetry-level', 'off', '--default-folder', workdir],
    { cwd: upstream.directory, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, STUDIO_START_TEST_NODE_MODULES: path.join(ROOT, 'examples/conversation/node_modules'),
      STUDIO_START_TEST_PROJECT_DIRECTORIES: JSON.stringify([path.join(workdir, `new-window-${language}`), path.join(workdir, `same-window-${language}`)]),
      NODE_ENV: 'development', VSCODE_DEV: '1', STUDIO_STEAMHARNESS_SOURCE: path.resolve(ROOT, '..'), STEAMHARNESS_CLI_AUTH_DIR: path.join(directory, 'auth'),
      STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '', STUDIO_START_TEST_READY: readyFile, STUDIO_START_TEST_TOKEN: token,
      VSCODE_SKIP_BUILTIN_EXTENSIONS: 'vscode.vscode-api-tests,GitHub.copilot,GitHub.copilot-chat' } });
    for (const stream of [child.stdout, child.stderr]) { stream.on('data', chunk => { log += chunk.toString().replaceAll(token, '[redacted]'); }); }
    const port = await until(() => log, text => /Web UI available at http:\/\/[^:/\s]+:(\d+)/.test(text) || /Extension host agent listening on (\d+)/.test(text), 'Studio server startup timed out')
      .then(text => /Web UI available at http:\/\/[^:/\s]+:(\d+)/.exec(text)?.[1] ?? /Extension host agent listening on (\d+)/.exec(text)?.[1]);
    browser = await chromium.launch({ channel: process.env.STUDIO_START_TEST_BROWSER || undefined,
      executablePath: process.env.STUDIO_START_TEST_BROWSER_PATH || undefined, headless: true,
      args: ['--disable-features=LocalNetworkAccessChecks'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: language === 'en' ? 'en-US' : 'zh-CN' });
    await context.addCookies([{ name: 'vscode.nls.locale', value: language, domain: '127.0.0.1', path: '/' }]);
    // Source workbenches do not load a language pack before initializing the extension host.
    await context.addInitScript(language => { globalThis._VSCODE_NLS_LANGUAGE = language; }, language);
    // Keep the Webview origin validation while serving its bootstrap from this checkout.
    await context.route(/https:\/\/[^/]+\.vscode-cdn\.net\/.*\/webview\/browser\/pre\/(?:index\.html|fake\.html|service-worker\.js)(?:\?|$)/, async route => {
      const filename = path.posix.basename(new URL(route.request().url()).pathname);
      await route.fulfill({ path: path.join(upstream.directory, 'out/vs/workbench/contrib/webview/browser/pre', filename),
        contentType: filename.endsWith('.js') ? 'application/javascript' : 'text/html' });
    });
    page = await context.newPage(); page.on('pageerror', error => errors.push(`${language}: ${error.message}`));
    await page.goto(`http://127.0.0.1:${port}/?tkn=${token}`, { waitUntil: 'domcontentloaded' });
    let bridge = await until(async () => await exists(readyFile) ? JSON.parse(await readFile(readyFile, 'utf8')) : {}, value => value.port || value.error, 'Studio extension startup timed out', 120_000);
    assert.equal(bridge.error, undefined, bridge.error);
    const call = async (input, port = bridge.port) => {
      const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(60_000) });
      const body = await response.json(); assert.equal(response.status, 200, body.error); return body.result;
    };
    const command = (command, ...args) => call({ action: 'command', command, args });
    const start = () => page.locator('.studio-start:visible').last();
    const findFrame = async (selector, projectUri) => {
      for (const frame of page.frames()) {
        if (!await frame.locator(selector).first().isVisible().catch(() => false)) { continue; }
        if (projectUri && await frame.locator('#app').getAttribute('data-project-uri').catch(() => undefined) !== projectUri) { continue; }
        let current = frame, visible = true;
        while (current.parentFrame()) {
          if (!await (await current.frameElement()).isVisible()) { visible = false; break; }
          current = current.parentFrame();
        }
        if (visible) { return frame; }
      }
    };
    await command('workbench.action.closeAllEditors');
    const initial = await until(() => call({ action: 'state' }), state => state.start.templates.length === 7 && (layoutOnly || state.start.projects.length === 7), 'Current projects were not scanned');
    assert.equal(initial.language, language);
    await command('workbench.action.closeSidebar'); await command('workbench.action.closeAuxiliaryBar');
    const settingsAction = page.locator('.activitybar').getByRole('button', { name: language === 'en' ? 'Settings' : '设置', exact: true });
    await settingsAction.waitFor();
    assert.equal(await settingsAction.getAttribute('aria-haspopup'), null, 'Settings is a direct action');
    for (const input of ['click', 'Enter', 'Space']) {
      if (input === 'click') { await settingsAction.click(); }
      else { await settingsAction.focus(); await settingsAction.press(input); }
      await until(() => call({ action: 'state' }), state => state.groups.some(group => group.tabs.some(tab => tab.viewType?.endsWith('studio.settings'))), 'The activity bar did not open Studio settings');
      await page.locator('.tabs-container .tab').filter({ hasText: language === 'en' ? 'Settings' : '设置' }).waitFor();
      assert.equal(await page.locator('.context-view .monaco-menu:visible').count(), 0, 'Settings must open without the Manage popup');
      await command('workbench.action.closeAllEditors');
    }
    check(`${language}: the settings gear opens Studio settings directly with the mouse, Enter and Space`);
    // Exercise the real native view with a delayed state source, independent of extension startup speed.
    await page.evaluate(async () => {
      const { StudioStartView } = await import(new URL('vs/workbench/browser/parts/editor/studioStart.js', globalThis._VSCODE_FILE_ROOT).href);
      const { Emitter } = await import(new URL('vs/base/common/event.js', globalThis._VSCODE_FILE_ROOT).href);
      const host = document.createElement('div'); host.className = 'studio-start-loading-test';
      Object.assign(host.style, { position: 'absolute', inset: '0', zIndex: '10' });
      document.querySelector('.editor-group-container').append(host);
      const change = new Emitter();
      const service = { state: undefined, onDidChange: change.event, setVisible() {} };
      const view = new StudioStartView(host, service, { executeCommand: async () => undefined });
      globalThis.studioStartLoadingTest = { host, change, service, view };
    });
    try {
      const loading = page.locator('.studio-start-loading-test > .studio-start');
      const checkHeaderLayouts = async phase => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
          await call({ action: 'theme', theme });
          await page.waitForFunction(dark => document.querySelector('.monaco-workbench')?.classList.contains('vs-dark') === dark, theme.includes('Dark'));
          for (const width of [1200, 600, 420, 360, 320, 280, 240]) {
            await page.evaluate(width => { globalThis.studioStartLoadingTest.host.style.width = `${width}px`; }, width);
            const bounds = await loading.evaluate(element => {
              const header = element.querySelector('.studio-start-header');
              const badge = header.querySelector('.studio-start-badge');
              return { client: element.clientWidth, scroll: element.scrollWidth,
                header: header.getBoundingClientRect().toJSON(),
                logo: header.querySelector('.studio-start-logo').getBoundingClientRect().toJSON(),
                title: header.querySelector('h1').getBoundingClientRect().toJSON(),
                badge: { visible: badge.checkVisibility(), ...badge.getBoundingClientRect().toJSON() },
                refresh: header.querySelectorAll('[data-action="studio.refreshStart"]').length,
                actions: [...header.querySelectorAll('button')].filter(button => button.checkVisibility()).map(button => button.getBoundingClientRect().toJSON()) };
            });
            const context = `${language} ${theme} ${phase} ${width}: ${JSON.stringify(bounds)}`;
            assert.ok(bounds.scroll <= bounds.client + 1, `The view must fit its editor group: ${context}`);
            assert.ok(Math.abs((bounds.logo.top + bounds.logo.bottom) / 2 - (bounds.title.top + bounds.title.bottom) / 2) <= 1,
              `The logo must remain beside the title: ${context}`);
            assert.ok(bounds.logo.left >= bounds.header.left && bounds.logo.right <= bounds.title.left && bounds.title.right <= bounds.header.right + 1,
              `Brand elements must fit without overlapping: ${context}`);
            assert.equal(bounds.refresh, 0, 'The start header must not expose a refresh button');
            if (phase === 'loaded' && width > 600) {
              assert.ok(bounds.badge.visible && bounds.badge.left >= bounds.title.right && bounds.badge.right <= bounds.header.right,
                `The enhanced badge must follow the title: ${context}`);
              assert.ok(Math.abs((bounds.badge.top + bounds.badge.bottom) / 2 - (bounds.title.top + bounds.title.bottom) / 2) <= 1,
                `The enhanced badge must align with the title: ${context}`);
              assert.ok(bounds.actions.every(action => action.left >= bounds.badge.right), `Header actions must follow the brand: ${context}`);
            }
            for (const action of bounds.actions) {
              assert.ok(action.left >= bounds.header.left && action.right <= bounds.header.right + 1,
                `Header actions must fit the editor group: ${context}`);
              if (width <= 600) {
                assert.ok(action.top >= Math.max(bounds.logo.bottom, bounds.title.bottom), `Narrow actions must follow the brand: ${context}`);
              }
            }
            if (width === 280 || width === 1200) {
              await loading.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-${phase}-header-${width}.png`) });
            }
          }
        }
        await page.evaluate(() => { globalThis.studioStartLoadingTest.host.style.width = ''; });
        check(`${language}: ${phase} header keeps the logo beside the title and actions in bounds across 240-1200px editor groups in both themes`);
      };
      for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
        await call({ action: 'theme', theme });
        await page.waitForFunction(dark => document.querySelector('.monaco-workbench')?.classList.contains('vs-dark') === dark, theme.includes('Dark'));
        for (const width of [1440, 420]) {
          await page.setViewportSize({ width, height: width === 420 ? 780 : 1000 });
          assert.equal(await loading.getAttribute('aria-busy'), 'true');
          assert.equal(await loading.locator('[role="progressbar"]').isVisible(), true);
          assert.equal(await loading.locator('button:visible').count(), 0, 'Loading must not expose unlabeled actions');
          assert.equal(await loading.locator('h2:visible').count(), 0, 'Loading must not expose empty section headings');
          const bounds = await loading.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth,
            placeholders: [...element.querySelectorAll('.studio-start-skeleton')].every(item => item.offsetWidth > 0 && item.offsetHeight > 0) }));
          assert.ok(bounds.scroll <= bounds.client + 1 && bounds.placeholders, JSON.stringify(bounds));
          await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-loading-${width}.png`) });
        }
      }
      await checkHeaderLayouts('loading');
      await page.evaluate(() => globalThis.studioStartLoadingTest.view.focus());
      assert.equal(await loading.evaluate(element => document.activeElement === element), true);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await loading.locator('.studio-start-skeleton, .studio-start-loading-indicator').evaluateAll(elements =>
        elements.every(element => getComputedStyle(element).animationName === 'none')), true);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      check(`${language}: delayed first load shows themed skeletons, hides unlabeled controls and supports narrow layouts and reduced motion`);
      await page.evaluate(state => {
        const fixture = globalThis.studioStartLoadingTest;
        fixture.service.state = state; fixture.change.fire();
        fixture.card = fixture.host.querySelector('.studio-start-current .studio-start-project-card');
      }, { ...initial.start, badge: language === 'en' ? 'Enhanced' : '增强版',
        projects: layoutOnly ? projects.map(project => ({ uri: pathToFileURL(project.directory).href, name: project.name,
          projectType: project.projectType, folderPath: project.directory })) : initial.start.projects });
      assert.equal(await loading.getAttribute('aria-busy'), 'false');
      assert.equal(await loading.locator('[role="progressbar"]').isVisible(), false);
      assert.equal(await loading.locator('.studio-start-project-card:visible').count(), 7);
      assert.equal(await loading.locator('[data-action="studio.createProject"]').isEnabled(), true);
      await checkHeaderLayouts('loaded');
      await page.evaluate(() => {
        const fixture = globalThis.studioStartLoadingTest;
        fixture.service.state = { ...fixture.service.state, badge: undefined }; fixture.change.fire();
      });
      assert.equal(await loading.locator('.studio-start-badge').evaluate(element => getComputedStyle(element).display === 'none' && element.getBoundingClientRect().width === 0), true,
        'An empty badge must not leave a border or layout space');
      await page.evaluate(error => {
        const fixture = globalThis.studioStartLoadingTest;
        fixture.service.state = { ...fixture.service.state, error }; fixture.change.fire();
      }, initial.start.labels.unavailable);
      assert.equal(await loading.locator('.studio-start-error').textContent(), initial.start.labels.unavailable);
      assert.equal(await loading.locator('[role="progressbar"]').isVisible(), false);
      assert.equal(await page.evaluate(() => globalThis.studioStartLoadingTest.card === globalThis.studioStartLoadingTest.host.querySelector('.studio-start-current .studio-start-project-card')), true);
      check(`${language}: first data replaces skeletons, enables labeled actions and preserves content after a refresh error`);
    } finally {
      await page.evaluate(() => {
        const fixture = globalThis.studioStartLoadingTest;
        fixture.view.dispose(); fixture.change.dispose(); fixture.host.remove(); delete globalThis.studioStartLoadingTest;
      });
    }
    if (layoutOnly) { assert.deepEqual(errors, []); continue; }
    await start().locator('[data-action="studio.createProject"]').first().waitFor();
    assert.equal(await page.locator('.tabs-container .tab').count(), 0, 'The empty-group start must not create a tab');
    await start().locator('h1').dblclick();
    await pause(300);
    assert.equal(await page.locator('.tabs-container .tab').count(), 0, 'Double-clicking the empty background must not create Untitled');
    assert.equal(await start().locator('[data-action="studio.createProject"]').count(), 1);
    assert.equal(await start().locator('[data-action="studio.createExample"]').count(), 0);
    assert.equal(await start().locator('h2').first().textContent(), language === 'en' ? 'Current Projects' : '当前项目');
    assert.equal(await start().locator('.studio-start-project-card').count(), 7);
    for (const project of initial.start.projects) {
      const card = start().locator('.studio-start-project-card').filter({ has: page.locator('h3', { hasText: project.name }) });
      assert.equal(await card.locator('.studio-start-project-path').textContent(), project.folderPath);
      assert.equal(await card.locator('[data-action="studio.openProject"] .studio-start-action-label').textContent(), initial.start.labels.run);
      assert.equal(await card.locator('.studio-start-project-type').textContent(), initial.start.labels[`type.${project.projectType}`]);
    }
    check(`${language}: single creation entry and current-project cards with name, type, path and Run`);
    const modal = () => page.locator('.studio-create-dialog');
    const submit = () => modal().locator('.dialog-buttons .monaco-button').filter({ hasText: language === 'en' ? /^Create$/ : /^创建$/ });
    const openCreation = async () => { await start().locator('[data-action="studio.createProject"]').click(); await modal().waitFor(); };
    await openCreation();
    assert.match(await modal().locator('[data-field="parentDirectory"]').inputValue(), /Documents[\\/]steamharness-projects$/);
    assert.equal(await submit().getAttribute('aria-disabled'), 'true');
    await modal().locator('[data-field="parentDirectory"]').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    assert.equal(await modal().locator('.dialog-buttons .monaco-button.secondary').evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await modal().locator('input[name="projectType"][value="workflow"]').evaluate(input => input === document.activeElement), true);
    await modal().locator('input[name="projectType"][value="workflow"]').focus(); await page.keyboard.press('ArrowRight');
    await modal().locator('input[name="projectType"][value="conversation"]:checked').waitFor({ state: 'attached' });
    for (const [type, count] of [['conversation', 2], ['kanban', 3], ['workflow', 2]]) {
      await modal().locator(`input[name="projectType"][value="${type}"]`).locator('..').click();
      assert.equal(await modal().locator('input[name="templateId"]').count(), count);
      const allowed = initial.start.templates.filter(template => template.projectType === type).map(template => template.id);
      assert.deepEqual(await modal().locator('input[name="templateId"]').evaluateAll(inputs => inputs.map(input => input.value)), allowed);
    }
    await modal().locator('[data-field="projectName"]').fill('../invalid');
    await modal().locator('.studio-create-error').filter({ hasText: initial.start.labels.requiredName }).waitFor({ state: 'hidden' });
    await until(() => modal().locator('.studio-create-error').textContent(), text => !!text, 'Invalid project name was not shown inline');
    assert.equal(await submit().getAttribute('aria-disabled'), 'true');
    await modal().locator('[data-field="projectName"]').fill('workflow-starter');
    await modal().locator('[data-field="parentDirectory"]').fill(workdir);
    await until(() => modal().locator('.studio-create-error').textContent(), text => text?.includes(language === 'en' ? 'already exists' : '已存在'), 'Folder conflicts were not shown inline');
    await modal().locator('[data-field="projectName"]').fill("新项目 & ' $()");
    await modal().locator('.studio-create-browse').click();
    const directoryPicker = page.locator('.quick-input-widget:visible input');
    await directoryPicker.fill(`${workdir}/`); await directoryPicker.press('Enter');
    await page.locator('.quick-input-widget:visible').waitFor({ state: 'hidden' });
    assert.equal(await modal().locator('[data-field="parentDirectory"]').inputValue(), workdir);
    await until(() => submit().getAttribute('aria-disabled'), value => value !== 'true', 'Valid project form did not enable creation');
    await modal().locator('[data-field="projectName"]').focus(); await page.keyboard.press('Tab');
    assert.equal(await modal().locator('[data-field="parentDirectory"]').evaluate(input => input === document.activeElement), true);
    await page.screenshot({ path: path.join(proof, `${language}-create-dialog.png`) });
    await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
    assert.equal(await exists(path.join(workdir, "新项目 & ' $()")), false);
    check(`${language}: creation modal filters templates, defaults location, browses, validates names and conflicts, tabs and cancels`);
    const iconProjects = ['workflow-starter', 'conversation-starter', 'kanban-starter'].map(name => projects.find(project => project.name === name));
    const ordinary = path.join(directory, 'ordinary-folder'); await mkdir(ordinary);
    const workspaceFile = path.join(directory, 'icons.code-workspace'); await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: ordinary }] }));
    const recentUris = new Map(iconProjects.map(project => [pathToFileURL(project.directory).href, project.projectType]));
    const folderBridgePort = bridge.port;
    await call({ action: 'recent', paths: [...iconProjects.map(project => project.directory), ordinary], workspace: workspaceFile });
    bridge = await until(async () => JSON.parse(await readFile(readyFile, 'utf8')),
      value => value.error || value.port !== folderBridgePort, 'The multi-root workspace did not reconnect', 120_000);
    assert.equal(bridge.error, undefined, bridge.error);
    await until(() => call({ action: 'state' }), state => [...recentUris].every(([uri, type]) => state.start.recent.some(project => project.uri === uri && project.projectType === type)), 'Recent project types were not detected');
    await call({ action: 'removeFolders' });
    await call({ action: 'nativeRecent', paths: [...iconProjects.map(project => project.directory), ordinary], workspace: workspaceFile });
    const expectedIcons = { workflow: 'run-all', conversation: 'comment-discussion', kanban: 'layout' };
    const assertRecentIcons = async () => {
      for (const [uri, type] of recentUris) {
        await start().locator(`[data-action="studio.openRecentProject"][data-uri="${uri}"] .codicon-${expectedIcons[type]}`).waitFor();
      }
      await start().locator(`[data-action="studio.openRecentProject"][data-uri="${pathToFileURL(ordinary).href}"] .codicon-folder`).waitFor();
    };
    for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
      await call({ action: 'theme', theme });
      await page.waitForFunction(dark => document.querySelector('.monaco-workbench')?.classList.contains('vs-dark') === dark, theme.includes('Dark'));
      await assertRecentIcons();
      await command('workbench.action.closeAuxiliaryBar');
      void command('workbench.action.openRecent').catch(error => errors.push(error.message));
      const quick = page.locator('.quick-input-widget:visible'); await quick.waitFor();
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-recent-open.png`) });
      for (const project of iconProjects) {
        const row = quick.locator('.monaco-list-row').filter({ has: page.locator('.quick-input-list-label', { hasText: project.name }) });
        await row.locator(`.quick-input-list-icon.codicon-${expectedIcons[project.projectType]}`).waitFor();
      }
      const input = quick.locator('input'); await input.fill('conversation-starter');
      await quick.locator('.monaco-list-row.focused .codicon-comment-discussion').waitFor();
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-recent-icons.png`) });
      if (theme.includes('Light')) {
        await input.fill('ordinary-folder');
        const ordinaryRow = quick.locator('.monaco-list-row').filter({ hasText: 'ordinary-folder' });
        assert.equal(await ordinaryRow.locator('.quick-input-list-icon.codicon').count(), 0, 'Ordinary folders keep their file-theme icon');
        await ordinaryRow.hover();
        await ordinaryRow.locator('.action-label').click();
        await ordinaryRow.waitFor({ state: 'hidden' });
        assert.equal(await quick.isVisible(), true);
        await input.fill('icons');
        const workspaceRow = quick.locator('.monaco-list-row').filter({ hasText: 'icons' }); await workspaceRow.waitFor();
        assert.equal(await workspaceRow.locator('.quick-input-list-icon.codicon').count(), 0, 'Saved workspaces keep their file-theme icon');
      }
      await page.keyboard.press('Escape'); await quick.waitFor({ state: 'hidden' });
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}.png`) });
      await openCreation();
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-create-dialog.png`) });
      await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
    }
    check(`${language}: project type icons in Recent Projects and Open Recent, both themes, filtering and dismissal`);
    await command('workbench.action.files.newUntitledFile');
    const untitled = (await call({ action: 'state' })).active;
    assert.ok(untitled?.startsWith('untitled:'));
    const editor = () => page.locator('.monaco-editor:visible').last();
    const assertPlainUntitled = async () => {
      await editor().locator('textarea.inputarea').waitFor({ state: 'attached' });
      assert.equal(await page.locator('.studio-start:visible').count(), 0, 'Untitled must remain a plain text editor');
      assert.equal(await page.locator('.studio-start-overlay').count(), 0);
      const state = await call({ action: 'state' });
      assert.equal(state.active, untitled);
      assert.equal(state.documents.find(document => document.uri === untitled)?.text, '');
    };
    await assertPlainUntitled();
    const tabs = page.locator('.tabs-container:visible').last();
    const blank = await tabs.evaluate(container => {
      const bounds = container.getBoundingClientRect(), y = bounds.top + bounds.height / 2;
      for (let x = bounds.right - 5; x > bounds.left; x -= 5) {
        if (document.elementFromPoint(x, y) === container) { return { x, y }; }
      }
    });
    assert.ok(blank, 'The test must double-click the empty tab strip');
    await page.mouse.dblclick(blank.x, blank.y);
    await pause(300);
    assert.equal(await page.locator('.tabs-container .tab').count(), 1, 'Double-clicking the empty tab strip must not create Untitled');
    check(`${language}: background and tab-strip double-clicks do not create Untitled; the New File command still works`);
    await command('workbench.action.closeAuxiliaryBar');
    await page.setViewportSize({ width: 1100, height: 900 });
    for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
      await call({ action: 'theme', theme });
      await page.waitForFunction(dark => document.querySelector('.monaco-workbench')?.classList.contains('vs-dark') === dark, theme.includes('Dark'));
      await assertPlainUntitled();
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-untitled.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await command('workbench.action.focusActiveEditorGroup');
    await page.keyboard.type('native typing');
    await until(() => call({ action: 'state' }), state => state.documents.some(document => document.uri === untitled && document.text === 'native typing'), 'Typing did not reach the original Untitled');
    for (let attempt = 0; attempt < 5; attempt++) {
      await command('undo');
      const state = await call({ action: 'state' });
      if (state.documents.find(document => document.uri === untitled)?.text === '') { break; }
    }
    await assertPlainUntitled();
    await editor().locator('textarea.inputarea').evaluate(input => {
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', 'pasted text\nsecond line');
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    });
    await until(() => call({ action: 'state' }), state => state.documents.some(document => document.uri === untitled && document.text === 'pasted text\nsecond line'), 'Pasting did not reach the original Untitled');
    await call({ action: 'replace', text: '' }); await assertPlainUntitled();
    check(`${language}: native blank Untitled in both themes, typing, DOM paste, undo and clear`);
    await command('workbench.action.closeActiveEditor');
    await start().locator('[data-action="studio.createProject"]').waitFor();
    assert.equal(await page.locator('.tabs-container .tab').count(), 0);
    check(`${language}: closing the empty file returns to the background Start workbench`);
    await call({ action: 'file', path: emptyFile }); assert.equal(await page.locator('.studio-start-overlay .studio-start:visible').count(), 0);
    await call({ action: 'diff' }); assert.equal(await page.locator('.monaco-diff-editor .studio-start-overlay').count(), 0);
    await command('studio.openStart');
    await openCreation(); await modal().locator('[data-field="projectName"]').fill('modal input');
    assert.equal((await call({ action: 'state' })).documents.some(document => document.text === 'modal input'), false);
    await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
    await command('workbench.action.splitEditorRight');
    await page.setViewportSize({ width: 900, height: 900 });
    await start().locator('h2').first().waitFor();
    const bounds = await page.locator('.studio-start:visible').evaluateAll(elements => elements.map(element => {
      const brand = document.createRange(), title = element.querySelector('h1').firstChild;
      brand.setStart(title, 0); brand.setEnd(title, 'Workflow'.length);
      return { client: element.clientWidth, scroll: element.scrollWidth, brandLines: brand.getClientRects().length,
        overflow: [...element.querySelectorAll('button,h1,h2,dd,p')].some(item => item.scrollWidth > item.clientWidth + 1) };
    }));
    assert.ok(bounds.every(bound => bound.scroll <= bound.client + 1 && !bound.overflow && bound.brandLines === 1), JSON.stringify(bounds));
    await page.screenshot({ path: path.join(proof, `${language}-split.png`) });
    await openCreation();
    await page.setViewportSize({ width: 420, height: 780 });
    const modalBounds = await modal().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: innerWidth, overflow: element.scrollWidth > element.clientWidth + 1 };
    });
    assert.ok(modalBounds.left >= 0 && modalBounds.right <= modalBounds.width && !modalBounds.overflow, JSON.stringify(modalBounds));
    await page.screenshot({ path: path.join(proof, `${language}-narrow-dialog.png`) });
    await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
    await command('workbench.action.joinAllGroups'); await page.setViewportSize({ width: 1440, height: 1000 });
    check(`${language}: saved empty file and diff excluded, narrow split layout`);
    const conversation = projects.find(project => project.name === 'conversation-round-output');
    await start().locator(`.studio-start-current [data-action="studio.openProject"][data-uri="${pathToFileURL(conversation.directory).href}"]`).click();
    const frame = await until(() => findFrame('#message', pathToFileURL(conversation.directory).href), Boolean, 'Conversation runtime did not open');
    await frame.locator('#parameters[aria-busy=false]').waitFor({ state: 'attached' });
    await frame.locator('#message').fill('Offline'); await frame.locator('#message').press('Enter');
    await frame.waitForFunction(() => document.querySelector('#message').value === '');
    await frame.locator('.message.assistant .message-content').filter({ hasText: 'Round 1: Offline' }).waitFor();
    assert.equal(await frame.locator('.message.assistant .message-content details').count(), 0, 'The main answer must be in the conversation body');
    const draftSaved = page.waitForResponse(response => response.url().endsWith('/api/message') && response.request().postDataJSON()?.type === 'draft');
    await frame.locator('#message').fill('Click'); await draftSaved;
    await frame.locator('#send').click();
    await frame.locator('.message.assistant .message-content').filter({ hasText: 'Round 2: Click' }).waitFor();
    check(`${language}: current-project runtime and Conversation answer in body`);
    if (language === 'en') {
      for (const name of ['kanban-default', 'kanban-parameters']) {
        const board = projects.find(project => project.name === name);
        await command('studio.openProject', { uri: pathToFileURL(board.directory).href });
        const boardFrame = await until(() => findFrame('#task-title'), Boolean, `${name} did not load`);
        await boardFrame.locator('#add-task:not(:disabled)').waitFor();
        await boardFrame.locator('#task-title').fill('Offline task'); await boardFrame.locator('#add-task').click();
        await boardFrame.locator('.todo article').filter({ hasText: 'Offline task' }).waitFor();
        await boardFrame.locator('.todo article').filter({ hasText: 'Offline task' }).getByRole('button', { name: 'Move to Next Column' }).click();
        await boardFrame.locator('.doing article').filter({ hasText: 'Offline task' }).waitFor();
        await boardFrame.locator('#add-task:not(:disabled)').waitFor();
        await boardFrame.evaluate(() => location.reload()); await boardFrame.locator('.doing article').filter({ hasText: 'Offline task' }).waitFor();
        assert.equal(await boardFrame.locator('h2').first().textContent(), 'To Do');
        if (name === 'kanban-parameters') {
          const configuration = await until(() => findFrame('#kanban-fields'), Boolean, 'Kanban parameters did not load');
          await configuration.getByLabel('Board Title', { exact: true }).fill('Configured Board');
          await boardFrame.locator('#title').filter({ hasText: 'Configured Board' }).waitFor();
          await configuration.getByLabel('Show Completed Tasks', { exact: true }).uncheck();
          await boardFrame.locator('.done').waitFor({ state: 'hidden' });
        }
      }
      check('en: both offline task boards create, move and persist tasks');
    }
    await command('studio.openStart');
    await start().locator('.studio-start-current [data-action="studio.openProjectSource"]').first().click();
    await until(() => call({ action: 'state' }), state => state.active?.endsWith('/package.json'), 'Source entry did not open');
    await command('studio.openStart'); await start().locator('[data-action="studio.openAnalysis"]').click();
    await until(() => findFrame('#content .stats'), Boolean, 'Built-in Analysis did not load');
    check(`${language}: source and real built-in Analysis`);
    await command('studio.openStart'); await start().locator('[data-action="studio.openAssistant"]').click();
    await page.locator('.webview').first().waitFor({ state: 'attached' });
    await start().locator('[data-action="studio.openAccount"]').click();
    await until(async () => {
      for (const frame of page.frames()) { if (await frame.locator('#login-form').isVisible().catch(() => false)) { return true; } }
      return await page.locator('.tab').filter({ hasText: initial.start.labels.account }).count() > 0;
    }, Boolean, 'Account entry did not open');
    await command('studio.openStart'); await start().locator('[data-action="studio.openSettings"]').click();
    await until(() => findFrame('#settings-navigation'), Boolean, 'Studio settings did not open');
    await command('studio.openStart');
    const before = await call({ action: 'state' }); assert.ok(before.start.recent.length);
    const recentProject = start().locator('.studio-start-recent .studio-start-project').first();
    await recentProject.hover();
    await page.screenshot({ path: path.join(proof, `${language}-recent-hover.png`) });
    await recentProject.locator('[data-action="studio.removeRecentProject"]').click();
    await until(() => call({ action: 'state' }), state => state.start.recent.length < before.start.recent.length, 'Recent projects did not update');
    check(`${language}: assistant, account, settings and recent-project updates`);
    const dirtyUntitled = await call({ action: 'untitled', text: 'unsaved stays here' }); await command('studio.openStart');
    // Web hot-exit backups are debounced and cannot finish during unload.
    await pause(2_000);
    const previousPort = bridge.port;
    const reloaded = page.waitForEvent('domcontentloaded', { timeout: 60_000 });
    void command('workbench.action.reloadWindow').catch(() => undefined);
    await reloaded;
    bridge = await until(async () => JSON.parse(await readFile(readyFile, 'utf8')),
      value => value.error || value.port !== previousPort && value.folders?.[0] === workdir, 'The reloaded extension did not reconnect', 120_000);
    assert.equal(bridge.error, undefined, bridge.error);
    await start().locator('h2').first().waitFor({ timeout: 60_000 });
    await page.locator('.tabs-container .tab').filter({ hasText: path.posix.basename(new URL(dirtyUntitled).pathname) }).click();
    await until(() => call({ action: 'state' }), state => state.documents.some(document => document.text === 'unsaved stays here'), 'Dirty Untitled was not restored');
    await command('studio.openStart');
    check(`${language}: Start tab and dirty Untitled survive window reload`);
    const projectName = `new-window-${language}`, projectDirectory = path.join(workdir, projectName);
    const popup = page.waitForEvent('popup', { timeout: 60_000 });
    void popup.catch(() => undefined);
    await start().locator('[data-action="studio.createProject"]').first().click();
    await modal().locator('[data-field="projectName"]').fill(projectName);
    await modal().locator('[data-field="parentDirectory"]').fill(workdir);
    await until(() => submit().getAttribute('aria-disabled'), value => value !== 'true', 'Creation form remained invalid');
    await submit().click();
    await page.locator('.monaco-dialog-box .monaco-button').filter({ hasText: language === 'en' ? 'Open in New Window' : '在新窗口打开' }).click();
    const targetPage = await popup;
    targetPage.on('pageerror', error => errors.push(`${language}: ${error.message}`));
    const targetBridge = await until(async () => JSON.parse(await readFile(readyFile, 'utf8')),
      value => value.error || value.port !== bridge.port && value.folders?.[0] === projectDirectory, 'The project window did not activate', 120_000);
    assert.equal(targetBridge.error, undefined, targetBridge.error);
    const targetCall = input => call(input, targetBridge.port);
    const installing = await until(() => targetCall({ action: 'state' }), state => state.start.installing || !state.start.pending.length, 'The project window did not start installation');
    assert.deepEqual(installing.folders, [projectDirectory]);
    const source = await call({ action: 'state' });
    assert.deepEqual(source.folders, [workdir]); assert.equal(source.start.installing, undefined);
    assert.ok(source.documents.some(document => document.text === 'unsaved stays here' && document.dirty));
    assert.equal(await call({ action: 'installationLog' }), '');
    await targetPage.screenshot({ path: path.join(proof, `${language}-new-window-install.png`) });
    await until(() => targetCall({ action: 'state' }), state => !state.start.busy && state.start.pending.length === 0
      && state.start.projects.some(project => project.name === projectName), 'The new project did not finish installation and refresh');
    assert.ok(await exists(path.join(projectDirectory, 'node_modules')));
    const installationLog = await targetCall({ action: 'installationLog' });
    assert.ok(installationLog.includes(`Installing fixture dependencies in ${projectDirectory}`), JSON.stringify(installationLog));
    assert.ok(installationLog.includes('Fixture dependencies ready'));
    assert.equal(context.pages().length, 2, 'Successful installation must keep the existing project window');
    check(`${language}: project opens a second window, installs there and preserves the source workspace and unsaved file`);
    const sameName = `same-window-${language}`, sameDirectory = path.join(workdir, sameName);
    await targetCall({ action: 'command', command: 'studio.openStart' });
    await targetPage.locator('.studio-start:visible [data-action="studio.createProject"]').click();
    const sameModal = targetPage.locator('.studio-create-dialog');
    await sameModal.locator('input[name="projectType"][value="conversation"]').locator('..').click();
    await sameModal.locator('input[name="templateId"][value="conversation-round-output"]').locator('..').click();
    await sameModal.locator('[data-field="projectName"]').fill(sameName);
    await sameModal.locator('[data-field="parentDirectory"]').fill(workdir);
    const sameSubmit = sameModal.locator('.dialog-buttons .monaco-button').filter({ hasText: language === 'en' ? /^Create$/ : /^创建$/ });
    await until(() => sameSubmit.getAttribute('aria-disabled'), value => value !== 'true', 'Current-window form remained invalid');
    await sameSubmit.click();
    await targetPage.locator('.monaco-dialog-box .monaco-button').filter({ hasText: language === 'en' ? 'Open in Current Window' : '在当前窗口打开' }).click();
    const sameBridge = await until(async () => JSON.parse(await readFile(readyFile, 'utf8')),
      value => value.error || value.port !== targetBridge.port && value.folders?.[0] === sameDirectory, 'Reusing the window did not activate the new project', 120_000);
    assert.equal(sameBridge.error, undefined, sameBridge.error);
    await until(() => call({ action: 'state' }, sameBridge.port), state => !state.start.busy && !state.start.pending.length
      && state.start.projects.some(project => project.name === sameName && project.projectType === 'conversation'), 'The reused window did not finish installation');
    assert.equal(context.pages().length, 2, 'Current-window selection must reuse the chosen window');
    assert.ok((await call({ action: 'installationLog' }, sameBridge.port)).includes(`Installing fixture dependencies in ${sameDirectory}`));
    assert.deepEqual((await call({ action: 'state' })).folders, [workdir]);
    await targetPage.close();
    check(`${language}: current-window selection navigates before installing, without opening a third window`);
    void command('workbench.action.openRecent');
    const recentPicker = page.locator('.quick-input-widget:visible'), recentInput = recentPicker.locator('input');
    await recentInput.fill('workflow-starter');
    await recentPicker.locator('.monaco-list-row.focused .codicon-run-all').waitFor();
    const recentPopup = context.waitForEvent('page');
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    if (language === 'en') { await recentInput.press(`${modifier}+Enter`); }
    else { await recentPicker.locator('.monaco-list-row.focused .quick-input-list-label').click({ modifiers: [modifier] }); }
    const recentPage = await recentPopup;
    await until(async () => JSON.parse(await readFile(readyFile, 'utf8')),
      value => value.port !== bridge.port && value.folders?.[0] === iconProjects[0].directory, 'Open Recent did not open the selected project in a new window', 120_000);
    assert.deepEqual((await call({ action: 'state' })).folders, [workdir]);
    await recentPage.close();
    check(`${language}: Open Recent ${language === 'en' ? 'keyboard' : 'mouse'} selection and new-window modifier`);
    assert.deepEqual(errors, []);
    console.log(`[OK] ${language}: Studio Start headless checks`);
  } catch (error) {
    const frames = [];
    for (const frame of page?.frames() ?? []) {
      frames.push(await frame.evaluate(() => ({ url: location.href, app: { ...document.querySelector('#app')?.dataset },
        text: document.body.innerText.slice(-5000), send: document.querySelector('#send')?.outerHTML,
        input: document.querySelector('#message')?.value,
        params: document.querySelector('#parameters')?.outerHTML.slice(0, 2000) })).catch(() => ({})));
    }
    await writeFile(path.join(proof, `${language}-failure.json`), JSON.stringify({ error: error.message, frames }, null, 2));
    await page?.screenshot({ path: path.join(proof, `${language}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    if (child?.pid) {
      const kill = signal => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') { throw error; } } };
      kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(4000)]);
      if (child.exitCode === null) { kill('SIGKILL'); }
    }
    await writeFile(path.join(proof, `${language}-server.log`), log);
    await writeFile(path.join(proof, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
    await rm(directory, { recursive: true, force: true });
  }
}
