import { AsyncLocalStorage } from "node:async_hooks";
import { assertDatabaseAuthorization, type DatabaseAuthorization, type DatabaseConsumer } from "@steamharness/database-spaces";
import { readProjectCliAuthConfigSync } from "../auth-config";
import type { KVNamespaceLockInput, KVStore, KVStoreGetInput, KVStoreSetInput, KVStoreListInput, KVStoreValuePage } from "../kv/index";
import type { DatabaseResolver } from "./index";
import { HarnessError } from "../workflow/errors";

export interface DatabaseConnection { serverUrl: string; token: string }
export function databaseConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseConnection | undefined {
  const config = readProjectCliAuthConfigSync(env);
  const serverUrl = (env.STEAMHARNESS_SERVER_URL ?? config.serverUrl).trim();
  const token = (env.STEAMHARNESS_SERVER_ADMIN_KEY ?? env.STEAMHARNESS_SERVER_TOKEN ?? config.apiKey).trim();
  return serverUrl && token ? { serverUrl: serverUrl.replace(/\/+$/, ""), token } : undefined;
}
export async function databaseHostRequest<T>(connection: DatabaseConnection, endpoint: string, body?: unknown): Promise<T> {
  let status: number | undefined;
  try {
    const response = await fetch(`${connection.serverUrl.replace(/\/+$/, "")}/api/database-spaces${endpoint}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error" });
    status = response.status;
    const result = await response.json() as { errCode: number; errMessage: string; data: T };
    if (!response.ok || result.errCode !== 0) throw new Error(result.errMessage || `Database host returned HTTP ${response.status}.`);
    return result.data;
  } catch (cause) {
    throw new HarnessError({
      type: "execution", message: cause instanceof Error ? cause.message : "Database host is unavailable.", cause,
      metadata: { code: "DATABASE_ACCESS_FAILED", host: "server", serverUrl: connection.serverUrl, ...(status === undefined ? {} : { status }) },
    });
  }
}
function consumerFailure(cause: unknown, consumer: DatabaseConsumer, alias: string): never {
  const error = cause instanceof Error ? cause : new Error("Database access failed.");
  const metadata = (error as Error & { metadata?: Record<string, unknown> }).metadata;
  throw new HarnessError({ type: "execution", message: error.message, cause: error,
    metadata: { ...metadata, code: "DATABASE_ACCESS_FAILED", projectId: consumer.projectId, entryId: consumer.entryId, database: alias } });
}
interface RemoteValue { exists: boolean; value?: unknown; revision?: string }
interface TransactionEntry { address: KVStoreGetInput; before: RemoteValue; write?: { operation: "set"; value: unknown; source?: unknown } | { operation: "delete" } }

/** CAS and optimistic multi-key transactions are committed atomically by the host. */
export class RemoteDatabaseSpaceStore implements KVStore {
  private readonly transaction = new AsyncLocalStorage<Map<string, TransactionEntry>>();
  constructor(private readonly connection: DatabaseConnection, private readonly consumer: DatabaseConsumer & { alias: string; bindingRef: string }, private readonly spaceId: string, private readonly credentialVersion: number, private readonly dispatch?: <T>(body: Record<string, unknown>) => Promise<T>, private readonly management = false) {}
  private address(input: KVStoreGetInput) {
    if (input.projectId !== this.spaceId) throw new Error("Database space address mismatch.");
    if (input.scope === "conversation" && !this.management && !input.conversationId?.startsWith(`${this.consumer.projectId}:${this.consumer.entryId}:`)) throw new Error("Invalid database conversation namespace.");
    return { spaceId: this.spaceId, storageKind: input.storageKind, scope: input.scope, conversationId: input.conversationId, key: input.key };
  }
  private request<T>(body: unknown): Promise<T> { const request = { ...this.consumer, credentialVersion: this.credentialVersion, ...body as object }; return (this.dispatch ? this.dispatch<T>(request) : databaseHostRequest<T>(this.connection, `/${encodeURIComponent(this.spaceId)}/data`, request)).catch(cause => consumerFailure(cause, this.consumer, this.consumer.alias)); }
  async listValues(input: KVStoreListInput): Promise<KVStoreValuePage> {
    return this.request({ operation: 'list', entry: this.address({ ...input, key: '*' }), query: input.query, cursor: input.cursor, pageSize: input.pageSize, keyPrefixes: input.keyPrefixes });
  }
  async readRevision(): Promise<string> { return (await this.request<{ revision: string }>({ operation: "revision" })).revision; }
  private async current(input: KVStoreGetInput): Promise<TransactionEntry> {
    const address = this.address(input); const key = JSON.stringify(address); const transaction = this.transaction.getStore();
    const existing = transaction?.get(key); if (existing) return existing;
    const entry: TransactionEntry = { address: input, before: await this.request<RemoteValue>({ operation: "get", entry: address }) };
    if (entry.before.exists && typeof entry.before.revision !== "string") throw new Error("Database host omitted a revision.");
    transaction?.set(key, entry); return entry;
  }
  async getValue(input: KVStoreGetInput) {
    const entry = await this.current(input);
    if (entry.write) return entry.write.operation === "set" ? structuredClone(entry.write.value) : undefined;
    return entry.before.exists ? structuredClone(entry.before.value) : undefined;
  }
  async setValue(input: KVStoreSetInput) {
    if (JSON.stringify(input.value) === undefined) throw new Error("Database values must be JSON serializable.");
    if (this.transaction.getStore()) { (await this.current(input)).write = { operation: "set", value: structuredClone(input.value), source: input.source }; return; }
    await this.request({ operation: "set", entry: this.address(input), value: input.value, source: input.source });
  }
  async deleteValue(input: KVStoreGetInput) {
    if (this.transaction.getStore()) { const entry = await this.current(input); const existed = entry.write ? entry.write.operation === "set" : entry.before.exists; entry.write = { operation: "delete" }; return existed; }
    return (await this.request<{ removed: boolean }>({ operation: "delete", entry: this.address(input) })).removed;
  }
  async updateValue(input: KVStoreGetInput & { source?: unknown }, updater: (value: unknown) => unknown) {
    if (this.transaction.getStore()) { const value = updater(await this.getValue(input)); await this.setValue({ ...input, source: input.source as KVStoreSetInput["source"], value }); return value; }
    for (let attempt = 0; attempt < 24; attempt++) {
      const current = await this.current(input); const value = updater(current.before.value);
      if (JSON.stringify(value) === undefined) throw new Error("Database values must be JSON serializable.");
      const result = await this.request<{ applied: boolean }>({ operation: "compare-and-set", entry: this.address(input), expectedRevision: current.before.exists ? current.before.revision : null, value, source: input.source });
      if (result.applied) return value;
    }
    throw new Error("Database update conflicted repeatedly. Retry the operation.");
  }
  async withNamespaceLock<T>(_input: KVNamespaceLockInput, operation: () => Promise<T> | T): Promise<T> {
    if (this.transaction.getStore()) return operation();
    const entries = new Map<string, TransactionEntry>();
    const result = await this.transaction.run(entries, operation);
    if (!entries.size) return result;
    const commit = await this.request<{ applied: boolean }>({ operation: "transaction", entries: [...entries.values()].map((entry) => ({ entry: this.address(entry.address), expectedRevision: entry.before.exists ? entry.before.revision : null, mutation: entry.write })) });
    if (!commit.applied) throw Object.assign(new Error("Database transaction conflicted. Retry the complete transaction."), { code: "DATABASE_TRANSACTION_CONFLICT" });
    return result;
  }
  withNamespaceReadLock<T>(input: KVNamespaceLockInput, operation: () => Promise<T> | T) { return this.withNamespaceLock(input, operation); }
}

export function createRemoteDatabaseResolver(connection: DatabaseConnection): DatabaseResolver {
  const stores = new Map<string, RemoteDatabaseSpaceStore>();
  return { async resolve(requirement, consumer) {
    if (requirement.host !== "server" || !requirement.bindingRef) return undefined;
    const authorization = await databaseHostRequest<DatabaseAuthorization>(connection, `/bindings/${encodeURIComponent(requirement.bindingRef)}?projectId=${encodeURIComponent(consumer.projectId)}&entryId=${encodeURIComponent(consumer.entryId)}`).catch(cause => consumerFailure(cause, consumer, requirement.alias));
    const { bindingRef } = requirement;
    const key = `${consumer.projectId}:${consumer.entryId}:${bindingRef}`;
    let store = stores.get(key);
    if (!store || (store as unknown as { credentialVersion: number }).credentialVersion !== authorization.grant.credentialVersion) { store = new RemoteDatabaseSpaceStore(connection, { ...consumer, alias: requirement.alias, bindingRef }, authorization.space.spaceId, authorization.grant.credentialVersion); stores.set(key, store); }
    return { authorization, store };
  } };
}
