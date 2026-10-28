import { databaseReadPrefixes } from './list';
import type { KVStoreValuePage } from '../kv/index';
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createResolvedProjectFile, type FileReference, type CreateFileInput, type ResolvedFile } from "../files/index";
import { assertDatabaseAuthorization, normalizeDatabaseRequirement, DatabaseAccessError, type DatabaseAuthorization, type DatabaseConsumer, type DatabaseRequirement } from "@steamharness/database-spaces";
import { createProjectKVContext, createProjectPersistentValueContext, normalizeProjectKVKey, type KVContext, type KVNamespace, type KVStore } from "../kv/index";
import { createKnowledgeDocument, deleteKnowledgeDocument, describeKnowledgeMutationKeys, editKnowledgeDocument, getKnowledgeDocument, isKnowledgeDocumentStorageKey, listKnowledgeDocumentPage, readKnowledgeDocumentLines, searchKnowledgeDocuments, type CreateKnowledgeDocumentInput, type EditKnowledgeDocumentInput, type ListKnowledgeDocumentsInput, type ReadKnowledgeDocumentLinesInput, type SearchKnowledgeDocumentsInput } from "../knowledge/index";
import { LocalDatabaseRegistry } from "./local-registry";
import { createLocalDatabaseSpaceStore } from "./local-store";
import { registerDatabaseKnowledgeContext } from "./knowledge-context";
export * from "@steamharness/database-spaces";
export * from "@steamharness/database-spaces/catalog";
export * from "./local-registry";
export * from "./remote";
export * from "./bindings";

export interface DatabaseKnowledgeContext {
  listDocuments(input?: ListKnowledgeDocumentsInput): ReturnType<typeof listKnowledgeDocumentPage>;
  getDocument(documentId: string): ReturnType<typeof getKnowledgeDocument>;
  createDocument(input: CreateKnowledgeDocumentInput): ReturnType<typeof createKnowledgeDocument>;
  editDocument(input: EditKnowledgeDocumentInput): ReturnType<typeof editKnowledgeDocument>;
  deleteDocument(documentId: string): ReturnType<typeof deleteKnowledgeDocument>;
  searchDocuments(input: SearchKnowledgeDocumentsInput): ReturnType<typeof searchKnowledgeDocuments>;
  files: { createFile(input: CreateFileInput): Promise<FileReference>; readFile(fileId: string): Promise<ResolvedFile>; deleteFile(fileId: string): Promise<boolean> };
  readDocumentLines(input: ReadKnowledgeDocumentLinesInput): ReturnType<typeof readKnowledgeDocumentLines>;
}
export interface DatabaseContext {
  listValues(input?: { query?: string; cursor?: string; pageSize?: number; scope?: 'project' | 'conversation' }): Promise<KVStoreValuePage>;
  kv: KVContext;
  knowledge: DatabaseKnowledgeContext;
  getBinding(): Promise<DatabaseAuthorization>;
  getRevision(): Promise<string>;
  subscribe(listener: (revision: string) => void, options?: { signal?: AbortSignal; onError?: (error: unknown) => void }): () => void;
  transaction<T>(operation: (database: DatabaseContext) => Promise<T> | T): Promise<T>;
}
export interface DatabasesContext {
  list(): ReadonlyArray<DatabaseRequirement>;
  get(alias: string): DatabaseContext;
}
export interface ResolvedDatabase {
  authorization: DatabaseAuthorization;
  store: KVStore;
}
/** Supplied by the trusted host; the manifest records only aliases and database IDs. */
export interface DatabaseResolver {
  resolve(requirement: DatabaseRequirement, consumer: DatabaseConsumer): Promise<ResolvedDatabase | undefined> | ResolvedDatabase | undefined;
}
export function createLocalDatabaseResolver(registry = new LocalDatabaseRegistry()): DatabaseResolver {
  const stores = new Map<string, KVStore>();
  return { resolve(requirement, consumer) {
    const authorization = registry.resolve(requirement.databaseId, consumer);
    if (!authorization) return undefined;
    let store = stores.get(authorization.space.spaceId);
    if (!store) { store = createLocalDatabaseSpaceStore(registry.directory, authorization.space.spaceId); stores.set(authorization.space.spaceId, store); }
    return { authorization, store };
  } };
}

