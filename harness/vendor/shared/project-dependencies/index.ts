import type { WorkflowRelatedProject } from "../project-info/index";
import { isWorkflowUuid } from "../workflow-ids/index";

export const STEAMHARNESS_PROJECT_GROUP_VERSION = 1;
export const STEAMHARNESS_PROJECT_GROUP_MANIFEST_FILE = "project-group.json";
export const STEAMHARNESS_PROJECT_DEPENDENCY_CAPABILITY = "download_source" as const;

export interface WorkflowProjectDependencyLocalizedError extends Error {
  steamHarnessI18n: {
    namespace: "common";
    key: string;
    values?: Record<string, unknown>;
  };
}

export type WorkflowProjectDependencyDelivery = "included" | "external";

export interface WorkflowProjectDependencyLock {
  alias: string;
  projectId: string;
  delivery: WorkflowProjectDependencyDelivery;
  version?: string;
  sourceHash?: string;
}

export interface WorkflowProjectGroupProject {
  projectId: string;
  role: "root" | "dependency";
  archivePath: string;
  alias?: string;
  /**
   * The immutable package version that the archive is expected to publish.
   * This is optional for older clients; new clients always include it.
   */
  version?: string;
}

export interface WorkflowProjectGroupManifestV1 {
  version: 1;
  rootProjectId: string;
  projects: WorkflowProjectGroupProject[];
  dependencies: WorkflowProjectDependencyLock[];
}

export interface WorkflowProjectDependencySelection {
  alias: string;
  delivery: WorkflowProjectDependencyDelivery;
}

export interface WorkflowProjectDownloadItem {
  alias?: string;
  projectId: string;
  version: string;
  sourceHash: string;
  projectName?: string;
  role: "root" | "dependency";
  alreadyAvailable?: boolean;
}

export interface WorkflowProjectSkippedDependency {
  dependency: WorkflowProjectDependencyLock;
  reason: "external" | "source_unavailable" | "permission_required";
  requestUrl?: string;
}

export interface WorkflowProjectDownloadPlan {
  rootProjectId: string;
  rootVersion: string;
  dependencies: WorkflowProjectDependencyLock[];
  downloads: WorkflowProjectDownloadItem[];
  skippedDependencies: WorkflowProjectSkippedDependency[];
  complete: boolean;
  copyAllowed: boolean;
}

export interface WorkflowProjectDependencyStatus {
  dependency: WorkflowProjectDependencyLock;
  projectName?: string;
  projectAvailable: boolean;
  sourceAvailable: boolean;
  sourceDownloadAllowed: boolean;
  relationshipConfirmed: boolean;
  dataInitialized: boolean;
  requestUrl?: string;
}

export interface WorkflowProjectDependencyStatusResult {
  rootProjectId: string;
  rootVersion: string;
  dependencies: WorkflowProjectDependencyStatus[];
  publishable: boolean;
}

export type WorkflowProjectAccessRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revoked";

export interface WorkflowProjectAccessRequest {
  id: string;
  projectId: string;
  requesterUserId: string;
  capability: typeof STEAMHARNESS_PROJECT_DEPENDENCY_CAPABILITY;
  reason: string;
  status: WorkflowProjectAccessRequestStatus;
  createdAt: string;
  updatedAt: string;
  resolvedByUserId?: string;
  resolvedAt?: string;
}

export interface WorkflowProjectCapabilityGrant {
  projectId: string;
  userId: string;
  capability: typeof STEAMHARNESS_PROJECT_DEPENDENCY_CAPABILITY;
  createdByUserId?: string;
  createdAt: string;
  revokedByUserId?: string;
  revokedAt?: string;
}

export function createExternalWorkflowProjectDependencyLocks(
  relatedProjects: readonly WorkflowRelatedProject[],
): WorkflowProjectDependencyLock[] {
  return relatedProjects.map((relatedProject) => ({
    alias: relatedProject.alias,
    projectId: relatedProject.projectId,
    delivery: "external",
  }));
}

