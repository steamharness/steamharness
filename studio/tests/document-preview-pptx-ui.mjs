import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { buildDocumentPreviews } from '../scripts/document-preview.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const proofDir = path.join(root, '.studio/document-preview-pptx'), assets = path.join(proofDir, 'assets');
await mkdir(proofDir, { recursive: true }); await buildDocumentPreviews({ output: assets });
const require = createRequire(import.meta.url), icons = path.dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
const bundles = Object.fromEntries(await Promise.all(['en', 'zh-cn'].map(async language => [language,
  JSON.parse(await readFile(path.join(root, `extensions/studio-workstation/l10n/bundle.l10n${language === 'en' ? '' : '.zh-cn'}.json`), 'utf8'))])));
const proof = { checks: [], screenshots: [], errors: [] };

async function tableFixture(updated = false) {
  const zip = await JSZip.loadAsync(await fixture());
  const texts = ['Stage', 'Time', 'Task', '\u5efa\u7acb\u4e60\u60ef', 'Week 1', 'Read and review',
    '\u603b\u7ed3\u4e0e\u5ef6\u7eed', 'Week 5', updated ? 'Updated final task' : 'Final task'];
  for (const index of [1, 2]) {
    const uri = `http://schemas.openxmlformats.org/drawingml/2006/${index === 2 ? 'main/' : ''}table`;
    const rows = [600000, 1000000, 1000000].map((height, row) => `<a:tr h="${height}">${texts.slice(row * 3, row * 3 + 3).map(text => `<a:tc><a:txBody><a:bodyPr anchor="ctr" lIns="0" rIns="0" tIns="0" bIns="0"/><a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr sz="1800" b="${row === 0 ? 1 : 0}"><a:solidFill><a:srgbClr val="${row === 0 ? 'FFFFFF' : '202020'}"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="Times New Roman"/></a:rPr><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr marL="101600" marR="101600" marT="50800" marB="50800" anchor="ctr"><a:solidFill><a:srgbClr val="${['245C48', 'E6EFE9', 'FFFFFF'][row]}"/></a:solidFill></a:tcPr></a:tc>`).join('')}</a:tr>`).join('');
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Reading table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="600000" y="1600000"/><a:ext cx="7600000" cy="2600000"/></p:xfrm><a:graphic><a:graphicData uri="${uri}"><a:tbl><a:tblPr/><a:tblGrid>${[1600000, 2200000, 3800000].map(width => `<a:gridCol w="${width}"/>`).join('')}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const xml = await zip.file(`ppt/slides/slide${index}.xml`).async('string');
    zip.file(`ppt/slides/slide${index}.xml`, xml.replace('cy="3500000"', 'cy="500000"')
      .replace(`<a:t>Slide ${index}</a:t>`, `<a:t>\u9605\u8bfb\u8ba1\u5212 ${index}</a:t>`)
      .replace('<a:latin typeface="Arial"/>', '<a:latin typeface="Arial"/><a:ea typeface="Times New Roman"/>')
      .replace('</p:spTree>', `${table}</p:spTree>`));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function fixture() {
  const zip = new JSZip(), p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main', r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${[1, 2].map(index => `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="presentation" Type="${r}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="256" r:id="slide1"/><p:sldId id="257" r:id="slide2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1, 2].map(index => `<Relationship Id="slide${index}" Type="${r}/slide" Target="slides/slide${index}.xml"/>`).join('')}</Relationships>`);
  for (const index of [1, 2]) {
    zip.file(`ppt/slides/slide${index}.xml`, `<p:sld xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${r}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="600000" y="600000"/><a:ext cx="7500000" cy="3500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${index === 1 ? '008877' : 'CC3366'}"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr" tIns="91440" bIns="91440"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="3600"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>Slide ${index}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const themeCss = `:root{--vscode-font-family:Arial,sans-serif;--vscode-font-size:13px;--vscode-editor-foreground:#333;--vscode-editor-background:#fff;--vscode-editorGroupHeader-tabsBackground:#ececec;--vscode-widget-border:#bcbcbc;--vscode-panel-border:#ddd;--vscode-descriptionForeground:#666;--vscode-icon-foreground:#444;--vscode-input-background:#fff;--vscode-input-foreground:#333;--vscode-input-border:#ccc;--vscode-focusBorder:#0078d4}
html[data-theme=dark]{color-scheme:dark;--vscode-editor-foreground:#ccc;--vscode-editor-background:#1f1f1f;--vscode-editorGroupHeader-tabsBackground:#181818;--vscode-widget-border:#595959;--vscode-panel-border:#444;--vscode-descriptionForeground:#aaa;--vscode-icon-foreground:#ccc;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-input-border:#555}`;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      const language = url.searchParams.get('language') === 'zh-cn' ? 'zh-cn' : 'en';
      const localization = JSON.stringify({ bundle: bundles[language], locale: language }).replace(/</g, '\\u003c');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      const csp = "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'nonce-preview-test' 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' data: blob:; frame-src 'self' blob:;";
      response.end(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${themeCss}</style><link rel="stylesheet" href="/main.css"><link rel="stylesheet" href="/codicon.css"></head><body><div id="preview-app"></div><script type="application/json" id="studio-localization">${localization}</script><script nonce="preview-test">window.previewMessages=[];window.acquireVsCodeApi=()=>({getState:()=>window.previewState,setState:state=>{window.previewState=state},postMessage:message=>window.previewMessages.push(message)});</script><script type="module" nonce="preview-test" src="/main.js"></script></body></html>`);
      return;
    }
    const asset = path.resolve(assets, `.${decodeURIComponent(url.pathname)}`);
    if (!asset.startsWith(`${assets}${path.sep}`)) { response.writeHead(404).end(); return; }
    const file = url.pathname === '/codicon.css' || url.pathname === '/codicon.ttf' ? path.join(icons, path.basename(url.pathname)) : asset;
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
    response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream'); response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.addInitScript(() => {
    const prototype = CanvasRenderingContext2D.prototype, clear = prototype.clearRect, fill = prototype.fillText;
    prototype.clearRect = function (...args) { this.canvas.previewText = []; return clear.apply(this, args); };
    prototype.fillText = function (text, x, y, ...rest) {
      const matrix = this.getTransform();
      (this.canvas.previewText ??= []).push({ text: String(text), font: this.font,
        x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f,
        width: this.measureText(text).width * Math.hypot(matrix.a, matrix.b) });
      return fill.call(this, text, x, y, ...rest);
    };
  });
  const bytes = await fixture(); let generation = 0;
  async function preview(bytes, name = 'fixture.pptx') {
    const next = ++generation;
    await page.evaluate(({ bytes, generation, name }) => window.postMessage({ type: 'document', kind: 'pptx', bytes, generation, name }, '*'),
      { bytes: Array.from(bytes), generation: next, name });
    await page.waitForFunction(generation => document.getElementById('preview-app').dataset.generation === String(generation), next);
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.preview-slide canvas'); if (!canvas) { return false; }
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let colored = 0; for (let index = 0; index < pixels.length; index += 4) {
        if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) - Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) > 40) { ++colored; }
      }
      return colored > 100;
    });
  }
  async function layout(ratio = 16 / 9) {
    await page.waitForFunction(() => {
      const viewport = document.querySelector('.preview-slide'), canvas = viewport.querySelector('canvas');
      const area = viewport.getBoundingClientRect(), slide = canvas.getBoundingClientRect();
      return Math.abs(slide.x + slide.width / 2 - area.x - area.width / 2) < 2 &&
        Math.abs(slide.y + slide.height / 2 - area.y - area.height / 2) < 2 &&
        slide.width <= area.width - 31 && slide.height <= area.height - 31;
    });
    const dimensions = await page.locator('.preview-slide').evaluate(viewport => {
      const canvas = viewport.querySelector('canvas'), area = viewport.getBoundingClientRect(), slide = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      return { ratio: (slide.width - 2) / (slide.height - 2), border: style.borderTopWidth, borderColor: style.borderTopColor,
        background: getComputedStyle(viewport).backgroundColor, slideBackground: style.backgroundColor,
        overflow: viewport.scrollWidth > viewport.clientWidth || viewport.scrollHeight > viewport.clientHeight };
    });
    assert.ok(Math.abs(dimensions.ratio - ratio) < 0.01); assert.equal(dimensions.border, '1px');
    assert.notEqual(dimensions.borderColor, 'rgba(0, 0, 0, 0)'); assert.notEqual(dimensions.background, dimensions.slideBackground);
    assert.equal(dimensions.overflow, false); assert.equal(await page.locator('.slide-text, #preview-content details, #preview-content pre').count(), 0);
  }
  async function presentation(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const parts = Object.fromEntries(await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/slides\/[^/]+\.xml$/.test(name)).map(async name => [name, await zip.file(name).async('string')])));
    return page.evaluate(({ xml, rels, parts }) => {
      const nodes = (root, name) => Array.from(root.getElementsByTagNameNS('*', name));
      const parse = xml => new DOMParser().parseFromString(xml, 'application/xml');
      const relationships = new Map(nodes(parse(rels), 'Relationship').map(node => [node.getAttribute('Id'), node.getAttribute('Target')]));
      const doc = parse(xml), size = nodes(doc, 'sldSz')[0];
      const dimensions = { width: Number(size.getAttribute('cx')), height: Number(size.getAttribute('cy')) };
      const slides = nodes(doc, 'sldId').map(id => {
        const target = relationships.get(id.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
        const slide = parse(parts[new URL(target, 'https://fixture.invalid/ppt/presentation.xml').pathname.slice(1)]);
        return { text: nodes(slide, 't').map(node => node.textContent).join('\n'), tables: nodes(slide, 'tbl').map(table => {
          let frame = table.parentElement; while (frame && frame.localName !== 'graphicFrame') { frame = frame.parentElement; }
          const transform = nodes(frame, 'xfrm')[0], off = nodes(transform, 'off')[0], ext = nodes(transform, 'ext')[0];
          return { x: Number(off.getAttribute('x')), y: Number(off.getAttribute('y')),
            width: Number(ext.getAttribute('cx')), height: Number(ext.getAttribute('cy')),
            columns: nodes(table, 'gridCol').map(col => Number(col.getAttribute('w'))),
            rows: nodes(table, 'tr').map(row => ({ height: Number(row.getAttribute('h')), cells: nodes(row, 'tc').map(cell => {
              const properties = nodes(cell, 'tcPr')[0];
              const fill = Array.from(properties.children).find(node => node.localName === 'solidFill');
              const textColor = nodes(nodes(cell, 'rPr')[0], 'srgbClr')[0];
              return { text: nodes(cell, 't').map(node => node.textContent).join(''),
                fill: fill ? nodes(fill, 'srgbClr')[0]?.getAttribute('val') : undefined,
                color: textColor?.getAttribute('val') };
            }) })) };
        }) };
      });
      return { dimensions, slides };
    }, { xml: await zip.file('ppt/presentation.xml').async('string'),
      rels: await zip.file('ppt/_rels/presentation.xml.rels').async('string'), parts });
  }
  async function selectSlide(index, expected) {
    const input = page.locator('.preview-pager input'); await input.fill(String(index + 1)); await input.press('Enter');
    await page.waitForFunction(expected => {
      document.querySelector('.codicon-copy').parentElement.click();
      return window.previewMessages.at(-1)?.text === expected;
    }, expected);
  }
  async function slideText(slide) {
    const traces = await page.locator('.preview-slide canvas').evaluate(canvas => canvas.previewText ?? []);
    const normalize = text => text.replace(/\s/g, '');
    const rendered = normalize(traces.map(trace => trace.text).join(''));
    for (const text of slide.text.split('\n')) {
      assert.ok(rendered.includes(normalize(text)), `Slide is missing text: ${text}`);
    }
    return traces;
  }
  async function tables(slide, dimensions) {
    const results = await page.locator('.preview-slide canvas').evaluate((canvas, { slide, dimensions }) => {
      const context = canvas.getContext('2d'), traces = canvas.previewText ?? [];
      const sx = canvas.width / dimensions.width, sy = canvas.height / dimensions.height;
      const normalized = text => text.replace(/\s/g, '');
      const rgb = hex => [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
      return slide.tables.flatMap(table => {
        const totalWidth = table.columns.reduce((sum, width) => sum + width, 0);
        const totalHeight = table.rows.reduce((sum, row) => sum + row.height, 0);
        let y = table.y * sy;
        return table.rows.flatMap((row, rowIndex) => {
          const height = row.height / totalHeight * table.height * sy; let x = table.x * sx;
          const cells = row.cells.map((cell, column) => {
            const width = table.columns[column] / totalWidth * table.width * sx;
            const drawn = traces.filter(trace => trace.x >= x - 1 && trace.x < x + width && trace.y >= y - 1 && trace.y < y + height);
            const left = Math.ceil(x + 1), top = Math.ceil(y + 1), w = Math.max(1, Math.floor(width - 2)), h = Math.max(1, Math.floor(height - 2));
            const pixels = context.getImageData(left, top, w, h).data;
            const fill = cell.fill ? rgb(cell.fill) : null, color = cell.color ? rgb(cell.color) : null;
            const contrast = color && fill ? color.map((value, channel) => value - fill[channel]) : null;
            const contrastSquared = contrast?.reduce((sum, value) => sum + value * value, 0);
            let fillPixels = 0, textPixels = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (fill && fill.every((value, channel) => Math.abs(value - pixels[i + channel]) < 8)) { ++fillPixels; }
              if (contrastSquared) {
                // Small slides have antialiased glyphs with no fully opaque foreground pixels.
                const coverage = contrast.reduce((sum, value, channel) => sum + value * (pixels[i + channel] - fill[channel]), 0) / contrastSquared;
                if (coverage > 0.15 && coverage <= 1.05 && contrast.every((value, channel) =>
                  Math.abs(pixels[i + channel] - fill[channel] - value * coverage) < 16)) { ++textPixels; }
              } else if (color && color.every((value, channel) => Math.abs(value - pixels[i + channel]) < 24)) { ++textPixels; }
            }
            const result = { row: rowIndex, column, text: cell.text,
              drawn: normalized(drawn.map(trace => trace.text).join('')).includes(normalized(cell.text)),
              fits: drawn.every(trace => trace.x + trace.width <= x + width + 2),
              fillRatio: fill ? fillPixels / (w * h) : null, textPixels: color ? textPixels : null,
              fonts: drawn.map(trace => trace.font) };
            x += width; return result;
          });
          y += height; return cells;
        });
      });
    }, { slide, dimensions });
    for (const cell of results) {
      assert.equal(cell.drawn, true, `Cell ${cell.row},${cell.column} missing text: ${cell.text}`);
      assert.equal(cell.fits, true, `Cell ${cell.row},${cell.column} clips text: ${cell.text}`);
      if (cell.fillRatio !== null) { assert.ok(cell.fillRatio > 0.35, `Cell ${cell.row},${cell.column} has the wrong background`); }
      if (cell.textPixels !== null && cell.text) { assert.ok(cell.textPixels > 1, `Cell ${cell.row},${cell.column} has no visible text`); }
    }
    return results;
  }
  for (const language of ['en', 'zh-cn']) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?language=${language}`);
    await page.waitForFunction(() => window.previewMessages.some(message => message.type === 'ready'));
    for (const theme of ['light', 'dark']) {
      await page.locator('html').evaluate((html, theme) => { html.dataset.theme = theme; }, theme);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 420 }, { width: 360, height: 640 }]) {
        await page.setViewportSize(viewport); await preview(bytes); await layout();
        assert.equal(await page.locator('.preview-readonly').innerText(), bundles[language]['Read-only']);
        const name = `${language}-${theme}-${viewport.width}.png`; await page.screenshot({ path: path.join(proofDir, name) });
        proof.screenshots.push(name); proof.checks.push(`${language} ${theme} ${viewport.width}x${viewport.height}: centered, proportional, fully visible slide with a border, distinct background and no text panel`);
      }
    }
    const copyLabel = bundles[language]['Copy slide text'], nextLabel = bundles[language]['Next page'];
    await page.getByRole('button', { name: copyLabel, exact: true }).click();
    assert.equal(await page.evaluate(() => window.previewMessages.at(-1).text), 'Slide 1');
    await page.getByRole('button', { name: nextLabel, exact: true }).click();
    await page.waitForFunction(() => {
      document.querySelector('.codicon-copy').parentElement.click();
      return window.previewMessages.at(-1)?.text === 'Slide 2';
    });
    await preview(bytes); assert.equal(await page.locator('.preview-pager input').inputValue(), '2'); await layout();
    proof.checks.push(`${language}: slide navigation, toolbar text copying and refresh retain the selected slide`);
    await page.setViewportSize({ width: 1440, height: 900 });
    const withTables = await tableFixture(), expected = await presentation(withTables);
    await preview(withTables);
    for (let index = 0; index < expected.slides.length; index++) {
      await selectSlide(index, expected.slides[index].text); await layout();
      const cells = await tables(expected.slides[index], expected.dimensions);
      const traces = await slideText(expected.slides[index]);
      assert.equal(cells.length, 9);
      for (const cell of cells.filter(cell => /[\u2e80-\u9fff]/u.test(cell.text))) {
        assert.ok(cell.fonts.every(font => font.includes('Times New Roman')));
      }
      assert.ok(traces.filter(trace => /[\u2e80-\u9fff]/u.test(trace.text)).every(trace => trace.font.includes('Times New Roman')));
      assert.ok(cells[0].fonts.every(font => font.includes('Arial')));
      proof.checks.push(`${language}: ${index === 0 ? 'standard' : 'alternate'} table URI renders all 9 cells, unequal column widths, row heights, fills and explicit East Asian fonts`);
    }
    const updated = await tableFixture(true), updatedPresentation = await presentation(updated);
    await preview(updated); assert.equal(await page.locator('.preview-pager input').inputValue(), '2');
    await selectSlide(1, updatedPresentation.slides[1].text); await tables(updatedPresentation.slides[1], updatedPresentation.dimensions);
    proof.checks.push(`${language}: updated table content renders after refresh while retaining the selected slide`);
  }
  const sample = process.env.STUDIO_TEST_PREVIEW_PPTX;
  if (sample) {
    const source = await readFile(sample), hash = createHash('sha256').update(source).digest('hex');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?language=zh-cn`);
    await page.waitForFunction(() => window.previewMessages.some(message => message.type === 'ready'));
    const expected = await presentation(source), ratio = expected.dimensions.width / expected.dimensions.height;
    await preview(source, path.basename(sample)); await layout(ratio);
    for (const theme of ['light', 'dark']) {
      await page.locator('html').evaluate((html, theme) => { html.dataset.theme = theme; }, theme);
      for (let index = 0; index < expected.slides.length; index++) {
        await selectSlide(index, expected.slides[index].text); await layout(ratio);
        const cells = await tables(expected.slides[index], expected.dimensions);
        await slideText(expected.slides[index]);
        const name = `source-${theme}-page-${index + 1}.png`; await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name);
        proof.checks.push(`Real PPTX ${theme} page ${index + 1}: all slide text rendered; ${cells.length} table cells have complete visible text and matching backgrounds`);
      }
    }
    await page.setViewportSize({ width: 360, height: 640 });
    for (let index = 0; index < expected.slides.length; index++) {
      await selectSlide(index, expected.slides[index].text); await layout(ratio);
      await tables(expected.slides[index], expected.dimensions); await slideText(expected.slides[index]);
      const name = `source-narrow-page-${index + 1}.png`; await page.screenshot({ path: path.join(proofDir, name) }); proof.screenshots.push(name);
    }
    proof.checks.push('Every real PPTX slide and table renders proportionally at 360x640 without clipped cell text');
    assert.equal(createHash('sha256').update(await readFile(sample)).digest('hex'), hash);
    proof.checks.push('The real PPTX sample renders centered in both themes without changing its bytes');
  }
  assert.deepEqual(proof.errors, []); console.log(JSON.stringify(proof, null, 2));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(proofDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
}
