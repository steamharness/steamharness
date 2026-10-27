import type * as vscode from 'vscode';
import { parseAgentModels } from '../../../../shared/project-configuration/agent-models';
import { t } from './localization';
import type { ConfiguredAgentModel, UserModelsState, UserModelCatalogProvider, UserModelCatalog, UserModelWriteLock } from './user-model-types';

export const USER_MODELS_SECRET = 'studio.agent.models';
interface StoredModels { revision: number; models: ConfiguredAgentModel[]; defaultModelId?: string }

/** Browser extension hosts share an origin; Node hosts inject a filesystem lock. */
async function webWriteLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: {
    request<T>(name: string, options: { ifAvailable: boolean }, run: (lock: unknown) => Promise<T>): Promise<T>;
  } } }).navigator?.locks;
  if (!locks) return run();
  return locks.request(USER_MODELS_SECRET, { ifAvailable: true }, lock => {
    if (!lock) throw new Error(t('Models changed in another window. Reopen the editor and try again.'));
    return run();
  });
}

/** User-wide storage; keys never enter settings JSON, project profiles or page state. */
export class UserModels implements vscode.Disposable {
  private stored: StoredModels = { revision: 0, models: [] };
  private error?: string;
  private provider?: UserModelCatalogProvider;
  private systemModels: Extract<ConfiguredAgentModel, { source: 'system' }>[] = [];
  private providerNames: Record<string, string> = {};
  private catalogError?: string;
  private catalogAbort?: AbortController;
  private catalogPending?: Promise<UserModelCatalog>;
  private connectionIdentity?: string;
  private pending = Promise.resolve();
  private generation = 0;
  private disposed = false;
  constructor(private readonly secrets: vscode.SecretStorage, private readonly changed: () => void,
    private readonly writeLock: UserModelWriteLock = webWriteLock) {}
  private parseSavedModels(value: unknown): ConfiguredAgentModel[] {
    if (!Array.isArray(value)) return parseAgentModels(value);
    const models = value.map(entry => parseAgentModels([entry])[0]!);
    parseAgentModels(models.filter(model => model.source === 'third-party'));
    if (new Set(models.map(model => model.id)).size !== models.length) throw new Error(t('Enter a valid model.'));
    return models;
  }
  private parse(encoded?: string): StoredModels {
    if (!encoded) return { revision: 0, models: [] };
    try {
      const value = JSON.parse(encoded);
      if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error();
      if (value.defaultModelId !== undefined && (typeof value.defaultModelId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.defaultModelId))) throw new Error();
      return { revision: value.revision, models: this.parseSavedModels(value.models), ...(value.defaultModelId ? { defaultModelId: value.defaultModelId } : {}) };
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
    this.provider = provider; void this.refreshCatalog().catch(() => undefined);
    return { dispose: () => { if (this.provider === provider) { this.provider = undefined; this.clearCatalog(); this.changed(); } } };
  }
  private clearCatalog(): void {
    this.catalogAbort?.abort(); this.catalogAbort = undefined; this.catalogPending = undefined;
    this.systemModels = []; this.providerNames = {}; this.catalogError = undefined;
  }
  setConnection(connection: { serverUrl: string; accessToken: string } | undefined): void {
    const identity = connection ? JSON.stringify([connection.serverUrl, connection.accessToken]) : undefined;
    if (identity === this.connectionIdentity) return;
    this.connectionIdentity = identity; this.clearCatalog(); this.changed();
    if (this.provider) void this.refreshCatalog().catch(() => undefined);
  }
  /** One host-wide refresh feeds settings and every runtime using the same snapshot. */
  refreshCatalog(): Promise<UserModelCatalog> {
    if (this.catalogPending) return this.catalogPending;
    if (!this.provider || this.disposed) return Promise.resolve({ entries: [], unavailable: true });
    const controller = new AbortController(); this.catalogAbort = controller; this.catalogError = undefined;
    const pending = this.catalog(controller.signal).then(async catalog => {
      const providers: Record<string, string> = {}, seen = new Set<string>();
      const models = await Promise.all(catalog.entries.flatMap(credential => credential.models.map(async model => {
        const reference = JSON.stringify([credential.id, model.id]);
        if (seen.has(reference)) return undefined;
        seen.add(reference);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reference));
        const id = `system_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
        providers[id] = credential.name;
        return parseAgentModels([{ id, name: model.name, model: model.id, source: 'system', credentialId: credential.id }])[0] as Extract<ConfiguredAgentModel, { source: 'system' }>;
      })));
      if (controller.signal.aborted || this.disposed || this.catalogAbort !== controller) throw new Error(t('Model catalogue changed. Refresh and try again.'));
      this.systemModels = models.filter((model): model is NonNullable<typeof model> => !!model); this.providerNames = providers;
      return catalog;
    }).catch(error => {
      if (!controller.signal.aborted && !this.disposed && this.catalogAbort === controller) this.catalogError = error instanceof Error ? error.message : t('Unable to refresh built-in models.');
      throw error;
    }).finally(() => {
      if (this.catalogAbort === controller) { this.catalogPending = undefined; this.catalogAbort = undefined; this.changed(); }
    });
    this.catalogPending = pending; this.changed(); return pending;
  }
  private effectiveModels(stored = this.stored): ConfiguredAgentModel[] {
    const systems = this.systemModels.map(model => {
      const previous = stored.models.find(entry => entry.source === 'system' && entry.credentialId === model.credentialId && entry.model === model.model);
      return previous ? { ...model, id: previous.id } : model;
    });
    const models = [...systems, ...stored.models.filter(model => model.source === 'third-party')];
    const preferred = models.find(model => model.id === (stored.defaultModelId ?? stored.models[0]?.id));
    return preferred ? [preferred, ...models.filter(model => model !== preferred)] : models;
  }
  models(): ConfiguredAgentModel[] {
    return structuredClone(this.effectiveModels());
  }
  state(): UserModelsState {
    const providerNames: Record<string, string> = {};
    for (const model of this.effectiveModels()) if (model.source === 'system') {
      const reference = this.systemModels.find(entry => entry.credentialId === model.credentialId && entry.model === model.model);
      if (reference) providerNames[model.id] = this.providerNames[reference.id]!;
    }
    return { revision: this.stored.revision, systemAvailable: !!this.provider, error: this.error,
      catalogLoading: !!this.catalogPending, catalogError: this.catalogError, providerNames,
      entries: this.models().map(model => {
        if (model.source === 'system') return model;
        const { apiKey, ...entry } = model;
        return { ...entry, hasApiKey: !!apiKey };
      }) };
  }
  async catalog(signal: AbortSignal): Promise<UserModelCatalog> {
    const provider = this.provider, identity = this.connectionIdentity;
    if (!provider) return { entries: [], unavailable: true };
    const result = await provider.load(signal);
    if (this.disposed || signal.aborted || provider !== this.provider || identity !== this.connectionIdentity) throw new Error(t('Model catalogue changed. Refresh and try again.'));
    return result;
  }
  update(message: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const operation = this.pending.then(() => this.writeLock(async () => {
      const current = this.parse(await this.secrets.get(USER_MODELS_SECRET));
      if (message.revision !== current.revision) { await this.reload(); throw new Error(t('Models changed in another window. Reopen the editor and try again.')); }
      let models = current.models;
      let defaultModelId: string | undefined = current.defaultModelId ?? this.effectiveModels(current)[0]?.id;
      if (message.action === 'save') {
        if (!message.model || typeof message.model !== 'object' || Array.isArray(message.model)) throw new Error(t('Enter a valid model.'));
        const candidate = { ...message.model } as Record<string, unknown>;
        const previous = models.find(model => model.id === candidate.id);
        if (candidate.source === 'system' || previous?.source === 'system') throw new Error(t('Built-in models are managed by your AI account.'));
        if (typeof candidate.id === 'string' && candidate.id.startsWith('system_')) throw new Error(t('Enter a valid model.'));
        if (candidate.source === 'third-party' && candidate.apiKey === '' && previous?.source === 'third-party') candidate.apiKey = previous.apiKey;
        let parsed: ConfiguredAgentModel[];
        try { parsed = parseAgentModels([candidate]); } catch { throw new Error(t('Model configuration is invalid. Check name, protocol, Base URL, model ID and API key.')); }
        const [model] = parsed;
        models = previous ? models.map(entry => entry.id === model!.id ? model! : entry) : [...models, model!];
      } else if (message.action === 'delete' || message.action === 'default') {
        const selected = this.effectiveModels(current).find(model => model.id === message.id);
        if (!selected) throw new Error(t('The selected model is no longer available.'));
        if (message.action === 'delete') {
          if (selected.source === 'system') throw new Error(t('Built-in models are managed by your AI account.'));
          models = models.filter(model => model.id !== selected.id);
          if (defaultModelId === selected.id) defaultModelId = this.effectiveModels({ ...current, models }).find(model => model.id !== selected.id)?.id;
        } else defaultModelId = selected.id;
      } else throw new Error(t('Unsupported model action.'));
      if (models.filter(model => model.source === 'third-party').length > 100) throw new Error(t('You can save up to 100 custom models.'));
      defaultModelId ??= this.effectiveModels({ ...current, models })[0]?.id;
      this.parseSavedModels(models);
      if (this.disposed || signal.aborted) throw new Error(t('Model changes cancelled.'));
      const latest = this.parse(await this.secrets.get(USER_MODELS_SECRET));
      if (latest.revision !== current.revision) { await this.reload(); throw new Error(t('Models changed in another window. Reopen the editor and try again.')); }
      if (JSON.stringify(models) === JSON.stringify(current.models) && defaultModelId === current.defaultModelId) return;
      // Saving only public catalogue references prevents stale account tokens entering storage.
      const next = { revision: current.revision + 1, models, ...(defaultModelId ? { defaultModelId } : {}) };
      await this.secrets.store(USER_MODELS_SECRET, JSON.stringify({ version: 1, ...next }));
      if (!this.disposed) { ++this.generation; this.stored = next; this.error = undefined; this.changed(); }
    }));
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  dispose(): void { this.disposed = true; this.clearCatalog(); ++this.generation; }
}
