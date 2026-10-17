import type { AssistantWorkspaceFolder, WorkflowProject } from './workflow-types';
import type { WorkflowConnection } from './workflow-auth-client';
import type { ResourceRequest } from './workflow-resources-types';
import type { CreatedProject, ProjectCreationInput, StartEnvironment, StartSummary, StartTemplate } from './start-page-types';
import type { ProjectType } from './projects';
import type { DownloadedServerProject, ProjectTransferProgress, UpdatedServerProject } from './workflow-server-projects';

export interface WorkflowRelatedProjectBinding { alias: string; projectDir: string }

export interface WorkflowWebReady {
  type: 'ready'; protocolVersion: number; hostProtocolVersion: number; url: string;
  assistantProtocolVersion?: number;
  accountProtocolVersion?: number;
  relatedProjectsProtocolVersion?: number;
  traceProtocolVersion?: number;
  project: Pick<WorkflowProject, 'id' | 'name' | 'projectType'>;
  runtime: { harnessVersion: string; harnessPath: string };
}
export interface WorkflowWebSession {
  ready: WorkflowWebReady;
  closed: Promise<void>;
  close(): Promise<void>;
  updateAuth(connection?: WorkflowConnection): void;
  updateRelatedProjects(projects: WorkflowRelatedProjectBinding[], resourceProjects?: string[]): void;
  onExit(callback: () => void): { dispose(): void };
}
export interface WorkflowLauncher {
  available: boolean;
  projectCreationDirectory?: string;
  templates?(): Promise<StartTemplate[]>;
  validateProjectCreation?(input: ProjectCreationInput): Promise<void>;
  createProject?(input: { templateId: string; name: string; parentDirectory: string }, signal?: AbortSignal): Promise<CreatedProject>;
  installDependencies?(directory: string, signal: AbortSignal, log: (message: string) => void): Promise<void>;
  uploadProject?(project: WorkflowProject, releaseLog: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void): Promise<void>;
  downloadProject?(projectId: string, version: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void): Promise<DownloadedServerProject[]>;
  upgradeProject?(project: WorkflowProject, version: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void,
    beforeReplace: () => Promise<void>, afterReplace: (projects: DownloadedServerProject[]) => Promise<void>): Promise<UpdatedServerProject>;
  environmentStatus?(): Promise<StartEnvironment>;
  analysisSummary?(): Promise<StartSummary>;
  analyzeProjectType?(sources: Array<{ name: string; text: string }>): Promise<ProjectType | undefined>;
  inspect(paths: string[]): Promise<{ projects: Omit<WorkflowProject, 'uri'>[]; errors: string[] }>;
  inspectAssistant(target: AssistantWorkspaceFolder, folders: AssistantWorkspaceFolder[]): Promise<{ projects: Omit<WorkflowProject, 'uri'>[]; errors: string[] }>;
  inspectAnalysis?(): Promise<WorkflowProject>;
  updateAnalysisProjects?(projects: WorkflowProject[]): void;
  start(project: WorkflowProject, surface: 'editor' | 'assistant', signal?: AbortSignal, relatedProjects?: WorkflowRelatedProjectBinding[], resourceProjects?: string[]): Promise<WorkflowWebSession>;
  cliEntry(projectDir: string): Promise<string>;
  resource?(project: WorkflowProject, input: ResourceRequest, signal: AbortSignal): Promise<unknown>;
  dispose(): void;
}
