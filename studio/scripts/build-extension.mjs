import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, builtinProjectDirectory, resolveMonorepoRoot, readJSON } from './distribution.mjs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildDocumentPreviews } from './document-preview.mjs';
import { checkoutServiceChannel } from '../../shared/service-urls/node.mjs';
import { publicServiceUrls } from '../../shared/service-urls/index.ts';
import { copyAssistantTemplate } from './assistant-template.mjs';

export async function buildExtension({ watch = false } = {}) {
  const directory = path.join(ROOT, 'extensions/studio-workstation');
  const templates = path.join(ROOT, 'vendor/project-templates');
  await esbuild.build({ entryPoints: [path.join(templates, 'project-templates.ts')], outfile: path.join(directory, 'dist/project-templates.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  await fs.rm(path.join(directory, 'dist/project-templates'), { recursive: true, force: true });
  await fs.cp(path.join(templates, 'project-templates'), path.join(directory, 'dist/project-templates'), { recursive: true });
  const monorepo = await resolveMonorepoRoot();
  const [harness, cli] = await Promise.all(['harness', 'cli'].map(name => readJSON(path.join(monorepo, name, 'package.json'))));
  await fs.writeFile(path.join(directory, 'dist/project-template-versions.json'), JSON.stringify({ harness: harness.version, cli: cli.version }));
  const shared = {
    absWorkingDir: directory,
    entryPoints: ['src/extension.ts'],
    bundle: true,
    external: ['vscode'],
    format: 'cjs',
    sourcemap: true,
    logLevel: 'info',
    define: { __STEAMHARNESS_DEFAULT_SERVER_URL__: JSON.stringify(publicServiceUrls(checkoutServiceChannel({ root: ROOT })).server) },
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
  for (const [entry, name] of [['account', 'account'], ['login', 'login'], ['resources', 'resources'], ['databases', 'databases'], ['trace', 'trace'], ['info', 'info'], ['versions', 'versions'], ['welcome', 'welcome']]) {
    const ui = {
      absWorkingDir: directory, entryPoints: [`webview/${entry}.ts`], bundle: true, platform: 'browser',
      target: 'es2022', outfile: `dist/${name}-ui.js`, logLevel: 'info', loader: { '.svg': 'dataurl' },
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
  await fs.copyFile(path.join(directory, 'resources/model-icons/LICENSE'), path.join(directory, 'dist/model-icons-LICENSE.txt'));
  const codicons = path.dirname(require.resolve('@vscode/codicons/package.json'));
  await fs.cp(path.join(codicons, 'dist'), path.join(directory, 'dist/codicons'), { recursive: true });
  const assistantSource = await builtinProjectDirectory('developer-assistant');
  const assistantOutput = path.join(directory, 'dist/developer-assistant');
  await copyAssistantTemplate(assistantSource, assistantOutput);
  await fs.rm(path.join(directory, 'dist/studio-control'), { recursive: true, force: true });
  const analysisSource = await builtinProjectDirectory('analysis');
  const analysisOutput = path.join(directory, 'dist/analysis');
  await fs.rm(analysisOutput, { recursive: true, force: true });
  await fs.mkdir(analysisOutput, { recursive: true });
  for (const name of ['package.json', 'configuration.json', 'index.html', 'assets']) {
    await fs.cp(path.join(analysisSource, name), path.join(analysisOutput, name), { recursive: true });
  }
  for (const name of ['runtime', 'workflow-ui.js', 'workflow-ui.css']) {
    await fs.rm(path.join(directory, 'dist', name), { recursive: true, force: true });
  }
  if (!watch) esbuild.stop();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildExtension({ watch: process.argv.includes('--watch') });
}
