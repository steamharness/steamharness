import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const html = await readFile('index.html', 'utf8');
const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
await mkdir('dist', { recursive: true });
await build({ bundle: true, platform: 'browser', format: 'esm', outfile: 'dist/board.js',
  ...(inline ? { stdin: { contents: inline[1], resolveDir: process.cwd(), sourcefile: 'board-entry.js' } } : { entryPoints: ['board.js'] }) });
await writeFile('dist/index.html', inline ? html.replace(inline[0], '<script type="module" src="board.js"></script>') : html);
if (!inline) await writeFile(path.join('dist', 'board.css'), await readFile('board.css'));
