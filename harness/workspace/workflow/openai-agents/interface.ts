export interface OpenAIAgentsInput {
  message: string;
  model?: string;
  workdir?: string;
  localShell?: boolean;
  agentName?: string;
  instructions?: string | string[];
  defaultTools?: boolean;
  memoryTools?: boolean;
  knowledgeTools?: boolean;
  testTool?: boolean;
  writeConversation?: boolean;
  writeAgentState?: boolean;
  customTools?: unknown[];
  agentRunner?: OpenAIAgentsRunner;
  streamRecorder?: OpenAIAgentsStreamRecorder;
}

export interface OpenAIAgentsParsedInput extends OpenAIAgentsInput {
  message: string;
  model: string;
  workdir: string;
  localShell: boolean;
  agentName: string;
  instructions: string[];
  defaultTools: boolean;
  memoryTools: boolean;
  knowledgeTools: boolean;
  testTool: boolean;
  writeConversation: boolean;
  writeAgentState: boolean;
  customTools: unknown[];
  agentRunner?: OpenAIAgentsRunner;
  streamRecorder?: OpenAIAgentsStreamRecorder;
}

export interface OpenAIAgentsRunInput extends OpenAIAgentsParsedInput {
  conversation: ConversationSnapshot;
  runCount: number;
  facts: AgentFact[];
}

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

export interface AgentFact {
  key: string;
  value: string;
  updatedAt: string;
}

export interface ConversationMessageSnapshot {
  role: string;
  content: string;
}

export interface ConversationSnapshot {
  conversationId?: string;
  messages: ConversationMessageSnapshot[];
}

export interface AgentRunUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
}

export interface AgentToolCallSummary {
  name: string;
  status?: string;
}

export interface AgentRunDetails {
  mode: "live";
  model: string;
  workdir: string;
  baseURL?: string;
  localShell: boolean;
  lastResponseId?: string;
  toolCalls: AgentToolCallSummary[];
  usage: AgentRunUsage;
  historyLength: number;
  conversationId?: string;
  runCount: number;
  facts: AgentFact[];
}

export interface OpenAIAgentsRunnerInput {
  agent: unknown;
  message: string;
  context: unknown;
  signal?: AbortSignal;
  tools: unknown[];
}

export interface OpenAIAgentsRunnerResult {
  finalOutput?: unknown;
  outputChunks?: Iterable<string> | AsyncIterable<string>;
  lastResponseId?: string;
  newItems?: unknown[];
  history?: unknown[];
  usage?: unknown;
}

export type OpenAIAgentsRunner = (
  input: OpenAIAgentsRunnerInput,
) => Promise<OpenAIAgentsRunnerResult> | OpenAIAgentsRunnerResult;

export interface OpenAIAgentsStreamRecorder {
  onTextDelta?(delta: string): Promise<void> | void;
}

export interface OpenAIAgentsOutputPayload extends WorkflowOutputPayload {
  mode: "live";
  model: string;
  workdir: string;
  localShell: boolean;
  conversationId?: string;
  conversationMessages: number;
  runCount: number;
  facts: AgentFact[];
  historyLength: number;
  toolCalls: AgentToolCallSummary[];
}

export type OpenAIAgentsOutput = WorkflowExecutorResult<OpenAIAgentsOutputPayload>;
