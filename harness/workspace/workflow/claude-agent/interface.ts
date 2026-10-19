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

export interface ClaudeAgentOutputPayload extends RunOutputPayload {
  prompt: string;
  toolCallCount: number;
  resultSubtype?: string;
}

export type ClaudeAgentOutput = ExecutorResult<ClaudeAgentOutputPayload>;
