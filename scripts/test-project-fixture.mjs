import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectKeys = ['id', 'name', 'version', 'description', 'defaultEntry', 'entries', 'projectCard', 'projectInfo', 'builtinRelease'];

/** Expand a flat test definition into the independent npm, root and child documents. */
export function projectFixtureFiles(files) {
  if (files.some(file => file.path === "steamharness.json")) return files;
  return files.flatMap(file => {
    if (file.path !== 'package.json' || typeof file.content !== 'string') return [file];
    let document;
    try { document = JSON.parse(file.content); } catch { return [file]; }
    if (!document?.entries || !document.id) return [file];
    const manifest = { version: '0.1.0', ...Object.fromEntries(projectKeys.filter(key => Object.hasOwn(document, key)).map(key => [key, structuredClone(document[key])])) };
    const npm = Object.fromEntries(Object.entries(document).filter(([key]) => !projectKeys.includes(key) || ['name', 'version', 'description'].includes(key)));
    const children = [];
    for (const entry of manifest.entries) {
      if (entry.root === '.' || entry.entry === undefined) continue;
      const { entryId, root, ...child } = entry;
      children.push({ path: `${root}/steamharness.json`, content: JSON.stringify(child) });
      for (const key of Object.keys(entry)) if (!['entryId', 'root'].includes(key)) delete entry[key];
    }
    return [{ ...file, content: JSON.stringify(npm) }, { ...file, path: 'steamharness.json', content: JSON.stringify(manifest) }, ...children];
  });
}
export function projectFixtureArchive(files) {
  return Object.fromEntries(projectFixtureFiles(Object.entries(files).map(([path, content]) => ({path, content}))).map(file => [file.path, file.content]));
}
export async function writeProjectFixture(filename, content, options) {
  if (path.basename(filename) !== 'package.json') return writeFile(filename, content, options);
  const files = projectFixtureFiles([{ path: 'package.json', content: String(content) }]);
  if (files.length === 1) return writeFile(filename, content, options);
  for (const file of files) {
    const target = path.join(path.dirname(filename), file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, options);
  }
}
