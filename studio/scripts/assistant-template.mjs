import { cp, mkdir, readdir, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';

/** Both Studio runtime bundles need the complete registered assistant project. */
export async function copyAssistantTemplate(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && (['package.json', 'config.json', 'configuration.json'].includes(entry.name)
      || entry.name.endsWith('.ts') && !entry.name.endsWith('.config.ts'))) {
      await copyFile(path.join(source, entry.name), path.join(destination, entry.name));
    }
  }
  await cp(path.join(source, 'skills'), path.join(destination, 'skills'), { recursive: true });
  const control = path.join(destination, 'studio-control');
  await mkdir(control, { recursive: true });
  for (const entry of await readdir(path.join(source, 'studio-control'), { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'configuration.json' || entry.name.endsWith('.ts'))) {
      await copyFile(path.join(source, 'studio-control', entry.name), path.join(control, entry.name));
    }
  }
}
