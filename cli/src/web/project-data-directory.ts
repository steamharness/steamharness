import { readProjectReleaseSync } from "@steamharness/project-manifest/release-node";
import path from 'node:path';
import { projectEntryKey } from '@steamharness/project-manifest';

export function webProjectDataDirectory(storageDir: string, projectId: string, entryId: string): string {
  projectEntryKey(projectId, entryId);
  return path.join(storageDir, 'projects', projectId.toLowerCase(), 'entries', entryId);
}
export function folderBotDataRoot(storageDir: string, id: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid local folder Bot identity.');
  return path.join(storageDir, 'folder-bots', id);
}
export function projectDataDirectorySync(storageDir: string, projectDir: string, projectId: string, entryId: string): string {
  return webProjectDataDirectory(readProjectReleaseSync(projectDir) ? path.join(storageDir, "release") : storageDir, projectId, entryId);
}
export async function projectDataDirectory(storageDir: string, projectDir: string, projectId: string, entryId: string): Promise<string> {
  return projectDataDirectorySync(storageDir, projectDir, projectId, entryId);
}
