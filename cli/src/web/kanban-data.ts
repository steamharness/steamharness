import { parseKanbanBridgeCall, type KanbanBridgeCall } from '@steamharness/kanban-project';
import type { Project } from './workflow-types';
export { readProjectInfo, resolveProjectName } from '@steamharness/project-info';
export { readProjectCardMetadata } from '@steamharness/project-card-metadata';
export { webProjectDataDirectory } from './project-data-directory';
/** Local and server spaces use the same approved database context. */
export async function runKanbanDataCall(core: typeof import('steamharness'), project: Project, _storageDir: string, value: KanbanBridgeCall): Promise<unknown> {
  const { operation, input } = parseKanbanBridgeCall(value);
  const declaration = core.resolveProjectEntrySync(project.folderPath, project.entryId);
  const connection = core.databaseConnectionFromEnv();
  if (operation.startsWith('knowledge.') || operation.startsWith('files.')) {
    const bases = core.createKnowledgeBasesContext({ projectId: project.id, entryId: project.entryId, requirements: declaration.registration.knowledgeBases ?? [], host: connection ? core.createServerKnowledgeBaseHost(connection) : undefined });
    return core.executeKnowledgeBaseOperation(bases.get(String(input.knowledgeBase)), operation, input);
  }
  const local = core.createLocalDatabaseResolver(), remote = connection && core.createRemoteDatabaseResolver(connection);
  const databases = core.createDatabasesContext({ projectId: project.id, entryId: project.entryId, requirements: declaration.registration.databases, resolver: { resolve: async (requirement, consumer) => await local.resolve(requirement, consumer) ?? remote?.resolve(requirement, consumer) } });
  return core.executeDatabaseOperation(databases.get(String(input.database)), operation, input);
}
