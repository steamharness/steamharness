import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MentionFiles } from './conversation-mentions';
import type { Project } from './workflow-types';

const execute = promisify(execFile);
const excluded = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.data', '.release', '.steamharness', '.oss-content']);
const visible = (name: string) => !name.split('/').some(part => excluded.has(part) || /^\.env(?:\.|$)/.test(part) && !part.endsWith('.example'));

/** A bounded, read-only catalog; no client-supplied paths are opened. */
export async function projectMentionFiles(project: Project, query: string): Promise<MentionFiles> {
  const root = await realpath(project.assistant?.workdir ?? project.folderPath);
  let names: string[] = [], truncated = false;
  try {
    const { stdout } = await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      { cwd: root, encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    names = stdout.split('\0').filter(Boolean);
  } catch {
    const directories = [''];
    let visited = 0;
    for (let index = 0; index < directories.length; index++) {
      const directory = directories[index];
      const children = await readdir(path.join(root, directory), { withFileTypes: true }).catch(error => {
        if (!directory) throw error;
        return [];
      });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (++visited > 20_000) { truncated = true; break; }
        const name = directory ? `${directory}/${child.name}` : child.name;
        if (!visible(name) || child.isSymbolicLink()) continue;
        if (child.isDirectory()) directories.push(name);
        else if (child.isFile()) names.push(name);
      }
      if (truncated) break;
    }
  }
  const search = query.toLocaleLowerCase().replaceAll('\\', '/');
  names = [...new Set(names)].filter(name => visible(name) && name.toLocaleLowerCase().includes(search))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const files: MentionFiles['files'] = [];
  for (const name of names) {
    const target = path.resolve(root, name);
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    try {
      // Reject symlinks, including a tracked file beneath a replaced symlink directory.
      if (!(await lstat(target)).isFile()) continue;
      const resolved = await realpath(target), contained = path.relative(root, resolved);
      if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) continue;
    } catch { continue; }
    if (files.length === 60) { truncated = true; break; }
    files.push({ path: target, name });
  }
  return { files, truncated };
}
