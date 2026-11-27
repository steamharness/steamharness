import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, builtinProjectDirectory, resolveMonorepoRoot, readJSON } from './distribution.mjs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildDocumentPreviews } from './document-preview.mjs';
import { checkoutServiceChannel } from '../../shared/service-urls/node.mjs';
import { publicServiceUrls } from '../../shared/service-urls/index.ts';
import { copyAssistantTemplate } from './assistant-template.mjs';
import { overlayExtensionBuildPlugin } from './extension-overlay.mjs';
import { buildBuiltinProjectRelease, stageBuiltinKanban } from './builtin-project-release.mjs';
import { optionalNativeExternals } from './node-extension-build.mjs';

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
    define: { __STEAMHARNESS_SERVICE_CHANNEL__: JSON.stringify(checkoutServiceChannel({ root: ROOT })), __STEAMHARNESS_DEFAULT_SERVER_URL__: JSON.stringify(publicServiceUrls(checkoutServiceChannel({ root: ROOT })).server),
      __STEAMHARNESS_STUDIO_RUNTIME_VERSIONS__: JSON.stringify({ coreVersion: harness.version, cliVersion: cli.version }) },
  };
  const options = [
    { ...shared, external: [...shared.external, ...optionalNativeExternals], entryPoints: ['src/extension-node.ts'], platform: 'node', target: 'node22', outfile: 'dist/extension.js' },
    { ...shared, platform: 'browser', target: 'es2022', outfile: 'dist/extension-web.js' },
  ];
  const worker = { absWorkingDir: directory, bundle: true, platform: 'node', target: 'node22' };
  for (const options of [
    { ...worker, entryPoints: ['src/workflow-process-service.ts'], format: 'cjs', outfile: 'dist/workflow-process-service.cjs' },
    { ...worker, entryPoints: ['src/project-usage-worker.ts'], format: 'cjs', outfile: 'dist/project-usage-worker.cjs' },
    { ...worker, entryPoints: ['src/bot-management-worker.ts'], format: 'esm', outfile: 'dist/bot-management-worker.mjs',
      banner: { js: "import { createRequire as __workerCreateRequire } from 'node:module'; const require = __workerCreateRequire(import.meta.url);" } },
  ]) {
    if (watch) { await (await esbuild.context(options)).watch(); }
    else { await esbuild.build(options); }
  }
  for (const option of options) {
    option.plugins = [overlayExtensionBuildPlugin(directory, path.join(ROOT, '.studio/extension-with-overlay'), path.basename(option.outfile))];
    if (watch) {
      await (await esbuild.context(option)).watch();
    } else {
      await esbuild.build(option);
    }
  }
  const webviews = Object.fromEntries(['account', 'login', 'trace', 'info', 'versions', 'welcome', 'schedules'].map(name => [name, `webview/${name}.ts`]));
  webviews['bot-management'] = path.join(monorepo, 'cli/src/web/ui/bot-management-standalone.ts');
  for (const [name, entry] of Object.entries(webviews)) {
    const ui = {
      absWorkingDir: directory, entryPoints: [entry], bundle: true, platform: 'browser',
      target: 'es2022', outfile: `dist/${name}-ui.js`, logLevel: 'info', loader: { '.svg': 'dataurl' },
    };
    if (watch) { await (await esbuild.context(ui)).watch(); }
    else { await esbuild.build(ui); }
  }
  await buildDocumentPreviews({ watch });
  const require = createRequire(import.meta.url);
  await fs.copyFile(path.join(directory, 'webview/scrollbars.css'), path.join(directory, 'dist/scrollbars.css'));
  await fs.copyFile(path.join(directory, 'webview/schedules.css'), path.join(directory, 'dist/schedules.css'));
  await fs.copyFile(path.join(directory, 'resources/model-icons/LICENSE'), path.join(directory, 'dist/model-icons-LICENSE.txt'));
  const codicons = path.dirname(require.resolve('@vscode/codicons/package.json'));
  await fs.cp(path.join(codicons, 'dist'), path.join(directory, 'dist/codicons'), { recursive: true });
  const assistantSource = await builtinProjectDirectory('developer-assistant');
  const assistantOutput = path.join(directory, 'dist/developer-assistant');
  await buildBuiltinProjectRelease(path.join(assistantOutput, 'project'), assistantSource, async stage => {
    await copyAssistantTemplate(assistantSource, stage, { includeSkills: false });
    const manifest = await readJSON(path.join(stage, 'package.json'));
    delete manifest.scripts;
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest));
  });
  await fs.rm(path.join(assistantOutput, 'skills'), { recursive: true, force: true });
  await fs.cp(path.join(assistantSource, 'skills'), path.join(assistantOutput, 'skills'), { recursive: true });
  // Remove the old source template after successfully producing its replacement.
  for (const name of await fs.readdir(assistantOutput)) {
    if (name !== 'project' && name !== 'skills') await fs.rm(path.join(assistantOutput, name), { recursive: true, force: true });
  }
  await fs.rm(path.join(directory, 'dist/studio-control'), { recursive: true, force: true });
  const analysisSource = await builtinProjectDirectory('analysis');
  await promisify(execFile)(process.execPath, [path.join(analysisSource, 'scripts/build.mjs')], { cwd: analysisSource });
  const analysisOutput = path.join(directory, 'dist/analysis');
  await buildBuiltinProjectRelease(analysisOutput, assistantSource, stage =>
    stageBuiltinKanban(stage, analysisSource, path.join(analysisSource, 'dist/steamharness/build/main'), 'main'));
  for (const name of ['runtime', 'workflow-ui.js', 'workflow-ui.css']) {
    await fs.rm(path.join(directory, 'dist', name), { recursive: true, force: true });
  }
  if (!watch) esbuild.stop();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildExtension({ watch: process.argv.includes('--watch') });
}
