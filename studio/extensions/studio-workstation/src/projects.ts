export type ProjectType = 'workflow' | 'bot' | 'kanban';
export const projectTypeIcons: Record<ProjectType, string> = { workflow: 'run-all', bot: 'hubot', kanban: 'layout' };

/** Keep only the cover filename and version in history, never the image bytes. */
export interface LibraryArtwork {
  cover?: { name: string; mtime: number };
  entries?: string[];
  files?: string[];
}

export interface RecentProject {
  uri: string;
  label: string;
  kind: 'folder' | 'workspace';
  lastOpened: number;
  projectType?: ProjectType;
  projectName?: string;
  description?: string;
  version?: string;
  avatarUrl?: string;
  projectId?: string;
  distribution?: 'source' | 'release' | 'download';
  artwork?: LibraryArtwork;
  entries?: { entryId: string; name: string; type: ProjectType; primary: boolean }[];
}

export const IMPORTED_PROJECTS_KEY = 'studio.importedProjects';
export const RECENT_PROJECTS_KEY = 'studio.recentProjects';

export type RecentMetadata = Pick<RecentProject, 'projectType' | 'avatarUrl' | 'version' | 'projectId' | 'distribution' | 'artwork' | 'entries' | 'projectName' | 'description'>;
export function applyRecentMetadata(rows: RecentProject[], updates: ReadonlyMap<string, RecentMetadata>): RecentProject[] {
  return rows.map(row => row.kind === 'folder' && updates.has(row.uri) ? { ...row, ...updates.get(row.uri) } : row);
}

export interface ImportedProject {
  id: string;
  uri: string;
  name: string;
  version?: string;
}

export function projectId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : undefined;
}

export function readImportedProjects(value: unknown): ImportedProject[] {
  if (!Array.isArray(value)) { return []; }
  return value.flatMap(item => {
    const id = projectId(item?.id);
    if (!id || typeof item?.name !== 'string' || !item.name.trim() || typeof item?.uri !== 'string') { return []; }
    try {
      if (!['file:', 'vscode-remote:'].includes(new URL(item.uri).protocol)) { return []; }
    } catch { return []; }
    return [{ id, uri: item.uri, name: item.name, ...(typeof item.version === 'string' ? { version: item.version } : {}) }];
  });
}

export function rememberImportedProjects(previous: ImportedProject[], imported: ImportedProject[]): ImportedProject[] {
  const projects = new Map<string, ImportedProject>();
  const known = new Map(readImportedProjects(previous).map(project => [project.uri, project]));
  for (const project of readImportedProjects([...imported, ...previous])) {
    const existing = known.get(project.uri);
    if (!projects.has(project.uri)) { projects.set(project.uri, { ...(existing?.id === project.id ? existing : {}), ...project }); }
  }
  return [...projects.values()];
}

export function readRecentProjects(value: unknown): RecentProject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is RecentProject => {
    if (!item || typeof item !== 'object' || typeof item.uri !== 'string' ||
        typeof item.label !== 'string' || !item.label ||
        !['folder', 'workspace'].includes(item.kind) ||
        typeof item.lastOpened !== 'number' || !Number.isFinite(item.lastOpened)) {
      return false;
    }
    try {
      return ['file:', 'vscode-remote:'].includes(new URL(item.uri).protocol);
    } catch {
      return false;
    }
  });
}

export function rememberProjects(
  previous: RecentProject[],
  opened: RecentProject[],
  limit: number,
): RecentProject[] {
  const projects = new Map<string, RecentProject>();
  const known = new Map(previous.map(row => [row.uri, row]));
  for (const project of [...opened, ...previous].sort((a, b) => b.lastOpened - a.lastOpened)) {
    if (!projects.has(project.uri)) {
      projects.set(project.uri, { ...known.get(project.uri), ...project });
    }
  }
  return [...projects.values()].slice(0, Math.min(50, Math.max(1, limit)));
}
