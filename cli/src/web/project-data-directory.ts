import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isProjectUuid } from '@steamharness/workflow-ids';
import { createHash } from 'node:crypto';

export const webProjectDataDirectory = (storageDir: string, projectDir: string) => path.join(storageDir, createHash('sha256').update(projectDir).digest('hex').slice(0, 24));

/** Preserve the old application's data when a folder obtains a new Server identity. */
export async function projectDataDirectory(storageDir: string, projectDir: string, projectId: string): Promise<string> {
  const root = webProjectDataDirectory(storageDir, projectDir);
  let originalId: string;
  try { originalId = JSON.parse(await readFile(path.join(root, 'application-identity.json'), 'utf8')).originalProjectId; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    try { originalId = JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8')).projectId; }
    catch (metadataError) { if ((metadataError as NodeJS.ErrnoException).code === 'ENOENT') { return root; } throw metadataError; }
  }
  if (typeof originalId !== 'string' || !isProjectUuid(originalId) || !isProjectUuid(projectId)) { throw new Error('Invalid application history identity.'); }
  return originalId.toLowerCase() === projectId.toLowerCase() ? root : path.join(root, 'applications', projectId.toLowerCase());
}

export function projectDataDirectorySync(storageDir: string, projectDir: string, projectId: string): string {
  const root = webProjectDataDirectory(storageDir, projectDir);
  let originalId: string;
  try { originalId = JSON.parse(readFileSync(path.join(root, 'application-identity.json'), 'utf8')).originalProjectId; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    try { originalId = JSON.parse(readFileSync(path.join(root, 'project.json'), 'utf8')).projectId; }
    catch (metadataError) { if ((metadataError as NodeJS.ErrnoException).code === 'ENOENT') { return root; } throw metadataError; }
  }
  if (typeof originalId !== 'string' || !isProjectUuid(originalId) || !isProjectUuid(projectId)) { throw new Error('Invalid application history identity.'); }
  return originalId.toLowerCase() === projectId.toLowerCase() ? root : path.join(root, 'applications', projectId.toLowerCase());
}

export async function retainProjectDataIdentity(storageDir: string, projectDir: string, projectId: string): Promise<void> {
  const root = webProjectDataDirectory(storageDir, projectDir);
  await mkdir(root, { recursive: true });
  let originalProjectId = projectId;
  try { originalProjectId = JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8')).projectId; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!isProjectUuid(originalProjectId)) throw new Error('Invalid application history identity.');
  try { await writeFile(path.join(root, 'application-identity.json'), JSON.stringify({ originalProjectId }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
  await projectDataDirectory(storageDir, projectDir, projectId);
}
