import * as legacyTestDocuments from "../knowledge/index";
import { createKnowledgeBaseContext, createKnowledgeBasesContext } from "../knowledge-bases/index";
import { randomUUID } from "node:crypto";
import { DatabaseCatalog } from "@steamharness/database-spaces/catalog";
import { createDatabasesContext, type DatabasesContext } from "../databases/index";
import { createEntriesContext } from "../entries/index";
import type { KVStore } from "../kv/index";

export function createTestResources(store?: KVStore) {
  const values = new Map<string, unknown>();
  const key = (input: { storageKind: string; projectId: string; scope: string; conversationId?: string; key: string }) => JSON.stringify([input.storageKind, input.projectId, input.scope, input.conversationId, input.key]);
  store ??= { async getValue(input) { return values.get(key(input)); }, async setValue(input) { values.set(key(input), input.value); }, async deleteValue(input) { return values.delete(key(input)); }, async updateValue(input, update) { const value = update(values.get(key(input))); values.set(key(input), value); return value; }, async withNamespaceLock(_input, operation) { return operation(); } };
  const projectId = randomUUID();
  const entryId = "test";
  const all = { mode: "all" as const };
  const requirements = ["data", "other"].map((alias) => ({ alias, host: "local" as const, permissions: { kv: { read: all, write: all }, knowledge: { read: all, write: all } } }));
  const catalog = new DatabaseCatalog("local", { spaces: [], grants: [], requests: [], bindings: [] }, randomUUID, () => new Date().toISOString());
  const actor = { userId: "test", isSystemAdmin: true };
  const bound = requirements.map((requirement) => {
    const request = catalog.request({ ...requirement, projectId, entryId, target: { kind: "create", name: requirement.alias } }, actor);
    const approved = catalog.review(request.requestId, { approve: true }, actor);
    return { alias: requirement.alias, databaseId: approved.databaseId! };
  });
  const databases: DatabasesContext = createDatabasesContext({ projectId, entryId, requirements: bound, conversationId: "conversation", resolver: { resolve(requirement, consumer) { const authorization = catalog.resolve(requirement.databaseId, consumer); return authorization ? { authorization, store: store! } : undefined; } } });
  return { projectId, entryId, databases, knowledgeBases: createTestKnowledgeBases(projectId, entryId), entries: createEntriesContext({ projectId, name: "test", defaultEntry: entryId, entries: [{ entryId, name: "test", type: "workflow", root: ".", entry: "index.ts", databases: bound }] }, { actor, projectId, sourceEntryId: entryId }, { async list() { return []; }, async run() { throw new Error("No nested test entry."); } }) };
}

/** Explicit offline repository fixture; production contexts never fall back to this test store. */
export function createTestKnowledgeBases(projectId: string, entryId: string, aliases = ['data', 'other']) {
  const repositories = new Map<string, ReturnType<typeof createKnowledgeBaseContext>>();
  return { list: () => aliases.map(alias => ({ alias, knowledgeBaseId: projectId })), get(alias: string) {
    if (!aliases.includes(alias)) throw new Error('Knowledge alias is not declared.');
    if (!repositories.has(alias)) {
      const values = new Map<string, unknown>();
      const context = { persistentValue: {
        async withLock<T>(operation: () => Promise<T>) { return operation(); },
        async withReadLock<T>(operation: () => Promise<T>) { return operation(); },
        async getValue<T>(key: string) { return values.get(key) as T | undefined; },
        async setValue<T>(key: string, value: T) { values.set(key, value); },
        async deleteValue(key: string) { return values.delete(key); },
        async updateValue<T>(key: string, update: (current: T | undefined) => T) { const value = update(values.get(key) as T | undefined); values.set(key, value); return value; },
      } };
      repositories.set(alias, createKnowledgeBaseContext(async (operation, input: any) => {
        switch (operation) {
          case 'knowledge.listDocuments': return legacyTestDocuments.listKnowledgeDocumentPage(context, input) as any;
          case 'knowledge.getDocument': return legacyTestDocuments.getKnowledgeDocument(context, input.documentId) as any;
          case 'knowledge.createDocument': return legacyTestDocuments.createKnowledgeDocument(context, input) as any;
          case 'knowledge.editDocument': return legacyTestDocuments.editKnowledgeDocument(context, { ...input, id: input.documentId }) as any;
          case 'knowledge.deleteDocument': return legacyTestDocuments.deleteKnowledgeDocument(context, input.documentId) as any;
          case 'knowledge.searchDocuments': return legacyTestDocuments.searchKnowledgeDocuments(context, input) as any;
          case 'knowledge.readDocumentLines': return legacyTestDocuments.readKnowledgeDocumentLines(context, input) as any;
          default: throw new Error('Unsupported fixture operation.');
        }
      }));
    }
    return repositories.get(alias)!;
  } };
}
