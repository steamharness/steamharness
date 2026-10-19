import type { RecentProject } from './projects';
import type { ProjectVersionStatus } from './steamharness-server-projects';

export interface StartTemplate {
  id: string;
  projectType: 'workflow' | 'conversation' | 'kanban';
  kind: 'starter' | 'example';
  name: string;
  description: string;
}
export interface CreatedProject {
  id: string; name: string; directory: string; projectType: StartTemplate['projectType']; entryFile: string;
}
export interface ProjectCreationInput {
  templateId: string; name: string; parentDirectory: string;
}
export type ProjectCreationDialogResult = ProjectCreationInput | { shareUrl: string };
export interface ProjectCreationDialog {
  templates: StartTemplate[];
  labels: Record<string, string>;
  parentDirectory: string;
  templateId?: string;
  projectType?: string;
}
export interface StartEnvironment {
  node?: string; harness?: string; cli?: string; error?: string;
}
export interface StartSummary {
  projects: number; running: number; waiting: number; unavailable: number; generatedAt: number;
}
export interface PendingProjectSetup extends CreatedProject {
  status: 'failed' | 'cancelled'; error?: string; installOnOpen?: boolean;
}
export interface StudioStartState {
  version: 1;
  labels: Record<string, string>;
  templates: StartTemplate[];
  projects: Array<{ uri: string; name: string; version?: string; projectType: string; folderPath: string; update?: ProjectVersionStatus }>;
  recent: RecentProject[];
  pending: PendingProjectSetup[];
  environment: StartEnvironment & { studio: string; vscode: string; account: string; server: string };
  summary?: StartSummary;
  error?: string;
  busy: boolean;
  installing?: string;
  canCreate: boolean;
}
