import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { buildStudioNode } from '../scripts/node-extension-build.mjs';

const bundle = await buildStudioNode({ stdin: { resolveDir: process.cwd(), contents: `export { runtimeDataDirectory } from '../cli/src/web/project-data-directory';` }, platform: 'node', format: 'esm', bundle: true, write: false });
const { runtimeDataDirectory: resolve } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
test('replaceable builds share a project while accounts, entries, folder instances and bound workspaces stay isolated', () => {
  const account = path.resolve('account-A'), project = { id: randomUUID(), entryId: 'main' };
  const home = path.join(account, 'projects', project.id);
  const managed = workdir => ({ ...project, assistant: { workdir, storageScope: 'managed-project' } });
  const ordinary = resolve(account, project);
  assert.equal(ordinary, path.join(home, 'entries', 'main'));
  assert.equal(resolve(account, managed(path.join(home, 'builds', 'a'))), ordinary);
  assert.equal(resolve(account, managed(path.join(home, 'builds', 'b'))), ordinary);
  const instance = randomUUID();
  assert.equal(resolve(account, project, instance), path.join(home, 'instances', instance, 'entries', 'main'));
  const locations = [ordinary, resolve(account, { ...project, entryId: 'another' }), resolve(account, project, instance),
    resolve(path.resolve('account-B'), project), ...['a', 'b'].map(folder => resolve(account, { ...project, assistant: { workdir: path.resolve(folder) } }))];
  assert.equal(new Set(locations).size, locations.length);
  assert.throws(() => resolve(account, project, '../escape'));
});
