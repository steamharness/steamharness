import * as vscode from 'vscode';
import { PROJECT_MANIFEST_FILE } from '@steamharness/project-manifest';

export const ignoredProjectDirectories = new Set(['node_modules', 'vendor', 'dist', 'out', 'build', 'upstream']);
const containers = new Set(['workspace', 'workflow', 'projects', 'examples']);
const batchSize = 12;

/** Locate aggregate roots without parsing or evaluating any entries. */
export async function findProjectCandidates(roots: readonly vscode.Uri[], cancelled = () => false): Promise<vscode.Uri[]> {
  const pending = roots.map(uri => ({ uri, depth: 0 }));
  const visited = new Set<string>();
  const projects: vscode.Uri[] = [];
  for (let offset = 0; offset < pending.length && !cancelled();) {
    const next = pending.slice(offset, offset + batchSize);
    offset += next.length;
    const batch = await Promise.all(next.map(async ({ uri, depth }) => {
      const key = uri.toString();
      if (visited.has(key)) return;
      visited.add(key);
      try {
        const manifest = await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, PROJECT_MANIFEST_FILE));
        if (manifest.type & vscode.FileType.File) return { project: uri };
      } catch { /* Ordinary folders are not projects. */ }
      if (depth === 4 || cancelled()) return;
      try {
        const children = await vscode.workspace.fs.readDirectory(uri);
        const container = containers.has(uri.path.split('/').at(-1) ?? '');
        return { children: children.filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.') &&
          !ignoredProjectDirectories.has(name) && (depth === 0 || container || containers.has(name)))
          .map(([name]) => ({ uri: vscode.Uri.joinPath(uri, name), depth: depth + 1 })) };
      } catch { return; }
    }));
    for (const candidate of batch) {
      if (candidate?.project) projects.push(candidate.project);
      if (candidate?.children) for (const child of candidate.children) pending.push(child);
    }
  }
  return projects;
}
