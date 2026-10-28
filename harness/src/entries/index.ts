import { selectProjectEntry, type ProjectEntry, type ProjectManifest } from "@steamharness/project-manifest";
import type { AccessActor } from "@steamharness/project-access";
import type { ToolPermissionContext } from "../tool-permissions/index";
export * from "@steamharness/project-manifest";
export { resolveProjectEntry, resolveProjectEntrySync, type ResolvedProjectEntry } from "@steamharness/project-manifest/node";

export interface EntryOperation { id: string; title?: string; description?: string }
export interface EntryCallIdentity {
  actor: AccessActor;
  projectId: string;
  sourceEntryId: string;
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
  runEntrypoint(entrypointId: string, args?: readonly string[]): Promise<unknown>;
}
export interface EntriesContext {
  list(): ReadonlyArray<ProjectEntry>;
  get(entryId: string): EntryContext;
}
export function createEntriesContext(manifest: ProjectManifest, identity: EntryCallIdentity, runner: EntryRunner): EntriesContext {
  return {
    list: () => structuredClone(manifest.entries),
    get(entryId) {
      const registration = selectProjectEntry(manifest, entryId);
      if (registration.type !== "workflow") throw new Error(`Entry "${entryId}" does not expose Workflow operations.`);
      const assertActive = () => { if (identity.abortSignal?.aborted) throw identity.abortSignal.reason ?? new Error("Entry call cancelled."); };
      return {
        registration: Object.freeze(structuredClone(registration)),
        async listEntrypoints() { assertActive(); return runner.list(entryId, identity); },
        async runEntrypoint(entrypointId, args = []) { assertActive(); return runner.run(entryId, entrypointId, args, identity); },
      };
    },
  };
}
