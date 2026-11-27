import { t } from './localization';
import { lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
    return pathReferences([{ path: path.normalize(location), kind: info.isDirectory() ? 'directory' : 'file', size: info.size }])[0];
  }));
}

/** Browser copies belong to this entry, not the source tree or a user-selected workdir. */
export async function importDroppedEntries(entryDirectory: string, value: unknown): Promise<PathReference[]> {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error(t("Invalid dropped files."));
  let size = 0;
  const keyFor = (name: string) => name.normalize('NFC').toLowerCase();
  const names = new Map<string, { name: string; kind: 'file' | 'directory' }>();
  const entries = value.map(entry => {
    if (!entry || typeof entry.name !== 'string' || entry.name.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(entry.name)
      || entry.name.split('/').some((part: string) => !part || part === '.' || part === '..'
        || process.platform === 'win32' && (/[<>"|?*]|[. ]$/.test(part) || /^(?:con(?:in\$|out\$)?|prn|aux|nul|(?:com|lpt)[0-9¹²³]) *(?:\.|$)/i.test(part)))
      || !['file', 'directory'].includes(entry.kind)) throw new Error(t("Invalid dropped file name."));
    const key = keyFor(entry.name);
    if (names.has(key)) throw new Error(t("Duplicate dropped file name."));
    names.set(key, { name: entry.name, kind: entry.kind });
    let bytes: Buffer | undefined;
    if (entry.kind === 'file') {
      if (typeof entry.data !== 'string' || entry.data.length > 70 * 1024 * 1024 || entry.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) throw new Error(t("Invalid dropped file data."));
      bytes = Buffer.from(entry.data, 'base64'); size += bytes.length;
      if (size > 50 * 1024 * 1024) throw new Error(t("Files selected for import exceed 50 MiB in total."));
    }
    return { name: entry.name as string, kind: entry.kind as 'file' | 'directory', bytes };
  });
  const top = new Map<string, 'file' | 'directory'>();
  const fileSizes = new Map<string, number>();
  const folders = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/'), key = keyFor(parent);
      const declared = names.get(key), previous = folders.get(key) ?? declared?.name;
      if (declared?.kind === 'file') throw new Error(t("A dropped file conflicts with a folder."));
      if (previous !== undefined && previous !== parent) throw new Error(t("Duplicate dropped file name."));
      folders.set(key, parent);
    }
    top.set(parts[0], parts.length > 1 ? 'directory' : entry.kind);
    if (parts.length === 1 && entry.bytes) fileSizes.set(entry.name, entry.bytes.length);
  }
  if (top.size > 32) throw new Error(t("Too many path references."));
  // Neither a project-supplied symlink nor a browser filename can redirect the write.
  let root = await realpath(entryDirectory);
  for (const segment of ['files', 'uploads']) {
    root = path.join(root, segment);
    try { await mkdir(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error(t("The project upload directory must be a regular folder."));
  }
  const directory = path.join(root, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      await mkdir(entry.kind === 'directory' ? target : path.dirname(target), { recursive: true });
      if (entry.bytes) await writeFile(target, entry.bytes, { flag: 'wx' });
    }
    return pathReferences([...top].map(([name, kind]) => ({ path: path.join(directory, name), kind, size: fileSizes.get(name), source: 'workspace-upload' })));
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
