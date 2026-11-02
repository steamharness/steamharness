import { randomBytes, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { StorageRequestError } from "@earendil-works/pi-durable";
import type { AgentStorageFactory } from "../agent/storage";
import {
  RuntimeStorageError, type AgentStorage, type RuntimeWorkspaceInput, type RuntimeWorkspace,
  type RuntimeStorageLease, type RuntimeStorageOperation, type RuntimeStorageErrorCode,
  type AgentStorageWrite, type Seq, type Id, type ConversationId, type ConversationQuery,
  type EntryId, type EntryQuery, type TaskId, type TaskQuery, type SubmissionId, type SubmissionQuery,
  type DocumentId, type DocumentAddress, type DocumentPoint, type DocumentQuery, type Cursor,
} from "./contract";

export interface ServerAgentStorageOptions {
  serverUrl: string;
  token: string | (() => string | Promise<string>);
  workspace: RuntimeWorkspaceInput | { id: string };
  sessionKey: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
}

/** Explicit opt-in backend; the default conversation storage changes in a later phase. */
export function createServerAgentStorage(options: ServerAgentStorageOptions): AgentStorageFactory {
  return {
    label: "SteamHarness PostgreSQL",
    async open() {
      const storage = await ServerAgentStorage.open(options);
      return { storage, release: () => storage.close() };
    },
  };
}

export class ServerAgentStorage implements AgentStorage {
  private readonly pending = new Set<Promise<unknown>>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private renewing = false;
  private failure?: Error;
  private closing?: Promise<void>;
  private closed = false;

  private constructor(
    private readonly options: ServerAgentStorageOptions,
    readonly workspace: RuntimeWorkspace,
    readonly lease: RuntimeStorageLease,
    private readonly ownerToken: string,
  ) {}

  static async open(options: ServerAgentStorageOptions): Promise<ServerAgentStorage> {
    const url = new URL(options.serverUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Runtime storage requires an HTTP Server URL without credentials, query or fragment.");
    }
    const workspace = "id" in options.workspace
      ? await request<RuntimeWorkspace>(options, `/workspaces/${encodeURIComponent(options.workspace.id)}`)
      : await request<RuntimeWorkspace>(options, "/workspaces", options.workspace);
    const ownerToken = randomBytes(32).toString("base64url");
    const lease = await request<RuntimeStorageLease>(options, `/workspaces/${workspace.id}/sessions/open`, {
      sessionKey: options.sessionKey, ownerToken,
    });
    const storage = new ServerAgentStorage(options, workspace, lease, ownerToken);
    storage.heartbeat = setInterval(() => {
      if (storage.closed || storage.renewing || storage.failure) return;
      storage.renewing = true;
      void storage.operation<RuntimeStorageLease>({ kind: "renew" }).then(
        renewed => Object.assign(storage.lease, renewed),
        error => { storage.failure = error instanceof Error ? error : new Error("Runtime storage lease renewal failed."); },
      ).finally(() => { storage.renewing = false; });
    }, Math.max(250, Math.floor(lease.durationMs / 3)));
    storage.heartbeat.unref();
    return storage;
  }

  private operation<T>(operation: RuntimeStorageOperation, context?: Context): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ServerAgentStorage is closed"));
    if (this.failure) return Promise.reject(this.failure);
    const promise = request<T>(this.options, `/sessions/${this.lease.sessionId}/operations`, {
      ownerToken: this.ownerToken, fence: this.lease.fence, operation,
    }, context?.abortSignal);
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  commit(writes: readonly AgentStorageWrite[], context: Context): Promise<Seq> {
    return this.operation({ kind: "commit", requestId: randomUUID(), writes }, context);
  }
  mintId<I extends Id<string>>(): Promise<I> { return this.operation({ kind: "mintId", requestId: randomUUID() }); }
  conversation(id: ConversationId, context: Context): ReturnType<AgentStorage["conversation"]> {
    return this.operation({ kind: "conversation", id }, context);
  }
  scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context): ReturnType<AgentStorage["scanConversations"]> {
    return this.operation({ kind: "conversations", query, limit, cursor }, context);
  }
  entry(id: EntryId, context: Context): ReturnType<AgentStorage["entry"]>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<AgentStorage["entry"]>;
  entry(first: EntryId | ConversationId, second: EntryId | Context, third?: Context): ReturnType<AgentStorage["entry"]> {
    return this.operation({ kind: "entry", id: third ? second as EntryId : first, ...(third ? { conversationId: first } : {}) }, third ?? second as Context);
  }
  findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, context: Context): ReturnType<AgentStorage["findLatestHeadMarker"]> {
    return this.operation({ kind: "head", conversationId, atOrBeforeEntryId }, context);
  }
  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context): ReturnType<AgentStorage["scanEntries"]> {
    return this.operation({ kind: "entries", query, limit, cursor }, context);
  }
  task(id: TaskId, context: Context): ReturnType<AgentStorage["task"]> { return this.operation({ kind: "task", id }, context); }
  scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context): ReturnType<AgentStorage["scanTasks"]> {
    return this.operation({ kind: "tasks", query, limit, cursor }, context);
  }
  submission(id: SubmissionId, context: Context): ReturnType<AgentStorage["submission"]> { return this.operation({ kind: "submission", id }, context); }
  scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, context: Context): ReturnType<AgentStorage["scanSubmissions"]> {
    return this.operation({ kind: "submissions", query, limit, cursor }, context);
  }
  submissionByRequest(conversationId: ConversationId, requestId: string, context: Context): ReturnType<AgentStorage["submissionByRequest"]> {
    return this.operation({ kind: "submissionByRequest", conversationId, requestId }, context);
  }
  findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): ReturnType<AgentStorage["findDocument"]> {
    return this.operation({ kind: "findDocument", address, at }, context);
  }
  document(id: DocumentId, at: DocumentPoint, context: Context): ReturnType<AgentStorage["document"]> {
    return this.operation({ kind: "document", id, at }, context);
  }
  scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context): ReturnType<AgentStorage["scanDocuments"]> {
    return this.operation({ kind: "documents", query, limit, cursor }, context);
  }
  close(_context?: Context): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.closing = (async () => {
      await Promise.allSettled([...this.pending]);
      try {
        await request(this.options, `/sessions/${this.lease.sessionId}/operations`, {
          ownerToken: this.ownerToken, fence: this.lease.fence, operation: { kind: "release" },
        });
      } catch (error) {
        // A lost or already released lease needs no cleanup. Connectivity errors
        // remain visible; expiry is the final backstop for an unreachable Server.
        if (!(error instanceof RuntimeStorageError) || error.code !== "RUNTIME_STORAGE_LEASE_LOST") throw error;
      }
    })();
    return this.closing;
  }
}

