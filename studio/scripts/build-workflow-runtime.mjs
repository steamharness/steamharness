import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ROOT, exists, resolveWorkflowSource } from './distribution.mjs';

const require = createRequire(import.meta.url);

export async function buildWorkflowRuntime(directory) {
  const source = await resolveWorkflowSource();
  const useSource = await exists(path.join(source, 'core/dist/index.js')) && await exists(path.join(source, 'cli/dist/index.js'));
  const coreEntry = useSource ? path.join(source, 'core/dist/index.js') : fileURLToPath(import.meta.resolve('steamharness'));
  const cliDirectory = useSource ? path.join(source, 'cli') : path.dirname(require.resolve('@steamharness/cli/package.json'));
  const coreManifest = JSON.parse(await fs.readFile(path.resolve(coreEntry, '../../package.json'), 'utf8'));
  const cliManifest = JSON.parse(await fs.readFile(path.join(cliDirectory, 'package.json'), 'utf8'));
  const runtime = path.join(directory, 'dist/runtime');
  await fs.mkdir(path.join(runtime, 'cli/dist'), { recursive: true });
  const options = {
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
    external: ['typescript', 'tsx', 'tsx/*'],
    banner: { js: 'import { createRequire as studioRequire } from "node:module"; const require = studioRequire(import.meta.url);' },
    logOverride: { 'impossible-typeof': 'silent' },
  };
  await esbuild.build({ ...options, entryPoints: [coreEntry], outfile: path.join(runtime, 'core.mjs') });
  // Preserve CLI module boundaries: several modules have their own entry guards.
  await fs.cp(path.join(cliDirectory, 'dist'), path.join(runtime, 'cli/dist'), { recursive: true });
  await fs.copyFile(path.join(cliDirectory, 'dist/index.js'), path.join(runtime, 'cli/dist/index.mjs'));
  const cliCore = path.join(runtime, 'cli/node_modules/steamharness');
  await fs.mkdir(cliCore, { recursive: true });
  await fs.writeFile(path.join(cliCore, 'package.json'), JSON.stringify({
    name: 'steamharness', version: coreManifest.version, type: 'module',
    exports: { '.': './index.mjs', './runtime-api': './index.mjs' },
  }, null, 2) + '\n');
  await fs.writeFile(path.join(cliCore, 'index.mjs'), 'export * from "../../../core.mjs";\n');
  await fs.copyFile(path.join(directory, 'runtime/worker.mjs'), path.join(runtime, 'worker.mjs'));
  await esbuild.build({ ...options, entryPoints: [path.join(directory, 'src/assistant-workspace.ts')], outfile: path.join(runtime, 'assistant-workspace.mjs') });
  const assistantSource = path.join(ROOT, 'vendor/developer-assistant');
  if (!await exists(path.join(assistantSource, 'index.ts'))) {
    throw new Error('Project Assistant source is missing. Run git submodule update --init vendor/developer-assistant.');
  }
  const assistant = path.join(runtime, 'developer-assistant');
  await fs.rm(assistant, { recursive: true, force: true });
  await fs.mkdir(assistant, { recursive: true });
  for (const entry of await fs.readdir(assistantSource, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'package.json' || entry.name.endsWith('.ts') && entry.name !== 'vitest.config.ts')) {
      await fs.copyFile(path.join(assistantSource, entry.name), path.join(assistant, entry.name));
    }
  }
  await fs.cp(path.join(assistantSource, 'skills'), path.join(assistant, 'skills'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'cli/package.json'), JSON.stringify(cliManifest, null, 2) + '\n');
  await fs.writeFile(path.join(runtime, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { 'steamharness': ['./core.mjs'] } },
  }, null, 2) + '\n');
  await fs.writeFile(path.join(runtime, 'versions.json'), JSON.stringify({
    core: coreManifest.version, cli: cliManifest.version, source: useSource ? source : 'npm', assistant: 'vendor/developer-assistant',
  }, null, 2) + '\n');
  await fs.cp(path.join(ROOT, 'examples/conversation'), path.join(runtime, 'demo'), { recursive: true });
  console.log(`Workflow runtime: Core ${coreManifest.version}, CLI ${cliManifest.version} (${useSource ? source : 'npm'}).`);
}
