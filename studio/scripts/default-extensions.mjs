import * as path from 'node:path';
import { ROOT, exists, readJSON } from './distribution.mjs';
import { ensureExtensionVsix } from './extension-artifacts.mjs';

export async function ensureDefaultExtensions(extensionsDirectory, install) {
  const defaults = await readJSON(path.join(ROOT, 'config/default-extensions.json'));
  const registryFile = path.join(extensionsDirectory, 'extensions.json');
  const installed = await exists(registryFile) ? await readJSON(registryFile) : [];

  for (const extension of defaults) {
    // Native startup and packaging load these through product.builtInExtensions.
    if (extension.builtin) continue;
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

    await install(await ensureExtensionVsix(ROOT, extension));
  }
}
