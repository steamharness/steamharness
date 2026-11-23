import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import test from 'node:test';
import { applyFolderAgentInput, folderPermissionCeiling, validateLocalFolderContext } from '../executor/folder-context';
import { withUserSettings } from '../user-settings';

const entry = { entryId: 'main', type: 'bot' as const, name: 'Bot', root: '.', entry: 'index.ts', folderContext: true };
const directory = realpathSync(process.cwd());
const input = { errCode: 0, errMessage: '', prompt: 'hello', workdir: '/source' };

test('local folder context is opt-in and pins the source identity before use', () => {
  assert.equal(validateLocalFolderContext(entry, undefined, 'bot'), undefined);
  const folder = validateLocalFolderContext(entry, { directory, projectId: 'bot' }, 'bot');
  assert.deepEqual(folder, { directory });
  assert.ok(Object.isFrozen(folder));
  assert.throws(() => validateLocalFolderContext(entry, { directory, projectId: 'other' }, 'bot'), /valid local folder context/);
  assert.throws(() => validateLocalFolderContext({ ...entry, folderContext: false }, { directory }, 'bot'), /valid local folder context/);
  assert.throws(() => validateLocalFolderContext(entry, { directory: '.' }, 'bot'), /valid local folder context/);
});

test('folder Bot input uses the supplied directory and rejects permissions above the local approval', () => {
  const context = { folderContext: { directory }, [folderPermissionCeiling]: 'workspace' } as const;
  withUserSettings({ agent: { permissionPolicy: 'read-only' } }, () => {
    assert.deepEqual(applyFolderAgentInput(input, context), { ...input, workdir: directory, permissionPolicy: 'read-only' });
    assert.equal(applyFolderAgentInput({ ...input, permissionPolicy: 'inherit' }, context).permissionPolicy, 'read-only');
    assert.equal(applyFolderAgentInput({ ...input, permissionPolicy: 'workspace' }, context).permissionPolicy, 'workspace');
    assert.throws(() => applyFolderAgentInput({ ...input, permissionPolicy: 'auto' }, context), /expanded permissions/);
  });
  assert.equal(applyFolderAgentInput(input, {}), input);
});
