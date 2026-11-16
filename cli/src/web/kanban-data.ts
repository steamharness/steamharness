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
  if (!declaration.registration.databases.includes(String(input.database))) throw Object.assign(new Error('Declare this database alias on the entry first.'), { code: 'DATABASE_ALIAS_UNDECLARED' });
  if (!connection) throw Object.assign(new Error('Sign in to SteamHarness Server to access databases.'), { code: 'DATABASE_SIGN_IN_REQUIRED' });
  return core.executeDatabaseQueryBridge(core.createRemoteDatabaseQueryHost(connection, { projectId: project.id, entryId: project.entryId }), operation, input);
}
