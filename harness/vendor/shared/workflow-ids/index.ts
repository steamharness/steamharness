import path from "node:path";

export const STEAMHARNESS_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const STEAMHARNESS_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSafeProjectId(value: string): boolean {
  const normalized = value.trim();

  return (
    value === normalized &&
    normalized !== "" &&
    STEAMHARNESS_ID_PATTERN.test(normalized) &&
    !/^\.+$/.test(normalized)
  );
}

export function isWorkflowUuid(value: string): boolean {
  return STEAMHARNESS_UUID_PATTERN.test(value.trim());
}

export function assertSafeProjectId(value: string, label = "workflow id"): string {
  const normalized = value.trim();

  if (!isSafeProjectId(normalized)) {
    throw new Error(`Invalid ${label} "${value}".`);
  }

  return normalized;
}

export function assertWorkflowUuid(value: string, label = "workflow id"): string {
  const normalized = value.trim();

  if (!isWorkflowUuid(normalized)) {
    throw new Error(`Invalid ${label} "${value}".`);
  }

  return normalized;
}

export function createUnsafeProjectIdMessage(value: string, label = "workflow id"): string {
  return `Invalid ${label} "${value}".`;
}

export function createInvalidWorkflowUuidMessage(value: string, label = "workflow id"): string {
  return `Invalid ${label} "${value}". Expected a UUID.`;
}

export function resolveWorkflowRoot(workflowsRoot: string, projectId: string): string {
  const safeProjectId = assertSafeProjectId(projectId);
  const root = path.resolve(workflowsRoot);
  const resolved = path.resolve(root, safeProjectId);
  const rootPrefix = `${root}${path.sep}`;

  if (resolved !== root && `${resolved}${path.sep}`.startsWith(rootPrefix)) {
    return resolved;
  }

  throw new Error(`Resolved workflow root for "${projectId}" is outside workflows root.`);
}
