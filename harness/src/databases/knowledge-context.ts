import type { KnowledgeContext } from "../knowledge/index";
const namespaces = new WeakMap<object, KnowledgeContext>();
export function registerDatabaseKnowledgeContext(database: object, context: KnowledgeContext): void { namespaces.set(database, context); }
export function databaseKnowledgeContext(database: object): KnowledgeContext {
  const context = namespaces.get(database);
  if (!context) throw new Error("The database was not created by this host.");
  return context;
}
