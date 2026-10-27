import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-user-settings.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], write: false });

test('opens the user permissions section and rejects unsupported keys and protocol versions', async () => {
  const module = { exports: {} }, commands = [];
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
    require: () => ({ commands: { executeCommand: async (...args) => commands.push(JSON.parse(JSON.stringify(args))) } }) });
  const open = module.exports.openProjectUserSettings;
  for (const message of [undefined, {}, { type: 'workflow-user-settings', version: 2, key: 'agent.permissionPolicy' },
    { type: 'workflow-user-settings', version: 1, key: 'arbitrary.command' }]) assert.equal(await open(message), false);
  assert.equal(commands.length, 0);
  assert.equal(await open({ type: 'workflow-user-settings', version: 1, key: 'agent.permissionPolicy' }), true);
  assert.deepEqual(commands, [['studio.openSettings', { section: 'permissions', target: 'user' }]]);
});
