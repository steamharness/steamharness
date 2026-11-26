import type { ImportedProject, RecentProject } from './projects';

export interface ProjectHistory { recent: RecentProject[]; imported: ImportedProject[] }

export interface AccountWorkspace {
  readonly owner: string;
  readonly runs: string;
  readonly schedules: string;
  readHistory(): ProjectHistory;
  updateHistory(edit: (history: ProjectHistory) => ProjectHistory): boolean;
  prepare(): void;
  inbox(input: unknown): unknown;
}

export const isWorkspaceOwner = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
