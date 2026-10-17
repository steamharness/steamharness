import { build } from 'esbuild';
import { cp } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await build({ entryPoints: [path.join(root, 'src/project-templates.ts')], outfile: path.join(root, 'dist/project-templates.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
await cp(path.join(root, 'src/project-templates'), path.join(root, 'dist/project-templates'), { recursive: true });
