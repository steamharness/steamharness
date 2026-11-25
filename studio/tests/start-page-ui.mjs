import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { ROOT, assertRuntime, assertUpstream, exists } from '../scripts/distribution.mjs';
import { serveLocalWebviewAssets } from './local-webview-assets.mjs';

await assertRuntime();
const upstream = await assertUpstream();
const layoutOnly = process.argv.includes('--layout-only');
const groupsOnly = process.argv.includes('--groups-only');
const proof = path.join(ROOT, groupsOnly ? '.studio/editor-group-close-ui' : layoutOnly ? '.studio/start-page-layout-ui' : '.studio/start-page-ui'); await mkdir(proof, { recursive: true });
const { createProjectFromTemplate, listProjectTemplates } = await import('../extensions/studio-workstation/dist/project-templates.mjs');
const templates = await listProjectTemplates();
const fixtureModules = process.env.STUDIO_START_TEST_NODE_MODULES || path.join(ROOT, 'examples/bot/node_modules');
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
  const creationParent = path.join(directory, 'created-projects');
  const readyFile = path.join(directory, 'ready.json'), token = randomBytes(24).toString('hex');
  let browser, child, page, sourceMessages, log = '';
  try {
    const defaultEntryLabel = language === 'en' ? 'Default' : '默认入口';
    await mkdir(workdir, { recursive: true }); await mkdir(extension, { recursive: true }); await mkdir(creationParent);
    if (language === 'zh-cn' && process.env.STEAMHARNESS_UI_LANGUAGE_PACK) {
      const location = await realpath(process.env.STEAMHARNESS_UI_LANGUAGE_PACK);
      const contents = await readFile(path.join(location, 'package.json'), 'utf8'), manifest = JSON.parse(contents);
      const localization = manifest.contributes?.localizations?.find(entry => entry.languageId === language);
      assert.ok(localization, `The cached language pack does not support ${language}`);
      const main = localization.translations.find(entry => entry.id === 'vscode');
      const pack = JSON.parse(await readFile(path.resolve(location, main.path), 'utf8'));
      sourceMessages = Object.fromEntries(Object.entries(pack.contents).flatMap(([moduleId, translations]) =>
        Object.entries(translations).map(([key, value]) => [`${moduleId}#${key}`, value])));
      const data = path.join(directory, 'server/data'); await mkdir(data, { recursive: true });
      await writeFile(path.join(data, 'languagepacks.json'), JSON.stringify({ [language]: {
        hash: createHash('sha256').update(contents).digest('hex'), label: localization.localizedLanguageName,
        extensions: [{ extensionIdentifier: { id: `${manifest.publisher}.${manifest.name}` }, version: manifest.version }],
        translations: Object.fromEntries(localization.translations.map(entry => [entry.id, path.resolve(location, entry.path)])),
      } }));
    }
    const bin = path.join(directory, 'bin'); await mkdir(bin);
    const node = process.platform === 'win32' ? 'node.exe' : 'node';
    const installer = 'install.cjs', runtimeManifest = path.join(directory, 'runtime.json');
    await copyFile(process.execPath, path.join(bin, node));
    await copyFile(path.join(ROOT, 'tests/start-page-ui-install.cjs'), path.join(directory, installer));
    await writeFile(runtimeManifest, JSON.stringify({ schemaVersion: 1, nodeVersion: process.versions.node,
      node: `bin/${node}`, bin: 'bin', npm: installer, pnpm: installer }));
    const projects = [];
    for (const template of templates) {
      const project = await createProjectFromTemplate({ templateId: template.id, name: template.id, parentDirectory: workdir, versions });
      await symlink(fixtureModules, path.join(project.directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      projects.push(project);
    }
    const aggregate = path.join(workdir, 'overview-sample');
    await mkdir(aggregate);
    const entryNames = { chat: ['Project Bot', '项目 Bot'], api: ['Data Workflow', '数据工作流'], board: ['Project Board', '项目看板'] };
    const registrations = [];
    for (const [entryId, templateId] of [['chat', 'bot-starter'], ['api', 'workflow-starter'], ['board', 'kanban-starter']]) {
      const template = projects.find(project => project.name === templateId);
      const entryRoot = path.join(aggregate, entryId);
      await mkdir(entryRoot);
      if (entryId === 'board') {
        await writeFile(path.join(entryRoot, template.entryFile), '<!doctype html><html><body><main id="overview-board">Overview Board</main></body></html>');
      } else {
        await copyFile(path.join(template.directory, template.entryFile), path.join(entryRoot, template.entryFile));
      }
      await copyFile(path.join(template.directory, 'configuration.json'), path.join(entryRoot, 'configuration.json'));
      const entry = template.projectType === 'kanban' ? path.posix.join(entryId, template.entryFile) : template.entryFile;
      await writeFile(path.join(entryRoot, 'steamharness.json'), JSON.stringify({ name: entryNames[entryId][0], type: template.projectType,
        entry, configuration: 'configuration.json', projectInfo: { localizedNames: { 'zh-CN': entryNames[entryId][1] } } }));
      registrations.push({ entryId, root: entryId });
    }
    await writeFile(path.join(aggregate, 'package.json'), JSON.stringify({ name: 'overview-sample', version: '1.2.3', private: true, type: 'module',
      devDependencies: { steamharness: versions.harness, '@steamharness/cli': versions.cli } }));
    await writeFile(path.join(aggregate, 'steamharness.json'), JSON.stringify({ id: randomUUID(), name: 'Overview Sample', version: '1.2.3',
      description: 'An aggregate with Bot, Workflow, and Kanban entries.', defaultEntry: 'api', entries: registrations,
      projectInfo: { localizedNames: { 'zh-CN': '项目概览示例' } } }));
    await symlink(fixtureModules, path.join(aggregate, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
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
      STEAMHARNESS_STUDIO_NODE_RUNTIME: runtimeManifest, STUDIO_START_TEST_NODE_MODULES: fixtureModules,
      STUDIO_START_TEST_PROJECT_DIRECTORIES: JSON.stringify([path.join(creationParent, `new-window-${language}`), path.join(creationParent, `same-window-${language}`)]),
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
    // Source Web workbenches need the installed pack's stable module/key messages before startup.
    await context.addInitScript(({ language, messages }) => {
      globalThis._VSCODE_NLS_LANGUAGE = language;
      if (messages) { globalThis._VSCODE_NLS_MESSAGES = messages; }
    }, { language, messages: sourceMessages });
    await serveLocalWebviewAssets(context, upstream);
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
    const initial = await until(() => call({ action: 'state' }), state => state.start?.labels.overview && (layoutOnly || groupsOnly || state.start.projects.length === projects.length + 1), 'Current projects were not scanned');
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
    const groups = () => page.locator('.part.editor > .content .editor-group-container:visible');
    const inactiveGroup = () => page.locator('.part.editor > .content .editor-group-container:not(.active):visible').first();
    const emptyClose = () => groups().locator(':scope > .editor-group-container-toolbar .codicon-close');
    const tabbedClose = () => groups().locator(':scope > .title .editor-layout-actions .codicon-close');
    const nativeChinese = language === 'zh-cn' && !!sourceMessages;
    const waitForGroups = count => until(() => call({ action: 'state' }), state => state.groups.length === count, `Expected ${count} editor groups`);
    await command('workbench.action.newGroupRight'); await waitForGroups(2);
    for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
      await call({ action: 'theme', theme });
      await page.waitForFunction(dark => document.querySelector('.monaco-workbench')?.classList.contains('vs-dark') === dark, theme.includes('Dark'));
      assert.equal(await emptyClose().count(), 2);
      for (const button of await emptyClose().all()) {
        await button.waitFor({ state: 'visible' });
        assert.match(await button.getAttribute('aria-label'), nativeChinese ? /关闭/ : /Close Group/);
        assert.equal(await button.evaluate(element => {
          const rect = element.getBoundingClientRect(), group = element.closest('.editor-group-container').getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return (element === hit || element.contains(hit)) && group.right - rect.right < 20 && rect.top - group.top < 20;
        }), true, 'Close must be reachable above Start in the upper-right corner');
      }
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-empty-groups.png`) });
    }
    await command('workbench.action.newGroupBelow'); await waitForGroups(3);
    await inactiveGroup().locator(':scope > .editor-group-container-toolbar .codicon-close').click();
    await waitForGroups(2);
    await emptyClose().first().focus(); await emptyClose().first().press('Enter'); await waitForGroups(1);
    assert.equal(await emptyClose().isVisible(), false);
    check(`${language}: empty groups close with mouse and keyboard above Start, including inactive groups and nested splits`);
    await call({ action: 'file', path: emptyFile });
    await command('workbench.action.splitEditorRight'); await waitForGroups(2);
    const unsaved = await call({ action: 'untitled', text: 'keep unsaved group contents' });
    assert.equal(await tabbedClose().count(), 2);
    const dirtyGroup = groups().filter({ has: page.locator('.tab.dirty') });
    await dirtyGroup.locator('.editor-layout-actions .codicon-close').click();
    const dialog = page.locator('.monaco-dialog-box:visible');
    await dialog.getByRole('button', { name: nativeChinese ? /取消/ : /^Cancel$/ }).click();
    const cancelled = await waitForGroups(2);
    assert.ok(cancelled.documents.some(document => document.uri === unsaved && document.dirty && document.text === 'keep unsaved group contents'));
    await page.screenshot({ path: path.join(proof, `${language}-unsaved-cancel.png`) });
    await dirtyGroup.locator('.editor-layout-actions .codicon-close').click();
    await dialog.getByRole('button', { name: nativeChinese ? /不保存/ : /Don't Save/ }).click();
    await waitForGroups(1);
    assert.equal(await tabbedClose().count(), 0);
    assert.ok((await call({ action: 'state' })).groups[0].tabs.some(tab => tab.uri === pathToFileURL(emptyFile).href));
    await command('workbench.action.splitEditorRight'); await waitForGroups(2);
    await inactiveGroup().locator('.editor-layout-actions .codicon-close').click();
    await waitForGroups(1);
    assert.equal(await tabbedClose().count(), 0);
    check(`${language}: populated groups close the selected group, preserve unsaved changes on cancel, and hide Close for the final group`);
    await command('workbench.action.closeAllEditors');
    if (groupsOnly) { assert.deepEqual(errors, []); continue; }
    // Exercise the real native view with a delayed state source, independent of extension startup speed.
    await page.evaluate(async () => {
      const { StudioStartView } = await import(new URL('vs/workbench/browser/parts/editor/studioStart.js', globalThis._VSCODE_FILE_ROOT).href);
      const { Emitter } = await import(new URL('vs/base/common/event.js', globalThis._VSCODE_FILE_ROOT).href);
      const host = document.createElement('div'); host.className = 'studio-start-loading-test';
      Object.assign(host.style, { position: 'absolute', inset: '0', zIndex: '10' });
      document.querySelector('.editor-group-container').append(host);
      const change = new Emitter();
      const service = { state: undefined, onDidChange: change.event, setVisible() {} };
      const view = new StudioStartView(host, service, { executeCommand: async () => undefined }, { writeText: async () => {} }, { getObject: () => undefined });
      globalThis.studioStartLoadingTest = { host, change, service, view };
    });
    try {
      const loading = page.locator('.studio-start-loading-test > .studio-start');
      const checkLayouts = async phase => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
          await call({ action: 'theme', theme });
          await page.waitForFunction(dark => document.querySelector('.monaco-workbench')?.classList.contains('vs-dark') === dark, theme.includes('Dark'));
          for (const width of [1200, 600, 420, 360, 320, 280, 240]) {
            await page.evaluate(width => { globalThis.studioStartLoadingTest.host.style.width = `${width}px`; }, width);
            const bounds = await loading.evaluate((element, phase) => {
              const loading = phase === 'loading';
              const avatar = element.querySelector(loading ? '.studio-start-skeleton-avatar' : '.lp-detail-mark').getBoundingClientRect();
              const title = element.querySelector(loading ? '.studio-start-skeleton-name' : '.lp-detail-identity').getBoundingClientRect();
              const layout = element.querySelector('.studio-start-inner').getBoundingClientRect();
              return { client: element.clientWidth, scroll: element.scrollWidth, avatarAligned: avatar.right <= title.left && avatar.top < title.bottom && avatar.bottom > title.top,
                outside: [...element.querySelectorAll('button, .lp-detail-location, .lp-entry-name')].some(item => {
                  const rect = item.getBoundingClientRect();
                  return rect.left < layout.left - 1 || rect.right > layout.right + 1;
                }), placeholders: [...element.querySelectorAll('.studio-start-skeleton')].every(item => item.offsetWidth > 0 && item.offsetHeight > 0) };
            }, phase);
            const context = `${language} ${theme} ${phase} ${width}: ${JSON.stringify(bounds)}`;
            assert.ok(bounds.scroll <= bounds.client + 1, `The view must fit its editor group: ${context}`);
            assert.ok(bounds.avatarAligned && !bounds.outside, `Project identity and actions must fit without overlapping: ${context}`);
            if (phase === 'loading') { assert.ok(bounds.placeholders, context); }
            if (width === 280 || width === 1200) {
              await loading.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-${phase}-overview-${width}.png`) });
            }
          }
        }
        await page.evaluate(() => { globalThis.studioStartLoadingTest.host.style.width = ''; });
        check(`${language}: ${phase} project overview fits 240-1200px editor groups in both themes`);
      };
      assert.equal(await loading.getAttribute('aria-busy'), 'true');
      assert.equal(await loading.locator('[role="progressbar"]').isVisible(), true);
      assert.equal(await loading.locator('button:visible, h1:visible').count(), 0, 'Loading must not expose empty headings or controls');
      await checkLayouts('loading');
      await page.evaluate(() => globalThis.studioStartLoadingTest.view.focus());
      assert.equal(await loading.evaluate(element => document.activeElement === element), true);
      assert.equal(await loading.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await loading.locator('.studio-start-skeleton').evaluateAll(elements =>
        elements.every(element => getComputedStyle(element).animationName === 'none')), true);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      const samples = language === 'en' ? ['Project Assistant', 'Data API', 'Map 2D'] : ['项目助手', '数据接口', '地图看板'];
      await page.evaluate(state => {
        const fixture = globalThis.studioStartLoadingTest;
        fixture.service.state = state; fixture.change.fire();
        fixture.card = fixture.host.querySelector('.studio-start-current .lp-project-details');
      }, { ...initial.start, hasWorkspace: true, pending: [], platform: true,
        projects: [{ uri: pathToFileURL(workdir).href, name: language === 'en' ? 'Workspace Data Assistant' : '工作区数据助手',
          description: language === 'en' ? 'Chat, query project data, and review it on the map.' : '用于项目对话、查询数据和查看地图。',
          projectType: 'aggregate', version: '0.1.0', folderPath: path.join(workdir, 'a-very-long-and-uninterrupted-project-folder-name'), defaultEntry: 'api',
          entries: [['chat', 'bot'], ['api', 'workflow'], ['map', 'kanban']].map(([entryId, projectType], index) => ({ entryId, projectType, name: samples[index], available: true })) }] });
      assert.equal(await loading.getAttribute('aria-busy'), 'false');
      assert.equal(await loading.locator('[role="progressbar"]').isVisible(), false);
      assert.equal(await loading.locator('.lp-detail-entries [data-entry-id]').count(), 3);
      assert.equal(await loading.locator('[data-entry-id="api"] .lp-entry-default').textContent(), defaultEntryLabel);
      assert.equal(await loading.locator('[data-action="studio.createProject"], .studio-start-recent, .studio-start-system, .studio-start-quick').count(), 0);
      await checkLayouts('loaded');
      await page.evaluate(() => {
        const fixture = globalThis.studioStartLoadingTest;
        fixture.service.state = { ...fixture.service.state, recent: [...fixture.service.state.recent].reverse() }; fixture.change.fire();
      });
      assert.equal(await page.evaluate(() => globalThis.studioStartLoadingTest.card === globalThis.studioStartLoadingTest.host.querySelector('.studio-start-current .lp-project-details')), true);
      check(`${language}: initialization shows the project and its entries; refreshing recents leaves the overview unchanged`);
    } finally {
      await page.evaluate(() => {
        const fixture = globalThis.studioStartLoadingTest;
        fixture.view.dispose(); fixture.change.dispose(); fixture.host.remove(); delete globalThis.studioStartLoadingTest;
      });
    }
    await start().locator('h1').first().waitFor();
    assert.equal(await start().getAttribute('aria-label'), language === 'en' ? 'Project Overview' : '项目概览');
    assert.equal(await start().locator('[data-action="studio.createProject"], .studio-start-recent, .studio-start-system, .studio-start-quick').count(), 0);
    if (await exists(fixtureModules)) {
      const title = language === 'en' ? 'Overview Sample' : '项目概览示例';
      const current = start().locator('.lp-project-details').filter({ has: page.getByRole('heading', { name: title, exact: true, level: 1 }) });
      await current.waitFor();
      assert.equal(await current.locator('.lp-detail-location').textContent(), aggregate);
      assert.deepEqual(await current.locator('.lp-entry-name').allTextContents(), registrations.map(({ entryId }) => entryNames[entryId][language === 'en' ? 0 : 1]));
      assert.equal(await current.locator('[data-entry-id="api"] .lp-entry-default').textContent(), defaultEntryLabel);
      assert.equal(await current.locator('.lp-detail-mark img, .lp-detail-entries img').count(), 4);
      await current.screenshot({ path: path.join(proof, `${language}-workspace-project.png`) });
      if (layoutOnly) {
        await current.locator('[data-entry-id="board"] button').click();
        await until(() => findFrame('#overview-board'), Boolean, 'The non-default Kanban entry did not open from the overview');
      }
      check(`${language}: the empty editor renders the inspected aggregate and its localized entries`);
    }
    if (layoutOnly) { assert.deepEqual(errors, []); continue; }
    const recentBefore = await call({ action: 'state' });
    const removeRecent = () => { void command('studio.removeRecentProject', recentBefore.start.recent[0]).catch(error => errors.push(error.message)); };
    removeRecent();
    const removeDialog = page.locator('.monaco-dialog-box:visible');
    await removeDialog.waitFor();
    await removeDialog.getByRole('button', { name: language === 'en' ? 'Cancel' : '取消', exact: true }).waitFor();
    assert.ok((await removeDialog.textContent()).includes(language === 'en'
      ? 'This only removes the recent entry. The project files and current workspace will not be affected.'
      : '此操作只移除最近记录，不会删除项目文件或关闭当前工作区。'));
    await page.screenshot({ path: path.join(proof, `${language}-remove-recent-confirmation.png`) });
    await page.keyboard.press('Escape'); await removeDialog.waitFor({ state: 'hidden' });
    assert.deepEqual((await call({ action: 'state' })).start.recent, recentBefore.start.recent);
    removeRecent();
    await removeDialog.getByRole('button', { name: language === 'en' ? 'Remove from Recent Projects' : '从最近项目中移除', exact: true }).click();
    await until(() => call({ action: 'state' }), state => state.start.recent.length === recentBefore.start.recent.length - 1, 'Recent projects did not update after confirmation');
    assert.deepEqual((await call({ action: 'state' })).folders, recentBefore.folders);
    check(`${language}: the global recent removal command preserves cancelled entries and the current workspace`);
    assert.equal(await page.locator('.tabs-container .tab').count(), 0, 'The empty-group start must not create a tab');
    await start().locator('h1').first().dblclick();
    await pause(300);
    assert.equal(await page.locator('.tabs-container .tab').count(), 0, 'Double-clicking the empty background must not create Untitled');
    assert.equal(await start().locator('.lp-project-details').count(), initial.start.projects.length);
    for (const project of initial.start.projects) {
      const card = start().locator('.lp-project-details').filter({ has: page.getByRole('heading', { name: project.name, exact: true, level: 1 }) });
      assert.equal(await card.locator('.lp-detail-location').textContent(), project.folderPath);
      assert.deepEqual(await card.locator('.lp-detail-entries [data-entry-id]').evaluateAll(rows => rows.map(row => row.dataset.entryId)), project.entries.map(entry => entry.entryId));
      assert.equal(await card.locator(`[data-entry-id="${project.defaultEntry}"] .lp-entry-default`).textContent(), defaultEntryLabel);
      const type = project.projectType === 'aggregate' ? language === 'en' ? 'Multi-entry' : '多入口' : initial.start.labels[`type.${project.projectType}`];
      assert.equal(await card.locator('.lp-detail-type').textContent(), type);
    }
    check(`${language}: editor overview lists only current projects, paths, types and their declared entries`);
    const modal = () => page.locator('.studio-create-dialog');
    const submit = () => modal().locator('.dialog-buttons .monaco-button').filter({ hasText: language === 'en' ? /^Create$/ : /^创建$/ });
    const openCreation = async (target = page, port = bridge.port) => {
      void call({ action: 'command', command: 'studio.createProject' }, port).catch(error => errors.push(error.message));
      await target.locator('.studio-create-dialog').waitFor();
    };
    await openCreation();
    assert.match(await modal().locator('[data-field="parentDirectory"]').inputValue(), /Documents[\\/]steamharness-projects$/);
    assert.equal(await submit().getAttribute('aria-disabled'), 'true');
    await modal().locator('[data-field="parentDirectory"]').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    assert.equal(await modal().locator('.dialog-buttons .monaco-button.secondary').evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await modal().locator('input[name="projectType"][value="workflow"]').evaluate(input => input === document.activeElement), true);
    await modal().locator('input[name="projectType"][value="workflow"]').focus(); await page.keyboard.press('ArrowRight');
    await modal().locator('input[name="projectType"][value="bot"]:checked').waitFor({ state: 'attached' });
    assert.deepEqual(await modal().locator('.studio-create-template-name').allTextContents(), ['Core Agent', 'Core LLM']);
    assert.equal(await modal().locator('input[name="templateId"]:checked').inputValue(), 'bot-starter');
    for (const type of ['bot', 'kanban', 'workflow']) {
      await modal().locator(`input[name="projectType"][value="${type}"]`).locator('..').click();
      const allowed = templates.filter(template => template.projectType === type).map(template => template.id);
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
    const iconProjects = ['workflow-starter', 'bot-starter', 'kanban-starter'].map(name => projects.find(project => project.name === name));
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
    const projectAvatar = '.quick-input-list-icon[style*="data:image/svg+xml"]';
    for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
      await call({ action: 'theme', theme });
      await page.waitForFunction(dark => document.querySelector('.monaco-workbench')?.classList.contains('vs-dark') === dark, theme.includes('Dark'));
      await command('workbench.action.closeAuxiliaryBar');
      void command('workbench.action.openRecent').catch(error => errors.push(error.message));
      const quick = page.locator('.quick-input-widget:visible'); await quick.waitFor();
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-recent-open.png`) });
      for (const project of iconProjects) {
        const row = quick.locator('.monaco-list-row').filter({ has: page.locator('.quick-input-list-label', { hasText: project.name }) });
        await row.locator(projectAvatar).waitFor();
      }
      const input = quick.locator('input'); await input.fill('bot-starter');
      await quick.locator('.monaco-list-row.focused').locator(projectAvatar).waitFor();
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-recent-icons.png`) });
      if (theme.includes('Light')) {
        await input.fill('ordinary-folder');
        const ordinaryRow = quick.locator('.monaco-list-row').filter({ hasText: 'ordinary-folder' });
        assert.equal(await ordinaryRow.locator(`${projectAvatar}, .quick-input-list-icon.codicon`).count(), 0, 'Ordinary folders keep their file-theme icon');
        await ordinaryRow.hover();
        await ordinaryRow.locator('.action-label').click();
        await ordinaryRow.waitFor({ state: 'hidden' });
        assert.equal(await quick.isVisible(), true);
        await input.fill('icons');
        const workspaceRow = quick.locator('.monaco-list-row').filter({ hasText: 'icons' }); await workspaceRow.waitFor();
        assert.equal(await workspaceRow.locator(`${projectAvatar}, .quick-input-list-icon.codicon`).count(), 0, 'Saved workspaces keep their file-theme icon');
      }
      await page.keyboard.press('Escape'); await quick.waitFor({ state: 'hidden' });
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}.png`) });
      await openCreation();
      await page.screenshot({ path: path.join(proof, `${language}-${theme.includes('Dark') ? 'dark' : 'light'}-create-dialog.png`) });
      await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
    }
    check(`${language}: project type icons in Open Recent, both themes, filtering and dismissal`);
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
    await start().getByRole('heading', { name: 'workflow-starter', exact: true, level: 1 }).waitFor();
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
    const bounds = await page.locator('.studio-start:visible').evaluateAll(elements => elements.map(element => ({
      client: element.clientWidth, scroll: element.scrollWidth,
      overflow: [...element.querySelectorAll('button,h1,h2,dd,p')].some(item => item.scrollWidth > item.clientWidth + 1),
    })));
    assert.ok(bounds.every(bound => bound.scroll <= bound.client + 1 && !bound.overflow), JSON.stringify(bounds));
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
    await start().locator('[data-entry-id="board"] button').click();
    await until(() => findFrame('#overview-board'), Boolean, 'The non-default Kanban entry did not open');
    check(`${language}: the overview opens the selected child entry`);
    await command('studio.openStart');
    await start().locator('.studio-start-current [data-action="studio.openProjectSource"]').first().click();
    await until(() => call({ action: 'state' }), state => state.active?.endsWith('/steamharness.json'), 'Source entry did not open');
    await command('studio.openAnalysis');
    await until(() => findFrame('#content .stats'), Boolean, 'Built-in Analysis did not load');
    check(`${language}: source and real built-in Analysis`);
    await command('studio.openAssistant');
    await page.locator('.webview').first().waitFor({ state: 'attached' });
    await command('studio.openSettings');
    await until(() => findFrame('#settings-navigation'), Boolean, 'Studio settings did not open');
    await command('studio.openStart');
    check(`${language}: assistant and settings remain available from their commands`);
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
    const projectName = `new-window-${language}`, projectDirectory = path.join(creationParent, projectName);
    const popup = page.waitForEvent('popup', { timeout: 60_000 });
    void popup.catch(() => undefined);
    await openCreation();
    await modal().locator('[data-field="projectName"]').fill(projectName);
    await modal().locator('[data-field="parentDirectory"]').fill(creationParent);
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
    assert.ok(!source.start.projects.some(project => project.folderPath === projectDirectory));
    assert.ok(!source.start.pending.some(project => project.directory === projectDirectory));
    await targetPage.screenshot({ path: path.join(proof, `${language}-new-window-install.png`) });
    await until(() => targetCall({ action: 'state' }), state => !state.start.busy && state.start.pending.length === 0
      && state.start.projects.some(project => project.name === projectName), 'The new project did not finish installation and refresh');
    assert.ok(await exists(path.join(projectDirectory, 'node_modules')));
    const installationLog = await targetCall({ action: 'installationLog' });
    assert.ok(installationLog.includes(`Installing fixture dependencies in ${projectDirectory}`), JSON.stringify(installationLog));
    assert.ok(installationLog.includes('Fixture dependencies ready'));
    assert.equal(context.pages().length, 2, 'Successful installation must keep the existing project window');
    check(`${language}: project opens a second window, installs there and preserves the source workspace and unsaved file`);
    const sameName = `same-window-${language}`, sameDirectory = path.join(creationParent, sameName);
    await targetCall({ action: 'command', command: 'studio.openStart' });
    await openCreation(targetPage, targetBridge.port);
    const sameModal = targetPage.locator('.studio-create-dialog');
    await sameModal.locator('input[name="projectType"][value="bot"]').locator('..').click();
    await sameModal.locator('input[name="templateId"][value="bot-llm"]').locator('..').click();
    await sameModal.locator('[data-field="projectName"]').fill(sameName);
    await sameModal.locator('[data-field="parentDirectory"]').fill(creationParent);
    const sameSubmit = sameModal.locator('.dialog-buttons .monaco-button').filter({ hasText: language === 'en' ? /^Create$/ : /^创建$/ });
    await until(() => sameSubmit.getAttribute('aria-disabled'), value => value !== 'true', 'Current-window form remained invalid');
    await sameSubmit.click();
    await targetPage.locator('.monaco-dialog-box .monaco-button').filter({ hasText: language === 'en' ? 'Open in Current Window' : '在当前窗口打开' }).click();
    const sameBridge = await until(async () => JSON.parse(await readFile(readyFile, 'utf8')),
      value => value.error || value.port !== targetBridge.port && value.folders?.[0] === sameDirectory, 'Reusing the window did not activate the new project', 120_000);
    assert.equal(sameBridge.error, undefined, sameBridge.error);
    await until(() => call({ action: 'state' }, sameBridge.port), state => !state.start.busy && !state.start.pending.length
      && state.start.projects.some(project => project.name === sameName && project.projectType === 'bot'), 'The reused window did not finish installation');
    assert.match(await readFile(path.join(sameDirectory, 'index.ts'), 'utf8'), /engine: "llm",/u);
    assert.equal(context.pages().length, 2, 'Current-window selection must reuse the chosen window');
    assert.ok((await call({ action: 'installationLog' }, sameBridge.port)).includes(`Installing fixture dependencies in ${sameDirectory}`));
    assert.deepEqual((await call({ action: 'state' })).folders, [workdir]);
    await targetPage.close();
    check(`${language}: current-window selection navigates before installing, without opening a third window`);
    void command('workbench.action.openRecent');
    const recentPicker = page.locator('.quick-input-widget:visible'), recentInput = recentPicker.locator('input');
    await recentInput.fill('workflow-starter');
    await recentPicker.locator('.monaco-list-row.focused').locator(projectAvatar).waitFor();
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
