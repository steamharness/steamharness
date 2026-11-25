import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../upstream/vscode/src/vs/workbench/electron-browser/parts/titlebar/titlebarPart.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;

test('native macOS controls use the embedded header height at every zoom and restore the IDE height', () => {
  const updates = [], mode = { steam: false }, chrome = { height: 52 };
  let zoom = 1;
  class BrowserTitlebarPart { layout() {} get hasStudioModeSwitcher() { return true; } get minimumHeight() { return 35; } }
  const common = { BrowserTitlebarPart, BrowserTitleService: class {}, isMacintosh: true,
    getWindow: () => ({}), getWindowId: () => 7, getZoomFactor: () => zoom, useWindowControlsOverlay: () => true,
    studioModeState: mode, studioWindowChrome: chrome };
  const service = () => () => {};
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require: () => new Proxy(common, { get: (object, key) => key in object ? object[key] : service }) });
  const native = Object.create(module.exports.NativeTitlebarPart.prototype);
  native.element = { offsetWidth: 1400 };
  native.configurationService = {};
  native.nativeHostService = { updateWindowControls: options => updates.push(options) };
  for (const scale of [1, .8, 1.5]) {
    zoom = scale; mode.steam = true;
    // A hidden grid title bar may report zero. Native buttons must remain in the content header.
    native.layout(1400, 0);
    assert.equal(updates.at(-1).height, Math.round(52 * scale));
    assert.equal(updates.at(-1).horizontalInset, 10);
    mode.steam = false; native.layout(1400, 35);
    assert.equal(updates.at(-1).height, Math.round(35 * scale));
  }
  native.isStudioLaunchpad = true;
  assert.equal(native.hasStudioModeSwitcher, false, 'the resident launchpad must not create the floating IDE mode switcher');
});

test('macOS fullscreen keeps a populated title bar in Auto and respects an explicit hide preference', async () => {
  const source = await readFile(new URL('../upstream/vscode/src/vs/workbench/services/layout/browser/layoutService.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  const services = {
    refineServiceDecorator: service => service,
    isMacintosh: true, isNative: true, isWeb: false, isFullscreen: window => window.fullscreen,
    hasCustomTitlebar: () => true,
    hasNativeTitlebar: config => config.getValue('window.titleBarStyle') === 'native',
    hasNativeMenu: () => true,
    TitleBarSetting: { CUSTOM_TITLE_BAR_VISIBILITY: 'window.customTitleBarVisibility' },
    CustomTitleBarVisibility: { WINDOWED: 'windowed', NEVER: 'never' },
  };
  runInNewContext(compiled, { module, exports: module.exports, require: () => services });
  const show = (fullscreen, hasContent, preference = 'auto', nativeTitleBar = false) => module.exports.shouldShowCustomTitleBar({
    getValue: key => ({ 'window.customTitleBarVisibility': preference, 'window.titleBarStyle': nativeTitleBar ? 'native' : 'custom' })[key],
  }, { fullscreen }, false, hasContent);
  assert.equal(show(true, false), false, 'an empty custom title bar should still give back the space');
  assert.equal(show(true, true), true, 'registered actions count even with the built-in title controls disabled');
  assert.equal(show(true, true, 'windowed'), false);
  assert.equal(show(false, true, 'windowed'), true);
  assert.equal(show(true, true, 'never', true), false);
});

const dragSource = await readFile(new URL('../upstream/vscode/src/vs/workbench/contrib/webview/browser/studioWindowDrag.ts', import.meta.url), 'utf8');
const dragCompiled = ts.transpileModule(dragSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function dragFixture() {
  class Disposable {
    disposables = [];
    _register(value) { this.disposables.push(value); return value; }
    dispose() { this.disposables.forEach(value => value.dispose()); }
  }
  const document = { createElement: () => ({ ownerDocument: document, style: {}, children: [], setAttribute() {},
    appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, remove() { this.removed = true; } }) };
  const parent = document.createElement();
  const module = { exports: {} };
  runInNewContext(dragCompiled, { module, exports: module.exports, require: () => ({ Disposable, toDisposable: dispose => ({ dispose }) }) });
  const drag = new module.exports.StudioWindowDragRegions({ ownerDocument: document, parentElement: parent });
  return { drag, overlay: parent.children[0] };
}

test('project drag regions stay anchored to their own webview at different sizes and dispose with it', () => {
  const { drag, overlay } = dragFixture();
  const maxWidth = 'max(0px, calc(75% - var(--studio-window-chrome-right, 0px)))';
  drag.update({ version: 1, width: 800, height: 600, regions: [{ x: 200, y: 0, width: 400, height: 48 }] });
  assert.deepEqual(overlay.children[0].style, { left: '25%', top: '0%', width: '50%', height: '8%', maxWidth });
  drag.update({ version: 1, width: 1600, height: 1200, regions: [{ x: 400, y: 0, width: 800, height: 48 }] });
  assert.deepEqual(overlay.children[0].style, { left: '25%', top: '0%', width: '50%', height: '4%', maxWidth });
  drag.update({ version: 1, width: 800, height: 600, regions: [] });
  assert.equal(overlay.children.length, 0);
  drag.dispose(); assert.equal(overlay.removed, true);
});

test('malformed or out-of-header native geometry clears old regions instead of blocking project content', () => {
  const { drag, overlay } = dragFixture();
  const valid = { version: 1, width: 800, height: 600, regions: [{ x: 200, y: 0, width: 400, height: 48 }] };
  for (const invalid of [{ ...valid, width: NaN }, { ...valid, version: 2 }, { ...valid, regions: null },
    ...[{ x: -1 }, { y: 256 }, { width: 801 }, { height: Infinity }].map(change => ({ ...valid, regions: [{ ...valid.regions[0], ...change }] }))]) {
    drag.update(valid); assert.equal(overlay.children.length, 1);
    drag.update(invalid); assert.equal(overlay.children.length, 0);
  }
  drag.dispose();
});
