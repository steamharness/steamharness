import { expect, it } from 'vitest';
import { hydrateUserSettings, userSettingsJsonReplacer } from '../web/user-settings';
import { projectWithUserSettings, projectParamArgs, type Project } from '../web/workflow-types';
import type { UserSettings } from 'steamharness';

const settings: UserSettings = { agent: { permissionPolicy: 'workspace', models: [
  { id: 'third', name: 'Custom', model: 'actual', source: 'third-party', apiKind: 'openai-responses', baseUrl: 'https://example.test/v1', apiKey: 'test-only-secret' },
  { id: 'system', name: 'Plan', model: 'subscribed', source: 'system', credentialId: 'plan' },
] } };
it('user model defaults honor system-only policy and remain empty in saved project arguments', () => {
  const project: Project = { entryId: 'main', aggregateName: 'Model', entries: [], defaultEntry: 'main', entryRoot: '', databases: [], id: 'model', name: 'Model', uri: '', folderPath: '', projectType: 'conversation', entrypoints: [],
    agentModelPolicy: { allowThirdParty: false }, fields: [{ name: 'model', type: 'string', flag: '--model', userSetting: { key: 'agent.model', mode: 'default' } }] };
  const configured = projectWithUserSettings(project, settings);
  expect(configured.fields[0].userSettingValue).toBe('system');
  expect(configured.fields[0].userModelSources).toEqual({ system: 'system' });
  expect(projectParamArgs(configured.fields, { model: '' })).toEqual([]);
  expect(projectParamArgs(configured.fields, { model: 'system' })).toEqual(['--model', 'system']);
  expect(projectParamArgs(configured.fields, { model: 'inherit' })).toEqual(['--model', 'inherit']);
  expect(JSON.stringify(configured)).not.toContain('test-only-secret');
  const unrestricted = projectWithUserSettings({ ...project, agentModelPolicy: undefined,
    entrypoints: [{ id: 'secondary', fields: project.fields }] }, settings);
  expect(unrestricted.fields[0].userModelSources).toEqual({ third: 'third-party', system: 'system' });
  expect(unrestricted.entrypoints[0].fields[0].userModelSources).toEqual(unrestricted.fields[0].userModelSources);
  expect(unrestricted.fields[0].userSettingValue).toBe('third');
  expect(project.fields[0].userModelSources).toBeUndefined();
  expect(JSON.stringify(unrestricted)).not.toContain('apiKey');
});
it('projects display the same composed default and keep both connection identities private', () => {
  const project = { entrypoints: [], fields: [{ name: 'model', type: 'string', userSetting: { key: 'agent.model', mode: 'default' } }] } as unknown as Project;
  const local = { ...settings.agent.models![0], model: 'project-model', apiKey: 'project-only-key' };
  const composed = projectWithUserSettings(project, settings, { STEAMHARNESS_AGENT_MODELS: [local] as any });
  expect(composed.fields[0].userSettingValue).toBe('project:third');
  expect(composed.fields[0].userModelSources).toEqual({ 'project:third': 'third-party', third: 'third-party', system: 'system' });
  expect(JSON.stringify(composed)).not.toMatch(/project-only-key|test-only-secret|baseUrl/);
  const reference = projectWithUserSettings(project, settings, { STEAMHARNESS_AGENT_MODELS: [{ id: 'alias', name: 'Alias', source: 'user-settings', modelId: 'third' }] });
  expect(reference.fields[0].userSettingValue).toBe('alias');
  expect(reference.fields[0].userModelSources).toEqual({ alias: 'third-party', system: 'system' });
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
it('preserves unrelated project output named userSettings without breaking state or history serialization', () => {
  for (const userSettings of [null, 'custom', {}, { agent: null }, { agent: 'custom' }, { agent: { models: [] } },
    { agent: { permissionPolicy: 'custom', models: [] } }, { agent: { permissionPolicy: 'auto', models: 'custom' } }]) {
    const output = { result: { data: { userSettings } } };
    expect(JSON.parse(JSON.stringify(output, userSettingsJsonReplacer))).toEqual(output);
  }
  const extended = { userSettings: { ...settings, metadata: { owner: 'project' } } };
  expect(JSON.parse(JSON.stringify(extended, userSettingsJsonReplacer)).userSettings.metadata).toEqual({ owner: 'project' });
});
