import type * as vscode from 'vscode';
import { parseAgentModels } from '../../../../shared/project-configuration/agent-models';
import { t } from './localization';
import type { ConfiguredAgentModel, UserModelsState, UserModelCatalogProvider, UserModelCatalog } from './user-model-types';

export const USER_MODELS_SECRET = 'studio.agent.models';
interface StoredModels { revision: number; models: ConfiguredAgentModel[] }

/** User-wide storage; keys never enter settings JSON, project profiles or page state. */
export class UserModels implements vscode.Disposable {
  private stored: StoredModels = { revision: 0, models: [] };
  private error?: string;
  private provider?: UserModelCatalogProvider;
  private pending = Promise.resolve();
  private generation = 0;
  private disposed = false;
  constructor(private readonly secrets: vscode.SecretStorage, private readonly changed: () => void) {}
  private parse(encoded?: string): StoredModels {
    if (!encoded) return { revision: 0, models: [] };
    try {
      const value = JSON.parse(encoded);
      if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error();
      return { revision: value.revision, models: parseAgentModels(value.models) };
    } catch { throw new Error(t('Unable to read saved models.')); }
  }
  async reload(): Promise<void> {
    const generation = ++this.generation;
    try {
      const next = this.parse(await this.secrets.get(USER_MODELS_SECRET));
      if (this.disposed || generation !== this.generation) return;
      if (this.error || JSON.stringify(next) !== JSON.stringify(this.stored)) { this.stored = next; this.error = undefined; this.changed(); }
    } catch {
      if (!this.disposed && generation === this.generation) { this.error = t('Unable to read saved models.'); this.changed(); }
    }
  }
  registerCatalogProvider(provider: UserModelCatalogProvider): vscode.Disposable {
    if (this.provider) throw new Error('A user model catalogue is already registered.');
    this.provider = provider; this.changed();
    return { dispose: () => { if (this.provider === provider) { this.provider = undefined; this.changed(); } } };
  }
  models(): ConfiguredAgentModel[] {
    return structuredClone(this.stored.models.filter(model => this.provider || model.source === 'third-party'));
  }
  state(): UserModelsState {
    return { revision: this.stored.revision, systemAvailable: !!this.provider, error: this.error,
      entries: this.models().map(model => {
        if (model.source === 'system') return model;
        const { apiKey, ...entry } = model;
        return { ...entry, hasApiKey: !!apiKey };
      }) };
  }
  async catalog(signal: AbortSignal): Promise<UserModelCatalog> {
    const provider = this.provider;
    if (!provider) return { entries: [], unavailable: true };
    const result = await provider.load(signal);
    if (this.disposed || signal.aborted || provider !== this.provider) throw new Error(t('Model catalogue changed. Refresh and try again.'));
    return result;
  }
  update(message: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const operation = this.pending.then(async () => {
      const current = this.parse(await this.secrets.get(USER_MODELS_SECRET));
      if (message.revision !== current.revision) { await this.reload(); throw new Error(t('Models changed in another window. Reopen the editor and try again.')); }
      let models = current.models;
      if (message.action === 'save') {
        if (!message.model || typeof message.model !== 'object' || Array.isArray(message.model)) throw new Error(t('Enter a valid model.'));
        const candidate = { ...message.model } as Record<string, unknown>;
        const previous = models.find(model => model.id === candidate.id);
        if (candidate.source === 'system') {
          const catalog = await this.catalog(signal);
          if (!catalog.entries.some(entry => entry.id === candidate.credentialId && entry.models.some(model => model.id === candidate.model))) {
            throw new Error(t('This system AI model is unavailable. Refresh the catalogue and check your account.'));
          }
        } else if (candidate.source === 'third-party' && candidate.apiKey === '' && previous?.source === 'third-party') candidate.apiKey = previous.apiKey;
        let parsed: ConfiguredAgentModel[];
        try { parsed = parseAgentModels([candidate]); } catch { throw new Error(t('Model configuration is invalid. Check name, protocol, Base URL, model ID and API key.')); }
        const [model] = parsed;
        models = previous ? models.map(entry => entry.id === model!.id ? model! : entry) : [...models, model!];
      } else if (message.action === 'delete' || message.action === 'default') {
        const selected = models.find(model => model.id === message.id && (this.provider || model.source === 'third-party'));
        if (!selected) throw new Error(t('The selected model is no longer available.'));
        models = message.action === 'delete' ? models.filter(model => model !== selected) : [selected, ...models.filter(model => model !== selected)];
      } else throw new Error(t('Unsupported model action.'));
      if (models.length > 100) throw new Error(t('You can save up to 100 models.'));
      parseAgentModels(models);
      if (this.disposed || signal.aborted) throw new Error(t('Model changes cancelled.'));
      const latest = this.parse(await this.secrets.get(USER_MODELS_SECRET));
      if (latest.revision !== current.revision) { await this.reload(); throw new Error(t('Models changed in another window. Reopen the editor and try again.')); }
      if (JSON.stringify(models) === JSON.stringify(current.models)) return;
      // Saving only public catalogue references prevents stale account tokens entering storage.
      const next = { revision: current.revision + 1, models };
      await this.secrets.store(USER_MODELS_SECRET, JSON.stringify({ version: 1, ...next }));
      if (!this.disposed) { ++this.generation; this.stored = next; this.error = undefined; this.changed(); }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  dispose(): void { this.disposed = true; ++this.generation; }
}
