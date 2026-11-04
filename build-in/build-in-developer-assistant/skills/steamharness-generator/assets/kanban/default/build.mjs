import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
const html = await readFile('index.html', 'utf8');
const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
await rm('dist/steamharness/build/main', { recursive: true, force: true });
await mkdir('dist/steamharness/build/main', { recursive: true });
await build({ bundle: true, platform: 'browser', format: 'esm', outfile: 'dist/steamharness/build/main/board.js',
  ...(inline ? { stdin: { contents: inline[1], resolveDir: process.cwd(), sourcefile: 'board-entry.js' } } : { entryPoints: ['board.js'] }) });
await writeFile('dist/steamharness/build/main/index.html', inline ? html.replace(inline[0], '<script type="module" src="board.js"></script>') : html);
if (!inline) await writeFile(path.join('dist/steamharness/build/main', 'board.css'), await readFile('board.css'));
