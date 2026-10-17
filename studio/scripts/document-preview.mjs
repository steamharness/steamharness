import { build, context } from 'esbuild';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './distribution.mjs';

export async function buildDocumentPreviews({ watch = false, output: outputDirectory } = {}) {
  const directory = path.join(ROOT, 'extensions/studio-workstation');
  const output = outputDirectory ?? path.join(directory, 'dist/document-preview');
  await fs.rm(output, { recursive: true, force: true });
  const options = { absWorkingDir: directory,
    entryPoints: ['webview/document-preview/main.ts'],
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', outdir: output,
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: 'fonts/[name]-[hash]',
    legalComments: 'linked', logLevel: 'info' };
  if (watch) { await (await context(options)).watch(); } else { await build(options); }
  for (const name of ['heif-worker', 'spreadsheet-worker']) {
    const worker = { ...options, splitting: false, entryPoints: [`webview/document-preview/${name}.ts`] };
    if (watch) { await (await context(worker)).watch(); } else { await build(worker); }
  }
  const require = createRequire(import.meta.url);
  const pdf = path.dirname(require.resolve('pdfjs-dist/package.json'));
  for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
    await fs.cp(path.join(pdf, name), path.join(output, 'pdf', name), { recursive: true,
      filter: file => !path.basename(file).startsWith('quickjs-eval') });
  }
  await fs.copyFile(path.join(pdf, 'legacy/build/pdf.worker.min.mjs'), path.join(output, 'pdf/pdf.worker.min.mjs'));
  for (const dependency of ['pdfjs-dist', 'docx-preview', 'pptxviewjs', 'xlsx', 'katex', 'dompurify', 'jszip', 'chart.js', 'libheif-js',
    '@kurkle/color', 'pako', 'lie', 'immediate', 'setimmediate']) {
    let dependencyRoot = path.dirname(require.resolve(dependency));
    while (true) {
      try { if (JSON.parse(await fs.readFile(path.join(dependencyRoot, 'package.json'), 'utf8')).name === dependency) { break; } }
      catch (error) { if (error.code !== 'ENOENT') { throw error; } }
      const parent = path.dirname(dependencyRoot);
      if (parent === dependencyRoot) { throw new Error(`Cannot locate the license for ${dependency}`); }
      dependencyRoot = parent;
    }
    const licenses = (await fs.readdir(dependencyRoot)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name));
    for (const name of licenses) {
      const destination = path.join(output, 'licenses', dependency, name);
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.join(dependencyRoot, name), destination);
    }
  }
  const heif = path.dirname(require.resolve('libheif-js/package.json'));
  await fs.copyFile(path.join(heif, 'libheif-wasm/LICENSE'), path.join(output, 'licenses/libheif-js/wasm-LICENSE'));
  await fs.copyFile(path.join(ROOT, 'docs/document-preview-licenses.md'), path.join(output, 'licenses/README.md'));
}
