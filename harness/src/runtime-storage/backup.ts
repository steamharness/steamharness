import { RuntimeStorageError, type RuntimeHistoryKind } from "./contract";
import type { RuntimePersistence } from "./history";

/** Explicit snapshot copy to a new, idle destination. Hosts may run it in the background. */
export async function copyRuntimePersistence(options: { source: RuntimePersistence; target: RuntimePersistence }): Promise<void> {
  const kinds: RuntimeHistoryKind[] = ["conversation", "run", "workflow", "state"];
  const existing = await Promise.all(kinds.map(kind => options.target.list(kind)));
  if (existing.some(records => records.length)) throw new RuntimeStorageError("RUNTIME_STORAGE_REVISION_CONFLICT", "Runtime backup requires an empty destination.");
  const records = (await Promise.all(kinds.map(kind => options.source.list(kind)))).flat();
  const ids = new Set(records.filter(record => record.kind !== "workflow").map(record => record.key));
  for (const record of records) if (record.kind === "conversation") ids.add(record.scope);
  const keys = new Set((await Promise.all([...ids].map(id => options.source.agentSessions(id)))).flat());
  for (const key of keys) await options.target.importSession(key, await options.source.exportSession(key));
  for (const scope of new Set(records.map(record => record.scope))) {
    const lease = await options.target.acquire(scope);
    try { for (const record of records.filter(record => record.scope === scope)) await lease.write({ ...record, revision: 0 }); }
    finally { await lease.close(); }
  }
}
