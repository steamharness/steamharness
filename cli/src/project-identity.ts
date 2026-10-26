import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isProjectUuid } from '@steamharness/workflow-ids';
import { i18n } from '@steamharness/i18n';

/** Replace only the reviewed manifest's ID; never overwrite edits made while requesting an ID. */
export async function writeProjectIdentity(directory: string, source: string, projectId: string, signal?: AbortSignal): Promise<void> {
  if (!isProjectUuid(projectId)) { throw new Error(i18n.t('projectCreationIdMismatch', { ns: 'cli' })); }
  const manifest = JSON.parse(source), filename = path.join(directory, 'package.json');
  const temporary = path.join(directory, `.package-identity-${randomUUID()}.tmp`);
  signal?.throwIfAborted();
  // SQLite releases its OS lock on process exit, including a crashed window.
  // Keep lock files outside the project so they cannot enter a source upload.
  const lockDirectory = path.join(os.tmpdir(), 'steamharness-project-identity');
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realpath(directory);
  const lockKey = process.platform === 'win32' ? canonicalDirectory.toLowerCase() : canonicalDirectory;
  const lock = new DatabaseSync(path.join(lockDirectory, `${createHash('sha256').update(lockKey).digest('hex')}.sqlite`));
  try {
    lock.exec('PRAGMA busy_timeout = 0');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5) throw new Error(i18n.t('projectIdentityChanged', { ns: 'cli' }));
    throw error;
  }
  const indentation = /\n([\t ]+)\S/.exec(source)?.[1] ?? '  ';
  try {
    if (await readFile(filename, 'utf8') !== source) { throw new Error(i18n.t('projectIdentityChanged', { ns: 'cli' })); }
    const content = JSON.stringify({ ...manifest, id: projectId }, null, indentation) + '\n';
    await writeFile(temporary, source.includes('\r\n') ? content.replaceAll('\n', '\r\n') : content, { flag: 'wx', mode: (await stat(filename)).mode & 0o777 });
    signal?.throwIfAborted();
    if (await readFile(filename, 'utf8') !== source) { throw new Error(i18n.t('projectIdentityChanged', { ns: 'cli' })); }
    await rename(temporary, filename);
  } finally {
    try { await rm(temporary, { force: true }); } finally { lock.close(); }
  }
}
