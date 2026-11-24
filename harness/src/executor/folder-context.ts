import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ProjectEntry } from "@steamharness/project-manifest";
import type { FolderContext, NodeContext } from "../types/context";
import { getUserSettings } from "../user-settings";
import { HarnessError } from "../workflow/errors";
import { resolveAgentPermissionPolicySetting } from "../agent/permission";
import type { AgentInput, AgentPermissionPolicy } from "../agent/types";
import { parseFolderBotProfile, type FolderBotProfile } from "./bot-profile";

export interface LocalFolderHostContext extends FolderContext {
  /** Optionally pin the source project identity before loading its code. */
  readonly projectId?: string;
  /** The highest policy the local owner has authorized for this host. */
  readonly permissionCeiling?: AgentPermissionPolicy;
  readonly profile?: FolderBotProfile;
}

export const LOCAL_FOLDER_CONTEXT_PROTOCOL_VERSION = 1;
export const folderPermissionCeiling = Symbol("folderPermissionCeiling");
export const folderProfile = Symbol("folderProfile");
type FolderAgentContext = Pick<NodeContext, "folderContext"> & { [folderPermissionCeiling]?: AgentPermissionPolicy; [folderProfile]?: FolderBotProfile };
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

export function readFolderBotProfile(context: FolderAgentContext): FolderBotProfile | undefined { return context.folderContext ? context[folderProfile] : undefined; }

export function folderBotResponsibilities(context: FolderAgentContext): string | undefined {
  const responsibility = readFolderBotProfile(context)?.responsibility;
  return responsibility && `Local Bot instance responsibilities (subject to the project's existing instructions and permissions):\n${responsibility}`;
}

export function validateFolderBotProfile(host: LocalFolderHostContext | undefined): FolderBotProfile | undefined {
  if (host?.profile === undefined) return;
  try { return parseFolderBotProfile(host.profile); }
  catch { throw new HarnessError({ type: 'input_validation', message: 'Invalid local Bot profile.' }); }
}

export function applyFolderAgentInput<T extends AgentInput>(input: T, context: FolderAgentContext, fixedModel?: unknown): T {
  if (!context.folderContext) return input;
  const profile = readFolderBotProfile(context);
  const hostPolicy = getUserSettings().agent.permissionPolicy;
  let permissionPolicy = input.permissionPolicy === undefined ? hostPolicy : resolveAgentPermissionPolicySetting(input.permissionPolicy);
  if (profile && levels.indexOf(permissionPolicy) > levels.indexOf(hostPolicy)) permissionPolicy = hostPolicy;
  const limit = profile?.tools?.ceiling;
  if (limit && levels.indexOf(permissionPolicy) > levels.indexOf(limit)) permissionPolicy = limit;
  const ceiling = context[folderPermissionCeiling];
  if (ceiling && levels.indexOf(permissionPolicy) > levels.indexOf(ceiling)) {
    throw new HarnessError({ type: "tool_permission_denied", message: "Approve the Bot's expanded permissions in the local host before running it." });
  }
  const model = profile?.modelId;
  if (model && fixedModel !== undefined && fixedModel !== model) throw new HarnessError({ type: 'input_validation', message: 'The folder Bot model override conflicts with the source project’s fixed model.' });
  return { ...input, ...(model && { model }), permissionPolicy, workdir: context.folderContext.directory };
}
