import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cliRoot = process.env.WORKFLOW_UI_CLI_ROOT ?? path.join(root, '../cli');
const proofDir = path.join(root, '.studio/scrollbars');
await fs.mkdir(proofDir, { recursive: true });
const legacy = await build({ entryPoints: [path.join(root, 'extensions/studio-workstation/webview/style.css')], bundle: true, write: false });
const surfaces = [];
for (const name of ['account', 'resources', 'trace', 'info']) {
  surfaces.push({ name: `studio-${name}`, css: await fs.readFile(path.join(root, `extensions/studio-workstation/dist/${name}-ui.css`), 'utf8') });
}
surfaces.push({ name: 'studio-legacy', css: legacy.outputFiles[0].text });
surfaces.push({ name: 'studio-assistant-status', css: await fs.readFile(path.join(root, 'extensions/studio-workstation/dist/scrollbars.css'), 'utf8') });
const theme = await fs.readFile(path.join(cliRoot, 'dist/web/theme.css'), 'utf8');
for (const name of ['workflow-ui', 'workflow-workspace', 'kanban-workspace', 'resource-preview']) {
  surfaces.push({ name: `cli-${name}`, css: `${await fs.readFile(path.join(cliRoot, `dist/web/${name}.css`), 'utf8')}\n${theme}` });
}
const browser = await chromium.launch({ channel: process.env.WORKFLOW_UI_BROWSER ?? 'chrome', headless: true,
  ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar'] });
const page = await browser.newPage();
await page.bringToFront();
const proof = { cliRoot, checks: [], screenshots: [] };
const transparent = 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)';
const fixture = `
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
  body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  #outside { height: 48px; padding: 8px; }
  #outer { width: min(440px, calc(100vw - 32px)); height: 240px; margin: 0 16px; overflow: auto; }
  #inner { width: 200px; height: 80px; margin: 8px; overflow: auto; }
  .content { width: 900px; height: 720px; }
  #input { display: block; width: min(440px, calc(100vw - 32px)); height: 80px; margin: 16px; overflow: auto; resize: none; }
`;
async function style(selector) {
  return page.locator(selector).evaluate(element => {
    const styles = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { color: styles.scrollbarColor, thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
      width: rect.width, height: rect.height, clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      top: element.scrollTop, left: element.scrollLeft };
  });
}
async function hover(selector, options) {
  await page.locator(selector).hover(options);
  await page.waitForFunction(selector => document.querySelector(selector).matches(':hover'), selector);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
}
function layout(state) { return [state.width, state.height, state.clientWidth, state.clientHeight]; }
async function pixels(buffer) {
  return page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, image.width, image.height).data];
  }, buffer.toString('base64'));
}
try {
  for (const surface of surfaces) {
    for (const themeName of ['light', 'dark']) {
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 560 });
        await page.setContent(`<!doctype html><html data-theme="${themeName}"><head><style>${surface.css}</style><style>${fixture}</style></head>
          <body><div id="outside">${surface.name}</div><section id="outer" tabindex="0">
          <div class="content"><section id="inner" tabindex="0"><div class="content">Nested content</div></section></div>
          </section><textarea id="input">${'Line\n'.repeat(40)}</textarea></body></html>`);
        await page.locator('html').evaluate((element, themeName) => {
          element.style.colorScheme = themeName;
          element.style.setProperty('--vscode-editor-background', themeName === 'dark' ? '#1f1f1f' : '#ffffff');
          element.style.setProperty('--vscode-editor-foreground', themeName === 'dark' ? '#cccccc' : '#333333');
          element.style.setProperty('--vscode-scrollbarSlider-background', '#79797999');
          element.style.setProperty('--vscode-scrollbarSlider-hoverBackground', '#646464cc');
          element.style.setProperty('--vscode-scrollbarSlider-activeBackground', '#555555ee');
        }, themeName);
        await hover('#outside');
        const hidden = await style('#outer'); assert.equal(hidden.color, transparent, surface.name);
        assert.equal(hidden.thumb, 'rgba(0, 0, 0, 0)');
        const box = await page.locator('#outer').boundingBox();
        const clip = { x: box.x + box.width - 10, y: box.y + 2, width: 10, height: box.height - 14 };
        const before = await pixels(await page.screenshot({ clip }));
        await hover('#outer', { position: { x: 220, y: 110 } });
        const shown = await style('#outer'); assert.notEqual(shown.color, transparent, surface.name);
        assert.deepEqual(layout(shown), layout(hidden), 'Hover must not change the scroll area dimensions');
        assert.equal((await style('#inner')).color, transparent, 'Nested scroll areas must not inherit a hovered parent thumb');
        const after = await pixels(await page.screenshot({ clip }));
        assert.ok(after.some((value, index) => value !== before[index]), `${surface.name}: hover must visibly paint the scrollbar`);
        await hover('#inner'); assert.notEqual((await style('#inner')).color, transparent);
        await hover('#outside'); assert.equal((await style('#outer')).color, transparent);
        const prefix = `${surface.name}-${themeName}-${width}`;
        if (width === 360) {
          await page.screenshot({ path: path.join(proofDir, `${prefix}-hidden.png`) });
          await hover('#outer', { position: { x: 220, y: 110 } });
          await page.screenshot({ path: path.join(proofDir, `${prefix}-hover.png`) });
          proof.screenshots.push(`${prefix}-hidden.png`, `${prefix}-hover.png`);
        }
        await hover('#outer', { position: { x: 220, y: 110 } });
        await page.mouse.wheel(0, 120); await page.waitForFunction(() => document.querySelector('#outer').scrollTop > 0);
        await page.locator('#outer').focus(); await page.keyboard.press('PageDown');
        await page.waitForFunction(() => document.querySelector('#outer').scrollTop > 120);
        await page.waitForTimeout(400);
        await page.locator('#outer').evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
        const gutter = shown.width - shown.clientWidth;
        assert.ok(gutter > 0, 'The browser must expose draggable scrollbars');
        await page.mouse.move(box.x + box.width - gutter / 2, box.y + 25); await page.mouse.down();
        await page.mouse.move(box.x + box.width - gutter / 2, box.y + 130, { steps: 10 }); await page.mouse.up();
        await page.waitForFunction(() => document.querySelector('#outer').scrollTop > 0);
        await page.mouse.move(box.x + 25, box.y + box.height - gutter / 2); await page.mouse.down();
        await page.mouse.move(box.x + 130, box.y + box.height - gutter / 2, { steps: 10 }); await page.mouse.up();
        await page.waitForFunction(() => document.querySelector('#outer').scrollLeft > 0);
        await hover('#input'); assert.notEqual((await style('#input')).color, transparent);
        await hover('#outside'); assert.equal((await style('#input')).color, transparent);
        proof.checks.push(`${prefix}: visible hover, nested areas, stable dimensions, wheel, keyboard, both thumb drags, textarea`);
      }
    }
  }
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await fs.writeFile(path.join(proofDir, 'proof.json'), JSON.stringify(proof, null, 2));
  await browser.close();
}
