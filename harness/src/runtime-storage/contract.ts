import type { Context, JsonValue } from "@earendil-works/chord";
import { HarnessError } from "../workflow/errors";
import type { ConversationQuery, DocumentAddress, DocumentPoint, DocumentQuery, EntryQuery, StorageWrite, SubmissionQuery, TaskQuery, Cursor } from "@earendil-works/pi-durable";
export type { TokenUsageEntry } from "../token-usage";

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

/** Host projections are split into ordered relational child records on Server. */
export type RuntimeHistoryKind = "conversation" | "run" | "workflow" | "state";
export interface RuntimeHistoryItem { id: string; value: Record<string, unknown> }
export interface RuntimeHistoryRecord {
  kind: RuntimeHistoryKind;
  key: string;
  scope: string;
  revision: number;
  state: Record<string, unknown>;
  messages: RuntimeHistoryItem[];
  queue: RuntimeHistoryItem[];
  events: RuntimeHistoryItem[];
  values: RuntimeHistoryItem[];
}
export interface AgentSessionSnapshot {
  format: "steamharness.agent-session";
  version: 1;
  nextId: number;
  commits: { seq: number; writes: readonly StorageWrite[] }[];
}

export type RuntimeStorageOperation =
  | { kind: "session.delete"; requestId: string }
  | { kind: "history.write"; requestId: string; record: RuntimeHistoryRecord }
  | { kind: "history.delete"; requestId: string; record: Pick<RuntimeHistoryRecord, "kind" | "key" | "scope" | "revision"> }
  | { kind: "usage"; requestId: string; entry: import("../token-usage").TokenUsageEntry }
  | { kind: "snapshot.import"; requestId: string; snapshot: AgentSessionSnapshot }
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
  | "RUNTIME_STORAGE_REVISION_CONFLICT"
  | "RUNTIME_STORAGE_IDEMPOTENCY_CONFLICT" | "RUNTIME_STORAGE_UNAVAILABLE";

export class RuntimeStorageError extends HarnessError {
  constructor(readonly code: RuntimeStorageErrorCode, message: string, options?: ErrorOptions) {
    super({ type: "execution", message, cause: options?.cause, metadata: { code, ...(code === "RUNTIME_STORAGE_OWNER_CONFLICT" ? { agentFailure: "owner_conflict" } : {}) } });
    this.name = "RuntimeStorageError";
  }
}