export function createWorkflowProjectDependencyLocks(
  relatedProjects: readonly WorkflowRelatedProject[],
  selections: readonly WorkflowProjectDependencySelection[],
): WorkflowProjectDependencyLock[] {
  const selectionsById = new Map<string, WorkflowProjectDependencyDelivery>();
  for (const selection of selections) {
    if (selectionsById.has(selection.alias)) {
      throw dependencyError(
        "duplicateSelection",
        `Duplicate dependency selection ${JSON.stringify(selection.alias)}.`,
        { alias: selection.alias },
      );
    }
    selectionsById.set(selection.alias, selection.delivery);
  }

  const locks = relatedProjects.map((relatedProject) => ({
    alias: relatedProject.alias,
    projectId: relatedProject.projectId,
    delivery: selectionsById.get(relatedProject.alias) ?? "external",
  } satisfies WorkflowProjectDependencyLock));

  for (const alias of selectionsById.keys()) {
    if (!relatedProjects.some((relatedProject) => relatedProject.alias === alias)) {
      throw dependencyError(
        "unknownSelection",
        `Unknown dependency selection ${JSON.stringify(alias)}.`,
        { alias },
      );
    }
  }
  return locks;
}

export function parseWorkflowProjectDependencyLocks(
  value: unknown,
  options: { published?: boolean } = {},
): WorkflowProjectDependencyLock[] {
  if (!Array.isArray(value)) {
    throw dependencyError("lockArray", "Project dependency lock must be an array.");
  }
  const aliases = new Set<string>();
  const projectIds = new Set<string>();
  return value.map((item, index) => {
    const dependency = parseDependencyLock(item, index, options.published === true);
    if (aliases.has(dependency.alias)) {
      throw dependencyError(
        "duplicateAlias",
        `Project dependency alias ${JSON.stringify(dependency.alias)} is duplicated.`,
        { alias: dependency.alias },
      );
    }
    aliases.add(dependency.alias);
    if (projectIds.has(dependency.projectId)) {
      throw dependencyError(
        "duplicateDependencyProjectId",
        `Project dependency projectId ${JSON.stringify(dependency.projectId)} is duplicated.`,
        { projectId: dependency.projectId },
      );
    }
    projectIds.add(dependency.projectId);
    return dependency;
  });
}

