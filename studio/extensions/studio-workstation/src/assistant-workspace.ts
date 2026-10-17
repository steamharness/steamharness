import type { AssistantWorkspaceFolder, WorkflowProject } from './workflow-types';

export const DEVELOPER_ASSISTANT_PROJECT_ID = 'a3aca697-b086-459b-84e4-d357ad2d9fb2';

const assistantTools = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'skill',
  'workflow-memory_global_memory', 'workflow-ui_present_card',
  'workflow-studio_studio_state', 'workflow-studio_get_related_projects', 'workflow-studio_get_diagnostics', 'workflow-studio_open_file',
  'workflow-studio_set_theme', 'workflow-studio_open_terminal', 'workflow-studio_show_view']);

export function createAssistantProject(
  template: WorkflowProject, target: AssistantWorkspaceFolder, folders: AssistantWorkspaceFolder[],
): WorkflowProject {
  const roots = [target, ...folders.filter((folder) => folder.uri !== target.uri)];
  return { ...template, uri: `studio-assistant:${encodeURIComponent(target.folderPath)}`,
    assistant: { ...template.assistant, workdir: target.folderPath, roots }, requiresLogin: true,
    fields: template.fields.map((field) => ({ ...field })),
    tools: template.tools?.filter((tool) => assistantTools.has(tool.name)),
  };
}

export function assistantWorkspaceAvailable(
  assistant: NonNullable<WorkflowProject['assistant']>, folders: AssistantWorkspaceFolder[],
): boolean {
  return assistant.roots.some(root => root.folderPath === assistant.workdir)
    && assistant.roots.every(root => folders.some(folder => folder.uri === root.uri && folder.folderPath === root.folderPath));
}

export function assistantWorkspaceManifest(assistant: NonNullable<WorkflowProject['assistant']>) {
  const primary = assistant.roots.find((folder) => folder.folderPath === assistant.workdir);
  if (!primary) { throw new Error('Assistant working directory is not an opened workspace folder.'); }
  return { schemaVersion: 2, primaryTarget: { kind: 'folder', folderId: primary.uri }, warnings: [],
    roots: assistant.roots.map((folder) => ({ target: { kind: 'folder', folderId: folder.uri },
      name: folder.name, rootPath: folder.folderPath,
      role: folder === primary ? 'primary' : 'linked', depth: folder === primary ? 0 : 1,
    })),
  };
}
