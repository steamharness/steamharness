import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({ absWorkingDir: root, entryPoints: ['src/app.js'], outfile: 'assets/analysis.js', bundle: true,
  platform: 'browser', format: 'esm', target: 'es2022', minify: true, legalComments: 'eof', logLevel: 'info' });