export function parseWorkflowProjectGroupManifest(
  value: unknown,
): WorkflowProjectGroupManifestV1 {
  if (!isRecord(value) || value["version"] !== STEAMHARNESS_PROJECT_GROUP_VERSION) {
    throw dependencyError(
      "manifestVersion",
      `Project group manifest version must be ${STEAMHARNESS_PROJECT_GROUP_VERSION}.`,
      { version: STEAMHARNESS_PROJECT_GROUP_VERSION },
    );
  }
  const rootProjectId = readUuid(value["rootProjectId"], "rootProjectId");
  if (!Array.isArray(value["projects"]) || value["projects"].length === 0) {
    throw dependencyError("manifestProjects", "Project group manifest projects must be a non-empty array.");
  }
  const projectIds = new Set<string>();
  const archivePaths = new Set<string>();
  const projects = value["projects"].map((item, index) => {
    if (!isRecord(item)) {
      throw dependencyError(
        "projectObject",
        `Project group projects[${index}] must be an object.`,
        { field: `projects[${index}]` },
      );
    }
    assertSupportedFields(
      item,
      ["projectId", "role", "archivePath", "alias", "version"],
      `projects[${index}]`,
    );
    const projectId = readUuid(item["projectId"], `projects[${index}].projectId`);
    const role = item["role"];
    if (role !== "root" && role !== "dependency") {
      throw dependencyError(
        "projectRole",
        `Project group projects[${index}].role is invalid.`,
        { field: `projects[${index}].role` },
      );
    }
    const archivePath = readSafeGroupPath(item["archivePath"], `projects[${index}].archivePath`);
    if (!archivePath.endsWith(".tgz") && !archivePath.endsWith(".tar.gz")) {
      throw dependencyError(
        "archiveFormat",
        `Project group projects[${index}].archivePath must be a tar.gz archive.`,
        { field: `projects[${index}].archivePath` },
      );
    }
    const alias = readOptionalString(item["alias"], `projects[${index}].alias`);
    const version = readOptionalString(item["version"], `projects[${index}].version`);
    if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version)) {
      throw dependencyError(
        "projectVersionInvalid",
        `Project group projects[${index}].version is invalid.`,
        { field: `projects[${index}].version` },
      );
    }
    if (role === "root" && alias !== undefined) {
      throw dependencyError(
        "rootAliasForbidden",
        `Project group projects[${index}].alias is not allowed for the root project.`,
        { field: `projects[${index}].alias` },
      );
    }
    if (projectIds.has(projectId)) {
      throw dependencyError(
        "duplicateProjectId",
        `Project group projectId ${JSON.stringify(projectId)} is duplicated.`,
        { projectId },
      );
    }
    if (archivePaths.has(archivePath.toLowerCase())) {
      throw dependencyError(
        "duplicateArchivePath",
        `Project group archivePath ${JSON.stringify(archivePath)} is duplicated.`,
        { path: archivePath },
      );
    }
    projectIds.add(projectId);
    archivePaths.add(archivePath.toLowerCase());
    return {
      projectId,
      role,
      archivePath,
      ...(alias === undefined ? {} : { alias }),
      ...(version === undefined ? {} : { version }),
    } satisfies WorkflowProjectGroupProject;
  });

  const roots = projects.filter((project) => project.role === "root");
  if (roots.length !== 1 || roots[0]?.projectId !== rootProjectId) {
    throw dependencyError(
      "rootCount",
      "Project group manifest must contain exactly one matching root project.",
    );
  }

  const dependencies = parseWorkflowProjectDependencyLocks(value["dependencies"]);
  const selfReference = dependencies.find((dependency) => dependency.projectId === rootProjectId);
  if (selfReference !== undefined) {
    throw dependencyError(
      "selfReference",
      `Project group dependency ${JSON.stringify(selfReference.alias)} cannot reference the root project.`,
      { alias: selfReference.alias },
    );
  }
  const included = dependencies.filter((dependency) => dependency.delivery === "included");
  const dependencyProjects = projects.filter((project) => project.role === "dependency");
  for (const dependency of included) {
    if (!dependencyProjects.some((project) => project.projectId === dependency.projectId)) {
      throw dependencyError(
        "includedArchiveMissing",
        `Included dependency ${JSON.stringify(dependency.alias)} has no project archive.`,
        { alias: dependency.alias },
      );
    }
  }
  for (const project of dependencyProjects) {
    if (!included.some((dependency) => (
      dependency.projectId === project.projectId &&
      (project.alias === undefined || dependency.alias === project.alias)
    ))) {
      throw dependencyError(
        "dependencyNotIncluded",
        `Dependency project ${JSON.stringify(project.projectId)} is not marked included.`,
        { projectId: project.projectId },
      );
    }
  }

  return {
    version: STEAMHARNESS_PROJECT_GROUP_VERSION,
    rootProjectId,
    projects,
    dependencies,
  };
}

export function finalizeWorkflowProjectDependencyLock(
  dependency: WorkflowProjectDependencyLock,
  published: { version: string; sourceHash: string } | undefined,
): WorkflowProjectDependencyLock {
  if (dependency.delivery === "external") {
    return {
      alias: dependency.alias,
      projectId: dependency.projectId,
      delivery: "external",
    };
  }
  if (published === undefined) {
    throw dependencyError(
      "includedNotPublished",
      `Included dependency ${JSON.stringify(dependency.alias)} was not published.`,
      { alias: dependency.alias },
    );
  }
  return parseDependencyLock({
    ...dependency,
    version: published.version,
    sourceHash: published.sourceHash,
  }, 0, true);
}

export function isProjectGroupHostDataPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "").toLowerCase();
  const parts = normalized.split("/");
  if (parts.some((part) => [
    ".workflow-kv",
    ".workflow-persistent-values",
    ".workflow-runs",
    ".workflow-schedules",
    ".steamharness",
    ".workflow-files",
    ".data",
    "local-project-registries",
    "workflow-files",
  ].includes(part))) {
    return true;
  }
  const baseName = parts.at(-1) ?? "";
  if (
    baseName === "steamharness.sqlite" ||
    baseName.startsWith("steamharness.sqlite-") ||
    baseName === "workflow-auth.json" ||
    baseName === "local-projects.json"
  ) {
    return true;
  }
  return baseName === ".env" || baseName === ".envrc" ||
    (baseName.startsWith(".env.") && baseName !== ".env.example");
}