export function createDatabasesContext(options: DatabaseConsumer & { requirements: readonly DatabaseRequirement[]; resolver?: DatabaseResolver; conversationId?: string; runId?: string; conversationNamespace?: string }): DatabasesContext {
  const requirements = options.requirements.map((item) => normalizeDatabaseRequirement(item));
  if (new Set(requirements.map(item => item.alias)).size !== requirements.length) throw new Error("Database aliases must be unique within an entry.");
  const contexts = new Map<string, DatabaseContext>();
  return {
    list: () => structuredClone(requirements),
    get(alias) {
      const requirement = requirements.find((item) => item.alias === alias);
      if (!requirement) throw new DatabaseAccessError("DATABASE_UNBOUND", `Database alias "${alias}" is not declared by entry "${options.entryId}".`);
      const existing = contexts.get(alias); if (existing) return existing;
      let cachedStore: ResolvedDatabase | undefined;
      const pinned = new AsyncLocalStorage<ResolvedDatabase>();
      const identity = (value: ResolvedDatabase) => JSON.stringify([value.authorization.binding.bindingRef,value.authorization.space.spaceId,value.authorization.grant.credentialVersion]);
      const resolve = async () => {
        const resolved = await options.resolver?.resolve(requirement, options);
        if (!resolved) throw new DatabaseAccessError("DATABASE_UNBOUND", `Database "${alias}" requires host authorization for database "${requirement.databaseId}".`);
        const transaction = pinned.getStore();
        if (transaction && identity(transaction) !== identity(resolved)) throw new DatabaseAccessError("DATABASE_ACCESS_DENIED", "Database authorization changed during the transaction.");
        // Keep the store transaction scope stable while revalidating its grant on every access.
        if (!cachedStore || identity(cachedStore) !== identity(resolved)) cachedStore = resolved;
        return {authorization:resolved.authorization,store:transaction?.store ?? cachedStore.store};
      };
      const consumer = { ...options, ...requirement };
      const assert = (resolved: ResolvedDatabase, resource: "kv" | "knowledge", operation: "read" | "write", key: string) => {
        assertDatabaseAuthorization(resolved.authorization, consumer, resource, operation, key);
        if (resource === "kv" && (isKnowledgeDocumentStorageKey(key) || key.startsWith("__knowledge_file:"))) throw new DatabaseAccessError("DATABASE_ACCESS_DENIED", "Knowledge data must be accessed through the knowledge API.");
      };
      const namespace = (resource: "kv" | "knowledge", conversation = false): KVNamespace => {
        const open = async (operation: "read" | "write", rawKey: string) => {
          const key = normalizeProjectKVKey(rawKey); const resolved = await resolve(); assert(resolved, resource, operation, key);
          const bound = { store: resolved.store, projectId: resolved.authorization.space.spaceId, conversationId: options.conversationNamespace ?? (options.conversationId ? `${options.projectId}:${options.entryId}:${options.conversationId}` : undefined), source: { projectId: options.projectId, entryId: options.entryId, runId: options.runId, conversationId: options.conversationId } };
          const context = resource === "kv" ? createProjectKVContext(bound) : createProjectPersistentValueContext(bound);
          return { resolved, key, namespace: conversation ? context.conversation : context };
        };
        const result: KVNamespace = {
          async getValue(key) { const opened = await open("read", key); return opened.namespace.getValue(opened.key); },
          async setValue(key, value) { const opened = await open("write", key); return opened.namespace.setValue(opened.key, value); },
          async deleteValue(key) { const opened = await open("write", key); return opened.namespace.deleteValue(opened.key); },
          async updateValue(key, update) { const opened = await open("write", key); assert(opened.resolved, resource, "read", opened.key); return opened.namespace.updateValue(opened.key, update); },
          async withLock(operation) {
            const resolved = await resolve(); const lock = resolved.store.withNamespaceLock;
            if (!lock) throw new Error("This host requires a server-side database transaction.");
            return pinned.run(resolved, () => lock.call(resolved.store, { projectId: resolved.authorization.space.spaceId, storageKind: resource === "kv" ? "kv" : "persistent_value", scope: conversation ? "conversation" : "project", conversationId: options.conversationNamespace ?? (options.conversationId ? `${options.projectId}:${options.entryId}:${options.conversationId}` : undefined) }, operation)) as ReturnType<typeof operation>;
          },
          async withReadLock(operation) { return result.withLock!(operation); },
        };
        return result;
      };
      const kv = { ...namespace("kv"), conversation: namespace("kv", true) };
      const knowledge = () => ({ persistentValue: namespace("knowledge") });
      const fileKey = (fileId: string) => { if (!/^[0-9a-f-]{36}$/.test(fileId)) throw new Error("Invalid knowledge attachment ID."); return `__knowledge_file:${fileId}`; };
      const files: DatabaseKnowledgeContext["files"] = {
        async createFile(input) {
          const buffer = typeof input.buffer === "string" ? Buffer.from(input.buffer, "base64") : Buffer.from(input.buffer instanceof ArrayBuffer ? new Uint8Array(input.buffer) : input.buffer);
          if (buffer.length > 50 * 1024 * 1024) throw new Error("Knowledge attachments cannot exceed 50 MiB.");
          if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 512 || /[\\/\0]/.test(input.name)) throw new Error("Invalid attachment name.");
          const resolved = await resolve(); const id = randomUUID();
          const mimeType = input.mimeType || "application/octet-stream";
          const file: FileReference = { id, name: input.name, mimeType, size: buffer.length, kind: input.kind ?? (mimeType.startsWith("image/") ? "image" : "file"), storage: "database", spaceId: resolved.authorization.space.spaceId, createdAt: new Date().toISOString() };
          await namespace("knowledge").setValue(fileKey(id), { file, base64: buffer.toString("base64") });
          return file;
        },
        async readFile(fileId) {
          const read = async () => {
            const value = await namespace("knowledge").getValue(fileKey(fileId)) as { file: FileReference; base64: string } | undefined;
            if (!value || typeof value.base64 !== "string" || value.file?.id !== fileId) throw new Error("Knowledge attachment is unavailable.");
            return value;
          };
          const value = await read();
          // Recheck authorization even when a resolved file handle was retained.
          return createResolvedProjectFile(value.file, async () => Buffer.from((await read()).base64, "base64"));
        },
        async deleteFile(fileId) { return namespace("knowledge").deleteValue(fileKey(fileId)); },
      };
      const context: DatabaseContext = {
        async listValues(input = {}) {
          const resolved = await resolve(); await context.getBinding();
          const keyPrefixes = databaseReadPrefixes(resolved.authorization.grant.permissions.kv.read);
          if (keyPrefixes?.length === 0) throw new DatabaseAccessError('DATABASE_ACCESS_DENIED', 'A KV read grant is required.');
          if (!resolved.store.listValues) throw new Error('This host cannot list database values.');
          const page = await resolved.store.listValues({ ...input, keyPrefixes, projectId: resolved.authorization.space.spaceId, storageKind: 'kv', scope: input.scope ?? 'project', conversationId: options.conversationNamespace ?? (options.conversationId ? `${options.projectId}:${options.entryId}:${options.conversationId}` : undefined) });
          for (const item of page.items) assert(resolved, 'kv', 'read', item.key);
          return page;
        },
        kv,
        async getRevision() {
          const resolved = await resolve(); await context.getBinding();
          if (!(["kv", "knowledge"] as const).some(resource => databaseReadPrefixes(resolved.authorization.grant.permissions[resource].read)?.length !== 0)) throw new DatabaseAccessError("DATABASE_ACCESS_DENIED", "A read grant is required for database revisions.");
          if (!resolved.store.readRevision) throw new Error("Database revision notifications are unavailable on this host.");
          return resolved.store.readRevision();
        },
        subscribe(listener, options = {}) {
          let stopped = false, previous: string | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stop = () => { stopped = true; clearTimeout(timer); options.signal?.removeEventListener("abort", stop); };
          const poll = async () => {
            try { const revision = await context.getRevision(); if (!stopped && revision !== previous) { previous = revision; listener(revision); } }
            catch (error) { if (!stopped) options.onError?.(error); }
            if (!stopped) { timer = setTimeout(() => void poll(), 1000); timer.unref?.(); }
          };
          if (options.signal?.aborted) stop(); else { options.signal?.addEventListener("abort", stop, { once: true }); void poll(); }
          return stop;
        },
        knowledge: {
          files,
          listDocuments: (input) => listKnowledgeDocumentPage(knowledge(), input ?? {}),
          getDocument: (id) => getKnowledgeDocument(knowledge(), id),
          createDocument: (input) => createKnowledgeDocument(knowledge(), input),
          editDocument: (input) => editKnowledgeDocument(knowledge(), input),
          deleteDocument: (id) => deleteKnowledgeDocument(knowledge(), id),
          searchDocuments: (input) => searchKnowledgeDocuments(knowledge(), input),
          readDocumentLines: (input) => readKnowledgeDocumentLines(knowledge(), input),
        },
        async getBinding() {
          const resolved = await resolve();
          // Validate identity and revocation without assuming any read grant.
          const all = { mode: "all" as const };
          assertDatabaseAuthorization({ ...resolved.authorization, grant: { ...resolved.authorization.grant, permissions: { kv: { read: all, write: all }, knowledge: { read: all, write: all } } } }, consumer, "kv", "read", "");
          return structuredClone(resolved.authorization);
        },
        async transaction(operation) {
          const resolved = await resolve(); await context.getBinding();
          if (!resolved.store.withNamespaceLock) throw new Error("This host requires declarative server-side database transactions.");
          return pinned.run(resolved, () => resolved.store.withNamespaceLock!({ projectId: resolved.authorization.space.spaceId, storageKind: "kv", scope: "project" }, () => operation(context)));
        },
      };
      registerDatabaseKnowledgeContext(context, knowledge());
      contexts.set(alias, context); return context;
    },
  };
}

export { executeDatabaseOperation } from "./operations";

export { databaseReadPrefixes } from "./list";
