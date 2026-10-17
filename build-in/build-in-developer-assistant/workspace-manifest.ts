import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST_SCHEMA_VERSION = 2;

export type DeveloperAssistantWorkspaceTargetRef =
  | { kind: "home" }
  | { kind: "project"; projectId: string }
  | { kind: "folder"; folderId: string };

export type DeveloperAssistantWorkspaceWarningCode =
  | "project_not_imported"
  | "folder_not_registered"
  | "path_unavailable"
  | "project_not_editable"
  | "manifest_invalid";

export type DeveloperAssistantWorkspaceRelation = "related-project" | "assistant-folder";

export interface DeveloperAssistantWorkspaceRoot {
  target: DeveloperAssistantWorkspaceTargetRef;
  name: string;
  rootPath: string;
  depth: number;
  role: "primary" | "linked";
}

export interface DeveloperAssistantWorkspaceWarning {
  code: DeveloperAssistantWorkspaceWarningCode;
  relation: DeveloperAssistantWorkspaceRelation;
  source: DeveloperAssistantWorkspaceTargetRef;
  target?: DeveloperAssistantWorkspaceTargetRef;
  message: string;
}

export interface DeveloperAssistantWorkspaceManifestV2 {
  schemaVersion: typeof DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST_SCHEMA_VERSION;
  primaryTarget: DeveloperAssistantWorkspaceTargetRef;
  roots: DeveloperAssistantWorkspaceRoot[];
  warnings: DeveloperAssistantWorkspaceWarning[];
}

export type DeveloperAssistantWorkspaceManifest = DeveloperAssistantWorkspaceManifestV2;

export async function loadDeveloperAssistantWorkspaceManifest(
  workdir: string,
  manifestPath?: string,
): Promise<DeveloperAssistantWorkspaceManifest> {
  const primaryRootPath = normalizeAbsolutePath(workdir, "target workspace directory");
  if (!manifestPath?.trim()) throw new Error("workspace manifest path is required");

  const normalizedManifestPath = normalizeAbsolutePath(manifestPath, "workspace manifest path");
  const source = await readFile(normalizedManifestPath, "utf8");
  return parseDeveloperAssistantWorkspaceManifest(JSON.parse(source) as unknown, primaryRootPath);
}

export function parseDeveloperAssistantWorkspaceManifest(
  value: unknown,
  workdir: string,
): DeveloperAssistantWorkspaceManifest {
  if (!isRecord(value)) throw new Error("workspace manifest must be an object");
  if (value.schemaVersion !== DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST_SCHEMA_VERSION) {
    throw new Error("workspace manifest must use schemaVersion 2");
  }

  const primaryTarget = parseWorkspaceTarget(value.primaryTarget, "primaryTarget");
  if (!Array.isArray(value.roots) || value.roots.length === 0) {
    throw new Error("workspace manifest roots must be a non-empty array");
  }
  if (!Array.isArray(value.warnings)) {
    throw new Error("workspace manifest warnings must be an array");
  }

  const targetKeys = new Set<string>();
  const rootPaths = new Set<string>();
  const roots = value.roots.map((root, index) => {
    if (!isRecord(root)) throw new Error(`workspace manifest roots[${index}] must be an object`);
    const target = parseWorkspaceTarget(root.target, `roots[${index}].target`);
    const targetKey = createTargetKey(target);
    const name = readNonEmptyString(root.name, `roots[${index}].name`);
    const rootPath = normalizeAbsolutePath(root.rootPath, `roots[${index}].rootPath`);
    const depth = root.depth;
    const role = root.role;
    if (!Number.isSafeInteger(depth) || Number(depth) < 0) {
      throw new Error(`workspace manifest roots[${index}].depth must be a non-negative integer`);
    }
    if (role !== "primary" && role !== "linked") {
      throw new Error(`workspace manifest roots[${index}].role is invalid`);
    }
    if (targetKeys.has(targetKey)) throw new Error(`workspace manifest contains duplicate target ${targetKey}`);
    const pathKey = createPathComparisonKey(rootPath);
    if (rootPaths.has(pathKey)) throw new Error(`workspace manifest contains duplicate path ${rootPath}`);
    targetKeys.add(targetKey);
    rootPaths.add(pathKey);
    return { target, name, rootPath, depth: Number(depth), role } satisfies DeveloperAssistantWorkspaceRoot;
  });

  const primaryRoots = roots.filter((root) => root.role === "primary");
  if (primaryRoots.length !== 1
    || createTargetKey(primaryRoots[0]!.target) !== createTargetKey(primaryTarget)
    || primaryRoots[0]!.depth !== 0
    || createPathComparisonKey(primaryRoots[0]!.rootPath) !== createPathComparisonKey(workdir)) {
    throw new Error("workspace manifest primary root does not match the target workspace directory");
  }
  if (roots.some((root) => root.role === "linked" && root.depth < 1)) {
    throw new Error("workspace manifest linked root depth must be at least 1");
  }

  return {
    schemaVersion: DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST_SCHEMA_VERSION,
    primaryTarget,
    roots,
    warnings: value.warnings.map((warning, index) => parseWorkspaceWarning(warning, index)),
  };
}

function parseWorkspaceWarning(value: unknown, index: number): DeveloperAssistantWorkspaceWarning {
  if (!isRecord(value)) throw new Error(`workspace manifest warnings[${index}] must be an object`);
  if (!isWorkspaceWarningCode(value.code)) {
    throw new Error(`workspace manifest warnings[${index}].code is invalid`);
  }
  if (value.relation !== "related-project" && value.relation !== "assistant-folder") {
    throw new Error(`workspace manifest warnings[${index}].relation is invalid`);
  }
  return {
    code: value.code,
    relation: value.relation,
    source: parseWorkspaceTarget(value.source, `warnings[${index}].source`),
    target: value.target === undefined
      ? undefined
      : parseWorkspaceTarget(value.target, `warnings[${index}].target`),
    message: readNonEmptyString(value.message, `warnings[${index}].message`),
  };
}

function parseWorkspaceTarget(value: unknown, label: string): DeveloperAssistantWorkspaceTargetRef {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.kind === "home") {
    return { kind: "home" };
  }
  if (value.kind === "project") {
    return { kind: "project", projectId: readNonEmptyString(value.projectId, `${label}.projectId`) };
  }
  if (value.kind === "folder") {
    return { kind: "folder", folderId: readNonEmptyString(value.folderId, `${label}.folderId`) };
  }
  throw new Error(`${label}.kind is invalid`);
}

function isWorkspaceWarningCode(value: unknown): value is DeveloperAssistantWorkspaceWarningCode {
  return value === "project_not_imported"
    || value === "folder_not_registered"
    || value === "path_unavailable"
    || value === "project_not_editable"
    || value === "manifest_invalid";
}

function normalizeAbsolutePath(value: unknown, label: string): string {
  const source = readNonEmptyString(value, label);
  if (!path.isAbsolute(source)) throw new Error(`${label} must be absolute`);
  const normalized = path.resolve(source);
  if (normalized === path.parse(normalized).root) throw new Error(`${label} cannot be a filesystem root`);
  return normalized;
}

function createTargetKey(target: DeveloperAssistantWorkspaceTargetRef): string {
  if (target.kind === "home") return "home";
  return target.kind === "project" ? `project:${target.projectId}` : `folder:${target.folderId}`;
}

function createPathComparisonKey(value: string): string {
  const normalized = path.resolve(value).normalize("NFC");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
