export interface ConversationKnowledgeInput {
  message: string;
  title?: string;
  dryRun: boolean;
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

export interface ConversationKnowledgeOutputPayload extends WorkflowOutputPayload {
  conversationId?: string;
  documentId: string;
  documentTitle: string;
  messageCount: number;
  conversationMessages: number;
  knowledgeWritten: boolean;
  dryRun: boolean;
}

export type ConversationKnowledgeOutput = WorkflowExecutorResult<ConversationKnowledgeOutputPayload>;
