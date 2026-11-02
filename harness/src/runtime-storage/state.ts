import { createHash } from "node:crypto";
import type { ConversationState, ConversationStateStorage } from "../conversation";
import { databaseConnectionFromEnv } from "../databases/remote";
import type { TokenUsageEntry } from "../token-usage";
import { RuntimeStorageError, type RuntimeHistoryRecord, type RuntimeWorkspaceInput } from "./contract";
import { createServerRuntimePersistence, emptyRuntimeRecord, type RuntimeHistoryLease, type RuntimePersistence } from "./history";

export function createRuntimeStateStorage(options: {
  projectId: string; entryId: string; rootDir: string; runId: string; conversationId?: string;
  env?: NodeJS.ProcessEnv; persistence?: RuntimePersistence; workspace?: RuntimeWorkspaceInput;
}): { persistence: RuntimePersistence; failure: AbortSignal; conversation: ConversationStateStorage; usage(entry: TokenUsageEntry): Promise<void>; close(): Promise<void> } {
  const failed = new AbortController();
  let backend = options.persistence;
  const resolve = () => {
    if (backend) return backend;
    const connection = databaseConnectionFromEnv(options.env);
    if (!connection) throw new RuntimeStorageError("RUNTIME_STORAGE_ACCESS_DENIED", "Sign in to SteamHarness Server to persist conversations and execution history.");
    return backend = createServerRuntimePersistence({ ...connection, resolveProject: true, workspace: options.workspace ?? {
      kind: "local", projectId: options.projectId, entryId: options.entryId,
      localKey: createHash("sha256").update(options.rootDir).digest("hex"),
    } });
  };
  const persistence: RuntimePersistence = {
    list: kind => resolve().list(kind), acquire: (scope, onLost) => resolve().acquire(scope, onLost),
    agentStorage: (conversationId, sessionKey) => ({ label: "SteamHarness PostgreSQL", open: () => resolve().agentStorage(conversationId, sessionKey).open() }),
    agentSessions: id => resolve().agentSessions(id), exportSession: key => resolve().exportSession(key),
    importSession: (key, snapshot) => resolve().importSession(key, snapshot), close: async () => { if (!options.persistence) await backend?.close(); },
    deleteSession: key => resolve().deleteSession(key),
  };
  const scope = `core:${options.conversationId ?? options.runId}`;
  let lease: Promise<RuntimeHistoryLease> | undefined;
  let record: RuntimeHistoryRecord | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const acquire = () => lease ??= persistence.acquire(scope, error => failed.abort(error)).catch(error => { lease = undefined; throw error; });
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation); pending = result.catch(() => undefined); return result;
  };
  const load = async (initial: ConversationState): Promise<ConversationState> => {
    (await acquire()).assertOwned();
    record ??= (await persistence.list("state")).find(item => item.key === initial.conversationId) ?? emptyRuntimeRecord("state", initial.conversationId, scope);
    return record.revision === 0 ? structuredClone(initial) : {
      ...record.state, messages: record.messages.map(item => item.value), values: Object.fromEntries(record.values.map(item => [item.id, item.value.value])),
    } as unknown as ConversationState;
  };
  return {
    persistence,
    failure: failed.signal,
    conversation: {
      read: initial => enqueue(() => load(initial)),
      update: (initial, change) => enqueue(async () => {
        const next = change(await load(initial));
        const { messages, values, ...state } = next;
        record = await (await acquire()).write(JSON.parse(JSON.stringify({ ...record!, state,
          messages: messages.map(message => ({ id: message.id, value: message })),
          values: Object.entries(values).map(([id, value]) => ({ id, value: { value } })),
        })));
        return structuredClone(next);
      }),
    },
    usage: entry => enqueue(async () => { await (await acquire()).usage(entry); }),
    async close() {
      await pending;
      if (lease) await (await lease).close();
      await persistence.close();
    },
  };
}
