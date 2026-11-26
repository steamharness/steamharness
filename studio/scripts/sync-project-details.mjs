import { readFile, writeFile } from 'node:fs/promises';

// The VS Code fork builds independently of the monorepo's workspace packages.
// Keep its checked-in renderer and CSS as generated snapshots of the CLI source.
const files = {
  'details.ts': 'studioProjectDetailsView.ts',
  'details.css': 'media/studioProjectDetailsView.css',
};
const write = process.argv.includes('--write');
const normalize = text => text.replaceAll('\r\n', '\n');
for (const [source, target] of Object.entries(files)) {
  const text = normalize(await readFile(new URL(`../../shared/project-info/${source}`, import.meta.url), 'utf8'));
  const snapshot = text.replace('\n\n', `\n\n/* Generated from shared/project-info/${source}. Run node studio/scripts/sync-project-details.mjs --write to update. */\n\n`);
  const file = new URL(`../upstream/vscode/src/vs/workbench/browser/${target}`, import.meta.url);
  const current = await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (normalize(current) === snapshot) continue;
  if (write) await writeFile(file, snapshot);
  else throw new Error(`${target} is out of sync. Run node studio/scripts/sync-project-details.mjs --write.`);
}
