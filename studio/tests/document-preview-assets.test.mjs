import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import { buildDocumentPreviews } from '../scripts/document-preview.mjs';

test('preview bundles contain offline PDF/font/license assets and self-contained blob workers', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'studio-preview-assets-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await buildDocumentPreviews({ output });
  const main = await readFile(path.join(output, 'main.js'), 'utf8');
  assert.ok(Buffer.byteLength(main) < 100 * 1024, 'The entry module must lazy-load the format libraries');
  assert.ok((await readdir(path.join(output, 'fonts'))).some(name => name.endsWith('.woff2')));
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) { assert.ok((await readdir(path.join(output, 'pdf', directory))).length > 0); }
  assert.ok((await readFile(path.join(output, 'pdf/pdf.worker.min.mjs'))).length > 100_000);
  assert.ok((await readdir(path.join(output, 'pdf/wasm'))).every(name => !name.startsWith('quickjs-eval')));
  for (const name of ['heif-worker', 'spreadsheet-worker']) {
    const script = await readFile(path.join(output, `${name}.js`), 'utf8'), ast = ts.createSourceFile(`${name}.js`, script, ts.ScriptTarget.Latest, true);
    assert.ok(script.length > 100_000);
    assert.equal(ast.statements.filter(statement => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) && statement.moduleSpecifier).length, 0,
      'Blob workers cannot resolve relative module imports');
  }
  for (const name of ['pdfjs-dist', 'docx-preview', 'pptxviewjs', 'xlsx', 'katex', 'dompurify', 'jszip', 'chart.js', 'libheif-js']) {
    assert.ok((await readdir(path.join(output, 'licenses', name))).length, name);
  }
  assert.match(await readFile(path.join(output, 'licenses/libheif-js/wasm-LICENSE'), 'utf8'), /GNU/);
});
