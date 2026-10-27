import { expect, it } from 'vitest';
import { hydrateUserSettings, userSettingsJsonReplacer } from '../web/user-settings';
import { projectWithUserSettings, projectParamArgs, type Project } from '../web/workflow-types';
import type { UserSettings } from 'steamharness';

const settings: UserSettings = { agent: { permissionPolicy: 'workspace', models: [
  { id: 'third', name: 'Custom', model: 'actual', source: 'third-party', apiKind: 'openai-responses', baseUrl: 'https://example.test/v1', apiKey: 'test-only-secret' },
  { id: 'system', name: 'Plan', model: 'subscribed', source: 'system', credentialId: 'plan' },
] } };
it('user model defaults honor system-only policy and remain empty in saved project arguments', () => {
  const project: Project = { id: 'model', name: 'Model', uri: '', folderPath: '', projectType: 'conversation', entrypoints: [],
    agentModelPolicy: { allowThirdParty: false }, fields: [{ name: 'model', type: 'string', flag: '--model', userSetting: { key: 'agent.model', mode: 'default' } }] };
  const configured = projectWithUserSettings(project, settings);
  expect(configured.fields[0].userSettingValue).toBe('system');
  expect(projectParamArgs(configured.fields, { model: '' })).toEqual([]);
  expect(projectParamArgs(configured.fields, { model: 'system' })).toEqual(['--model', 'system']);
  expect(JSON.stringify(configured)).not.toContain('test-only-secret');
});
it('histories, public state and exports omit keys; recovery rehydrates only the same endpoint reference', () => {
  const serialized = JSON.stringify({ agentParameters: { userSettings: settings }, messages: [{ userSettings: settings }] }, userSettingsJsonReplacer);
  expect(serialized).not.toContain('test-only-secret'); expect(serialized).not.toContain('apiKey');
  const restored = JSON.parse(serialized).agentParameters.userSettings;
  expect(restored.agent.models[0].model).toBe('actual');
  expect(hydrateUserSettings(restored, settings)).toEqual(settings);
  expect(() => hydrateUserSettings(restored, { agent: { ...settings.agent, models: [] } })).toThrow(/unavailable/);
  const changed = { agent: { ...settings.agent, models: settings.agent.models!.map(model => ({ ...model, baseUrl: 'https://different.test' })) } };
  expect(() => hydrateUserSettings(restored, changed)).toThrow(/unavailable/);
  expect(settings.agent.models![0]).toHaveProperty('apiKey', 'test-only-secret');
});
