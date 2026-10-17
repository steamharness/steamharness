import type {
  ConversationSession, WorkflowAttachment, WorkflowInputRequest, WorkflowOutputItem, WorkflowParamState,
  WorkflowParamValues, WorkflowReport, WorkflowResolvedInput, WorkflowTimerRecord, WorkflowToolPolicies,
} from './workflow-types';

export type WorkflowRunStatus = 'running' | 'waiting_for_input' | 'success' | 'failed' | 'aborted' | 'timed_out' | 'interrupted';
export interface WorkflowDraft {
  scopeId: string;
  values: WorkflowParamValues;
  rawArgs: string;
  inputMode: 'form' | 'raw';
  policies: WorkflowToolPolicies;
}
export interface WorkflowRunRecord {
  id: string;
  scopeId: string;
  entrypointId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: WorkflowRunStatus;
  args: string[];
  params: WorkflowParamValues;
  policies: WorkflowToolPolicies;
  items: WorkflowOutputItem[];
  events: Record<string, unknown>[];
  files: WorkflowAttachment[];
  nodes: Record<string, unknown>[];
  logs: string;
  pendingInput?: WorkflowInputRequest;
  resolvedInputs: WorkflowResolvedInput[];
  submittingInput?: WorkflowResolvedInput;
  report?: WorkflowReport;
  error?: string;
  durationMs?: number;
  tokenUsage?: WorkflowReport['tokenUsage'];
  timers?: WorkflowTimerRecord[];
  migratedFrom?: { sessionId: string; messageId?: string };
}
export interface WorkflowWorkspace {
  version: 1;
  runs: WorkflowRunRecord[];
  drafts: Record<string, WorkflowDraft>;
  selectedId?: string;
  occupiedId?: string;
  migratedConversations?: boolean;
}
export interface WorkflowStartInput {
  entrypointId?: string;
  params: WorkflowParamValues;
  states?: Record<string, WorkflowParamState>;
  rawArgs?: string;
  inputMode?: 'form' | 'raw';
}

export function parseWorkflowArgs(text: string): string[] {
  const value: unknown = JSON.parse(text || '[]');
  if (!Array.isArray(value) || !value.every(arg => typeof arg === 'string')) { throw new Error('Run arguments must be a JSON string array.'); }
  return value;
}

export function migrateWorkflowHistory(sessions: ConversationSession[], activeId?: string): WorkflowWorkspace {
  const workspace: WorkflowWorkspace = { version: 1, runs: [], drafts: {}, migratedConversations: true };
  for (const session of sessions) {
    let user: ConversationSession['messages'][number] | undefined;
    for (const [index, message] of session.messages.entries()) {
      if (message.role === 'user') { user = message; continue; }
      const report = message.report;
      const createdAt = message.createdAt ?? session.createdAt ?? 0;
      workspace.runs.push({
        id: message.id ?? `legacy-${session.id}-${index}`, scopeId: session.id,
        title: session.title, entrypointId: message.entrypointId ?? user?.entrypointId,
        createdAt, updatedAt: session.updatedAt ?? createdAt,
        status: (message.status ?? report?.status ?? 'success') as WorkflowRunStatus,
        args: message.args ?? user?.args ?? [], params: user?.input?.params ?? {}, policies: session.toolPermissionPolicies ?? {},
        items: report?.output?.items ?? message.items ?? (message.content ? [{ content: message.content, contentType: 'markdown' }] : []),
        events: message.events ?? [], nodes: report?.nodes ?? [], logs: report?.logs ?? '',
        files: [...(user?.attachments ?? []), ...(message.files ?? []), ...(report?.files ?? [])],
        report, pendingInput: message.pendingInput ?? report?.pendingUserInput, resolvedInputs: message.resolvedInputs ?? report?.resolvedUserInputs ?? [],
        error: message.error, durationMs: message.durationMs, tokenUsage: message.tokenUsage, timers: message.timers,
        migratedFrom: { sessionId: session.id, messageId: message.id },
      });
      if (session.id === activeId) { workspace.selectedId = workspace.runs.at(-1)!.id; }
    }
    for (const [entrypoint, values] of Object.entries(session.parameterValues ?? {})) {
      workspace.drafts[entrypoint] = { scopeId: session.id, values, rawArgs: '[]', inputMode: 'form', policies: session.toolPermissionPolicies ?? {} };
    }
  }
  workspace.runs.sort((a, b) => b.createdAt - a.createdAt);
  return workspace;
}

// File parameters are JSON strings; include references nested in them when cleaning storage.
export function workflowStorageReferences(value: unknown): { files: Set<string>; scopes: Set<string> } {
  const files = new Set<string>(), scopes = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      for (const id of item.match(/wf_[a-f0-9]{32}/g) ?? []) { files.add(id); }
      if (/^[\[{]/.test(item.trim())) { try { visit(JSON.parse(item)); } catch { /* Plain output can start with a bracket. */ } }
    } else if (Array.isArray(item)) { item.forEach(visit); }
    else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (typeof record.scopeId === 'string') { scopes.add(record.scopeId); }
      if (typeof record.conversationId === 'string') { scopes.add(record.conversationId); }
      Object.values(record).forEach(visit);
    }
  };
  visit(value);
  return { files, scopes };
}
