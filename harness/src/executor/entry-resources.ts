import { AsyncLocalStorage } from "node:async_hooks";
import { createEntriesContext, type ResolvedProjectEntry } from "../entries/index";
import type { ProjectRuntimeInfo } from "../runtime-info";
import type { RunContext } from "../types/context";
import type { RunLocalProjectOptions } from "./index";

const entryCallDepth = new AsyncLocalStorage<number>();

export type EntryDeclaration = ResolvedProjectEntry & { projectId: string; entryId: string };

export function createExecutorResources(declaration: EntryDeclaration, options: RunLocalProjectOptions, context: () => RunContext) {
  const { manifest, projectDir, registration } = declaration;
  return {
    projectId: declaration.projectId,
    entryId: declaration.entryId,
    runtimeInfo: {
      host: options.runtimeHost,
      project: {
        name: manifest.name,
        version: manifest.version,
        directory: projectDir,
        entry: { entryId: registration.entryId, name: registration.name, type: registration.type },
      },
    } satisfies ProjectRuntimeInfo,
    actor: options.actor,
    entries: createEntriesContext(declaration.manifest, { actor: options.actor ?? { isSystemAdmin: false }, projectId: declaration.projectId, sourceEntryId: declaration.entryId, get sourceConversationId() { return context().conversation.conversationId; }, get sourceRunId() { return String(context().metadata?.runId ?? ''); }, get abortSignal() { return context().abortSignal; }, get toolPermissions() { return context().toolPermissions; } }, {
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
        // Keep host permissions; the Bot engine check belongs to the parent conversation.
        const report = await entryCallDepth.run(depth + 1, () => runLocalProjectWithReport({ ...options, expectedBotEngine: undefined, entryCall: { entryId: identity.sourceEntryId, conversationId: identity.sourceConversationId, runId: identity.sourceRunId }, projectDir: declaration.projectDir, entryId, entrypointId, args: [...args], configuration: undefined, configurationRunId: undefined, runId: undefined, conversationId: undefined, hostInput: undefined, actor: identity.actor, abortSignal: identity.abortSignal, inheritedToolPermissions: identity.toolPermissions, onRuntimeEvent: undefined, onDefinedNodes: undefined }));
        if (report.status !== "success") throw new Error(`Entry "${entryId}" operation "${entrypointId}" failed: ${JSON.stringify(report.result)}`);
        if (!report.result.ok) throw new Error(report.result.error.message);
        const { readEntrypointOutput } = await import("../workflow/index");
        return readEntrypointOutput(report.result.data);
      },
    }, options.entryConversationHost && { async invoke(entryId, action, input, identity) {
      if (options.readOnly && action !== "list" && action !== "snapshot") throw new Error("Resource readers cannot mutate conversations.");
      await options.authorizeEntry?.(entryId, action, identity.actor);
      identity.abortSignal?.throwIfAborted();
      return options.entryConversationHost!.invoke(entryId, action, input, identity);
    } }, options.entryCall),
  };
}
