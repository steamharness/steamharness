import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { t } from './localization';

/** Serialize SecretStorage read/check/write across extension hosts. The database
 * contains no settings or keys; SQLite releases the lock if a window crashes. */
export async function withUserModelWriteLock<T>(directory: string, run: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, 'user-models-lock.sqlite'));
  try {
    try { database.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      if ([5, 6].includes((error as { errcode: number }).errcode)) {
        throw new Error(t('Models changed in another window. Reopen the editor and try again.'));
      }
      throw error;
    }
    return await run();
  } finally { database.close(); }
}
