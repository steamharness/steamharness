export interface RunPayload {
  errCode: number;
  errMessage: string;
}

export type OutputContentType = "markdown" | "text" | "json" | "audio";

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

export type PiAgentProvider = "anthropic" | "openai";

export interface PiAgentInput {
  prompt?: string;
  workdir?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  tools?: string[];
  knowledgeTools?: boolean;
  dryRun?: boolean;
}

export interface PiAgentParsedInput {
  prompt: string;
  workdir: string;
  model?: string;
  provider: PiAgentProvider;
  baseUrl?: string;
  tools: string[];
  explicitTools: boolean;
  knowledgeTools: boolean;
  dryRun: boolean;
}

export interface PiAgentRunInput extends PiAgentParsedInput {
  sessionFactory?: PiAgentSessionFactory;
  __snapshot?: PiAgentSessionSnapshot;
}

export interface PiAgentOutputPayload extends RunOutputPayload {
  prompt: string;
  workdir: string;
  model?: string;
  provider: PiAgentProvider;
  baseUrl?: string;
  dryRun: boolean;
  sessionId?: string;
  toolCount: number;
  messageCount: number;
  conversationMessages: number;
  activeTools: string[];
}

export type PiAgentOutput = ExecutorResult<PiAgentOutputPayload>;

export interface PiAgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface PiAgentSessionSnapshot {
  sessionId?: string;
  messages?: unknown[];
  activeTools?: string[];
  usage?: PiAgentUsage;
}

export type PiAgentTextEvent = {
  type: "text_delta";
  delta: string;
};

export type PiAgentToolEvent = {
  type: "tool";
  phase: "start" | "update" | "end";
  toolCallId: string;
  toolName: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
};

export type PiAgentOutputChunkEvent = {
  type: "output_chunk";
  chunk: {
    type: "output_item_start" | "output_item_delta" | "output_item_end";
    item?: OutputItem;
    itemId?: string;
    delta?: unknown;
  };
};

export type PiAgentSessionEvent = PiAgentTextEvent | PiAgentToolEvent | PiAgentOutputChunkEvent;

export interface PiAgentSessionRunner {
  prompt(prompt: string): AsyncIterable<PiAgentSessionEvent>;
  getSnapshot(): PiAgentSessionSnapshot;
  dispose(): void;
}

export interface PiAgentSessionRuntimeHooks {
  onPendingApproval?: (error: steamharness.HarnessError) => void;
}

export type PiAgentSessionFactory = (
  input: PiAgentParsedInput,
  hooks?: PiAgentSessionRuntimeHooks,
) => Promise<PiAgentSessionRunner> | PiAgentSessionRunner;
