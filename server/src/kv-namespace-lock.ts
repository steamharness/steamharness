import type pg from "pg";
import {
  normalizeWorkflowKVStoreInput,
  type WorkflowKVNamespaceLockInput,
} from "steamharness";

export const STEAMHARNESS_KV_NAMESPACE_LOCK_FAMILY = "workflow_project_storage_namespace";

export function createWorkflowKVNamespaceLockKey(
  input: WorkflowKVNamespaceLockInput,
): string {
  const normalized = normalizeWorkflowKVStoreInput({
    ...input,
    key: "namespace-lock",
  });

  return normalized.scope === "project"
    ? JSON.stringify({
        storageKind: normalized.storageKind,
        scope: normalized.scope,
        projectId: normalized.projectId,
      })
    : JSON.stringify({
        storageKind: normalized.storageKind,
        scope: normalized.scope,
        projectId: normalized.projectId,
        conversationId: normalized.conversationId,
      });
}

export async function withPostgresWorkflowKVNamespaceLock<T>(
  pool: Pick<pg.Pool, "connect">,
  input: WorkflowKVNamespaceLockInput,
  operation: () => Promise<T> | T,
): Promise<T> {
  const client = await pool.connect();
  const lockKey = createWorkflowKVNamespaceLockKey(input);

  try {
    await client.query(
      "select pg_advisory_lock(hashtext($1), hashtext($2))",
      [STEAMHARNESS_KV_NAMESPACE_LOCK_FAMILY, lockKey],
    );
    return await operation();
  } finally {
    try {
      await client.query(
        "select pg_advisory_unlock(hashtext($1), hashtext($2))",
        [STEAMHARNESS_KV_NAMESPACE_LOCK_FAMILY, lockKey],
      );
    } finally {
      client.release();
    }
  }
}
