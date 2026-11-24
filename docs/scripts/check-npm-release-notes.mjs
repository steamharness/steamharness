import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateReleasePair, verifyReleaseNoteLinks } from './release-notes.mjs';

const docs = path.join(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(docs, '../harness/package.json'), 'utf8'));
for (const component of ['core', 'cli']) {
  const docsPaths = validateReleasePair(docs, component, version);
  await verifyReleaseNoteLinks('https://docs.steamharness.yuhe.space', docsPaths);
}
