import { AsyncLocalStorage } from "node:async_hooks";
import { createRemoteDatabaseResolver, databaseConnectionFromEnv } from "../databases/remote";
import path from "node:path";
import os from "node:os";
import { createDatabasesContext, createLocalDatabaseResolver, type DatabaseResolver } from "../databases/index";
import { createEntriesContext, projectEntryKey, type ResolvedProjectEntry } from "../entries/index";
import { createLocalProjectKVStore, createProjectKVContext, createProjectPersistentValueContext } from "../kv/index";
import type { RunContext } from "../types/context";
import type { RunLocalProjectOptions } from "./index";

const entryCallDepth = new AsyncLocalStorage<number>();

export type EntryDeclaration = ResolvedProjectEntry & { projectId: string; entryId: string };

export function createExecutorHostState(options: { declaration: EntryDeclaration; conversationId?: string; runId?: string; projectName?: string; env?: NodeJS.ProcessEnv; options?: RunLocalProjectOptions["storage"] }) {
  const { declaration } = options;
  const identity = projectEntryKey(declaration.projectId, declaration.entryId);
  const backend = options.options?.[options.options.host];
  const rootDir = backend?.kvStoreDir ?? path.join(os.homedir(), ".steamharness", "runtime", declaration.projectId, declaration.entryId);
  const kvStore = backend?.kvStore ?? createLocalProjectKVStore({ rootDir, storageKind: "kv" });
  const bound = { projectId: identity, conversationId: options.conversationId, source: { projectId: declaration.projectId, entryId: declaration.entryId, runId: options.runId, conversationId: options.conversationId } };
  return { host: { kv: createProjectKVContext({ ...bound, store: kvStore }), persistentValue: createProjectPersistentValueContext({ ...bound, store: backend?.persistentValueStore ?? createLocalProjectKVStore({ rootDir: backend?.persistentValueStoreDir ?? rootDir, storageKind: "persistent_value" }) }) } };
}

export function createExecutorResources(declaration: EntryDeclaration, options: RunLocalProjectOptions, context: () => RunContext) {
  const localResolver = createLocalDatabaseResolver();
  const connection = databaseConnectionFromEnv(options.env);
  const remoteResolver = connection ? createRemoteDatabaseResolver(connection) : undefined;
  const resolver: DatabaseResolver = options.databaseResolver ?? { resolve(requirement, consumer) { return (requirement.host === "local" ? localResolver : remoteResolver)?.resolve(requirement, consumer); } };
  return {
    projectId: declaration.projectId,
    entryId: declaration.entryId,
    actor: options.actor,
    databases: createDatabasesContext({ projectId: declaration.projectId, entryId: declaration.entryId, requirements: declaration.registration.databases, resolver, conversationId: options.conversationId, runId: options.runId }),
    entries: createEntriesContext(declaration.manifest, { actor: options.actor ?? { isSystemAdmin: false }, projectId: declaration.projectId, sourceEntryId: declaration.entryId, get abortSignal() { return context().abortSignal; }, get toolPermissions() { return context().toolPermissions; } }, {
      async list(entryId, identity) {
        await options.authorizeEntry?.(entryId, undefined, identity.actor);
        const { inspectLocalProjectStructure } = await import("./index");
        return inspectLocalProjectStructure({ projectDir: declaration.projectDir, entryId }).entrypoints ?? [];
      },
      async run(entryId, entrypointId, args, identity) {
        if (identity.abortSignal?.aborted) throw identity.abortSignal.reason;
        const depth = entryCallDepth.getStore() ?? 0;
        if (depth >= 16) throw new Error("Cross-entry call depth exceeds 16.");
        await options.authorizeEntry?.(entryId, entrypointId, identity.actor);
        const policy = identity.toolPermissions?.getTool(`entry:${entryId}:${entrypointId}`);
        if (policy?.enabled === false) throw new Error("The caller disabled this entry operation.");
        if (policy) await identity.toolPermissions!.requireToolApproval({ name: `entry:${entryId}:${entrypointId}`, arguments: args });
        const { runLocalProjectWithReport } = await import("./index");
        // An operation uses its own entry grants. The caller never receives a database handle;
        // its actor, host credentials, cancellation and tool restrictions remain in force.
        const report = await entryCallDepth.run(depth + 1, () => runLocalProjectWithReport({ ...options, projectDir: declaration.projectDir, entryId, entrypointId, args: [...args], configuration: undefined, configurationRunId: undefined, runId: undefined, conversationId: undefined, hostInput: undefined, actor: identity.actor, abortSignal: identity.abortSignal, inheritedToolPermissions: identity.toolPermissions, databaseResolver: resolver, onRuntimeEvent: undefined, onDefinedNodes: undefined }));
        if (report.status !== "success") throw new Error(`Entry "${entryId}" operation "${entrypointId}" failed: ${JSON.stringify(report.result)}`);
        if (!report.result.ok) throw new Error(report.result.error.message);
        const { readEntrypointOutput } = await import("../workflow/index");
        return readEntrypointOutput(report.result.data);
      },
    }),
  };
}
