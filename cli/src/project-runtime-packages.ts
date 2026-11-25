import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const projectRuntimeDirectory = 'vendor/steamharness';
export const projectRuntimePackages = [
  { key: 'core', name: 'steamharness', file: 'steamharness.tgz' },
  { key: 'cli', name: '@steamharness/cli', file: 'steamharness-cli.tgz' },
] as const;

export const projectRuntimeSpec = (file: string): string => `file:./${projectRuntimeDirectory}/${file}`;

const hashPattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function unavailable(cause?: unknown): Error {
  return Object.assign(new Error('The bundled Core and CLI packages are missing or damaged.', { cause }), { code: 'runtime-packages-unavailable' });
}

export async function readProjectRuntimeArchives(directory: string) {
  try {
    if (!path.isAbsolute(directory)) throw new Error('Expected an absolute package directory.');
    const manifest = JSON.parse(await readFile(path.join(directory, 'runtime-packages.json'), 'utf8'));
    // Version 1 may contain a CLI that still requires a separate project runtime version field.
    if (manifest.schemaVersion !== 2) throw new Error('Update the bundled Core and CLI packages before creating or updating a project.');
    const version: unknown = manifest.packages.core.version;
    if (typeof version !== 'string' || !versionPattern.test(version) || manifest.packages.cli.version !== version) {
      throw new Error('The bundled Core and CLI versions do not match.');
    }
    return await Promise.all(projectRuntimePackages.map(async ({ key, name, file }) => {
      const source = path.join(directory, file);
      const { sha256 } = manifest.packages[key];
      if (typeof sha256 !== 'string' || !hashPattern.test(sha256) || !(await lstat(source)).isFile()) {
        throw new Error(`Invalid bundled package ${name}.`);
      }
      return { source, sha256, version, file, name };
    }));
  } catch (cause) { throw unavailable(cause); }
}

export async function copyProjectRuntimeArchives(project: string, archives: Awaited<ReturnType<typeof readProjectRuntimeArchives>>, signal?: AbortSignal): Promise<void> {
  const destination = path.join(project, projectRuntimeDirectory);
  try {
    await mkdir(destination, { recursive: true });
    for (const archive of archives) {
      signal?.throwIfAborted();
      const file = path.join(destination, archive.file);
      await copyFile(archive.source, file, constants.COPYFILE_EXCL);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
      if (hash.digest('hex') !== archive.sha256) throw new Error(`Checksum mismatch for ${archive.name}.`);
    }
  } catch (cause) { signal?.throwIfAborted(); throw unavailable(cause); }
}
