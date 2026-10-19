export interface RunPayload {
  errCode: number;
  errMessage: string;
}

export interface ExecutorResult<Output extends RunPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
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

export interface StoreDataInput extends RunPayload {
  alias?: string;
  content: string;
}

export interface GetDataInput extends RunPayload {
  alias?: string;
  id: string;
}

export interface StorageDataOutput extends RunOutputPayload {
  action: "store" | "get";
  storageLocation: "local" | "server";
  target: "current" | "related";
  alias?: string;
  id: string;
  content?: unknown;
}

export interface NoteDataInput extends RunPayload {
  alias: string;
  title: string;
  markdown: string;
}

export interface NoteDataOutput extends RunOutputPayload {
  action: "note";
  alias: string;
  documentId: string;
  relatedDocuments: number;
  content?: string;
}

export type StorageDataExecutorOutput = ExecutorResult<StorageDataOutput>;
