import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({ stdin: { contents: "export { readProjectManifest } from '@steamharness/project-manifest';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', write: false });
const { readProjectManifest } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
for (const relative of ['examples/conversation', 'examples/workflow', 'examples/kanban', 'tests/fixtures/conversation-features', 'tests/fixtures/parameter-layout']) {
  test(`${relative} declares a runnable entry and unbound database requirements`, async () => {
    const directory = path.join(root, relative);
    const manifest = readProjectManifest(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')));
    assert.ok(manifest.entries.some(entry => entry.entryId === manifest.defaultEntry));
    for (const entry of manifest.entries) {
      await access(path.join(directory, entry.root, entry.entry));
      if (entry.configuration) await access(path.join(directory, entry.root, entry.configuration));
      assert.ok(entry.databases.every(database => database.host === 'local' && !database.bindingRef));
    }
  });
}
