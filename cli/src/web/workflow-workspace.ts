import type {
  ConversationSession, Attachment, InputRequest, OutputItem, ParamState,
  ParamValues, Report, ResolvedInput, TimerRecord, ToolPolicies,
} from './workflow-types';

export type RunStatus = 'running' | 'waiting_for_input' | 'success' | 'failed' | 'aborted' | 'timed_out' | 'interrupted';
export interface Draft {
  scopeId: string;
  values: ParamValues;
  rawArgs: string;
  inputMode: 'form' | 'raw';
  policies: ToolPolicies;
}
export interface RunRecord {
  id: string;
  scopeId: string;
  entrypointId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: RunStatus;
  args: string[];
  params: ParamValues;
  policies: ToolPolicies;
  items: OutputItem[];
  events: Record<string, unknown>[];
  files: Attachment[];
  nodes: Record<string, unknown>[];
  logs: string;
  pendingInput?: InputRequest;
  resolvedInputs: ResolvedInput[];
  submittingInput?: ResolvedInput;
  report?: Report;
  error?: string;
  durationMs?: number;
  tokenUsage?: Report['tokenUsage'];
  timers?: TimerRecord[];
  migratedFrom?: { sessionId: string; messageId?: string };
}
export interface WorkspaceContract {
  version: 1;
  runs: RunRecord[];
  drafts: Record<string, Draft>;
  selectedId?: string;
  occupiedId?: string;
  migratedConversations?: boolean;
}
export interface StartInput {
  entrypointId?: string;
  params: ParamValues;
  states?: Record<string, ParamState>;
  rawArgs?: string;
  inputMode?: 'form' | 'raw';
}

export function parseProjectArgs(text: string): string[] {
  const value: unknown = JSON.parse(text || '[]');
  if (!Array.isArray(value) || !value.every(arg => typeof arg === 'string')) { throw new Error('Run arguments must be a JSON string array.'); }
  return value;
}

export function migrateProjectHistory(sessions: ConversationSession[], activeId?: string): WorkspaceContract {
  const workspace: WorkspaceContract = { version: 1, runs: [], drafts: {}, migratedConversations: true };
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
        status: (message.status ?? report?.status ?? 'success') as RunStatus,
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
export function projectStorageReferences(value: unknown): { files: Set<string>; scopes: Set<string> } {
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
