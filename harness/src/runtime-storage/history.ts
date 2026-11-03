import { randomBytes, randomUUID } from "node:crypto";
import type { AgentStorageFactory } from "../agent/storage";
import type { TokenUsageEntry } from "../token-usage";
import { RuntimeStorageError, type AgentSessionSnapshot, type RuntimeHistoryKind, type RuntimeHistoryRecord, type RuntimeWorkspace, type RuntimeWorkspaceInput } from "./contract";
import { ServerAgentStorage, runtimeStorageRequest, type ServerAgentStorageOptions } from "./server";

export interface RuntimeHistoryLease {
  assertOwned(): void;
  write(record: RuntimeHistoryRecord): Promise<RuntimeHistoryRecord>;
  delete(record: Pick<RuntimeHistoryRecord, "kind" | "key" | "scope" | "revision">): Promise<void>;
  usage(entry: TokenUsageEntry): Promise<void>;
  close(): Promise<void>;
}
export interface RuntimePersistence {
  list(kind: RuntimeHistoryKind): Promise<RuntimeHistoryRecord[]>;
  acquire(scope: string, onLost?: (error: Error) => void): Promise<RuntimeHistoryLease>;
  agentStorage(conversationId: string, sessionKey: string): AgentStorageFactory;
  agentSessions(conversationId: string): Promise<string[]>;
  exportSession(sessionKey: string): Promise<AgentSessionSnapshot>;
  importSession(sessionKey: string, snapshot: AgentSessionSnapshot): Promise<void>;
  deleteSession(sessionKey: string): Promise<void>;
  close(): Promise<void>;
}
export interface ServerRuntimePersistenceOptions extends Omit<ServerAgentStorageOptions, "sessionKey" | "workspace"> {
  workspace: RuntimeWorkspaceInput | { id: string };
  /** Resolve unpublished local projects to registered project identity when authorized. */
  resolveProject?: boolean;
}

export function agentRuntimeSessionKey(conversationId: string, sessionKey: string): string {
  return `agent:${encodeURIComponent(conversationId)}:${encodeURIComponent(sessionKey)}`;
}

export function createServerRuntimePersistence(options: ServerRuntimePersistenceOptions): RuntimePersistence {
  options = { ...options, ownerToken: randomBytes(32).toString("base64url") };
  let workspace: Promise<RuntimeWorkspace> | undefined;
  const leases = new Set<RuntimeHistoryLease>();
  const activeScopes = new Set<string>();
  const resolve = () => workspace ??= ("id" in options.workspace
    ? runtimeStorageRequest<RuntimeWorkspace>(options, `/workspaces/${encodeURIComponent(options.workspace.id)}`)
    : runtimeStorageRequest<RuntimeWorkspace>(options, options.resolveProject ? "/workspaces/resolve" : "/workspaces", options.workspace))
    .catch(error => { workspace = undefined; throw error; });
  return {
    async list(kind) {
      return runtimeStorageRequest(options, `/workspaces/${(await resolve()).id}/history/${kind}`);
    },
    async acquire(scope, onLost) {
      if (activeScopes.has(scope)) throw new RuntimeStorageError("RUNTIME_STORAGE_OWNER_CONFLICT", "This scope already has an execution owner.");
      activeScopes.add(scope);
      let storage: ServerAgentStorage;
      try { storage = await ServerAgentStorage.open({ ...options, onLeaseLost: onLost ?? options.onLeaseLost, workspace: { id: (await resolve()).id }, sessionKey: `host:${scope}` }); }
      catch (error) { activeScopes.delete(scope); throw error; }
      let closing: Promise<void> | undefined;
      const lease: RuntimeHistoryLease = {
        assertOwned: () => storage.assertOwned(),
        write: record => storage.operation({ kind: "history.write", requestId: randomUUID(), record }),
        delete: ({ kind, key, scope, revision }) => storage.operation({ kind: "history.delete", requestId: randomUUID(), record: { kind, key, scope, revision } }),
        usage: entry => storage.operation({ kind: "usage", requestId: randomUUID(), entry }),
        close() {
          return closing ??= storage.close().finally(() => { leases.delete(lease); activeScopes.delete(scope); });
        },
      };
      leases.add(lease);
      return lease;
    },
    agentStorage(conversationId, sessionKey) {
      return { label: "SteamHarness PostgreSQL", async open() {
        const storage = await ServerAgentStorage.open({ ...options, ownerToken: undefined, workspace: { id: (await resolve()).id }, sessionKey: agentRuntimeSessionKey(conversationId, sessionKey) });
        return { storage, failure: storage.failureSignal, release: () => storage.close() };
      } };
    },
    async agentSessions(conversationId) {
      return runtimeStorageRequest(options, `/workspaces/${(await resolve()).id}/agent-sessions?prefix=${encodeURIComponent(`agent:${encodeURIComponent(conversationId)}:`)}`);
    },
    async exportSession(sessionKey) {
      return runtimeStorageRequest(options, `/workspaces/${(await resolve()).id}/snapshot?sessionKey=${encodeURIComponent(sessionKey)}`);
    },
    async importSession(sessionKey, snapshot) {
      const storage = await ServerAgentStorage.open({ ...options, ownerToken: undefined, workspace: { id: (await resolve()).id }, sessionKey });
      try { await storage.operation({ kind: "snapshot.import", requestId: randomUUID(), snapshot }); }
      finally { await storage.close(); }
    },
    async deleteSession(sessionKey) {
      const storage = await ServerAgentStorage.open({ ...options, ownerToken: undefined, workspace: { id: (await resolve()).id }, sessionKey });
      try { await storage.operation({ kind: "session.delete", requestId: randomUUID() }); }
      finally { await storage.close(); }
    },
    async close() { await Promise.all([...leases].map(lease => lease.close())); },
  };
}

export function emptyRuntimeRecord(kind: RuntimeHistoryKind, key: string, scope = key): RuntimeHistoryRecord {
  return { kind, key, scope, revision: 0, state: {}, messages: [], queue: [], events: [], values: [] };
}
