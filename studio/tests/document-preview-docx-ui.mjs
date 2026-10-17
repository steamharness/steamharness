import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const proofDir = path.join(root, '.studio/document-preview-docx'); await mkdir(proofDir, { recursive: true });
const proof = { checks: [], screenshots: [], errors: [] };
const compiled = await build({ entryPoints: [path.join(root, 'extensions/studio-workstation/webview/document-preview/docx.ts')],
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' });
const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const text = value => `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`;
const simple = (instruction, cached = '99') => `<w:fldSimple w:instr="${instruction}"><w:r><w:rPr><w:color w:val="447766"/><w:sz w:val="18"/></w:rPr><w:t>${cached}</w:t></w:r></w:fldSimple>`;
const complex = (instruction, cached = '99') => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>${instruction.slice(0, 2)}</w:instrText></w:r><w:r><w:instrText>${instruction.slice(2)}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/><w:t>${cached}</w:t><w:fldChar w:fldCharType="end"/></w:r>`;
const section = numbering => `<w:sectPr><w:headerReference r:id="header" w:type="default"/><w:footerReference r:id="footer" w:type="default"/><w:pgSz w:w="9000" w:h="12000"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360"/>${numbering ?? ''}</w:sectPr>`;
const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
async function fixture({ footer, pages = 3, numbering, body }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="header" Type="${r}/header" Target="header1.xml"/><Relationship Id="footer" Type="${r}/footer" Target="footer1.xml"/></Relationships>`);
  zip.file('word/document.xml', `<w:document xmlns:w="${w}" xmlns:r="${r}"><w:body>${body ?? Array.from({ length: pages }, (_, index) => `<w:p>${text(`Page content ${index + 1}`)}</w:p>`).join(pageBreak)}${section(numbering)}</w:body></w:document>`);
  zip.file('word/header1.xml', `<w:hdr xmlns:w="${w}"><w:p>${text('Header ')}${simple('PAGE')}</w:p></w:hdr>`);
  zip.file('word/footer1.xml', `<w:ftr xmlns:w="${w}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${footer}</w:p></w:ftr>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const entry = `import render from '/renderer.js';
window.previewDocx = async (base64) => {
  window.currentPreview?.dispose(); document.body.replaceChildren();
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const context = { state: { page: 1, scale: 1, fit: true, top: 0, left: 0 }, width: () => innerWidth, save() {}, copy() {}, error(error) { throw error; } };
  const view = await render(bytes, context, new AbortController().signal, 'preview.docx');
  window.currentPreview = view; document.body.append(view.element); view.activate?.();
};`;
const server = createServer((request, response) => {
  if (request.url === '/renderer.js' || request.url === '/entry.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end(request.url === '/renderer.js' ? compiled.outputFiles[0].text : entry);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><head><style>html,body{width:100%;height:100%;margin:0;background:#fff;font-family:Arial}.preview-frame{width:100%;height:100%;border:0}</style><script type="module" nonce="docx-preview-test" src="/entry.js"></script></head><body></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.WORKFLOW_UI_BROWSER ?? 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 950 } }); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => typeof window.previewDocx === 'function');
  async function preview(bytes) {
    await page.evaluate(base64 => window.previewDocx(base64), bytes.toString('base64'));
    const frame = page.frameLocator('.preview-frame');
    await frame.locator('.docx-wrapper > section.docx').first().waitFor(); return frame;
  }
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  const simpleBytes = await fixture({ footer: text('Plan | Page ') + simple(' PAGE ', '1') + text(' of ') + simple(' NUMPAGES ') + text(' | ') + simple('DATE', 'cached date') });
  let frame = await preview(simpleBytes);
  assert.deepEqual((await frame.locator('footer').allTextContents()).map(normalize), ['Plan | Page 1 of 3 | cached date', 'Plan | Page 2 of 3 | cached date', 'Plan | Page 3 of 3 | cached date']);
  assert.deepEqual((await frame.locator('header').allTextContents()).map(normalize), ['Header 1', 'Header 2', 'Header 3']);
  assert.equal(await frame.locator('footer span').filter({ hasText: /^1$/ }).first().evaluate(node => getComputedStyle(node).color), 'rgb(68, 119, 102)');
  await frame.locator('footer').nth(1).evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  assert.equal(normalize(await frame.locator('body').evaluate(() => getSelection().toString())), 'Plan | Page 2 of 3 | cached date');
  const bounds = await frame.locator('footer').first().evaluate(node => {
    const page = node.closest('section').getBoundingClientRect(), footer = node.getBoundingClientRect();
    return { pageTop: page.top, pageBottom: page.bottom, footerTop: footer.top, footerBottom: footer.bottom };
  });
  assert.ok(bounds.footerTop > bounds.pageTop && bounds.footerBottom <= bounds.pageBottom);
  await frame.locator('footer').first().screenshot({ path: path.join(proofDir, 'simple-fields.png') }); proof.screenshots.push('simple-fields.png');
  proof.checks.push('Simple PAGE and NUMPAGES fields render every page with preserved styles, cached non-page fields, visible bounds and selectable numbers');

  frame = await preview(await fixture({ footer: text('Page ') + complex(' PAGE \\* MERGEFORMAT ') + text(' of ') + complex(' NUMPAGES '), numbering: '<w:pgNumType w:start="5"/>' }));
  assert.deepEqual((await frame.locator('footer').allTextContents()).map(normalize), ['Page 5 of 3', 'Page 6 of 3', 'Page 7 of 3']);
  proof.checks.push('Split complex fields and cached text sharing field-control runs render the current page and total count');

  frame = await preview(await fixture({ pages: 2, footer: text('Page ') + simple('PAGE \\* ROMAN') + text(' / ') + simple('PAGE \\* alphabetic'), numbering: '<w:pgNumType w:start="2"/>' }));
  assert.deepEqual((await frame.locator('footer').allTextContents()).map(normalize), ['Page II / b', 'Page III / c']);
  proof.checks.push('Page numbering starts and Roman/alphabetic field switches are respected');

  frame = await preview(await fixture({ footer: text('Page ') + simple('PAGE') + text(' of section ') + simple('SECTIONPAGES'), numbering: '<w:pgNumType w:start="1" w:fmt="lowerRoman"/>',
    body: `<w:p><w:pPr>${section('<w:pgNumType w:start="4"/>')}</w:pPr>${text('First section')}<w:r><w:br w:type="page"/></w:r></w:p><w:p>${text('Second section')}</w:p>` }));
  assert.deepEqual((await frame.locator('footer').allTextContents()).map(normalize), ['Page 4 of section 1', 'Page i of section 1']);
  proof.checks.push('Separate sections restart their page numbering and SECTIONPAGES counts rendered pages within each section');

  const sample = process.env.STUDIO_TEST_PREVIEW_DOCX;
  if (sample) {
    const bytes = await readFile(sample), originalHash = createHash('sha256').update(bytes).digest('hex');
    frame = await preview(bytes); const footers = (await frame.locator('footer').allTextContents()).map(normalize); assert.ok(footers.length);
    for (const [index, footer] of footers.entries()) { assert.match(footer, new RegExp(`\u7b2c\\s*${index + 1}\\s*\u9875`)); }
    await frame.locator('footer').first().screenshot({ path: path.join(proofDir, 'source-footer.png') }); proof.screenshots.push('source-footer.png');
    assert.equal(createHash('sha256').update(await readFile(sample)).digest('hex'), originalHash);
    proof.checks.push(`The source sample renders ${footers.length} numbered footers without changing its bytes`);
  }
  frame = await preview(simpleBytes); assert.equal(normalize(await frame.locator('footer').first().textContent()), 'Plan | Page 1 of 3 | cached date');
  assert.equal(await frame.locator('script:not([nonce]), [contenteditable=true], input').count(), 0);
  assert.deepEqual(proof.errors, []); proof.checks.push('Repeated previews remain read-only and retain the sandboxed document content');
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(proofDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
}
