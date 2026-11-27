import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import test from 'node:test';
import { applyFolderAgentInput, folderBotResponsibilities, folderPermissionCeiling, folderProfile, validateLocalFolderContext } from '../executor/folder-context';
import { assertFolderBotModel, resolveAgentSystemAIInput } from '../agent/model-resolution';
import { createProjectToolPermissionContext } from '../tool-permissions';
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

test('profiles narrow policy and choose only a configured model without overriding fixed source settings', async () => {
  const models = ['original', 'profile'].map(id => ({ id, name: id, source: 'third-party' as const, apiKind: 'openai-completions' as const,
    model: `${id}-route`, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only' }));
  const context = { folderContext: { directory }, [folderPermissionCeiling]: 'workspace' as const,
    [folderProfile]: { responsibility: 'Summaries', modelId: 'profile', tools: { ceiling: 'read-only' as const } } };
  await withUserSettings({ agent: { permissionPolicy: 'auto', models } }, async () => {
    const result = applyFolderAgentInput({ ...input, model: 'original', permissionPolicy: 'auto' }, context);
    assert.equal(result.permissionPolicy, 'read-only');
    assert.match(folderBotResponsibilities(context)!, /Summaries/);
    assertFolderBotModel(result, {}, result.model);
    const resolved = await resolveAgentSystemAIInput(result, {}, undefined);
    try { assert.equal(resolved.input.model, 'profile-route'); } finally { await resolved.close(); }
    assert.throws(() => assertFolderBotModel(result, {}, 'missing'), /unavailable/);
    assert.throws(() => applyFolderAgentInput(result, context, 'fixed-original'), /fixed model/);
  });
  const tools = createProjectToolPermissionContext({ projectName: 'fixture', runId: 'fixture', definitions: [{ name: 'write', autoApprove: true }],
    policies: { write: { enabled: true } }, disabledTools: ['write', 'lazy_tool'] });
  assert.equal(tools.getTool('write')?.enabled, false);
  assert.equal(tools.getTool('lazy_tool')?.enabled, false);
});

test('folder Bot input uses the supplied directory and rejects permissions above the local approval', () => {
  const context = { folderContext: { directory }, [folderPermissionCeiling]: 'workspace' } as const;
  withUserSettings({ agent: { permissionPolicy: 'read-only' } }, () => {
    assert.deepEqual(applyFolderAgentInput({ ...input, allowedDirectories: ['/source'] }, context), {
      ...input, workdir: directory, allowedDirectories: [directory], permissionPolicy: 'read-only',
    });
    assert.equal(applyFolderAgentInput({ ...input, permissionPolicy: 'inherit' }, context).permissionPolicy, 'read-only');
    assert.equal(applyFolderAgentInput({ ...input, permissionPolicy: 'workspace' }, context).permissionPolicy, 'workspace');
    assert.throws(() => applyFolderAgentInput({ ...input, permissionPolicy: 'auto' }, context), /expanded permissions/);
  });
  assert.equal(applyFolderAgentInput(input, {}), input);
});
