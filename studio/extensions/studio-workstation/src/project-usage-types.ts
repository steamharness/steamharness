export type {
  UsagePart, UsageState, UsageSize, DirectoryUsage, ConversationUsage, MemoryUsage, WorkflowUsage,
  KanbanUsage, EntryUsage, RuntimeUsage, ProjectUsageSnapshot,
} from '@steamharness/project-info/local-usage';

/** Resolved by the trusted enhanced host, not from the renderer or workspace file. */
export interface ManagedUsageTarget {
  instanceId: string;
  directory: string;
  projectId: string;
  entryId: string;
  projectDirectory?: string;
  name: string;
}
