import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ROOT, builtinProjectDirectory, exists, resolveMonorepoRoot } from './distribution.mjs';
import { copyAssistantTemplate } from './assistant-template.mjs';

const require = createRequire(import.meta.url);

export async function buildProjectRuntime(directory) {
  const source = await resolveMonorepoRoot();
  const useSource = await exists(path.join(source, 'harness/dist/index.js')) && await exists(path.join(source, 'cli/dist/index.js'));
  const harnessEntry = useSource ? path.join(source, 'harness/dist/index.js') : fileURLToPath(import.meta.resolve('steamharness'));
  const cliDirectory = useSource ? path.join(source, 'cli') : path.dirname(require.resolve('@steamharness/cli/package.json'));
  const harnessManifest = JSON.parse(await fs.readFile(path.resolve(harnessEntry, '../../package.json'), 'utf8'));
  const cliManifest = JSON.parse(await fs.readFile(path.join(cliDirectory, 'package.json'), 'utf8'));
  const runtime = path.join(directory, 'dist/runtime');
  await fs.mkdir(path.join(runtime, 'cli/dist'), { recursive: true });
  const options = {
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
    external: ['typescript', 'tsx', 'tsx/*'],
    banner: { js: 'import { createRequire as studioRequire } from "node:module"; const require = studioRequire(import.meta.url);' },
    logOverride: { 'impossible-typeof': 'silent' },
  };
  await esbuild.build({ ...options, entryPoints: [harnessEntry], outfile: path.join(runtime, 'harness.mjs') });
  // Preserve CLI module boundaries: several modules have their own entry guards.
  await fs.cp(path.join(cliDirectory, 'dist'), path.join(runtime, 'cli/dist'), { recursive: true });
  await fs.copyFile(path.join(cliDirectory, 'dist/index.js'), path.join(runtime, 'cli/dist/index.mjs'));
  const cliHarness = path.join(runtime, 'cli/node_modules/steamharness');
  await fs.mkdir(cliHarness, { recursive: true });
  await fs.writeFile(path.join(cliHarness, 'package.json'), JSON.stringify({
    name: 'steamharness', version: harnessManifest.version, type: 'module',
    exports: { '.': './index.mjs', './runtime-api': './index.mjs' },
  }, null, 2) + '\n');
  await fs.writeFile(path.join(cliHarness, 'index.mjs'), 'export * from "../../../harness.mjs";\n');
  await fs.copyFile(path.join(directory, 'runtime/worker.mjs'), path.join(runtime, 'worker.mjs'));
  await esbuild.build({ ...options, entryPoints: [path.join(directory, 'src/assistant-workspace.ts')], outfile: path.join(runtime, 'assistant-workspace.mjs') });
  const assistantSource = await builtinProjectDirectory('developer-assistant');
  const assistant = path.join(runtime, 'developer-assistant');
  await copyAssistantTemplate(assistantSource, assistant);
  await fs.writeFile(path.join(runtime, 'cli/package.json'), JSON.stringify(cliManifest, null, 2) + '\n');
  await fs.writeFile(path.join(runtime, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { 'steamharness': ['./harness.mjs'] } },
  }, null, 2) + '\n');
  await fs.writeFile(path.join(runtime, 'versions.json'), JSON.stringify({
    harness: harnessManifest.version, cli: cliManifest.version, source: useSource ? source : 'npm',
    assistant: 'build-in/build-in-developer-assistant',
  }, null, 2) + '\n');
  await fs.cp(path.join(ROOT, 'examples/conversation'), path.join(runtime, 'demo'), { recursive: true });
  console.log(`Workflow runtime: Harness ${harnessManifest.version}, CLI ${cliManifest.version} (${useSource ? source : 'npm'}).`);
}
