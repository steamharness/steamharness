import * as fs from 'node:fs/promises';
import path from 'node:path';

const entrypoints = ['extension.js', 'extension-web.js'];
const stat = file => fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
const link = async (source, target, directory) => {
  if (!await stat(target)) await fs.symlink(source, target, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
};

/** Keep executable entrypoints inside the extension's registered real path. */
export async function stageOverlayExtension(source, destination, updated = entrypoints) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (['package.json', 'dist'].includes(entry.name)) continue;
    await link(path.join(source, entry.name), path.join(destination, entry.name), entry.isDirectory());
  }
  const output = path.join(source, 'dist'), staged = path.join(destination, 'dist');
  if ((await stat(staged))?.isSymbolicLink()) {
    if (await fs.realpath(staged) !== await fs.realpath(output)) throw new Error('The staged extension output is not the managed Studio link.');
    await fs.unlink(staged);
  }
  await fs.mkdir(staged, { recursive: true });
  for (const entry of await fs.readdir(output, { withFileTypes: true })) {
    const original = path.join(output, entry.name), target = path.join(staged, entry.name);
    if (!entrypoints.includes(entry.name)) {
      await link(original, target, entry.isDirectory());
    } else if (updated.includes(entry.name)) {
      // A symlink here would make Node select the anonymous vscode API. Assets
      // remain linked, while successful rebuilds replace these small bundles.
      const temporary = `${target}.${process.pid}.tmp`;
      try { await fs.copyFile(original, temporary); await fs.rename(temporary, target); }
      finally { await fs.rm(temporary, { force: true }); }
    }
  }
}

export function overlayExtensionBuildPlugin(source, destination, entrypoint) {
  return { name: 'studio-overlay-entrypoint', setup(build) {
    build.onEnd(async result => {
      if (!result.errors.length && await stat(path.join(destination, 'package.json'))) {
        await stageOverlayExtension(source, destination, [entrypoint]);
      }
    });
  } };
}
