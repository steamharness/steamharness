export interface BrowserDatabaseDescriptor {
  kind: string; version: number; target: string; provider: string; alias: string; schemaHash: string;
  metadata: { models: readonly { name: string; delegate: string }[] };
}
export interface BrowserTableRequest {
  operation: 'rows' | 'insert' | 'update' | 'delete'; model: string;
  page?: number; pageSize?: number; search?: string; where?: Record<string, unknown>;
  orderBy?: Record<string, 'asc' | 'desc'>; data?: Record<string, unknown>; key?: Record<string, unknown>; rowVersion?: string;
}
export interface BrowserDatabaseBinding { alias: string; databaseId: string; id: string; revision: number; accessRevision: number }
export interface BrowserDatabaseHost {
  resolve(input: { alias: string; schemaHash: string }): Promise<BrowserDatabaseBinding>;
  query(binding: BrowserDatabaseBinding, schemaHash: string, request: BrowserTableRequest): Promise<unknown>;
}
/** Serialized into the preview; keep this function self-contained and free of host secrets. */
export async function connectBrowserDatabase(descriptor: BrowserDatabaseDescriptor, host: BrowserDatabaseHost): Promise<Record<string, unknown>> {
    const invalid = () => Object.assign(new Error('Use a generated database/browser descriptor.'), { code: 'DATABASE_INVALID_REQUEST' });
    if (!descriptor || descriptor.kind !== 'steamharness.database' || descriptor.version !== 1 || descriptor.target !== 'browser'
      || descriptor.provider !== 'postgresql' || !/^[a-z][a-z0-9_]{0,62}$/.test(descriptor.alias) || !/^[a-f0-9]{64}$/.test(descriptor.schemaHash)
      || !Array.isArray(descriptor.metadata?.models)) throw invalid();
    const names = new Set<string>();
    for (const model of descriptor.metadata.models) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.delegate)
        || ['__proto__', 'prototype', 'constructor', 'then', 'transaction'].includes(model.delegate) || names.has(model.delegate)) throw invalid();
      names.add(model.delegate);
    }
    const binding = await host.resolve({ alias: descriptor.alias, schemaHash: descriptor.schemaHash });
    if (binding.alias !== descriptor.alias) throw invalid();
    const client = Object.create(null);
    for (const model of descriptor.metadata.models) {
      const invoke = (request: Omit<BrowserTableRequest, 'model'>) => host.query(binding, descriptor.schemaHash, { ...request, model: model.name });
      client[model.delegate] = Object.freeze({
        rows: (input = {}) => invoke({ ...input, operation: 'rows' }),
        insert: (data: Record<string, unknown>) => invoke({ operation: 'insert', data }),
        update: (input: { key: Record<string, unknown>; rowVersion: string; data: Record<string, unknown> }) => invoke({ ...input, operation: 'update' }),
        delete: (input: { key: Record<string, unknown>; rowVersion: string }) => invoke({ ...input, operation: 'delete' }),
      });
    }
    return Object.freeze(client);
}
