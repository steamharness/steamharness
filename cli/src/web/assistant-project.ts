import { pathToFileURL } from 'node:url';
import type { WebHostConfiguration } from './host-config';
import type { Project, Runtime } from './workflow-types';

export const ASSISTANT_PROTOCOL_VERSION = 1;
export const DEVELOPER_ASSISTANT_PROJECT_ID = 'a3aca697-b086-459b-84e4-d357ad2d9fb2';

/** Only the dedicated host surface supplies assistant context, never a project manifest. */
export function isLocalBuiltinAssistant(project: Project): boolean {
  const info = project.projectInfo;
  return !!project.assistant && project.id.toLowerCase() === DEVELOPER_ASSISTANT_PROJECT_ID
    && project.projectType === 'conversation' && (info?.dataStorage?.mode === 'local' || info?.dataStorage?.mode === 'both')
    && info.relatedProjects.length === 0;
}

const assistantTools = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'skill',
  'workflow-memory_global_memory', 'workflow-ui_present_card',
  'workflow-studio_studio_state', 'workflow-studio_get_diagnostics', 'workflow-studio_open_file',
  'workflow-studio_set_theme', 'workflow-studio_open_terminal', 'workflow-studio_show_view']);

export async function inspectWebProject(runtime: Runtime, projectDir: string, host?: WebHostConfiguration) {
  if (host?.assistant && !host.assistantProjectDir) { throw new Error('A dedicated assistant project is required.'); }
  const inspection = await runtime.inspect([host?.assistantProjectDir ?? projectDir]);
  return { ...inspection, assistantProtocolVersion: host?.assistant ? ASSISTANT_PROTOCOL_VERSION : undefined,
    projects: inspection.projects.map(descriptor => {
      const project: Project = { ...descriptor, uri: pathToFileURL(descriptor.folderPath).href };
      if (host?.assistant) {
        project.assistant = host.assistant;
        project.uri = `studio-assistant:${encodeURIComponent(project.assistant.workdir)}`;
        project.requiresLogin = false;
        project.tools = project.tools?.filter(tool => assistantTools.has(tool.name));
      }
      return project;
    }),
  };
}
