export interface WorkflowPayload {
  errCode: number;
  errMessage: string;
}

export type WorkflowOutputContentType = "markdown" | "text" | "json";

export interface WorkflowOutputItem {
  id: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: WorkflowOutputContentType;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowOutputPayload extends WorkflowPayload {
  items: WorkflowOutputItem[];
}

export interface WorkflowExecutorResult<Output extends WorkflowPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
}

export interface DeltaforeAgentInput {
  query: string;
  maxRounds: number;
}

export interface ParsedAgentInput extends WorkflowPayload {
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

export interface WorkflowConversationRuntime {
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

export interface WorkflowNodeContext {
  conversation?: WorkflowConversationRuntime;
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

export interface ReactLoopState extends WorkflowPayload {
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

export interface AgentDecisionInput extends WorkflowPayload {
  query: string;
  maxRounds: number;
  round: number;
  history: ConversationChatMessage[];
  steps: ReactStep[];
  compactedHistory?: CompactedHistory;
}

export interface ReactThoughtPayload extends WorkflowPayload {
  phase: "action" | "final_answer";
  rawText: string;
  thought: ReactThought;
  action?: AgentToolCall;
  finalAnswer?: string;
  confidence?: "low" | "medium" | "high";
  usedObjectIDs?: Array<number | string>;
}

export interface ToolExecutionInput extends WorkflowPayload {
  round: number;
  toolCall: AgentToolCall;
}

export interface ToolExecutionPayload extends WorkflowOutputPayload {
  result: AgentToolResult;
  phase: "tool";
  round: number;
  toolName: AgentToolName;
  ok: boolean;
}

export interface ThoughtOutputInput extends WorkflowPayload {
  round: number;
  thought: ReactThought;
  action?: AgentToolCall;
}

export interface ThoughtOutputPayload extends WorkflowOutputPayload {
  round: number;
}

export interface FinalAnswerInput extends WorkflowPayload {
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

export interface DeltaforeAgentOutputPayload extends WorkflowOutputPayload {
  success: boolean;
  query: string;
  rounds: number;
  toolCallCount: number;
  conversationId?: string;
  historyLength: number;
  confidence?: "low" | "medium" | "high";
  usedObjectIDs: Array<number | string>;
}

export type DeltaforeAgentOutput = WorkflowExecutorResult<DeltaforeAgentOutputPayload>;

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
