import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseKanbanBridgeCall, resolveKanbanRelatedProject, type KanbanBridgeCall } from '@steamharness/kanban-project';
import { readProjectInfo, resolveProjectRelatedProjectAccess, isProjectAccessAllowed, isProjectDataStorageLocationAllowed } from '@steamharness/project-info';
import type { Project } from './workflow-types';
import type { CliRelatedProjectSpec } from '../related-projects';

export { readProjectInfo, resolveProjectName } from '@steamharness/project-info';
export { readProjectCardMetadataFromPackageJson } from '@steamharness/project-card-metadata';
export { webProjectDataDirectory } from './project-data-directory';
import { projectDataDirectory } from './project-data-directory';

export async function localKanbanRelatedProjects(project: Project, bindings: readonly CliRelatedProjectSpec[] = []) {
  const info = readProjectInfo(JSON.parse(await readFile(path.join(project.folderPath, 'package.json'), 'utf8')));
  const relations = info.relatedProjects;
  const projects = new Map<string, { folderPath: string; id: string; projectInfo: ReturnType<typeof readProjectInfo> }>();
  if (!relations.length) { return { info, projects }; }
  const parent = path.dirname(project.folderPath);
  const directories = (await readdir(parent, { withFileTypes: true })).filter(item => item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules').slice(0, 500);
  const boundAliases = new Set(bindings.map(binding => binding.alias));
  const candidates: { folderPath: string; alias?: string }[] = [...bindings.map(binding => ({ folderPath: binding.projectDir, alias: binding.alias })),
    ...directories.map(item => ({ folderPath: path.join(parent, item.name) }))];
  await Promise.all(candidates.map(async candidate => {
    try {
      const folderPath = await realpath(candidate.folderPath);
      const pkg = JSON.parse(await readFile(path.join(folderPath, 'package.json'), 'utf8'));
      const relation = relations.find(relation => relation.projectId.toLowerCase() === String(pkg.id).toLowerCase()
        && (candidate.alias ? relation.alias === candidate.alias : !boundAliases.has(relation.alias)));
      if (!relation) { return; }
      const projectInfo = readProjectInfo(pkg);
      const access = resolveProjectRelatedProjectAccess({ consumerProjectId: project.id, consumerProjectInfo: info, targetProjectId: pkg.id, targetProjectInfo: projectInfo, alias: relation.alias });
      if (access && isProjectDataStorageLocationAllowed(projectInfo, 'local')) {
        if (projects.has(relation.alias)) { throw new Error(`Duplicate related project UUID: ${pkg.id}`); }
        projects.set(relation.alias, { folderPath, id: pkg.id, projectInfo });
      }
    } catch (error) { if (String(error).includes('Duplicate related project UUID')) { throw error; } }
  }));
  return { info, projects };
}

// Core is supplied by the worker after resolving it from the user's project.
export async function runKanbanDataCall(core: typeof import('steamharness'), project: Project, storageDir: string, value: KanbanBridgeCall, bindings: readonly CliRelatedProjectSpec[] = []): Promise<unknown> {
  const call = parseKanbanBridgeCall(value), { operation, input } = call;
  const { info, projects } = await localKanbanRelatedProjects(project, bindings);
  if (info.dataStorage?.mode === 'server' || !isProjectDataStorageLocationAllowed(info, 'local')) { throw new Error('Kanban data must use its declared storage location.'); }
  const directory = await projectDataDirectory(storageDir, project.folderPath, project.id);
  const kv = core.createProjectKVContext({ store: core.createLocalProjectKVStore({ rootDir: path.join(directory, 'kv'), storageKind: 'kv' }), projectId: project.id });
  const knowledge = { persistentValue: core.createProjectPersistentValueContext({ store: core.createLocalProjectKVStore({ rootDir: path.join(directory, 'values'), storageKind: 'persistent_value' }), projectId: project.id }) };
  switch (operation) {
    case 'kv.getValue': return await kv.getValue(String(input.key)) ?? null;
    case 'kv.setValue': await kv.setValue(String(input.key), input.value); return null;
    case 'relatedProject.kv.getValue':
    case 'relatedProject.kv.setValue': {
      const alias = String(input.alias), key = String(input.key);
      resolveKanbanRelatedProject(info.relatedProjects, alias, key);
      const target = projects.get(alias);
      if (!target) { throw Object.assign(new Error('Related project is unavailable.'), { code: 'KANBAN_RELATED_PROJECT_UNAVAILABLE' }); }
      const access = resolveProjectRelatedProjectAccess({ consumerProjectId: project.id, consumerProjectInfo: info, targetProjectId: target.id, targetProjectInfo: target.projectInfo, alias });
      if (!access || !isProjectAccessAllowed(operation === 'relatedProject.kv.getValue' ? access.grant.read : access.grant.write, key)) { throw Object.assign(new Error('Related project did not grant this key.'), { code: 'KANBAN_RELATED_PROJECT_UNAVAILABLE' }); }
      const related = core.createProjectKVContext({ projectId: target.id, store: core.createLocalProjectKVStore({ rootDir: path.join(await projectDataDirectory(storageDir, target.folderPath, target.id), 'kv'), storageKind: 'kv' }) });
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
