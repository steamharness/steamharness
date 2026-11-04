import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cp, mkdir, rm } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rm(path.join(root, 'dist/main'), { recursive: true, force: true });
await build({ absWorkingDir: root, entryPoints: ['src/app.js'], outfile: 'dist/main/assets/analysis.js', bundle: true,
  platform: 'browser', format: 'esm', target: 'es2022', minify: true, legalComments: 'eof', logLevel: 'info' });

await mkdir(path.join(root, "dist/main"), { recursive: true });
await cp(path.join(root, "assets/analysis.css"), path.join(root, "dist/main/assets/analysis.css"));
await cp(path.join(root, "index.html"), path.join(root, "dist/main/index.html"));
