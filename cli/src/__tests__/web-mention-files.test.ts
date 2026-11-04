import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { projectMentionFiles } from '../web/mention-files';
import type { Project } from '../web/workflow-types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mention-files-'))); roots.push(root);
  const project = { folderPath: root } as Project;
  const write = async (name: string) => { const target = path.join(root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, name); };
  return { root, project, write };
}

it('searches ordinary projects, keeps Unicode and spaced paths, excludes generated data and never traverses linked directories', async () => {
  const f = await fixture(), external = await fixture();
  for (const name of ['index.ts', 'src/中文 main.ts', 'node_modules/dependency.ts', 'dist/bundle.js', '.data/history.json', '.env', '.env.local', '.env.example']) await f.write(name);
  await external.write('private.ts'); await symlink(external.root, path.join(f.root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const catalog = await projectMentionFiles(f.project, '');
  expect(catalog.files.map(file => file.name).sort()).toEqual(['.env.example', 'index.ts', 'src/中文 main.ts']);
  expect((await projectMentionFiles(f.project, 'MAIN')).files).toEqual([{ path: path.join(f.root, 'src/中文 main.ts'), name: 'src/中文 main.ts' }]);
  expect((await projectMentionFiles(f.project, 'src\\中文')).files).toHaveLength(1);
});

it('respects Git ignore rules and searches untracked files while excluding symlinks and deleted tracked files', async () => {
  const f = await fixture(), external = await fixture();
  await promisify(execFile)('git', ['init', '--quiet'], { cwd: f.root, windowsHide: true });
  await f.write('.gitignore'); await writeFile(path.join(f.root, '.gitignore'), 'ignored/\n');
  await f.write('tracked.ts'); await f.write('untracked.ts'); await f.write('ignored/secret.ts'); await f.write('.env.production');
  await symlink(external.root, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await promisify(execFile)('git', ['add', 'tracked.ts', 'linked'], { cwd: f.root, windowsHide: true });
  await rm(path.join(f.root, 'tracked.ts'));
  const result = await projectMentionFiles(f.project, '');
  expect(result.files.map(file => file.name).sort()).toEqual(['.gitignore', 'untracked.ts']);
});

it('bounds returned files, permits narrower searches and uses the assistant working directory', async () => {
  const f = await fixture(), assistant = await fixture();
  await Promise.all(Array.from({ length: 75 }, (_, index) => f.write(`src/file-${index}.ts`)));
  const result = await projectMentionFiles(f.project, ''); expect(result.files).toHaveLength(60); expect(result.truncated).toBe(true);
  expect(await projectMentionFiles(f.project, 'file-74')).toEqual({ files: [{ name: 'src/file-74.ts', path: path.join(f.root, 'src/file-74.ts') }], truncated: false });
  await assistant.write('assistant-only.ts');
  expect((await projectMentionFiles({ ...f.project, assistant: { workdir: assistant.root, roots: [] } }, '')).files.map(file => file.name)).toEqual(['assistant-only.ts']);
});
