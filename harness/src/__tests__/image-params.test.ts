import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { inspectLocalProjectStructure, readProjectParamDefinitionError, type ParamDefinition } from '../index';

const image = { crop: true, minWidth: 280, minHeight: 280, maxWidth: 1568, maxHeight: 1568 };

test('image parameters accept optional cropping and reject contradictory pixel limits', () => {
  const field: ParamDefinition = { name: 'photo', flag: '--photo', type: 'file', image };
  assert.equal(readProjectParamDefinitionError(field), undefined);
  assert.equal(readProjectParamDefinitionError({ ...field, multiple: true, image: { crop: false } }), undefined);
  for (const patch of [
    { type: 'string' }, { control: 'audio' }, { options: [] }, { panel: 'quick' },
    { image: null }, { image: { crop: 'true' } }, { image: { minWidth: 0 } },
    { image: { maxHeight: 2.5 } }, { image: { minWidth: 300, maxWidth: 200 } },
    { image: { minHeight: 300, maxHeight: 200 } }, { image: { maxBytes: 1024 } },
  ]) assert.ok(readProjectParamDefinitionError({ ...field, ...patch } as ParamDefinition));
});

test('structure carries image settings into the exact entrypoint and rejects nonliteral settings', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'steamharness-image-param-'));
  try {
    await writeProjectFixture(path.join(projectDir, 'package.json'), JSON.stringify({
      id: crypto.randomUUID(), name: 'image-param-test', version: '0.1.0', type: 'module', defaultEntry: 'main',
      entries: [{ entryId: 'main', name: 'Main', type: 'workflow', root: '.', entry: 'index.ts', databases: [] }],
    }));
    const source = (settings: string) => `const flow = steamharness.defineProject({ name: 'Image', run: async () => ({ errCode: 0, errMessage: '' }) });
      export const executor = steamharness.defineExecutor({ projectType: 'workflow', defaultEntrypoint: 'main', entrypoints: [steamharness.defineEntrypoint({
      id: 'main', title: 'Main', workflow: flow, params: [{ name: 'photo', flag: '--photo', type: 'file', image: ${settings} }], createInput({ paramValues }) { return paramValues; } })] });`;
    await writeFile(path.join(projectDir, 'index.ts'), source(JSON.stringify(image)));
    const report = inspectLocalProjectStructure({ projectDir });
    assert.deepEqual(report.diagnostics.violations, []);
    assert.deepEqual(report.entrypoints?.[0]?.params?.[0]?.image, image);
    for (const settings of ['null', '{ crop: "true" }', '{ minWidth: 0 }', '{ minWidth: 300, maxWidth: 200 }', '{ maxHeight: !1 }', '{ ...limits }']) {
      await writeFile(path.join(projectDir, 'index.ts'), source(settings));
      assert.throws(() => inspectLocalProjectStructure({ projectDir }), /script validation failed/, settings);
    }
  } finally { await rm(projectDir, { recursive: true, force: true }); }
});
