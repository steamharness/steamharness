import type { ConversationSession, WorkflowOutputItem, WorkflowReport, WorkflowInputRequest, WorkflowResolvedInput } from './workflow-types';
import type { TraceAgentSnapshot } from './workflow-agent-types';

export interface TraceSession extends ConversationSession {
  agentOwnerId?: string; agentConversationId?: number; forkSource?: { sessionId: string; entryId: number };
}

export interface TraceRunSummary { id: string; title: string; status: string; createdAt?: number; durationMs?: number; entrypointId?: string }
export interface TraceRun extends TraceRunSummary {
  args?: string[]; params?: Record<string, unknown>; items?: WorkflowOutputItem[]; events?: Record<string, unknown>[];
  nodes?: Record<string, unknown>[]; logs?: string; report?: WorkflowReport; error?: string;
  pendingInput?: WorkflowInputRequest; resolvedInputs?: WorkflowResolvedInput[];
}
export interface TraceSnapshot {
  project: { id: string; name: string; projectType: 'conversation' | 'workflow' };
  running?: boolean; sessions?: TraceSession[]; activeId?: string;
  durable?: boolean; agents?: Record<string, TraceAgentSnapshot>;
  runs?: TraceRunSummary[]; selectedId?: string; run?: TraceRun; occupiedRun?: TraceRun;
  history?: { total: number; hasMore: boolean; query: string };
}
export interface TraceTarget { sessionId?: string; messageId?: string; runId?: string }
export interface TraceSelection extends TraceTarget { projectUri?: string }
export interface TracePanelState {
  type: 'trace-state'; generation: number;
  projects: { uri: string; name: string; version?: string; projectType: string }[];
  selection: TraceSelection; snapshot?: TraceSnapshot; run?: TraceRun; status: string; loading?: boolean; error?: string;
  pending?: boolean;
  reveal?: number;
}