async function request<T>(options: ServerAgentStorageOptions, endpoint: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const base = options.serverUrl.replace(/\/$/, "");
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const token = typeof options.token === "function" ? await options.token() : options.token;
      const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? 10_000);
      const response = await (options.fetch ?? fetch)(`${base}/api/runtime-storage${endpoint}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: serialized, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if ([502, 503, 504, 429].includes(response.status)) {
        await response.body?.cancel();
        throw new RuntimeStorageError("RUNTIME_STORAGE_UNAVAILABLE", "Runtime storage is temporarily unavailable.");
      }
      const payload = await response.json() as { errCode: number; errMessage: string; data?: { code?: RuntimeStorageErrorCode } };
      if (!response.ok || payload.errCode !== 0) {
        if (payload.data?.code === "RUNTIME_STORAGE_INVALID_REQUEST") throw new StorageRequestError(payload.errMessage);
        const code = payload.data?.code ?? ([401, 403].includes(response.status) ? "RUNTIME_STORAGE_ACCESS_DENIED"
          : response.status === 404 ? "RUNTIME_STORAGE_NOT_FOUND" : response.status === 400 ? "RUNTIME_STORAGE_INVALID_REQUEST" : "RUNTIME_STORAGE_UNAVAILABLE");
        throw new RuntimeStorageError(code, payload.errMessage || "Runtime storage request failed.");
      }
      return (payload.data === null ? undefined : payload.data) as T;
    } catch (error) {
      signal?.throwIfAborted();
      const retryable = error instanceof TypeError || error instanceof SyntaxError || error instanceof DOMException && error.name === "TimeoutError"
        || error instanceof RuntimeStorageError && error.code === "RUNTIME_STORAGE_UNAVAILABLE";
      if (!retryable || attempt >= 2) throw error;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, (options.retryDelayMs ?? 100) * (attempt + 1));
        function done() { signal?.removeEventListener("abort", aborted); resolve(); }
        function aborted() { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(signal?.reason); }
        signal?.addEventListener("abort", aborted, { once: true });
      });
    }
  }
}
