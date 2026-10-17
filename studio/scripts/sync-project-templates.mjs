import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, resolveWorkflowSource } from './distribution.mjs';

const source = path.join(await resolveWorkflowSource(), 'cli/src');
const target = path.join(ROOT, 'vendor/project-templates');
await mkdir(target, { recursive: true });
await writeFile(path.join(target, 'project-templates.ts'), await readFile(path.join(source, 'project-templates.ts')));
await rm(path.join(target, 'project-templates'), { recursive: true, force: true });
await cp(path.join(source, 'project-templates'), path.join(target, 'project-templates'), { recursive: true });
console.log('Updated the Studio snapshot from CLI project templates.');
