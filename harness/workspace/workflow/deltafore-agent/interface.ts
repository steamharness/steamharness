export interface RunPayload {
  errCode: number;
  errMessage: string;
}

export type OutputContentType = "markdown" | "text" | "json";

export interface OutputItem {
  id: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: OutputContentType;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RunOutputPayload extends RunPayload {
  items: OutputItem[];
}

export interface ExecutorResult<Output extends RunPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
}

export interface DeltaforeAgentInput {
  query: string;
  maxRounds: number;
}

export interface ParsedAgentInput extends RunPayload {
  query: string;
  maxRounds: number;
}

export interface ConversationChatMessage {
  role: "user" | "assistant";
  content: string;
  metadata?: {
    timestamp?: string;
    toolCalls?: string;
    confidence?: string;
  };
}

export interface ConversationRuntime {
  conversationId?: string;
  getValue(): Promise<{
    messages: Array<{
      role: string;
      content: string;
      metadata?: Record<string, unknown>;
    }>;
  }>;
  appendMessage(message: {
    role: "user" | "assistant";
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  setTitle(title: string): Promise<void>;
}

export interface NodeRunContext {
  conversation?: ConversationRuntime;
  metadata?: {
    deltaforeApi?: unknown;
    [key: string]: unknown;
  };
  abortSignal?: AbortSignal;
}

export type AgentToolName = string;

export interface AgentToolCall {
  toolName: AgentToolName;
  args: Record<string, unknown>;
  reason?: string;
}

export interface AgentToolResult {
  toolName: AgentToolName;
  args: Record<string, unknown>;
  ok: boolean;
  data: unknown;
  summary: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface ReactThought {
  summary: string;
  hypothesis?: string;
  evidenceGap?: string;
  nextActionReason?: string;
}

export type ReactStepStatus = "planned" | "observed" | "failed";

export interface ReactStep {
  round: number;
  thought: ReactThought;
  action?: AgentToolCall;
  observation?: string;
  toolResult?: AgentToolResult;
  status: ReactStepStatus;
}

export type ReactLoopPhase = "thinking" | "done";

export interface ReactLoopState extends RunPayload {
  phase: ReactLoopPhase;
  query: string;
  maxRounds: number;
  round: number;
  history: ConversationChatMessage[];
  steps: ReactStep[];
  compactedHistory?: CompactedHistory;
  finalAnswer?: string;
  confidence?: "low" | "medium" | "high";
  usedObjectIDs: Array<number | string>;
}

export interface AgentDecisionInput extends RunPayload {
  query: string;
  maxRounds: number;
  round: number;
  history: ConversationChatMessage[];
  steps: ReactStep[];
  compactedHistory?: CompactedHistory;
}

export interface ReactThoughtPayload extends RunPayload {
  phase: "action" | "final_answer";
  rawText: string;
  thought: ReactThought;
  action?: AgentToolCall;
  finalAnswer?: string;
  confidence?: "low" | "medium" | "high";
  usedObjectIDs?: Array<number | string>;
}

export interface ToolExecutionInput extends RunPayload {
  round: number;
  toolCall: AgentToolCall;
}

export interface ToolExecutionPayload extends RunOutputPayload {
  result: AgentToolResult;
  phase: "tool";
  round: number;
  toolName: AgentToolName;
  ok: boolean;
}

export interface ThoughtOutputInput extends RunPayload {
  round: number;
  thought: ReactThought;
  action?: AgentToolCall;
}

export interface ThoughtOutputPayload extends RunOutputPayload {
  round: number;
}

export interface FinalAnswerInput extends RunPayload {
  query: string;
  maxRounds: number;
  rounds: number;
  content: string;
  success: boolean;
  history: ConversationChatMessage[];
  confidence?: "low" | "medium" | "high";
  usedObjectIDs: Array<number | string>;
  toolResults: AgentToolResult[];
}

export interface DeltaforeAgentOutputPayload extends RunOutputPayload {
  success: boolean;
  query: string;
  rounds: number;
  toolCallCount: number;
  conversationId?: string;
  historyLength: number;
  confidence?: "low" | "medium" | "high";
  usedObjectIDs: Array<number | string>;
}

export type DeltaforeAgentOutput = ExecutorResult<DeltaforeAgentOutputPayload>;

// Context Management Types

export interface ContextBudget {
  totalTokens: number;
  systemPromptTokens: number;
  outputTokens: number;
  availableTokens: number;
}

export interface ContextPartition {
  historyBudget: number;
  stepsBudget: number;
  queryBudget: number;
}

export interface ContextEntry {
  type: "history" | "step";
  tokens: number;
  relevanceScore: number;
  recency: number;
  value: number;
  content: string;
  summary?: string;
  compressed: boolean;
}

export interface CompactedHistory {
  summary: string;
  coveredMessageCount: number;
  lastCompactedAt: string;
  entities: string[];
  recentQueries: Array<{
    query: string;
    timestamp: string;
    toolsUsed: string[];
    keyFacts: string[];
  }>;
}

export interface ContextMetadata {
  totalRuns: number;
  lastRunAt: string;
  compactionCount: number;
}
