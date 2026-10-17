export type PermissionMode = "acceptEdits" | "dontAsk" | "bypassPermissions" | "default";

export interface ClaudeAgentInput {
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  permissionMode?: PermissionMode;
  workdir?: string;
  model?: string;
  knowledgeTools?: boolean;
}

export interface ClaudeAgentParsedInput {
  prompt: string;
  systemPrompt?: string;
  tools: string[];
  allowedTools: string[];
  permissionMode: PermissionMode;
  workdir: string;
  model?: string;
  knowledgeTools: boolean;
}

export interface ClaudeAgentSessionInput extends ClaudeAgentParsedInput {
  sessionId: string;
  isResume: boolean;
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

export interface ClaudeAgentOutputPayload extends WorkflowOutputPayload {
  prompt: string;
  toolCallCount: number;
  resultSubtype?: string;
}

export type ClaudeAgentOutput = WorkflowExecutorResult<ClaudeAgentOutputPayload>;
