import { currentBotRequestId } from "../agent/bot-lifecycle";
import { selectProjectEntry, type ProjectEntry, type ProjectManifest } from "@steamharness/project-manifest";
import type { AccessActor } from "@steamharness/project-access";
import type { ToolPermissionContext } from "../tool-permissions/index";
import type { EntryConversationContext, EntryConversationHost, EntryConversationAction } from './conversations';
export * from './conversations';
export * from "@steamharness/project-manifest";
export { readProjectDeclarationFromDirectory, readProjectDeclarationFromDirectorySync, readProjectDocument, readProjectDocumentSync, resolveProjectEntry, resolveProjectEntrySync, readProjectManifestFromDirectory, readProjectManifestFromDirectorySync, type ResolvedProjectEntry } from "@steamharness/project-manifest/node";

export interface EntryOperation { id: string; title?: string; description?: string }
export interface EntryCallSource { entryId: string; conversationId?: string; runId?: string }
export interface EntryCallIdentity {
  actor: AccessActor;
  projectId: string;
  sourceEntryId: string;
  sourceConversationId?: string;
  sourceRunId?: string;
  abortSignal?: AbortSignal;
  toolPermissions?: ToolPermissionContext;
}
export interface EntryRunner {
  list(entryId: string, identity: EntryCallIdentity): Promise<EntryOperation[]>;
  run(entryId: string, entrypointId: string, args: readonly string[], identity: EntryCallIdentity): Promise<unknown>;
}
export interface EntryContext {
  readonly registration: Readonly<ProjectEntry>;
  listEntrypoints(): Promise<EntryOperation[]>;
  runEntrypoint(entrypointId: string, args?: readonly string[], options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}
export interface EntriesContext {
  /** Trusted immediate caller of this operation, never supplied in business arguments. */
  readonly caller?: Readonly<EntryCallSource>;
  readonly conversations: { get(entryId: string): EntryConversationContext };
  list(): ReadonlyArray<ProjectEntry>;
  get(entryId: string): EntryContext;
}
export function createEntriesContext(manifest: ProjectManifest, identity: EntryCallIdentity, runner: EntryRunner, conversations?: EntryConversationHost, caller?: EntryCallSource): EntriesContext {
  return {
    caller: caller && Object.freeze({ ...caller }),
    conversations: { get(entryId) {
      const registration = selectProjectEntry(manifest, entryId);
      if (registration.type !== 'bot') throw new Error(`Entry "${entryId}" is not a Bot.`);
      const call = async (action: EntryConversationAction, input: Record<string, unknown> = {}) => {
        identity.abortSignal?.throwIfAborted();
        if (!conversations) throw Object.assign(new Error('Conversation entry control requires a local execution host.'), { code: 'ENTRY_RUNTIME_UNAVAILABLE' });
        const permission = identity.toolPermissions?.getTool(`entry:${entryId}:${action}`);
        if (permission?.enabled === false) throw new Error('The caller disabled this conversation operation.');
        if (permission) await identity.toolPermissions!.requireToolApproval({ name: `entry:${entryId}:${action}`, arguments: input });
        return conversations.invoke(entryId, action, structuredClone(input), identity);
      };
      return {
        list: () => call('list') as ReturnType<EntryConversationContext['list']>,
        submit: input => call('submit', { ...input }) as ReturnType<EntryConversationContext['submit']>,
        snapshot: conversationId => call('snapshot', { conversationId }) as ReturnType<EntryConversationContext['snapshot']>,
        resolveInput: input => call('resolveInput', input) as Promise<void>,
        cancel: input => call('cancel', input) as Promise<void>,
        resumeQueue: input => call('resumeQueue', input) as Promise<void>,
      };
    } },
    list: () => structuredClone(manifest.entries),
    get(entryId) {
      const registration = selectProjectEntry(manifest, entryId);
      if (registration.type !== "workflow") throw new Error(`Entry "${entryId}" does not expose Workflow operations.`);
      const assertActive = () => { if (identity.abortSignal?.aborted) throw identity.abortSignal.reason ?? new Error("Entry call cancelled."); };
      return {
        registration: Object.freeze(structuredClone(registration)),
        async listEntrypoints() { assertActive(); return runner.list(entryId, identity); },
        async runEntrypoint(entrypointId, args = [], options = {}) {
          assertActive();
          const abortSignal = options.abortSignal && identity.abortSignal ? AbortSignal.any([identity.abortSignal, options.abortSignal])
            : options.abortSignal ?? identity.abortSignal;
          abortSignal?.throwIfAborted();
          return runner.run(entryId, entrypointId, args, { ...identity, sourceRunId: currentBotRequestId(identity.projectId, identity.sourceEntryId) ?? identity.sourceRunId, abortSignal });
        },
      };
    },
  };
}
