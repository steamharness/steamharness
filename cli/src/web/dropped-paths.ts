import { t } from './localization';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pathReferences, type PathReference } from './conversation-paths';

export async function resolveDroppedPaths(value: unknown): Promise<PathReference[]> {
  if (!Array.isArray(value) || !value.length || value.length > 32 || value.some(entry => typeof entry !== 'string' || entry.length > 4096 || /[\0\r\n]/.test(entry))) throw new Error(t("Invalid dropped paths."));
  return Promise.all([...new Set(value as string[])].map(async value => {
    const location = value.startsWith('file:') ? fileURLToPath(value) : value;
    if (!path.isAbsolute(location)) throw new Error(t("Invalid dropped path."));
    const info = await stat(location);
    if (!info.isFile() && !info.isDirectory()) throw new Error(t("Only files and folders can be referenced."));
    return pathReferences([{ path: path.normalize(location), kind: info.isDirectory() ? 'directory' : 'file' }])[0];
  }));
}

/** Import browser drops, whose original absolute paths are unavailable. */
export async function importDroppedEntries(root: string, value: unknown): Promise<PathReference[]> {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error(t("Invalid dropped files."));
  let size = 0;
  const names = new Map<string, 'file' | 'directory'>();
  const entries = value.map(entry => {
    if (!entry || typeof entry.name !== 'string' || entry.name.length > 4096 || /[\\:\0\r\n]/.test(entry.name)
      || entry.name.split('/').some((part: string) => !part || part === '.' || part === '..') || !['file', 'directory'].includes(entry.kind)) throw new Error(t("Invalid dropped file name."));
    // Case-folding also prevents collisions on Windows and default macOS volumes.
    const key = entry.name.toLowerCase();
    if (names.has(key)) throw new Error(t("Duplicate dropped file name."));
    names.set(key, entry.kind);
    let bytes: Buffer | undefined;
    if (entry.kind === 'file') {
      if (typeof entry.data !== 'string' || entry.data.length > 70 * 1024 * 1024 || entry.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) throw new Error(t("Invalid dropped file data."));
      bytes = Buffer.from(entry.data, 'base64'); size += bytes.length;
      if (size > 50 * 1024 * 1024) throw new Error(t("Dropped files exceed 50 MiB."));
    }
    return { name: entry.name as string, kind: entry.kind as 'file' | 'directory', bytes };
  });
  const top = new Map<string, 'file' | 'directory'>();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let index = 1; index < parts.length; index++) {
      if (names.get(parts.slice(0, index).join('/').toLowerCase()) === 'file') throw new Error(t("A dropped file conflicts with a folder."));
    }
    top.set(parts[0], parts.length > 1 ? 'directory' : entry.kind);
  }
  if (top.size > 32) throw new Error(t("Too many path references."));
  const directory = path.join(root, randomUUID());
  try {
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      await mkdir(entry.kind === 'directory' ? target : path.dirname(target), { recursive: true });
      if (entry.bytes) await writeFile(target, entry.bytes, { flag: 'wx' });
    }
    return pathReferences([...top].map(([name, kind]) => ({ path: path.join(directory, name), kind })));
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
