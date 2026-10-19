import type { ManagedFileReference, ParamDefinition } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFileParamReferences(value: string | undefined): ManagedFileReference[] {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return [];

  try {
    return normalizeFileParamReferences(JSON.parse(trimmed) as unknown);
  } catch {
    return [];
  }
}

export function normalizeFileParamReferences(value: unknown): ManagedFileReference[] {
  if (Array.isArray(value)) {
    return value
      .map(normalizeFileParamReference)
      .filter((file): file is ManagedFileReference => file !== null);
  }

  const single = normalizeFileParamReference(value);
  return single === null ? [] : [single];
}

export function normalizeFileParamReference(value: unknown): ManagedFileReference | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;

  const mimeType = typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream";
  const storage = value.storage === "local" || value.storage === "server" ? value.storage : undefined;
  if (storage === undefined) return null;

  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
    mimeType,
    size: typeof value.size === "number" && Number.isFinite(value.size) ? value.size : 0,
    kind: value.kind === "image" || mimeType.startsWith("image/") ? "image" : "file",
    storage,
    projectId: typeof value.projectId === "string" ? value.projectId : undefined,
    conversationId: typeof value.conversationId === "string" ? value.conversationId : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
  };
}

export function serializeFileParamReferences(refs: ManagedFileReference[]): string {
  return refs.length === 0 ? "" : JSON.stringify(refs);
}

export function mergeFileReferences(
  current: ManagedFileReference[],
  added: ManagedFileReference[],
): ManagedFileReference[] {
  const byId = new Map(current.map((file) => [file.id, file]));
  for (const file of added) byId.set(file.id, file);
  return Array.from(byId.values());
}

export function replaceFileParamArgs(
  args: string[],
  param: ParamDefinition,
  refs: ManagedFileReference[],
): string[] {
  if (param.flag === undefined) return args;

  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === param.flag || (param.shortFlag !== undefined && arg === param.shortFlag)) {
      index += 1;
      continue;
    }
    if (arg !== undefined) next.push(arg);
  }

  const serialized = serializeFileParamReferences(refs);
  if (serialized !== "") next.push(param.flag, serialized);
  return next;
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
