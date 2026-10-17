import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantDependencyFixture } from './assistant-dependency-fixture.mjs';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/assistant-application.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire as l10nRequire } from 'node:module'; const require = l10nRequire(${JSON.stringify(import.meta.url)});` } });
const { prepareAssistantApplication } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('the assistant owns its app and dependencies and never borrows the opened project runtime', async t => {
  const source = await createAssistantDependencyFixture(); t.after(source.dispose);
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-assistant-app-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const templateDir = path.join(directory, 'template');
  await mkdir(path.join(templateDir, 'skills/workflow-code-generator'), { recursive: true });
  await writeFile(path.join(templateDir, 'package.json'), JSON.stringify({ id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', name: 'Project Assistant', type: 'module', devDependencies: { 'steamharness': 'link:../core' } }));
  await writeFile(path.join(templateDir, 'index.ts'), 'export const executor = workflow.defineExecutor({});');
  await writeFile(path.join(templateDir, 'skills/workflow-code-generator/SKILL.md'), 'Assistant skill');
  const userProject = path.join(directory, 'opened-project');
  await mkdir(userProject);
  await writeFile(path.join(userProject, 'package.json'), JSON.stringify({ id: 'a-different-project', name: 'User project' }));
  const options = { templateDir, storageDir: path.join(directory, 'storage'), dependencySources: [userProject, source.projectDir] };
  const [application, concurrent] = await Promise.all([prepareAssistantApplication(options), prepareAssistantApplication(options)]);
  assert.equal(application, concurrent, 'Two windows can initialize the same independent app safely.');
  assert.notEqual(application, userProject);
  assert.equal(await realpath(path.join(application, 'node_modules')), await realpath(path.join(source.projectDir, 'node_modules')));
  const manifest = JSON.parse(await readFile(path.join(application, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.devDependencies, { 'steamharness': '2.3.4', '@steamharness/cli': '1.2.3' });
  assert.equal(manifest.dependencies, undefined);
  assert.equal(await readFile(path.join(application, 'skills/workflow-code-generator/SKILL.md'), 'utf8'), 'Assistant skill');
  assert.equal(await prepareAssistantApplication(options), application);
  await assert.rejects(prepareAssistantApplication({ ...options, dependencySources: [userProject] }));
  await writeFile(path.join(templateDir, 'index.ts'), 'export const executor = workflow.defineExecutor({ params: [] });');
  assert.notEqual(await prepareAssistantApplication(options), application, 'Updated assistant templates must use a fresh app without overwriting a running version.');
});
