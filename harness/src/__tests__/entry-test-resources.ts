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
    return { ...requirement, bindingRef: approved.bindingRef };
  });
  const databases: DatabasesContext = createDatabasesContext({ projectId, entryId, requirements: bound, conversationId: "conversation", resolver: { resolve(requirement) { const authorization = catalog.authorization(requirement.bindingRef!); return authorization ? { authorization, store: store! } : undefined; } } });
  return { projectId, entryId, databases, entries: createEntriesContext({ projectId, name: "test", defaultEntry: entryId, entries: [{ entryId, name: "test", type: "workflow", root: ".", entry: "index.ts", databases: bound }] }, { actor, projectId, sourceEntryId: entryId }, { async list() { return []; }, async run() { throw new Error("No nested test entry."); } }) };
}
