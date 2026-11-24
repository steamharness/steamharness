import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import * as core from 'steamharness';
import type { FolderBotProfile } from 'steamharness';
import type { FolderBotHost } from './host-config';

/** The profile record comes from trusted Studio stdio, never from a page or model. */
export function readFolderBotProfile(host: FolderBotHost, entryId: string): FolderBotProfile {
  const file = host.profileRecord;
  if (!file) return {};
  if (typeof core.parseFolderBotProfile !== 'function') throw new Error('Update the project Core to use a local Bot profile.');
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd), limit = 64 * 1024;
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error();
    const data = Buffer.alloc(limit + 1);
    const bytes = readSync(fd, data, 0, data.length, 0);
    if (bytes > limit || bytes !== info.size) throw new Error();
    const row = JSON.parse(data.toString('utf8', 0, bytes));
    if (row?.id !== host.id || row.directory !== host.directory || (row.source?.kind !== 'assistant' &&
      (row.source?.kind !== 'project' || row.source.projectId !== host.projectId || row.source.entryId !== entryId))) throw new Error();
    return core.parseFolderBotProfile(row.profile);
  } catch { throw new Error('The local Bot profile is invalid, unavailable, or belongs to another instance.'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
