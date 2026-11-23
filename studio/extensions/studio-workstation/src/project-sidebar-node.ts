import { realpath } from 'node:fs/promises';
import { readProjectManifestFromDirectory, resolveRegisteredProjectEntry } from '@steamharness/project-manifest/node';
import type { SidebarProjectEntry } from './project-sidebar-types';

/** No dependency loading, network or execution in the history picker. */
export async function readSidebarProjectEntries(directory: string): Promise<SidebarProjectEntry[]> {
  const canonical = await realpath(directory);
  const manifest = await readProjectManifestFromDirectory(canonical);
  const entries = await Promise.allSettled(manifest.entries.map(async entry => {
    await resolveRegisteredProjectEntry(canonical, manifest, entry);
    return { directory: canonical, projectId: manifest.projectId, entryId: entry.entryId, title: entry.name.trim().slice(0, 256), type: entry.type,
      defaultEntry: entry.entryId === manifest.defaultEntry, ...(entry.folderContext === true && { folderContext: true }),
      ...(entry.projectInfo && Object.keys(entry.projectInfo.localizedNames).length ? { localizedNames: entry.projectInfo.localizedNames } : {}) };
  }));
  return entries.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
}
