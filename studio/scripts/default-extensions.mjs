import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ROOT, exists, readJSON } from './distribution.mjs';

const digest = (content) => createHash('sha256').update(content).digest('hex');

export async function ensureDefaultExtensions(extensionsDirectory, install) {
  const defaults = await readJSON(path.join(ROOT, 'config/default-extensions.json'));
  const registryFile = path.join(extensionsDirectory, 'extensions.json');
  const installed = await exists(registryFile) ? await readJSON(registryFile) : [];

  for (const extension of defaults) {
    const existing = installed.find((entry) => entry.identifier.id.toLowerCase() === extension.id.toLowerCase());
    if (existing && await exists(path.join(extensionsDirectory, existing.relativeLocation, 'package.json'))) {
      const manifest = await readJSON(path.join(extensionsDirectory, existing.relativeLocation, 'package.json'));
      if (manifest.contributes?.localizations?.length) {
        // The extension directory is shared by profiles; let the native CLI refresh
        // this profile's languagepacks.json without downloading or reinstalling the pack.
        await install(`${extension.id}@${manifest.version}`);
      }
      continue;
    }

    const vsix = path.join(ROOT, '.studio', `${extension.id}-${extension.version}.vsix`);
    if (!await exists(vsix) || digest(await fs.readFile(vsix)) !== extension.sha256) {
      const response = await fetch(extension.url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        throw new Error(`Extension ${extension.id} download returned HTTP ${response.status}.`);
      }
      const contents = new Uint8Array(await response.arrayBuffer());
      if (digest(contents) !== extension.sha256) {
        throw new Error(`Extension ${extension.id} does not match the pinned SHA-256.`);
      }
      await fs.mkdir(path.dirname(vsix), { recursive: true });
      await fs.writeFile(vsix, contents);
    }
    await install(vsix);
  }
}