function parseDependencyLock(
  value: unknown,
  index: number,
  published: boolean,
): WorkflowProjectDependencyLock {
  if (!isRecord(value)) {
    throw dependencyError(
      "lockObject",
      `Project dependency lock[${index}] must be an object.`,
      { field: `Project dependency lock[${index}]` },
    );
  }
  assertSupportedFields(
    value,
    ["alias", "projectId", "delivery", "version", "sourceHash"],
    `dependencies[${index}]`,
  );
  const alias = readNonEmptyString(value["alias"], `dependencies[${index}].alias`);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(alias)) {
    throw dependencyError(
      "lockAlias",
      `Project dependency lock[${index}].alias is invalid.`,
      { field: `Project dependency lock[${index}].alias` },
    );
  }
  const projectId = readUuid(value["projectId"], `dependencies[${index}].projectId`);
  const delivery = value["delivery"];
  if (delivery !== "included" && delivery !== "external") {
    throw dependencyError(
      "lockDelivery",
      `Project dependency lock[${index}].delivery is invalid.`,
      { field: `Project dependency lock[${index}].delivery` },
    );
  }
  const version = readOptionalString(value["version"], `dependencies[${index}].version`);
  const sourceHash = readOptionalString(value["sourceHash"], `dependencies[${index}].sourceHash`);
  if (delivery === "external" && (version !== undefined || sourceHash !== undefined)) {
    throw dependencyError(
      "externalPinned",
      `External dependency ${JSON.stringify(alias)} cannot pin a version or source hash.`,
      { alias },
    );
  }
  if (published && delivery === "included" && (version === undefined || sourceHash === undefined)) {
    throw dependencyError(
      "includedPinRequired",
      `Included dependency ${JSON.stringify(alias)} must pin version and sourceHash.`,
      { alias },
    );
  }
  if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version)) {
    throw dependencyError(
      "includedVersionInvalid",
      `Included dependency ${JSON.stringify(alias)} has an invalid version.`,
      { alias },
    );
  }
  if (sourceHash !== undefined && !/^[a-f0-9]{64}$/.test(sourceHash)) {
    throw dependencyError(
      "includedHashInvalid",
      `Included dependency ${JSON.stringify(alias)} has an invalid sourceHash.`,
      { alias },
    );
  }
  return {
    alias,
    projectId,
    delivery,
    ...(version === undefined ? {} : { version }),
    ...(sourceHash === undefined ? {} : { sourceHash }),
  };
}

function readSafeGroupPath(value: unknown, field: string): string {
  const path = readNonEmptyString(value, field).replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw dependencyError("unsafePath", `Project group ${field} is unsafe.`, { field });
  }
  return path;
}

function readUuid(value: unknown, field: string): string {
  const result = readNonEmptyString(value, field);
  if (!isWorkflowUuid(result)) {
    throw dependencyError("uuidRequired", `Project group ${field} must be a UUID.`, { field });
  }
  return result;
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw dependencyError("nonEmptyString", `${field} must be a non-empty string.`, { field });
  }
  return value.trim();
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw dependencyError(
      "optionalNonEmptyString",
      `${field} must be a non-empty string when provided.`,
      { field },
    );
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSupportedFields(
  value: Record<string, unknown>,
  supportedFields: readonly string[],
  field: string,
): void {
  const supported = new Set(supportedFields);
  const unsupported = Object.keys(value).find((key) => !supported.has(key));
  if (unsupported !== undefined) {
    throw dependencyError(
      "unsupportedField",
      `${field}.${unsupported} is not supported.`,
      { field: `${field}.${unsupported}` },
    );
  }
}

function dependencyError(
  key: string,
  message: string,
  values?: Record<string, unknown>,
): WorkflowProjectDependencyLocalizedError {
  return Object.assign(new Error(message), {
    name: "WorkflowProjectDependencyLocalizedError",
    steamHarnessI18n: {
      namespace: "common" as const,
      key: `projectDependencies.validation.${key}`,
      ...(values === undefined ? {} : { values }),
    },
  });
}
