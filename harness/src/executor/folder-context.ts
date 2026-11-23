import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ProjectEntry } from "@steamharness/project-manifest";
import type { FolderContext, NodeContext } from "../types/context";
import { getUserSettings } from "../user-settings";
import { HarnessError } from "../workflow/errors";
import { resolveAgentPermissionPolicySetting } from "../agent/permission";
import type { AgentInput, AgentPermissionPolicy } from "../agent/types";

export interface LocalFolderHostContext extends FolderContext {
  /** Optionally pin the source project identity before loading its code. */
  readonly projectId?: string;
  /** The highest policy the local owner has authorized for this host. */
  readonly permissionCeiling?: AgentPermissionPolicy;
}

export const LOCAL_FOLDER_CONTEXT_PROTOCOL_VERSION = 1;
export const folderPermissionCeiling = Symbol("folderPermissionCeiling");
type FolderAgentContext = Pick<NodeContext, "folderContext"> & { [folderPermissionCeiling]?: AgentPermissionPolicy };
const levels = ["read-only", "workspace", "auto"] as const;

export function validateLocalFolderContext(registration: ProjectEntry, host: LocalFolderHostContext | undefined, projectId: string): FolderContext | undefined {
  if (host === undefined) return;
  if (registration.type !== "bot" || registration.folderContext !== true || !host || typeof host.directory !== "string" ||
      !path.isAbsolute(host.directory) || (host.projectId !== undefined && host.projectId !== projectId) ||
      (host.permissionCeiling !== undefined && !levels.includes(host.permissionCeiling))) {
    throw new HarnessError({ type: "input_validation", message: "This Bot does not have a valid local folder context." });
  }
  try {
    if (realpathSync(host.directory) === host.directory && statSync(host.directory).isDirectory()) {
      return Object.freeze({ directory: host.directory });
    }
  } catch { /* Do not include the local path in the failure. */ }
  throw new HarnessError({ type: "input_validation", message: "The local Bot folder is unavailable or has changed." });
}

export function applyFolderAgentInput<T extends AgentInput>(input: T, context: FolderAgentContext): T {
  if (!context.folderContext) return input;
  const permissionPolicy = input.permissionPolicy === undefined ? getUserSettings().agent.permissionPolicy : resolveAgentPermissionPolicySetting(input.permissionPolicy);
  const ceiling = context[folderPermissionCeiling];
  if (ceiling && levels.indexOf(permissionPolicy) > levels.indexOf(ceiling)) {
    throw new HarnessError({ type: "tool_permission_denied", message: "Approve the Bot's expanded permissions in the local host before running it." });
  }
  return { ...input, permissionPolicy, workdir: context.folderContext.directory };
}
