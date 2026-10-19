import type { ToolPermissionDefinition, ToolPermissionPolicyMap } from "../tool-permissions/index";
import type { AgentPermissionPolicy } from "./types";
import { AGENT_PERMISSION_POLICIES, DEFAULT_AGENT_PERMISSION_POLICY } from "./types";
import {
  BUILTIN_AGENT_TOOL_CATALOG,
  MUTATING_AGENT_TOOL_NAMES,
  type AgentToolScope,
} from "./tools";

const MUTATING_TOOLS = new Set(MUTATING_AGENT_TOOL_NAMES);

export function parseAgentPermissionPolicy(value: unknown): AgentPermissionPolicy {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const match = AGENT_PERMISSION_POLICIES.find((policy) => policy === normalized);
    if (match !== undefined) {
      return match;
    }
  }

  return DEFAULT_AGENT_PERMISSION_POLICY;
}

export function isAgentPermissionPolicy(value: unknown): value is AgentPermissionPolicy {
  return typeof value === "string" &&
    AGENT_PERMISSION_POLICIES.some((policy) => policy === value.trim().toLowerCase());
}

/**
 * Tool permission definitions for a run.
 *
 * `requested` narrows the catalog; an unknown name is dropped rather than
 * declared, so a typo cannot silently register a tool that has no factory.
 */
export function readAgentToolDefinitions(
  requested?: readonly string[],
): ToolPermissionDefinition[] {
  const known = new Set(BUILTIN_AGENT_TOOL_CATALOG.map((tool) => tool.name));
  const wanted = requested === undefined
    ? undefined
    : new Set(requested.filter((name) => known.has(name as never)));

  return BUILTIN_AGENT_TOOL_CATALOG
    .filter((tool) => wanted === undefined || wanted.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      enabled: true,
      // The built-in tools answer to the run's `permissionPolicy`, exactly as
      // the built-in OpenCode project's own tools answer to OpenCode's
      // permission config. Declaring them auto-approved keeps the host's
      // approval gate out of a decision it does not own, while still letting a
      // host disable one outright.
      autoApprove: true,
    }));
}

/**
 * Turns the three user-facing policies into the per-tool policy map the
 * runtime enforces.
 *
 * The levels match the built-in OpenCode project: `read-only` hides the
 * mutating tools, `workspace` approves everything inside the workspace, and
 * `auto` matches OpenCode's `--auto` and approves every permission that is not
 * explicitly denied. None of them interrupt a run to ask — `workspace` and
 * `auto` differ in **how far the tools may reach**, which is
 * {@link resolveAgentToolScope}, not in whether they prompt.
 */
export function resolveAgentPermissionPolicy(
  policy: AgentPermissionPolicy,
  definitions: readonly ToolPermissionDefinition[],
): ToolPermissionPolicyMap {
  const resolved: ToolPermissionPolicyMap = {};

  for (const definition of definitions) {
    const mutating = MUTATING_TOOLS.has(definition.name);

    resolved[definition.name] = policy === "read-only"
      ? { enabled: !mutating, autoApprove: true }
      : { enabled: true, autoApprove: true };
  }

  return resolved;
}

/**
 * The directories a run's tools may touch.
 *
 * `auto` is OpenCode's `--auto`: approving every permission it has not been
 * denied also approves reaching outside the workspace, so the path guard is
 * lifted. `read-only` and `workspace` keep it.
 */
export function resolveAgentToolScope(
  policy: AgentPermissionPolicy,
  scope: AgentToolScope,
): AgentToolScope {
  return policy === "auto" ? { ...scope, allowAnyPath: true } : { ...scope, allowAnyPath: false };
}

/** Tools the model may call at all under a policy; disabled tools are not offered. */
export function listEnabledAgentToolNames(
  policy: AgentPermissionPolicy,
  definitions: readonly ToolPermissionDefinition[],
): string[] {
  const resolved = resolveAgentPermissionPolicy(policy, definitions);
  return definitions
    .filter((definition) => resolved[definition.name]?.enabled !== false)
    .map((definition) => definition.name);
}
