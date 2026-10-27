import type { UserSettings } from 'steamharness';

/** History and browser views retain model references, never host model credentials. */
export function userSettingsJsonReplacer(key: string, value: unknown): unknown {
  if (key === 'userSettings' && value && typeof value === 'object' && 'agent' in value) {
    const settings = value as UserSettings;
    const agent = settings.agent;
    // Project output can contain its own userSettings property. Only recognize
    // host snapshots; unrelated values must remain serializable and intact.
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)
      || !['read-only', 'workspace', 'auto'].includes(agent.permissionPolicy)
      || agent.models !== undefined && !Array.isArray(agent.models)) return value;
    return { ...settings, agent: { ...agent, ...(agent.models === undefined ? {} : {
      models: agent.models.map(model => model?.source === 'third-party' ? { ...model, apiKey: undefined } : model),
    }) } };
  }
  return value;
}

/** Recovery may refresh a key only for the same model and endpoint. A removed
 * reference must fail rather than sending a new credential to an old endpoint. */
export function hydrateUserSettings(saved: UserSettings | undefined, current: UserSettings): UserSettings {
  if (!saved) return current;
  return { agent: { ...saved.agent, models: saved.agent.models?.map(model => {
    if (model.source === 'system' || model.apiKey) return model;
    const candidate = current.agent.models?.find(item => item.id === model.id && item.source === 'third-party'
      && item.model === model.model && item.baseUrl === model.baseUrl && item.apiKind === model.apiKind);
    if (!candidate || candidate.source !== 'third-party') throw new Error('The saved model is unavailable. Check model settings before resuming.');
    return { ...model, apiKey: candidate.apiKey };
  }) ?? current.agent.models } };
}
