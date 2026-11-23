import type { AssistantWorkspaceFolder, Project } from './workflow-types';
import type { StudioUserSettings } from './user-settings';
import type { Connection } from './workflow-auth-client';
import type { CreatedProject, ProjectCreationInput, StartTemplate } from './start-page-types';
import type { ProjectType } from './projects';
import type { DownloadedServerProject, ProjectTransferProgress, UpdatedServerProject } from './steamharness-server-projects';
import type { WebAppFailureReason } from './web-app-errors';
import type { TraceModelRequestTarget } from './workflow-trace-types';
import type { OpenHostedSidebar, SidebarProjectEntry } from './project-sidebar-types';
import type { ProjectUsageSnapshot } from './project-usage-types';

export interface WebReady {
  type: 'ready'; protocolVersion: number; hostProtocolVersion: number; url: string;
  assistantProtocolVersion?: number;
  accountProtocolVersion?: number;
  webAppProtocolVersion?: number;
  webAppConfigurationProtocolVersion?: number;
  webAppLoginProtocolVersion?: number;
  webAppConfigurations?: Record<string, import('./web-app-types').WebAppRequest['configuration']>;
  systemAiConnectionProtocolVersion?: number;
  restrictedConfigurationEntries?: string[];
  entriesProtocolVersion: number;
  traceProtocolVersion?: number;
  traceModelRequestProtocolVersion?: number;
  hostConversationProtocolVersion?: number;
  folderBotProtocolVersion?: number;
  userSettingsProtocolVersion?: number;
  project: Pick<Project, 'id' | 'name' | 'entries' | 'defaultEntry'>;
  runtime?: { harnessVersion: string; harnessPath: string };
}
export interface WebSessionExit { code: number | null; signal: NodeJS.Signals | null; stderr: string }
export interface WebSession {
  ready: WebReady;
  closed: Promise<void>;
  close(): Promise<void>;
  updateAuth(connection?: Connection, ai?: Connection): void;
  connectPlatform?(purpose: 'project' | 'ai' | 'web-app', entryId: string, interactive?: boolean): Promise<void>;
  connectWebApp?(entryId?: string, connection?: Connection, options?: { interactive?: boolean; serverUrl?: string }): Promise<void>;
  onWebAppLogin?(callback: (entryId: string, isCurrent: () => boolean) => void): { dispose(): void };
  updateUserSettings(settings: StudioUserSettings): void;
  updateResourceProjects(projects: string[]): void;
  readModelRequest?(entryId: string, target: TraceModelRequestTarget): Promise<unknown>;
  hostTurn?(entryId: string, input: Record<string, unknown>): Promise<unknown>;
  retryWebApps?(): Promise<void>;
  onWebAppError?(callback: (reason: WebAppFailureReason) => void): { dispose(): void };
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
  registerProject?(directory: string, signal: AbortSignal): Promise<string>;
  installDependencies?(directory: string, signal: AbortSignal, log: (message: string) => void): Promise<void>;
  hasProjectDependencies?(directory: string): Promise<boolean>;
  prepareProjectTemplate?(directory: string, signal: AbortSignal): Promise<boolean>;
  prepareDistribution?(project: Project, snapshot: boolean, signal: AbortSignal, progress: (message: string) => void): Promise<{ directory: string; mode: 'source' | 'release'; entries?: string[] }>;
  uploadProject?(project: Project, releaseLog: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void): Promise<void>;
  downloadProject?(projectId: string, version: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void): Promise<DownloadedServerProject[]>;
  upgradeProject?(project: Project, version: string, signal: AbortSignal, progress: (value: ProjectTransferProgress) => void,
    beforeReplace: () => Promise<void>, afterReplace: (projects: DownloadedServerProject[]) => Promise<void>): Promise<UpdatedServerProject>;
  nodeRuntime?(): Promise<{ nodePath: string; env: Record<string, string | null | undefined>; electron: boolean }>;
  analyzeProjectType?(sources: Array<{ name: string; text: string }>): Promise<ProjectType | undefined>;
  inspect(paths: string[], options?: { validationDetails?: boolean; signal?: AbortSignal }): Promise<{ projects: Omit<Project, 'uri'>[]; errors: string[] }>;
  readSidebarEntries?(directory: string): Promise<SidebarProjectEntry[]>;
  readLibraryActivity?(projects: unknown): Promise<string[]>;
  readProjectUsage?(input: unknown): Promise<ProjectUsageSnapshot | undefined> | undefined;
  openHostedSidebar?: OpenHostedSidebar;
  inspectAssistant(target: AssistantWorkspaceFolder, folders: AssistantWorkspaceFolder[]): Promise<{ projects: Omit<Project, 'uri'>[]; errors: string[] }>;
  localAssistantDirectory?(): Promise<string>;
  inspectAnalysis?(): Promise<Project>;
  updateAnalysisProjects?(projects: Project[]): void;
  start(project: Project, surface: 'editor' | 'assistant', signal?: AbortSignal, options?: { resourceProjects?: string[]; embedded?: boolean }): Promise<WebSession>;
  startLegacyLocalFrame?(origin: URL): Promise<{ port: number; dispose(): void }>;
  cliEntry(projectDir: string): Promise<string>;
  dispose(): void;
}
