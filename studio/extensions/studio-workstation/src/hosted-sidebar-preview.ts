import { resolveProjectEntry } from '@steamharness/project-manifest/node';
import { readKanbanEntryConfig } from '../../../../shared/kanban-project/index';
import { KanbanPreview } from '../../../../cli/src/web/kanban-preview';
import { parseWebAppBindings, WebAppPreview } from '../../../../cli/src/web/web-app-preview';
import type { OpenHostedSidebar } from './project-sidebar-types';

/** Run a bundled Kanban artifact without starting a CLI process or reading project environment overrides. */
export const openHostedSidebar: OpenHostedSidebar = async (project, binding, signal) => {
  const { projectDir, manifest, registration } = await resolveProjectEntry(project.directory, project.entryId);
  if (manifest.projectId !== project.projectId || registration.type !== 'kanban' || registration.webApp?.service !== binding.service) {
    throw new Error('Packaged Kanban entry does not match the registered project and service.');
  }
  const artifact = readKanbanEntryConfig(registration);
  const assets = new KanbanPreview(projectDir, artifact, () => ({ id: 'default', name: '', params: {} }));
  if (!await assets.asset(new URL(assets.url, 'http://127.0.0.1'))) throw new Error('Packaged Kanban entry could not be read.');
  signal.throwIfAborted();
  const validated = parseWebAppBindings({ [registration.entryId]: binding })[registration.entryId];
  const preview = new WebAppPreview(() => ({ nonce: assets.nonce, artifact, asset: url => assets.asset(url), hostNotifications: project.hostNotifications }), {
    ...validated,
    // Keep the proxy target fixed, but give each new window the current host session.
    get bootstrap() { return binding.bootstrap ?? null; },
  });
  try {
    await preview.start();
    signal.throwIfAborted();
    return { url: preview.url, nonce: assets.nonce, microphone: artifact.webApp?.permissions?.includes('microphone') ?? false, close: () => preview.close() };
  } catch (error) { await preview.close(); throw error; }
};
