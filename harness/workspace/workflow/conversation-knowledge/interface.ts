export interface ConversationKnowledgeInput {
  message: string;
  title?: string;
  dryRun: boolean;
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

export interface ConversationKnowledgeOutputPayload extends RunOutputPayload {
  conversationId?: string;
  documentId: string;
  documentTitle: string;
  messageCount: number;
  conversationMessages: number;
  knowledgeWritten: boolean;
  dryRun: boolean;
}

export type ConversationKnowledgeOutput = ExecutorResult<ConversationKnowledgeOutputPayload>;
