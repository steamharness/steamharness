import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './distribution.mjs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildDocumentPreviews } from './document-preview.mjs';

export async function buildExtension({ watch = false } = {}) {
  const directory = path.join(ROOT, 'extensions/studio-workstation');
  const templates = path.join(ROOT, 'vendor/project-templates');
  await esbuild.build({ entryPoints: [path.join(templates, 'project-templates.ts')], outfile: path.join(directory, 'dist/project-templates.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  await fs.rm(path.join(directory, 'dist/project-templates'), { recursive: true, force: true });
  await fs.cp(path.join(templates, 'project-templates'), path.join(directory, 'dist/project-templates'), { recursive: true });
  const versions = JSON.parse(await fs.readFile(path.join(ROOT, 'examples/conversation/package.json'), 'utf8')).devDependencies;
  await fs.writeFile(path.join(directory, 'dist/project-template-versions.json'), JSON.stringify({ core: versions['steamharness'], cli: versions['@steamharness/cli'] }));
  const shared = {
    absWorkingDir: directory,
    entryPoints: ['src/extension.ts'],
    bundle: true,
    external: ['vscode'],
    format: 'cjs',
    sourcemap: true,
    logLevel: 'info',
  };
  const options = [
    { ...shared, entryPoints: ['src/extension-node.ts'], platform: 'node', target: 'node22', outfile: 'dist/extension.js' },
    { ...shared, platform: 'browser', target: 'es2022', outfile: 'dist/extension-web.js' },
  ];
  for (const option of options) {
    if (watch) {
      await (await esbuild.context(option)).watch();
    } else {
      await esbuild.build(option);
    }
  }
  for (const [entry, name] of [['account', 'account'], ['resources', 'resources'], ['trace', 'trace'], ['info', 'info'], ['versions', 'versions']]) {
    const ui = {
      absWorkingDir: directory, entryPoints: [`webview/${entry}.ts`], bundle: true, platform: 'browser',
      target: 'es2022', outfile: `dist/${name}-ui.js`, logLevel: 'info',
    };
    if (watch) { await (await esbuild.context(ui)).watch(); }
    else { await esbuild.build(ui); }
  }
  await buildDocumentPreviews({ watch });
  const worker = { entryPoints: [path.join(directory, 'runtime/resources-worker.mjs')], bundle: true, platform: 'node',
    format: 'esm', target: 'node22', outfile: path.join(directory, 'dist/resources-worker.mjs'), logLevel: 'info' };
  if (watch) { await (await esbuild.context(worker)).watch(); }
  else { await esbuild.build(worker); }
  const require = createRequire(import.meta.url);
  await fs.copyFile(path.join(directory, 'webview/scrollbars.css'), path.join(directory, 'dist/scrollbars.css'));
  const codicons = path.dirname(require.resolve('@vscode/codicons/package.json'));
  await fs.cp(path.join(codicons, 'dist'), path.join(directory, 'dist/codicons'), { recursive: true });
  const assistantSource = path.join(ROOT, 'vendor/developer-assistant');
  const assistantOutput = path.join(directory, 'dist/developer-assistant');
  await fs.rm(assistantOutput, { recursive: true, force: true });
  await fs.mkdir(assistantOutput, { recursive: true });
  for (const entry of await fs.readdir(assistantSource, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'package.json' || entry.name.endsWith('.ts') && !entry.name.endsWith('.config.ts'))) {
      await fs.copyFile(path.join(assistantSource, entry.name), path.join(assistantOutput, entry.name));
    }
  }
  await fs.cp(path.join(assistantSource, 'skills'), path.join(assistantOutput, 'skills'), { recursive: true });
  const controlSource = path.join(ROOT, 'vendor/studio-control');
  const controlOutput = path.join(directory, 'dist/studio-control');
  await fs.rm(controlOutput, { recursive: true, force: true });
  await fs.mkdir(controlOutput, { recursive: true });
  for (const entry of await fs.readdir(controlSource, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'package.json' || entry.name.endsWith('.ts') && !entry.name.endsWith('.config.ts'))) {
      await fs.copyFile(path.join(controlSource, entry.name), path.join(controlOutput, entry.name));
    }
  }
  const analysisOutput = path.join(directory, 'dist/analysis');
  await fs.rm(analysisOutput, { recursive: true, force: true });
  await fs.mkdir(analysisOutput, { recursive: true });
  for (const name of ['package.json', 'kanban.json', 'index.html', 'assets']) {
    await fs.cp(path.join(ROOT, 'vendor/analysis', name), path.join(analysisOutput, name), { recursive: true });
  }
  for (const name of ['runtime', 'workflow-ui.js', 'workflow-ui.css']) {
    await fs.rm(path.join(directory, 'dist', name), { recursive: true, force: true });
  }
  if (!watch) esbuild.stop();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildExtension({ watch: process.argv.includes('--watch') });
}
