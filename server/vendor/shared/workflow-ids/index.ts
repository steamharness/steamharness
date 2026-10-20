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

export function isProjectUuid(value: string): boolean {
  return STEAMHARNESS_UUID_PATTERN.test(value.trim());
}

export function assertSafeProjectId(value: string, label = "project id"): string {
  const normalized = value.trim();

  if (!isSafeProjectId(normalized)) {
    throw new Error(`Invalid ${label} "${value}".`);
  }

  return normalized;
}

export function assertProjectUuid(value: string, label = "project id"): string {
  const normalized = value.trim();

  if (!isProjectUuid(normalized)) {
    throw new Error(`Invalid ${label} "${value}".`);
  }

  return normalized;
}

export function createUnsafeProjectIdMessage(value: string, label = "project id"): string {
  return `Invalid ${label} "${value}".`;
}

export function createInvalidProjectUuidMessage(value: string, label = "project id"): string {
  return `Invalid ${label} "${value}". Expected a UUID.`;
}

export function resolveProjectRoot(projectsRoot: string, projectId: string): string {
  const safeProjectId = assertSafeProjectId(projectId);
  const root = path.resolve(projectsRoot);
  const resolved = path.resolve(root, safeProjectId);
  const rootPrefix = `${root}${path.sep}`;

  if (resolved !== root && `${resolved}${path.sep}`.startsWith(rootPrefix)) {
    return resolved;
  }

  throw new Error(`Resolved project root for "${projectId}" is outside projects root.`);
}
