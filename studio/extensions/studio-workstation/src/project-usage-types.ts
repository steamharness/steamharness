export type UsagePart = 'directory' | 'runtime';
export type UsageState = 'ok' | 'partial' | 'unavailable';
export interface UsageSize { state: UsageState; bytes?: number }
export interface DirectoryUsage extends UsageSize {
  path?: string;
  files?: number;
  directories?: number;
  folders: Array<UsageSize & { name: string }>;
  omittedFolders?: number;
}
export interface ConversationUsage extends UsageSize { sessions?: number; messages?: number }
export interface MemoryUsage extends UsageSize { records?: number; location?: string; created?: boolean }
export interface WorkflowUsage extends UsageSize { runs?: number; lastRunAt?: number }
export interface KanbanUsage { state: UsageState | 'unbuilt' | 'shared' | 'hosted'; bytes?: number; location?: string }
export type EntryUsage = { entryId: string; name: string } & (
  | { type: 'bot'; conversation: ConversationUsage; memory: MemoryUsage }
  | { type: 'workflow'; workflow: WorkflowUsage }
  | { type: 'kanban'; kanban: KanbanUsage }
);
export interface RuntimeUsage {
  state: UsageState | 'not-project';
  size: UsageSize;
  location?: string;
  entries: EntryUsage[];
}
export type ProjectUsageSnapshot = { measuredAt: number } & (
  { part: 'directory'; usage: DirectoryUsage } | { part: 'runtime'; usage: RuntimeUsage }
);

/** Resolved by the trusted enhanced host, not from the renderer or workspace file. */
export interface ManagedUsageTarget {
  instanceId: string;
  directory: string;
  projectId: string;
  entryId: string;
  projectDirectory?: string;
  name: string;
}
