import type { Context, JsonValue } from "@earendil-works/chord";
import type { ConversationQuery, DocumentAddress, DocumentPoint, DocumentQuery, EntryQuery, StorageWrite, SubmissionQuery, TaskQuery, Cursor } from "@earendil-works/pi-durable";

// The persistence service uses the same versioned record contract as the bundled
// Agent runtime. Project definitions and executable handlers never cross it.
export type { Context as AgentStorageContext, JsonValue as AgentStorageJson };
export type {
  Storage as AgentStorage, StorageWrite as AgentStorageWrite, ConversationRecord,
  ConversationId, ConversationQuery, EntryRecord, EntryId, EntryQuery,
  TaskRecord, TaskId, TaskQuery, SubmissionRecord, SubmissionId, SubmissionQuery,
  DocumentRecord, DocumentCreate, DocumentContent, DocumentCopySource, DocumentId,
  DocumentAddress, DocumentPoint, DocumentQuery, StoredDocument, JsonObject,
  Cursor, Id, Seq, Page, ScanOrder,
} from "@earendil-works/pi-durable";

export type RuntimeWorkspaceInput = {
  kind: "project";
  projectId: string;
  entryId: string;
} | {
  kind: "local" | "assistant";
  projectId: string;
  entryId: string;
  /** Stable host-owned identity for this local folder, not a project authority. */
  localKey: string;
};

export interface RuntimeWorkspace {
  id: string;
  kind: RuntimeWorkspaceInput["kind"];
  projectId: string;
  entryId: string;
  localKey?: string;
}

export interface RuntimeStorageLease {
  sessionId: string;
  fence: number;
  expiresAt: string;
  durationMs: number;
}

export interface RuntimeStorageCredentials {
  ownerToken: string;
  fence: number;
}

export type RuntimeStorageOperation =
  | { kind: "commit"; requestId: string; writes: readonly StorageWrite[] }
  | { kind: "mintId"; requestId: string }
  | { kind: "renew" }
  | { kind: "release" }
  | { kind: "conversation" | "task" | "submission"; id: number }
  | { kind: "entry"; id: number; conversationId?: number }
  | { kind: "head"; conversationId: number; atOrBeforeEntryId?: number }
  | { kind: "conversations"; query: ConversationQuery; limit: number; cursor?: Cursor }
  | { kind: "entries"; query: EntryQuery; limit: number; cursor?: Cursor }
  | { kind: "tasks"; query: TaskQuery; limit: number; cursor?: Cursor }
  | { kind: "submissions"; query: SubmissionQuery; limit: number; cursor?: Cursor }
  | { kind: "submissionByRequest"; conversationId: number; requestId: string }
  | { kind: "findDocument"; address: DocumentAddress; at: DocumentPoint }
  | { kind: "document"; id: number; at: DocumentPoint }
  | { kind: "documents"; query: DocumentQuery; limit: number; cursor?: Cursor };

export type RuntimeStorageErrorCode = "RUNTIME_STORAGE_INVALID_REQUEST" | "RUNTIME_STORAGE_NOT_FOUND" | "RUNTIME_STORAGE_ACCESS_DENIED"
  | "RUNTIME_STORAGE_OWNER_CONFLICT" | "RUNTIME_STORAGE_LEASE_LOST"
  | "RUNTIME_STORAGE_IDEMPOTENCY_CONFLICT" | "RUNTIME_STORAGE_UNAVAILABLE";

export class RuntimeStorageError extends Error {
  constructor(readonly code: RuntimeStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeStorageError";
  }
}
