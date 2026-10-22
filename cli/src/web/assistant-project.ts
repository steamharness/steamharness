import { pathToFileURL } from 'node:url';
import type { WebHostConfiguration } from './host-config';
import type { Project, Runtime } from './workflow-types';

export const ASSISTANT_PROTOCOL_VERSION = 1;
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
