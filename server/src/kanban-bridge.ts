import { executeKnowledgeBaseOperation } from "steamharness";
import type { Storage } from "./storage";
import { HttpError } from "./protocol";
import { parseKanbanBridgeCall, type KanbanBridgeCall } from "@steamharness/kanban-project";
import type { RuntimeLocale } from "steamharness";
import type { AccessActor } from "@steamharness/project-access";
export function readKanbanBridgeCall(value: unknown): KanbanBridgeCall {
  try { return parseKanbanBridgeCall(value); } catch { throw new HttpError(400,400,"The Kanban bridge request is invalid."); }
}
export async function invokeServerKanbanBridge(storage: Storage, projectId: string, call: KanbanBridgeCall, options: { entryId: string; actor: AccessActor; target?: string; runtimeLocale?: RuntimeLocale }): Promise<unknown> {
  const { operation, input } = readKanbanBridgeCall(call);
  if (operation === "runtime.getLocale") return options.runtimeLocale ?? "en";
  if (operation.startsWith('knowledge.') || operation.startsWith('files.')) {
    const bases = await storage.entryKnowledgeBases(projectId, options.entryId, options.actor, options.target);
    return executeKnowledgeBaseOperation(bases.get(String(input.knowledgeBase)), operation, input);
  }
  if (!options.actor.userId || !storage.relationalDatabases) throw new HttpError(401, 401, 'Account login and a database host are required.');
  if (!(await storage.entryDatabaseRequirements(projectId, options.entryId, options.target)).includes(String(input.database))) throw new HttpError(403, 403, 'Declare this database alias on the entry first.');
  const consumer = { projectId, entryId: options.entryId, alias: String(input.database), schemaHash: String(input.schemaHash) };
  if (operation === 'database.resolve') return storage.relationalDatabases.resolveQueryBinding(options.actor.userId, consumer);
  const { executeDatabaseQueryBridge } = await import('steamharness');
  return executeDatabaseQueryBridge({ resolve: identity => storage.relationalDatabases!.resolveQueryBinding(options.actor.userId!, { ...consumer, ...identity }),
    query: (binding, schemaHash, request) => storage.relationalDatabases!.data(options.actor.userId!, binding.databaseId, request, { ...consumer, schemaHash, binding: { id: binding.id, revision: binding.revision }, accessRevision: binding.accessRevision }) }, operation, input);
}
