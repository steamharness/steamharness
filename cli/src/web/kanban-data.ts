import { readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseKanbanBridgeCall, resolveKanbanRelatedProject, type KanbanBridgeCall } from '@steamharness/kanban-project';
import { readWorkflowProjectInfo, resolveWorkflowRelatedProjectAccess, isWorkflowProjectAccessAllowed, isWorkflowProjectDataStorageLocationAllowed } from '@steamharness/project-info';
import type { Project } from './workflow-types';

export { readWorkflowProjectInfo, resolveWorkflowProjectName } from '@steamharness/project-info';
export const webProjectDataDirectory = (storageDir: string, projectDir: string) => path.join(storageDir, createHash('sha256').update(projectDir).digest('hex').slice(0, 24));

export async function localKanbanRelatedProjects(project: Project) {
  const info = readWorkflowProjectInfo(JSON.parse(await readFile(path.join(project.folderPath, 'package.json'), 'utf8')));
  const relations = info.relatedProjects;
  const projects = new Map<string, { folderPath: string; id: string; projectInfo: ReturnType<typeof readWorkflowProjectInfo> }>();
  if (!relations.length) { return { info, projects }; }
  const parent = path.dirname(project.folderPath);
  const directories = (await readdir(parent, { withFileTypes: true })).filter(item => item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules').slice(0, 500);
  await Promise.all(directories.map(async item => {
    try {
      const folderPath = await realpath(path.join(parent, item.name));
      const pkg = JSON.parse(await readFile(path.join(folderPath, 'package.json'), 'utf8'));
      const relation = relations.find(relation => relation.projectId.toLowerCase() === String(pkg.id).toLowerCase());
      if (!relation) { return; }
      const projectInfo = readWorkflowProjectInfo(pkg);
      const access = resolveWorkflowRelatedProjectAccess({ consumerProjectId: project.id, consumerProjectInfo: info, targetProjectId: pkg.id, targetProjectInfo: projectInfo, alias: relation.alias });
      if (access && isWorkflowProjectDataStorageLocationAllowed(projectInfo, 'local')) {
        if (projects.has(relation.alias)) { throw new Error(`Duplicate related project UUID: ${pkg.id}`); }
        projects.set(relation.alias, { folderPath, id: pkg.id, projectInfo });
      }
    } catch (error) { if (String(error).includes('Duplicate related project UUID')) { throw error; } }
  }));
  return { info, projects };
}

// Core is supplied by the worker after resolving it from the user's project.
export async function runKanbanDataCall(core: typeof import('steamharness'), project: Project, storageDir: string, value: KanbanBridgeCall): Promise<unknown> {
  const call = parseKanbanBridgeCall(value), { operation, input } = call;
  const { info, projects } = await localKanbanRelatedProjects(project);
  if (info.dataStorage?.mode === 'server' || !isWorkflowProjectDataStorageLocationAllowed(info, 'local')) { throw new Error('Kanban data must use its declared storage location.'); }
  const directory = webProjectDataDirectory(storageDir, project.folderPath);
  const kv = core.createWorkflowKVContext({ store: core.createLocalWorkflowKVStore({ rootDir: path.join(directory, 'kv'), storageKind: 'kv' }), projectId: project.id });
  const knowledge = { persistentValue: core.createWorkflowPersistentValueContext({ store: core.createLocalWorkflowKVStore({ rootDir: path.join(directory, 'values'), storageKind: 'persistent_value' }), projectId: project.id }) };
  switch (operation) {
    case 'kv.getValue': return await kv.getValue(String(input.key)) ?? null;
    case 'kv.setValue': await kv.setValue(String(input.key), input.value); return null;
    case 'relatedProject.kv.getValue':
    case 'relatedProject.kv.setValue': {
      const alias = String(input.alias), key = String(input.key);
      resolveKanbanRelatedProject(info.relatedProjects, alias, key);
      const target = projects.get(alias);
      if (!target) { throw Object.assign(new Error('Related project is unavailable.'), { code: 'KANBAN_RELATED_PROJECT_UNAVAILABLE' }); }
      const access = resolveWorkflowRelatedProjectAccess({ consumerProjectId: project.id, consumerProjectInfo: info, targetProjectId: target.id, targetProjectInfo: target.projectInfo, alias });
      if (!access || !isWorkflowProjectAccessAllowed(operation === 'relatedProject.kv.getValue' ? access.grant.read : access.grant.write, key)) { throw Object.assign(new Error('Related project did not grant this key.'), { code: 'KANBAN_RELATED_PROJECT_UNAVAILABLE' }); }
      const related = core.createWorkflowKVContext({ projectId: target.id, store: core.createLocalWorkflowKVStore({ rootDir: path.join(webProjectDataDirectory(storageDir, target.folderPath), 'kv'), storageKind: 'kv' }) });
      if (operation === 'relatedProject.kv.getValue') { return await related.getValue(key) ?? null; }
      await related.setValue(key, input.value); return null;
    }
    case 'knowledge.listDocuments': return core.listKnowledgeDocumentPage(knowledge, input);
    case 'knowledge.getDocument': return await core.getKnowledgeDocument(knowledge, String(input.documentId)) ?? null;
    case 'knowledge.createDocument': return core.createKnowledgeDocument(knowledge, input as unknown as Parameters<typeof core.createKnowledgeDocument>[1]);
    case 'knowledge.editDocument': return core.editKnowledgeDocument(knowledge, { id: String(input.documentId), title: input.title as string | undefined, markdown: input.markdown as string | undefined });
    case 'knowledge.deleteDocument': return core.deleteKnowledgeDocument(knowledge, String(input.documentId));
    case 'knowledge.searchDocuments': return core.searchKnowledgeDocuments(knowledge, input as unknown as Parameters<typeof core.searchKnowledgeDocuments>[1]);
    case 'knowledge.readDocumentLines': return core.readKnowledgeDocumentLines(knowledge, input as unknown as Parameters<typeof core.readKnowledgeDocumentLines>[1]);
    default: throw new Error('Unsupported local Kanban operation.');
  }
}
