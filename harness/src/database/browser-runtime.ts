import { connectBrowserDatabase } from "@steamharness/kanban-project";
import type { DatabaseClient, DatabaseDescriptor, RelationalDatabasesContext } from './index';
import type { DatabaseBinding } from './resources';

export interface DatabaseQueryBinding extends DatabaseBinding { accessRevision: number }
export interface DatabaseTableRequest {
  operation: 'rows' | 'insert' | 'update' | 'delete'; model: string;
  page?: number; pageSize?: number; search?: string; where?: Record<string, unknown>;
  orderBy?: Record<string, 'asc' | 'desc'>;
  data?: Record<string, unknown>; key?: Record<string, unknown>; rowVersion?: string;
}
export interface DatabaseQueryHost {
  resolve(input: { alias: string; schemaHash: string }): Promise<DatabaseQueryBinding>;
  query(binding: DatabaseQueryBinding, schemaHash: string, request: DatabaseTableRequest): Promise<unknown>;
}
export type DatabaseJsonValue<Value> = Value extends Date | bigint | Uint8Array ? string : Value extends { toFixed(...args: any[]): string } ? string : Value extends readonly (infer Item)[] ? DatabaseJsonValue<Item>[] : Value;
export type DatabaseJsonModel<Model> = { [Key in keyof Model]: DatabaseJsonValue<Model[Key]> };
export interface DatabaseRow<Model> { values: DatabaseJsonModel<Model>; rowVersion: string }
export interface DatabaseTable<Model> {
  rows(input?: Pick<DatabaseTableRequest, 'page' | 'pageSize' | 'search' | 'where' | 'orderBy'>): Promise<{ items: DatabaseRow<Model>[]; total: number; page: number; pageSize: number }>;
  insert(data: Partial<DatabaseJsonModel<Model>>): Promise<DatabaseRow<Model>>;
  update(input: { key: Record<string, unknown>; rowVersion: string; data: Partial<DatabaseJsonModel<Model>> }): Promise<DatabaseRow<Model>>;
  delete(input: { key: Record<string, unknown>; rowVersion: string }): Promise<{ deleted: boolean }>;
}

/** Connect a generated Browser descriptor through an authenticated host. */
export function createBrowserDatabaseConnector(host: DatabaseQueryHost): RelationalDatabasesContext {
  return { connect: async <Descriptor extends DatabaseDescriptor>(descriptor: Descriptor) =>
    await connectBrowserDatabase(descriptor, host) as DatabaseClient<Descriptor> };
}
