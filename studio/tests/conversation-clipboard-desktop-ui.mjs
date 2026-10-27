import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const actualProject = process.env.STUDIO_CLIPBOARD_PROJECT_DIR;
const fixture = actualProject ? await realpath(actualProject) : path.join(root, 'tests/fixtures/conversation-features');
const proofDir = path.join(root, '.studio/conversation-clipboard', actualProject ? 'project' : 'fixture');
await mkdir(proofDir, { recursive: true });
const proof = { cliVersion: undefined, checks: [], errors: [], images: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const paste = process.platform === 'darwin' ? 'Meta+v' : 'Control+v';
const copy = process.platform === 'darwin' ? 'Meta+c' : 'Control+c';
for (const language of ['en', 'zh-cn']) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-clipboard-')));
  const projectDir = actualProject ? fixture : path.join(directory, 'project');
  const cliDir = !actualProject && process.env.STEAMHARNESS_UI_CLI_ENTRY ? path.resolve(path.dirname(process.env.STEAMHARNESS_UI_CLI_ENTRY), '..') : await realpath(path.join(fixture, 'node_modules/@steamharness/cli'));
  proof.cliVersion = JSON.parse(await readFile(path.join(cliDir, 'package.json'), 'utf8')).version;
  if (!actualProject) {
    await mkdir(path.join(projectDir, 'node_modules/@steamharness'), { recursive: true });
    for (const name of ['package.json', 'index.ts']) { await cp(path.join(fixture, name), path.join(projectDir, name)); }
    await symlink(await realpath(path.join(fixture, 'node_modules/steamharness')), path.join(projectDir, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(cliDir, path.join(projectDir, 'node_modules/@steamharness/cli'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const dataDir = path.join(directory, 'user'); await mkdir(path.join(dataDir, 'User'), { recursive: true });
  await writeFile(path.join(dataDir, 'User/settings.json'), JSON.stringify({ 'workbench.colorTheme': 'Light Modern', 'window.autoDetectColorScheme': false, 'git.openRepositoryInParentFolders': 'never' }));
  const desktop = await desktopLocaleLaunch(language, directory);
  let app, page, savedClipboard, lastClipboard, png;
  async function frameFor() {
    for (let attempt = 0; attempt < 300; attempt++) {
      for (const frame of page.frames()) {
        if (!frame.isDetached() && await frame.locator('#message').isVisible().catch(() => false)
          && await frame.locator('#app').getAttribute('data-project-uri') === pathToFileURL(projectDir).href) { return frame; }
      }
      await pause(100);
    }
    throw new Error('Conversation frame unavailable');
  }
  async function imageLoaded(frame, selector) {
    await frame.waitForFunction(selector => { const image = document.querySelector(selector); return image?.complete && image.naturalWidth === 96 && image.naturalHeight === 48; }, selector);
    const size = await frame.locator(selector).evaluate(image => {
      const box = image.getBoundingClientRect(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { width: image.naturalWidth, height: image.naturalHeight, renderedWidth: box.width, renderedHeight: box.height,
        withinViewport: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
        pixels: [Array.from(context.getImageData(24, 24, 1, 1).data), Array.from(context.getImageData(72, 24, 1, 1).data)] };
    });
    assert.ok(size.renderedWidth > 0 && size.renderedHeight > 0);
    assert.equal(size.withinViewport, true); assert.equal(size.pixels[0][3], 255); assert.equal(size.pixels[1][3], 255);
    assert.notDeepEqual(size.pixels[0], size.pixels[1]);
    proof.images.push({ language, selector, ...size });
  }
  async function imageOnlyAttachment(frame, container) {
    const attachment = frame.locator(`${container} .attachment`).first();
    assert.equal(await attachment.locator(':scope > span').count(), 0);
    assert.equal(await attachment.locator('img').getAttribute('alt'), language === 'zh-cn' ? '\u56fe\u7247' : 'Image');
    assert.equal(await attachment.locator('.attachment-preview').getAttribute('title'), language === 'zh-cn' ? '\u56fe\u7247' : 'Image');
    assert.equal(await attachment.innerText(), '');
  }
  async function clipboard(content) {
    const result = await app.evaluate(({ clipboard, nativeImage }, content) => {
      clipboard.clear();
      clipboard.write({ ...(content.text !== undefined ? { text: content.text } : {}), ...(content.image ? { image: nativeImage.createFromBuffer(Buffer.from(content.image, 'base64')) } : {}) });
      return { formats: clipboard.availableFormats(), image: clipboard.readImage().getSize(), text: clipboard.readText(),
        snapshot: clipboard.availableFormats().sort().map(format => ({ format, data: clipboard.readBuffer(format).toString('base64') })) };
    }, content);
    if (content.image) { assert.deepEqual(result.image, { width: 96, height: 48 }); }
    lastClipboard = result.snapshot;
  }
  async function command(name) {
    await page.locator('.monaco-workbench').evaluate(element => { element.tabIndex = -1; element.focus(); });
    await press(page.keyboard, 'F1'); await page.locator('.quick-input-widget input').fill(`>${name}`); await pause(200);
    await press(page.locator('.quick-input-widget input'), 'Enter'); await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
  }
  async function press(target, keys) {
    const window = await app.browserWindow(page);
    await window.evaluate(window => { window.__clipboardTestKeysAllowed = true; });
    try { await target.press(keys); }
    finally { await window.evaluate(window => { window.__clipboardTestKeysAllowed = false; }); }
  }
  async function nativePaste(triggeredByAccelerator = false, content) {
    const targetWindow = await app.browserWindow(page);
    const windowId = await targetWindow.evaluate(window => window.id);
    await app.evaluate(({ app, BrowserWindow }, id) => { app.focus({ steal: true }); BrowserWindow.fromId(id).focus(); }, windowId);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id) === windowId) { break; }
      await pause(100);
    }
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id), windowId, 'The native paste test requires the isolated window to have OS focus');
    await page.waitForFunction(() => document.hasFocus()); await pause(300);
    const snapshot = await app.evaluate(async ({ app, Menu, BrowserWindow, clipboard, nativeImage }, { triggeredByAccelerator, windowId, content }) => {
      const window = BrowserWindow.fromId(windowId);
      app.focus({ steal: true }); window.focus();
      for (let attempt = 0; attempt < 50 && !window.isFocused(); attempt++) { await new Promise(resolve => setTimeout(resolve, 100)); }
      if (!window.isFocused()) { throw new Error('The isolated window lost native focus'); }
      const findPaste = menu => {
        for (const item of menu?.items ?? []) {
          if (/^(?:cmd|command|ctrl|control)\+v$/i.test(item.accelerator ?? '')) { return item; }
          const found = findPaste(item.submenu); if (found) { return found; }
        }
      };
      const item = findPaste(Menu.getApplicationMenu());
      if (!item) { throw new Error('Native Paste menu unavailable'); }
      if (content) { clipboard.clear(); clipboard.write({ ...(content.text !== undefined ? { text: content.text } : {}), ...(content.image ? { image: nativeImage.createFromBuffer(Buffer.from(content.image, 'base64')) } : {}) }); }
      item.click(item, window, { triggeredByAccelerator });
      return clipboard.availableFormats().sort().map(format => ({ format, data: clipboard.readBuffer(format).toString('base64') }));
    }, { triggeredByAccelerator, windowId, content });
    if (content) { lastClipboard = snapshot; }
  }
  async function nativeTextPaste(frame, triggeredByAccelerator, text) {
    await frame.locator('#message').fill('Before selection After');
    await frame.locator('#message').evaluate(textarea => textarea.setSelectionRange(7, 16));
    await frame.waitForFunction(() => !navigator.userActivation.isActive);
    await nativePaste(triggeredByAccelerator, { text });
    await frame.waitForFunction(text => document.querySelector('#message').value === `Before ${text} After`, text);
  }
  async function selectText(frame, selector) {
    const target = frame.locator(selector).first(); await target.scrollIntoViewIfNeeded();
    return target.evaluate(element => {
      element.tabIndex = -1; element.focus({ preventScroll: true });
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString();
    });
  }
  async function copied(text) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await app.evaluate(({ clipboard }) => clipboard.readText()) === text) {
        lastClipboard = await app.evaluate(({ clipboard }) => clipboard.availableFormats().sort().map(format => ({ format, data: clipboard.readBuffer(format).toString('base64') })));
        return;
      }
      await pause(100);
    }
    throw new Error('Selected text did not reach the native clipboard');
  }
  try {
    app = await _electron.launch({ executablePath: desktop.executable, args: [...desktop.args, '--user-data-dir', dataDir,
      '--extensions-dir', path.join(root, '.studio/desktop-extensions'), `--locale=${language}`, '--disable-workspace-trust',
      '--disable-telemetry', '--skip-welcome', '--skip-release-notes', projectDir], cwd: path.join(root, 'upstream/vscode'),
      env: { ...process.env, ...desktop.env, STUDIO_STEAMHARNESS_SOURCE: process.env.STUDIO_STEAMHARNESS_SOURCE || path.resolve(root, '..'), STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '' }, timeout: 60_000 });
    savedClipboard = await app.evaluate(({ clipboard }) => clipboard.availableFormats().map(format => ({ format, data: clipboard.readBuffer(format).toString('base64') })));
    png = await app.evaluate(({ nativeImage }) => {
      const pixels = Buffer.alloc(96 * 48 * 4);
      for (let index = 0; index < pixels.length; index += 4) { pixels.set(index % (96 * 4) < 48 * 4 ? [80, 100, 220, 255] : [190, 160, 40, 255], index); }
      return nativeImage.createFromBitmap(pixels, { width: 96, height: 48 }).toPNG().toString('base64');
    });
    await desktop.waitUntilReady(app.process());
    page = await app.firstWindow(); page.setDefaultTimeout(15_000); page.on('pageerror', error => proof.errors.push(error.message));
    const nativeWindow = await app.browserWindow(page);
    await nativeWindow.evaluate(window => {
      window.__clipboardTestKeysAllowed = false;
      window.webContents.on('before-input-event', event => { if (!window.__clipboardTestKeysAllowed) { event.preventDefault(); } });
      window.focus();
    });
    await page.bringToFront();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const run = page.locator('.part.titlebar .studio-workflow-run').getByRole('button'); await run.waitFor({ timeout: 45_000 }); await run.click();
    let frame = await frameFor(); await frame.locator('#parameters[aria-busy=false]').waitFor({ state: 'attached' });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await Promise.any(page.frames().map(async current => { if (await current.locator('body[data-surface=assistant] #parameters[aria-busy=false]').count()) { return true; } throw new Error('Not ready'); })).catch(() => false)) { break; }
      await pause(100);
    }
    if (await page.locator('.part.auxiliarybar').isVisible()) { await command('View: Toggle Secondary Side Bar Visibility'); }
    await frame.evaluate(() => {
      window.__clipboardEvents = [];
      const exec = document.execCommand.bind(document);
      document.execCommand = (...args) => { const result = exec(...args); window.__clipboardEvents.push({ exec: args[0], result }); return result; };
      addEventListener('message', event => { if (event.data?.editCommand) { window.__clipboardEvents.push({ edit: event.data.editCommand, native: !!event.data.clipboardData, restoreFocus: event.data.restoreFocus }); } });
      for (const type of ['paste', 'keydown']) { addEventListener(type, event => window.__clipboardEvents.push({ type, key: event.key?.length === 1 && !event.metaKey && !event.ctrlKey ? 'character' : event.key, prevented: event.defaultPrevented, types: event.clipboardData?.types, items: Array.from(event.clipboardData?.items ?? []).map(item => ({ kind: item.kind, type: item.type })), files: Array.from(event.clipboardData?.files ?? []).map(file => ({ type: file.type })), textLength: event.clipboardData?.getData('text/plain')?.length })); }
    });
    await frame.parentFrame().evaluate(() => { window.__clipboardEvents = []; addEventListener('vscode-webview-exec-command', event => window.__clipboardEvents.push({ command: typeof event.detail === 'string' ? event.detail : event.detail?.command, native: !!event.detail?.clipboard, prevented: event.defaultPrevented, active: document.activeElement?.id })); });
    await clipboard({ text: 'Pasted text\nSecond line' });
    await frame.locator('#message').fill('Before / After');
    await frame.locator('#message').evaluate(textarea => textarea.setSelectionRange(7, 7));
    await press(frame.locator('#message'), paste);
    await frame.waitForFunction(() => document.querySelector('#message').value === 'Before Pasted text\nSecond line/ After');
    proof.checks.push(`${language}: native keyboard text paste inserts at the caret`);
    console.log(proof.checks.at(-1));
    await nativeTextPaste(frame, false, 'Native menu text');
    proof.checks.push(`${language}: the native application menu pastes after transient activation expires`);
    await nativeTextPaste(frame, true, 'Accelerator text');
    proof.checks.push(`${language}: the native Command/Ctrl+V accelerator replaces the selection`);
    await clipboard({ text: 'Context menu text' }); await frame.locator('#message').fill('Before selection After');
    await frame.locator('#message').evaluate(textarea => textarea.setSelectionRange(7, 16));
    const selectionPoint = await frame.locator('#message').evaluate(input => {
      const style = getComputedStyle(input), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return { x: parseFloat(style.paddingLeft) + context.measureText(input.value.slice(0, 9)).width,
        y: parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2 };
    });
    await frame.locator('#message').click({ button: 'right', position: selectionPoint });
    const contextMenu = page.locator('.context-view .monaco-menu');
    await contextMenu.waitFor();
    await page.screenshot({ path: path.join(proofDir, `${language}-context-menu.png`) });
    await clipboard({ text: 'Context menu text' });
    await contextMenu.locator('.action-menu-item').filter({ hasText: /Paste|\u7c98\u8d34/ }).click();
    await frame.waitForFunction(() => document.querySelector('#message').value === 'Before Context menu text After');
    proof.checks.push(`${language}: right-click opens the standard VS Code editing menu and Paste replaces the selection`);
    await clipboard({ text: 'Menu text' }); await frame.locator('#message').fill('Before selection After');
    await frame.locator('#message').evaluate(textarea => textarea.setSelectionRange(7, 16));
    await frame.waitForFunction(() => document.hasFocus() && document.activeElement === document.querySelector('#message'));
    await pause(300);
    await nativeWindow.evaluate(window => window.webContents.send('vscode:runAction', { id: 'editor.action.clipboardPasteAction', from: 'menu' }));
    await frame.waitForFunction(() => document.querySelector('#message').value === 'Before Menu text After');
    proof.checks.push(`${language}: the workbench Paste command replaces the selection`);
    await nativeWindow.evaluate(window => window.webContents.send('vscode:runAction', { id: 'undo', from: 'menu' }));
    await frame.waitForFunction(() => document.querySelector('#message').value === 'Before selection After');
    await nativeWindow.evaluate(window => window.webContents.send('vscode:runAction', { id: 'redo', from: 'menu' }));
    await frame.waitForFunction(() => document.querySelector('#message').value === 'Before Menu text After');
    proof.checks.push(`${language}: workbench undo and redo preserve native text editing`);
    await frame.locator('#message').fill('Image input');
    await clipboard({ image: png }); await press(frame.locator('#message'), paste);
    await frame.locator('#draft-attachments .attachment').waitFor();
    await imageLoaded(frame, '#draft-attachments img');
    await imageOnlyAttachment(frame, '#draft-attachments');
    assert.equal(await frame.locator('#message').inputValue(), 'Image input');
    await page.screenshot({ path: path.join(proofDir, `${language}-draft.png`) });
    await frame.locator('#draft-attachments .attachment-preview').click();
    await imageLoaded(frame, '.conversation-dialog[open] .image-preview');
    await page.screenshot({ path: path.join(proofDir, `${language}-preview.png`) });
    await frame.locator('.conversation-dialog[open] header button').last().click();
    await frame.locator('#draft-attachments button[title]').last().click();
    await frame.locator('#draft-attachments').waitFor({ state: 'hidden' });
    await clipboard({ image: png, text: 'Mixed clipboard' }); await frame.locator('#message').fill('Before selection After');
    await frame.locator('#message').evaluate(textarea => textarea.setSelectionRange(7, 16));
    await nativePaste(true, { text: 'Mixed clipboard', image: png });
    await frame.waitForFunction(() => document.querySelector('#message').value === 'Before Mixed clipboard After');
    await imageLoaded(frame, '#draft-attachments img');
    proof.checks.push(`${language}: mixed text and image paste retains both`);
    await frame.locator('#draft-attachments button[title]').last().click();
    await frame.locator('#draft-attachments').waitFor({ state: 'hidden' });
    await clipboard({ image: png }); await frame.locator('#message').fill('Image input');
    await frame.locator('#message').focus(); await pause(300);
    await nativePaste();
    await imageLoaded(frame, '#draft-attachments img');
    proof.checks.push(`${language}: the workbench Paste command uploads an image`);
    await frame.locator('#draft-attachments button[title]').last().click();
    await frame.locator('#draft-attachments').waitFor({ state: 'hidden' });
    const chooser = page.waitForEvent('filechooser'); await frame.locator('#attach').click();
    await (await chooser).setFiles({ name: 'selected.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await imageLoaded(frame, '#draft-attachments img');
    proof.checks.push(`${language}: the image file picker uploads and previews the selected file`);
    await page.setViewportSize({ width: 720, height: 900 });
    await imageLoaded(frame, '#draft-attachments img');
    await frame.locator('#draft-attachments .attachment-preview').click(); await imageLoaded(frame, '.conversation-dialog[open] .image-preview');
    await page.screenshot({ path: path.join(proofDir, `${language}-narrow-preview.png`) });
    await frame.locator('.conversation-dialog[open] header button').last().click();
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (!actualProject) {
      await frame.locator('#send').click(); await frame.locator('#app[data-run-state=idle]').waitFor();
      await frame.locator('.assistant .message-content').filter({ hasText: /image\/png, bytes=/ }).waitFor();
      await imageLoaded(frame, '.user .attachments img');
      await imageOnlyAttachment(frame, '.user .attachments');
      proof.checks.push(`${language}: the uploaded image reaches Core and remains visible in the conversation`);
    }
    const reloaded = page.waitForEvent('domcontentloaded'); await command('Developer: Reload Window'); await reloaded;
    frame = await frameFor();
    const restored = actualProject ? '#draft-attachments' : '.user .attachments';
    await imageLoaded(frame, `${restored} img`);
    await imageOnlyAttachment(frame, restored);
    await frame.locator(`${restored} .attachment-preview`).click(); await imageLoaded(frame, '.conversation-dialog[open] .image-preview');
    await page.screenshot({ path: path.join(proofDir, `${language}-history-preview.png`) });
    proof.checks.push(`${language}: reloading restores image history and full-size previews`);
    proof.checks.push(`${language}: images in the composer and conversation have no filename labels`);
    await frame.locator('.conversation-dialog[open] header button').last().click();
    if (!actualProject) {
      const response = await selectText(frame, '.assistant .message-content');
      await clipboard({ text: 'Response copy marker' }); await press(page.keyboard, copy); await copied(response);
      await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Database binding error\nDiagnostic log: failed request' } })));
      const errorText = await selectText(frame, '#error');
      await clipboard({ text: 'Error copy marker' }); await press(page.keyboard, copy); await copied(errorText);
      await clipboard({ text: 'Context copy marker' });
      await frame.locator('#error').click({ button: 'right' });
      await contextMenu.waitFor();
      await contextMenu.locator('.action-menu-item').filter({ hasText: /Copy|\u590d\u5236/ }).first().click(); await copied(errorText);
      await clipboard({ text: 'Workbench copy marker' }); await selectText(frame, '.assistant .message-content');
      await nativeWindow.evaluate(window => window.webContents.send('vscode:runAction', { id: 'editor.action.clipboardCopyAction', from: 'menu' })); await copied(response);
      proof.checks.push(`${language}: selected responses and multiline errors/logs copy through the keyboard, workbench command and right-click menu to the native clipboard`);
      await page.locator('.part.activitybar').getByRole('tab', { name: /^(?:Information|\u4fe1\u606f)(?:\s|$)/ }).click();
      let information;
      for (let attempt = 0; attempt < 100 && !information; attempt++) {
        information = await Promise.any(page.frames().map(async current => { if (await current.locator('#info-app').isVisible().catch(() => false)) { return current; } throw new Error('Not information'); })).catch(() => undefined);
        if (!information) { await pause(100); }
      }
      assert.ok(information);
      const value = await selectText(information, '[data-field=uuid] .info-value');
      await clipboard({ text: 'Studio copy marker' }); await press(page.keyboard, copy); await copied(value);
      const label = await selectText(information, '.section-label');
      await clipboard({ text: 'Studio label copy marker' }); await press(page.keyboard, copy); await copied(label);
      await clipboard({ text: 'Studio context copy marker' });
      await information.locator('.section-label').first().click({ button: 'right' }); await contextMenu.waitFor();
      await contextMenu.locator('.action-menu-item').filter({ hasText: /Copy|\u590d\u5236/ }).first().click(); await copied(label);
      proof.checks.push(`${language}: Studio information values and section labels copy through the keyboard and standard context menu`);
    }
    if (!await page.locator('.part.auxiliarybar').isVisible()) { await command('View: Toggle Secondary Side Bar Visibility'); }
    let assistant;
    for (let attempt = 0; attempt < 300 && !assistant; attempt++) {
      for (const current of page.frames()) {
        if (await current.locator('body[data-surface=assistant] #message').isVisible().catch(() => false)) { assistant = current; break; }
      }
      if (!assistant) { await pause(100); }
    }
    assert.ok(assistant); await assistant.locator('#parameters[aria-busy=false]').waitFor({ state: 'attached' });
    await clipboard({ text: 'Assistant paste' }); await assistant.locator('#message').click(); await press(assistant.locator('#message'), paste);
    await assistant.waitForFunction(() => document.querySelector('#message').value === 'Assistant paste');
    await clipboard({ image: png }); await press(assistant.locator('#message'), paste); await imageLoaded(assistant, '#draft-attachments img');
    await assistant.locator('#draft-attachments .attachment-preview').click(); await imageLoaded(assistant, '.conversation-dialog[open] .image-preview');
    await page.screenshot({ path: path.join(proofDir, `${language}-assistant-preview.png`) });
    proof.checks.push(`${language}: the right-side Assistant accepts native text and image paste and previews the image`);
  } catch (error) {
    await page?.screenshot({ path: path.join(proofDir, `${language}-failed.png`) }).catch(() => undefined);
    if (page) { console.error(JSON.stringify(await Promise.all(page.frames().map(frame => frame.evaluate(() => ({ url: location.href, focused: document.activeElement?.tagName, textLength: document.querySelector('#message')?.value.length, error: document.querySelector('#error')?.textContent, events: window.__clipboardEvents })).catch(() => ({})))))); }
    throw error;
  } finally {
    if (savedClipboard && app) { await app.evaluate(({ clipboard }, { entries, last }) => {
      const current = clipboard.availableFormats().sort().map(format => ({ format, data: clipboard.readBuffer(format).toString('base64') }));
      if (JSON.stringify(current) !== JSON.stringify(last)) { return; }
      clipboard.clear(); for (const { format, data } of entries) { clipboard.writeBuffer(format, Buffer.from(data, 'base64')); }
    }, { entries: savedClipboard, last: lastClipboard }).catch(() => undefined); }
    await app?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
assert.deepEqual(proof.errors, []);
await writeFile(path.join(proofDir, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify(proof));
