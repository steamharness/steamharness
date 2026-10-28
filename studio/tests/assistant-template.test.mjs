import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'tsx/esm/api';
import { copyAssistantTemplate } from '../scripts/assistant-template.mjs';

register();
const { resolveProjectEntry } = await import('../../shared/project-manifest/node.ts');

test('assistant bundles resolve every registered entry and its database configuration', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-assistant-template-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), destination = path.join(directory, 'bundle');
  await mkdir(path.join(source, 'studio-control'), { recursive: true });
  await mkdir(path.join(source, 'skills'), { recursive: true });
  const databaseId = '00000000-0000-4000-8000-000000000001';
  const manifest = { id: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', name: 'Assistant', steamHarness: {
    defaultEntry: 'main', entries: [
      { entryId: 'main', name: 'Assistant', type: 'conversation', root: '.', entry: 'index.ts', configuration: 'configuration.json', databases: ['memory'] },
      { entryId: 'studio-control', name: 'Control', type: 'workflow', root: 'studio-control', entry: 'index.ts', configuration: 'configuration.json' },
    ],
  } };
  const files = { 'package.json': JSON.stringify(manifest), 'config.json': JSON.stringify({ version: 1, databases: { memory: databaseId } }),
    'configuration.json': '{"version":1,"fields":[]}', 'index.ts': 'export {};',
    'studio-control/index.ts': 'export {};', 'studio-control/configuration.json': '{"version":1,"fields":[]}',
    'skills/SKILL.md': 'Assistant skills', '.env': 'PRIVATE_VALUE=excluded', 'vitest.config.ts': 'export {};',
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(source, name), content);
  await mkdir(destination); await writeFile(path.join(destination, 'stale.ts'), 'obsolete');
  await copyAssistantTemplate(source, destination);
  const main = await resolveProjectEntry(destination, 'main');
  assert.deepEqual(main.registration.databases, [{ alias: 'memory', databaseId }]);
  for (const entryId of ['main', 'studio-control']) {
    const entry = await resolveProjectEntry(destination, entryId);
    assert.equal(await readFile(entry.modulePath, 'utf8'), 'export {};');
    assert.equal(await readFile(entry.configurationPath, 'utf8'), files['configuration.json']);
  }
  assert.equal(await readFile(path.join(destination, 'skills/SKILL.md'), 'utf8'), files['skills/SKILL.md']);
  const names = await readdir(destination);
  for (const excluded of ['.env', 'vitest.config.ts', 'stale.ts']) assert.equal(names.includes(excluded), false);
});
