import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { RuntimeStorageError, type AgentSessionSnapshot, type AgentStorageWrite, type Id, type RuntimeHistoryRecord, type Seq } from "./contract";
import { agentRuntimeSessionKey, type RuntimeHistoryLease, type RuntimePersistence } from "./history";

/** Explicit temporary storage for tests and disposable runs. Never a connection fallback. */
export function createMemoryRuntimePersistence(): RuntimePersistence {
  const records = new Map<string, RuntimeHistoryRecord>();
  const owned = new Set<string>(), activeAgents = new Set<string>();
  const agents = new Map<string, SnapshotMemoryStorage>();
  const deletedAgents = new Set<string>();
  const usage = new Map<string, import("../token-usage").TokenUsageEntry>();
  const deleted = new Set<string>();
  return {
    async list(kind) { return structuredClone([...records.values()].filter(record => record.kind === kind && !deleted.has(`${record.kind}:${record.key}`))); },
    async acquire(scope) {
      if (owned.has(scope)) throw new RuntimeStorageError("RUNTIME_STORAGE_OWNER_CONFLICT", "This session already has an execution owner.");
      owned.add(scope);
      let closed = false;
      const assertOwned = () => { if (closed) throw new RuntimeStorageError("RUNTIME_STORAGE_LEASE_LOST", "The temporary lease is closed."); };
      const lease: RuntimeHistoryLease = {
        assertOwned,
        async write(record) {
          assertOwned();
          if (record.scope !== scope) throw new Error("History scope mismatch.");
          const key = `${record.kind}:${record.key}`, previous = records.get(key);
          if ((previous?.revision ?? 0) !== record.revision) throw new RuntimeStorageError("RUNTIME_STORAGE_REVISION_CONFLICT", "History revision changed.");
          const next = structuredClone({ ...record, revision: record.revision + 1 }); records.set(key, next); deleted.delete(key); return structuredClone(next);
        },
        async delete(record) {
          assertOwned(); const key = `${record.kind}:${record.key}`, previous = records.get(key);
          if (record.scope !== scope || previous?.revision !== record.revision) throw new RuntimeStorageError("RUNTIME_STORAGE_REVISION_CONFLICT", "History revision changed.");
          records.set(key, { ...previous, revision: previous.revision + 1 }); deleted.add(key);
        },
        async usage(entry) {
          assertOwned();
          if (scope !== `core:${entry.conversationId ?? entry.runId}`) throw new RuntimeStorageError("RUNTIME_STORAGE_ACCESS_DENIED", "Usage requires its run or conversation lease.");
          const previous = usage.get(entry.id);
          if (previous && (previous.runId !== entry.runId || previous.conversationId !== entry.conversationId)) throw new RuntimeStorageError("RUNTIME_STORAGE_IDEMPOTENCY_CONFLICT", "The usage receipt already belongs to another run or conversation.");
          usage.set(entry.id, structuredClone(entry));
        },
        async close() { if (!closed) { closed = true; owned.delete(scope); } },
      };
      return lease;
    },
    agentStorage(conversationId, sessionKey) {
      const key = agentRuntimeSessionKey(conversationId, sessionKey);
      return { label: "SteamHarness temporary memory", async open() {
        if (deletedAgents.has(key)) throw new RuntimeStorageError("RUNTIME_STORAGE_NOT_FOUND", "Agent session was deleted.");
        if (activeAgents.has(key)) throw new RuntimeStorageError("RUNTIME_STORAGE_OWNER_CONFLICT", "This agent already has an execution owner.");
        activeAgents.add(key);
        let storage = agents.get(key);
        if (!storage) { storage = new SnapshotMemoryStorage(); agents.set(key, storage); }
        let released = false;
        return { storage, release() { if (!released) { released = true; activeAgents.delete(key); } } };
      } };
    },
    async agentSessions(conversationId) { return [...agents.keys()].filter(key => key.startsWith(`agent:${encodeURIComponent(conversationId)}:`)); },
    async exportSession(key) { const storage = agents.get(key); if (!storage) throw new RuntimeStorageError("RUNTIME_STORAGE_NOT_FOUND", "Agent session does not exist."); return storage.snapshot(); },
    async importSession(key, snapshot) {
      if (agents.has(key) || deletedAgents.has(key)) throw new RuntimeStorageError("RUNTIME_STORAGE_REVISION_CONFLICT", "Agent session already exists.");
      agents.set(key, new SnapshotMemoryStorage(snapshot));
    },
    async deleteSession(key) { if (activeAgents.has(key)) throw new RuntimeStorageError("RUNTIME_STORAGE_OWNER_CONFLICT", "Agent session has an execution owner."); agents.delete(key); deletedAgents.add(key); },
    async close() { owned.clear(); activeAgents.clear(); },
  };
}

/** Detached committed state, safe to inspect without starting a Harness scheduler. */
export class SnapshotMemoryStorage extends MemoryStorage {
  private commits: AgentSessionSnapshot["commits"] = [];
  private watermark = 2;
  constructor(snapshot?: AgentSessionSnapshot) {
    super();
    if (snapshot) {
      if (snapshot.format !== "steamharness.agent-session" || snapshot.version !== 1) throw new Error("Unsupported agent session snapshot.");
      for (const commit of snapshot.commits) {
        if (commit.seq !== this.commits.length + 1) throw new Error("Snapshot commits must be contiguous.");
        this.prepareCommit(commit.writes, commit.seq as Seq).apply();
        this.record(commit.writes, commit.seq);
      }
      if (!Number.isSafeInteger(snapshot.nextId) || snapshot.nextId < this.watermark) throw new Error("Invalid snapshot ID watermark.");
      this.watermark = snapshot.nextId;
    }
  }
  override async commit(writes: readonly AgentStorageWrite[], context: Context): Promise<Seq> {
    const prepared = this.prepareCommit(writes);
    const seq = prepared.apply();
    this.record(prepared.writes, seq);
    return seq;
  }
  private record(writes: readonly AgentStorageWrite[], seq: number) {
    this.commits.push(structuredClone({ seq, writes }));
    for (const write of writes) {
      const id = "record" in write ? write.record.id : "value" in write ? write.value.id : write.id;
      this.watermark = Math.max(this.watermark, id + 1);
    }
  }
  override async mintId<I extends Id<string>>(): Promise<I> { return this.watermark++ as I; }
  override async close(): Promise<void> { /* The explicit temporary repository owns its lifetime. */ }
  snapshot(): AgentSessionSnapshot { return structuredClone({ format: "steamharness.agent-session", version: 1, nextId: this.watermark, commits: this.commits }); }
}
