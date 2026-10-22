import type { AssistantWorkspaceFolder, Project } from './workflow-types';
import type { Connection } from './workflow-auth-client';
import type { ResourceRequest } from './workflow-resources-types';
import type { CreatedProject, ProjectCreationInput, StartEnvironment, StartSummary, StartTemplate } from './start-page-types';
import type { ProjectType } from './projects';
import type { DownloadedServerProject, ProjectTransferProgress, UpdatedServerProject } from './steamharness-server-projects';

export interface RelatedProjectBinding { alias: string; projectDir: string }

export interface WebReady {
  type: 'ready'; protocolVersion: number; hostProtocolVersion: number; url: string;
  assistantProtocolVersion?: number;
  accountProtocolVersion?: number;
  relatedProjectsProtocolVersion?: number;
  traceProtocolVersion?: number;
  project: Pick<Project, 'id' | 'name' | 'projectType'>;
  runtime: { harnessVersion: string; harnessPath: string };
}
export interface WebSessionExit { code: number | null; signal: NodeJS.Signals | null; stderr: string }
export interface WebSession {
  ready: WebReady;
  closed: Promise<void>;
  close(): Promise<void>;
  updateAuth(connection?: Connection): void;
  updateRelatedProjects(projects: RelatedProjectBinding[], resourceProjects?: string[]): void;
  onExit(callback: (exit?: WebSessionExit) => void): { dispose(): void };
}
export interface Launcher {
  available: boolean;
  projectCreationDirectory?: string;
  templates?(): Promise<StartTemplate[]>;
  validateProjectCreation?(input: ProjectCreationInput): Promise<void>;
  createProject?(input: { templateId: string; name: string; parentDirectory: string }, signal?: AbortSignal): Promise<CreatedProject>;
  installDependencies?(directory: string, signal: AbortSignal, log: (message: string) => void): Promise<void>;
  uploadProject?(project: Project, releaseLog: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void, groupId?:string): Promise<void>;
  downloadProject?(projectId: string, version: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void): Promise<DownloadedServerProject[]>;
  upgradeProject?(project: Project, version: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void,
    beforeReplace: () => Promise<void>, afterReplace: (projects: DownloadedServerProject[]) => Promise<void>): Promise<UpdatedServerProject>;
  environmentStatus?(): Promise<StartEnvironment>;
  analysisSummary?(): Promise<StartSummary>;
  analyzeProjectType?(sources: Array<{ name: string; text: string }>): Promise<ProjectType | undefined>;
  inspect(paths: string[]): Promise<{ projects: Omit<Project, 'uri'>[]; errors: string[] }>;
  inspectAssistant(target: AssistantWorkspaceFolder, folders: AssistantWorkspaceFolder[]): Promise<{ projects: Omit<Project, 'uri'>[]; errors: string[] }>;
  inspectAnalysis?(): Promise<Project>;
  updateAnalysisProjects?(projects: Project[]): void;
  start(project: Project, surface: 'editor' | 'assistant', signal?: AbortSignal, relatedProjects?: RelatedProjectBinding[], resourceProjects?: string[], port?: number): Promise<WebSession>;
  cliEntry(projectDir: string): Promise<string>;
  resource?(project: Project, input: ResourceRequest, signal: AbortSignal): Promise<unknown>;
  dispose(): void;
}
