import { parseKanbanBridgeCall, type KanbanBridgeCall } from '@steamharness/kanban-project';
import type { Project } from './workflow-types';
export { readProjectInfo, resolveProjectName } from '@steamharness/project-info';
export { readProjectCardMetadata } from '@steamharness/project-card-metadata';
export { webProjectDataDirectory } from './project-data-directory';
/** Local and server spaces use the same approved database context. */
export async function runKanbanDataCall(core: typeof import('steamharness'), project: Project, _storageDir: string, value: KanbanBridgeCall): Promise<unknown> {
  const { operation, input } = parseKanbanBridgeCall(value);
  const declaration = core.resolveProjectEntrySync(project.folderPath, project.entryId);
  const local = core.createLocalDatabaseResolver(), connection = core.databaseConnectionFromEnv();
  const remote = connection && core.createRemoteDatabaseResolver(connection);
  const databases = core.createDatabasesContext({ projectId: project.id, entryId: project.entryId, requirements: declaration.registration.databases, resolver: { resolve: async (requirement, consumer) => await local.resolve(requirement, consumer) ?? remote?.resolve(requirement, consumer) } });
  const database = databases.get(String(input.database));
  switch (operation) {
    case 'files.createFile': return database.knowledge.files.createFile({ name: String(input.name), mimeType: input.mimeType as string | undefined, buffer: Buffer.from(String(input.base64), 'base64') });
    case 'files.readFile': { const file = await database.knowledge.files.readFile(String(input.fileId)); return { file: file.toJSON(), base64: await file.readBase64() }; }
    case 'files.deleteFile': return database.knowledge.files.deleteFile(String(input.fileId));
    case 'database.revision': return database.getRevision();
    case 'kv.getValue': return await database.kv.getValue(String(input.key)) ?? null;
    case 'kv.setValue': await database.kv.setValue(String(input.key), input.value); return null;
    case 'knowledge.listDocuments': return database.knowledge.listDocuments(input);
    case 'knowledge.getDocument': return await database.knowledge.getDocument(String(input.documentId)) ?? null;
    case 'knowledge.createDocument': return database.knowledge.createDocument(input as any);
    case 'knowledge.editDocument': return database.knowledge.editDocument({ id: String(input.documentId), title: input.title as string | undefined, markdown: input.markdown as string | undefined });
    case 'knowledge.deleteDocument': return database.knowledge.deleteDocument(String(input.documentId));
    case 'knowledge.searchDocuments': return database.knowledge.searchDocuments(input as any);
    case 'knowledge.readDocumentLines': return database.knowledge.readDocumentLines(input as any);
    default: throw new Error('Unsupported database operation.');
  }
}
