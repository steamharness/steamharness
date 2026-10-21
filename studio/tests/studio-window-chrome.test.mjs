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
});
