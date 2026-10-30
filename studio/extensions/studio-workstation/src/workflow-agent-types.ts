// Execution DTOs carried by the CLI host bridge; no runtime dependency on Core.
export interface TracePlanItem { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }
export interface TraceAgentWork {
  taskId: number; workId: string; agentId: string; label: string; status: string; attempt: number;
  childConversationId?: number; retryOf?: number; result?: string; error?: string;
  progress?: { completed: number; total: number; phase?: string }; metadata?: Record<string, unknown>;
}
export interface TraceTask {
  id: number; conversationId: number; parentId?: number; kind: string; label: string; status: string;
  phase?: string; background: boolean; stopping: boolean; blockedOn: number[]; blockedReason?: string;
  toolName?: string; callId?: string; arguments?: unknown; replay?: 'safe' | 'never'; attempt?: number;
  childConversationId?: number;
  details?: unknown; definitionVersion?: number; checkpoint?: unknown; wakeAt?: number; script?: string;
  agent?: TraceAgentWork; progress?: { completed: number; total: number; phase?: string };
}
export interface TraceAgentContext {
  conversationId: number; foreground: boolean; backgroundCount: number; epoch: number;
  configuration: { version: number; model: string; provider: string; effort: string; cwd?: string };
  prompt: { hash: string; version: number }; plan: { version: number; items: TracePlanItem[] };
}
export interface TraceAgentSnapshot extends TraceAgentContext {
  version: 1; ownerId: string; revision: number;
  contexts: TraceAgentContext[]; tasks: TraceTask[]; history: TraceTask[];
  conversations: { id: number; parentId?: number; title: string; background: boolean; forkEntryId?: number }[];
  turns: { conversationId: number; status: string }[];
  records: { id: number; conversationId: number; kind: string; label: string; data?: unknown }[];
  usage: { conversationId: number; parentId?: number; models: Record<string, unknown>; tools: Record<string, unknown> }[];
  compactionFailure?: string;
  agents?: TraceAgentWork[];
  resources?: {
    extensions: { name: string; tools: string[]; tasks: { name: string; version: number }[] }[];
    catalogs: { id: string; state: string; tools: string[]; loaded: string[] }[];
    codeMode: boolean; storage: string;
    environment: { id: string; label: string; state: string; remote: boolean };
  };
}
export type TraceAgentCommand = { targetId?: number } & (
  | { type: 'compact'; instructions?: string }
  | { type: 'reset'; handoff?: string }
  | { type: 'plan'; expectedVersion: number; items: TracePlanItem[] }
  | { type: 'cancel'; scope: 'foreground' | 'all' | 'task'; taskId?: number }
  | { type: 'subagent'; action: 'retry'; taskId: number }
);
export type TraceAgentAction = { sessionId: string; ownerId: string; conversationId: number } & (
  | { type: 'agent'; command: TraceAgentCommand }
  | { type: 'open-conversation'; targetId: number }
  | { type: 'open-session'; targetSessionId: string }
);
