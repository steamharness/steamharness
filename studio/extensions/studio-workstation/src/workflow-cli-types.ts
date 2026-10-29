import type { AssistantWorkspaceFolder, Project } from './workflow-types';
import type { StudioUserSettings } from './user-settings';
import type { Connection } from './workflow-auth-client';
import type { ResourceRequest } from './workflow-resources-types';
import type { HostDatabaseRequest } from './workflow-databases-types';
import type { CreatedProject, ProjectCreationInput, StartEnvironment, StartSummary, StartTemplate } from './start-page-types';
import type { ProjectType } from './projects';
import type { DownloadedServerProject, ProjectTransferProgress, UpdatedServerProject } from './steamharness-server-projects';

export interface WebReady {
  type: 'ready'; protocolVersion: number; hostProtocolVersion: number; url: string;
  assistantProtocolVersion?: number;
  accountProtocolVersion?: number;
  systemAiConnectionProtocolVersion?: number;
  entriesProtocolVersion: number;
  databaseSpacesProtocolVersion: number;
  traceProtocolVersion?: number;
  userSettingsProtocolVersion?: number;
  project: Pick<Project, 'id' | 'name' | 'entries' | 'defaultEntry'>;
  runtime?: { harnessVersion: string; harnessPath: string };
}
export interface WebSessionExit { code: number | null; signal: NodeJS.Signals | null; stderr: string }
export interface WebSession {
  ready: WebReady;
  closed: Promise<void>;
  close(): Promise<void>;
  updateAuth(connection?: Connection): void;
  updateUserSettings(settings: StudioUserSettings): void;
  updateResourceProjects(projects: string[]): void;
  reconnect?(): Promise<boolean>;
  onReconnect?(callback: () => void): { dispose(): void };
  onExit(callback: (exit?: WebSessionExit) => void): { dispose(): void };
}
export interface Launcher {
  available: boolean;
  downloadDirectory?: string;
  projectCreationDirectory?: string;
  templates?(): Promise<StartTemplate[]>;
  validateProjectCreation?(input: ProjectCreationInput): Promise<void>;
  createProject?(input: { templateId: string; name: string; parentDirectory: string }, signal?: AbortSignal): Promise<CreatedProject>;
  installDependencies?(directory: string, signal: AbortSignal, log: (message: string) => void): Promise<void>;
  hasProjectDependencies?(directory: string): Promise<boolean>;
  prepareProjectTemplate?(directory: string, signal: AbortSignal): Promise<boolean>;
  uploadProject?(project: Project, releaseLog: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void): Promise<void>;
  downloadProject?(projectId: string, version: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void): Promise<DownloadedServerProject[]>;
  upgradeProject?(project: Project, version: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void,
    beforeReplace: () => Promise<void>, afterReplace: (projects: DownloadedServerProject[]) => Promise<void>): Promise<UpdatedServerProject>;
  environmentStatus?(): Promise<StartEnvironment>;
  nodeRuntime?(): Promise<{ nodePath: string; env: Record<string, string | undefined>; electron: boolean }>;
  analysisSummary?(): Promise<StartSummary>;
  analyzeProjectType?(sources: Array<{ name: string; text: string }>): Promise<ProjectType | undefined>;
  inspect(paths: string[], options?: { validationDetails?: boolean }): Promise<{ projects: Omit<Project, 'uri'>[]; errors: string[] }>;
  inspectAssistant(target: AssistantWorkspaceFolder, folders: AssistantWorkspaceFolder[]): Promise<{ projects: Omit<Project, 'uri'>[]; errors: string[] }>;
  inspectAnalysis?(): Promise<Project>;
  updateAnalysisProjects?(projects: Project[]): void;
  start(project: Project, surface: 'editor' | 'assistant', signal?: AbortSignal, resourceProjects?: string[]): Promise<WebSession>;
  cliEntry(projectDir: string): Promise<string>;
  resource?(project: Project, input: ResourceRequest, signal: AbortSignal): Promise<unknown>;
  database?(input: HostDatabaseRequest, signal: AbortSignal): Promise<any>;
  dispose(): void;
}
