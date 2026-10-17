export interface WorkflowPayload {
  errCode: number;
  errMessage: string;
}

export interface WorkflowExecutorResult<Output extends WorkflowPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
}

export type WorkflowOutputContentType = "markdown" | "text" | "json" | "audio";

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

export interface StoreDataInput extends WorkflowPayload {
  alias?: string;
  content: string;
}

export interface GetDataInput extends WorkflowPayload {
  alias?: string;
  id: string;
}

export interface StorageDataOutput extends WorkflowOutputPayload {
  action: "store" | "get";
  storageLocation: "local" | "server";
  target: "current" | "related";
  alias?: string;
  id: string;
  content?: unknown;
}

export type StorageDataExecutorOutput = WorkflowExecutorResult<StorageDataOutput>;
