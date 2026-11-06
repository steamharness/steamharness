// Isolated headless geometry proof using the native switcher and actual CLI header styles.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const proof = process.env.STEAMHARNESS_UI_PROOF ?? path.join(root, 'studio/.studio/steam-chrome');
await mkdir(proof, { recursive: true });
const nativeCss = await readFile(path.join(root, 'studio/upstream/vscode/src/vs/workbench/browser/parts/media/studioMode.css'), 'utf8');
const source = await readFile(path.join(root, 'studio/upstream/vscode/src/vs/workbench/browser/parts/studioMode.ts'), 'utf8');
const nativeCode = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
const webCode = await build({ absWorkingDir: root, stdin: { contents: "export { ProjectWindowChrome } from './cli/src/web/ui/window-chrome'", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', globalName: 'WebChrome', outfile: 'chrome.js', write: false });
const webJs = webCode.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? webCode.outputFiles[0].text;
const iconRoot = path.join(root, 'cli/node_modules/@vscode/codicons/dist');
const icons = (await readFile(path.join(iconRoot, 'codicon.css'), 'utf8')).replace(/url\([^)]*codicon\.ttf[^)]*\)/g, `url(data:font/ttf;base64,${(await readFile(path.join(iconRoot, 'codicon.ttf'))).toString('base64')})`);
const baseCss = await readFile(path.join(root, 'cli/src/web/ui/style.css'), 'utf8');
const chromeCss = await readFile(path.join(root, 'cli/src/web/ui/window-chrome.css'), 'utf8');
const kanbanCss = await readFile(path.join(root, 'cli/src/web/ui/kanban-style.css'), 'utf8');
const glyph = name => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
const avatar = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#2363e9"/><path d="m16 6 9 5v10l-9 5-9-5V11Zm0 0v20m-9-15 9 5 9-5M7 21l9-5 9 5" fill="none" stroke="white" stroke-width="1.4"/></svg>').toString('base64')}`;
const browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
const results = [];
try {
  for (const [release, zoom, width] of [[true, 1, 1200], [true, 1.5, 2048], [true, .8, 1000], [false, 1.5, 1400]]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<style>
      html,body{margin:0;height:100%;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .monaco-workbench{--vscode-fontSize-body1:13px;--vscode-fontSize-label1:12px;--vscode-codiconFontSize:16px;--vscode-codiconFontSize-compact:12px;--vscode-spacing-size20:2px;--vscode-spacing-size40:4px;--vscode-spacing-size60:6px;--vscode-spacing-size80:8px;--vscode-spacing-size120:12px;--vscode-spacing-size160:16px;--vscode-spacing-size200:20px;--vscode-spacing-size240:24px;--vscode-spacing-size280:28px;--vscode-spacing-size320:32px;--vscode-spacing-size400:40px;--vscode-strokeThickness:1px;--vscode-cornerRadius-small:4px;--vscode-cornerRadius-medium:6px;--vscode-foreground:#333;--vscode-editor-background:white;--zoom-factor:${zoom};position:relative;zoom:${zoom};width:${width / zoom}px;height:${800 / zoom}px}
      iframe{display:block;width:100%;height:100%;border:0} #left,#right{display:none}
      ${icons}\n${nativeCss}
      </style><div class="monaco-workbench mac studio-steam-mode"><div id="left"></div><div id="right"></div><iframe></iframe></div>`);
    const frame = page.frames()[1];
    await frame.setContent(`<style>${icons}\n${baseCss}\n${chromeCss}</style><div id="app"><header class="toolbar"><div class="project-title"><button id="menu" class="icon-button">${glyph('layout-sidebar-left')}</button><h1>Agent</h1></div><div class="toolbar-actions"><button class="icon-button">${glyph('layout')}</button><button class="icon-button">${glyph('add')}</button><button class="icon-button">${glyph('hubot')}</button></div></header><main></main></div>`);
    await frame.addScriptTag({ content: webJs });
    await frame.evaluate(() => { window.chromeFixture = new WebChrome.ProjectWindowChrome(); });
    await page.evaluate(({ nativeCode, release, avatar }) => {
      const event = () => ({ dispose() {} });
      class Emitter { listeners = new Set(); event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire(value) { for (const fn of this.listeners) fn(value); } }
      class Disposable { items = []; _register(item) { this.items.push(item); return item; } dispose() { for (const item of this.items.reverse()) item.dispose(); } }
      class DisposableStore extends Disposable { add(item) { return this._register(item); } clear() { this.dispose(); this.items = []; } }
      const $ = (selector, attributes, ...children) => { const [tag, ...classes] = selector.split('.'); const node = document.createElement(tag || 'div'); node.className = classes.join(' '); for (const [key, value] of Object.entries(attributes ?? {})) { if (key === 'hidden') node.hidden = value; else node.setAttribute(key, value); } node.append(...children); return node; };
      const common = { $, append: (parent, child) => parent.appendChild(child), getWindow: () => window, Emitter, Disposable, DisposableStore,
        addDisposableListener: (target, name, fn) => { target.addEventListener(name, fn); return { dispose: () => target.removeEventListener(name, fn) }; },
        toDisposable: dispose => ({ dispose }), onDidChangeFullscreen: event, onDidChangeZoomLevel: event, CommandsRegistry: { registerCommand: event }, getDefaultHoverDelegate: () => ({}), Parts: { AUXILIARYBAR_PART: 'tools' } };
      const module = { exports: {} }, require = () => new Proxy(common, { get: (values, key) => key in values ? values[key] : () => {} });
      new Function('module', 'exports', 'require', nativeCode)(module, module.exports, require);
      const native = module.exports, visibility = new Emitter(); let visible = false;
      const layout = { mainContainer: document.querySelector('.monaco-workbench'), isVisible: () => visible, getContainer: () => undefined, onDidChangePartVisibility: visibility.event, onDidLayoutMainContainer: event };
      const commands = { executeCommand: async (command, value) => { if (command === 'studio.internalUpdateWindowChrome') document.querySelector('iframe').contentWindow.chromeFixture.update(value); else if (command === 'workbench.action.toggleAuxiliaryBar') { visible = !visible; visibility.fire(); } } };
      native.studioModeState.state = { available: true, releaseOnly: release, project: { name: '三角洲', avatarUrl: avatar }, labels: {} };
      window.switcher = new native.StudioModeSwitcher(document.querySelector('#left'), document.querySelector('#right'), commands, { error: error => { throw error; } }, layout, { setupManagedHover: () => ({ update() {}, dispose() {} }) });
      native.studioModeState.setMode(true, false);
    }, { nativeCode, release, avatar });
    await frame.locator('#app[data-studio-window-chrome]').waitFor();
    await page.evaluate(() => document.fonts.ready); await frame.evaluate(() => document.fonts.ready);
    const geometry = async () => {
      const outer = await page.evaluate(() => { const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { y: r.y, height: r.height, center: r.y + r.height / 2 }; }; return { project: box('.studio-mode-switcher'), tool: box('.studio-steam-toggle-tools'), nativeIcon: getComputedStyle(document.querySelector('.studio-steam-toggle-tools .codicon')).fontSize, logo: document.querySelector('.studio-release-project-logo').getBoundingClientRect().height }; });
      const inner = await frame.evaluate(() => { const r = document.querySelector('#menu').getBoundingClientRect(); return { center: r.y + r.height / 2, icon: getComputedStyle(document.querySelector('#menu .codicon')).fontSize }; });
      const frameBox = await page.locator('iframe').boundingBox();
      return { ...outer, entryCenter: frameBox.y + inner.center * zoom, webIcon: inner.icon };
    };
    const value = await geometry(); results.push({ release, zoom, width, ...value });
    assert.ok(Math.abs(value.project.center - value.entryCenter) < 1, JSON.stringify(value));
    assert.ok(Math.abs(value.tool.center - value.entryCenter) < 1, JSON.stringify(value));
    assert.equal(value.webIcon, '16px');
    assert.equal(value.nativeIcon, value.webIcon);
    if (release) assert.ok(Math.abs(value.logo - 20 * zoom) < 1, JSON.stringify(value));
    if (release && zoom === 1.5) await page.screenshot({ path: path.join(proof, 'after.png') });
    await frame.addStyleTag({ content: kanbanCss });
    await frame.evaluate(() => document.querySelector('#app').classList.add('kanban-app'));
    const kanban = await geometry(); assert.ok(Math.abs(kanban.tool.center - kanban.entryCenter) < 1, JSON.stringify(kanban));
    assert.deepEqual(errors, []);
    await page.close();
  }
  await writeFile(path.join(proof, 'geometry.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ headless: true, scenarios: results.length, proof, results }, null, 2));
} finally { await browser.close(); }
