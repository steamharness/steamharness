import path from 'node:path';
import { projectEntryKey } from '@steamharness/project-manifest';

export function webProjectDataDirectory(storageDir: string, projectId: string, entryId: string): string {
  projectEntryKey(projectId, entryId);
  return path.join(storageDir, 'projects', projectId.toLowerCase(), 'entries', entryId);
}
export function projectDataDirectorySync(storageDir: string, _projectDir: string, projectId: string, entryId: string): string {
  return webProjectDataDirectory(storageDir, projectId, entryId);
}
export async function projectDataDirectory(storageDir: string, projectDir: string, projectId: string, entryId: string): Promise<string> {
  return projectDataDirectorySync(storageDir, projectDir, projectId, entryId);
}
