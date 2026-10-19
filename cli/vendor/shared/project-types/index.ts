// Project type identity, labels, defaults, and executor capability
// live here so filters and project surfaces cannot drift from the public union.
export const STEAMHARNESS_PROJECT_TYPE_DEFINITIONS = [
  {
    id: "workflow",
    label: "Workflow",
    labelKey: "projectTypeProject",
    defaultIcon: "workflow",
    defaultIconBackgroundColor: "#2563eb",
    hasExecutor: true,
  },
  {
    id: "conversation",
    label: "Conversation",
    labelKey: "projectTypeConversation",
    defaultIcon: "message-circle",
    defaultIconBackgroundColor: "#0f766e",
    hasExecutor: true,
  },
  {
    id: "kanban",
    label: "Kanban",
    labelKey: "projectTypeKanban",
    defaultIcon: "boxes",
    defaultIconBackgroundColor: "#b45309",
    hasExecutor: false,
  },
] as const;

export type ProjectTypeDefinition = (typeof STEAMHARNESS_PROJECT_TYPE_DEFINITIONS)[number];
export type ProjectKind = ProjectTypeDefinition["id"];
export type ProjectTypeIcon = ProjectTypeDefinition["defaultIcon"];
export type ExecutorProjectType = {
  [ProjectType in ProjectKind]: Extract<
    ProjectTypeDefinition,
    { id: ProjectType }
  >["hasExecutor"] extends true
    ? ProjectType
    : never;
}[ProjectKind];

export const STEAMHARNESS_PROJECT_TYPES: readonly ProjectKind[] =
  STEAMHARNESS_PROJECT_TYPE_DEFINITIONS.map((definition) => definition.id);

export const STEAMHARNESS_EXECUTOR_PROJECT_TYPES: readonly ExecutorProjectType[] =
  STEAMHARNESS_PROJECT_TYPE_DEFINITIONS
    .filter((definition) => definition.hasExecutor)
    .map((definition) => definition.id as ExecutorProjectType);

const STEAMHARNESS_PROJECT_TYPE_DEFINITIONS_BY_ID = Object.fromEntries(
  STEAMHARNESS_PROJECT_TYPE_DEFINITIONS.map((definition) => [definition.id, definition]),
) as {
  [ProjectType in ProjectKind]: Extract<
    ProjectTypeDefinition,
    { id: ProjectType }
  >;
};

export const STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE = `workflow.defineExecutor({
  projectType: "conversation",
  conversation: {
    inputQueue: { enabled: true },
  },
  // ...
})`;

export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === "string" && STEAMHARNESS_PROJECT_TYPES.includes(value as ProjectKind);
}

export function isExecutorProjectKind(value: unknown): value is ExecutorProjectType {
  return typeof value === "string" &&
    STEAMHARNESS_EXECUTOR_PROJECT_TYPES.includes(value as ExecutorProjectType);
}

export function getProjectKindDefinition<ProjectType extends ProjectKind>(
  projectType: ProjectType,
): Extract<ProjectTypeDefinition, { id: ProjectType }> {
  return STEAMHARNESS_PROJECT_TYPE_DEFINITIONS_BY_ID[projectType];
}

export function getProjectKindLabel(projectType: ProjectKind): string {
  return getProjectKindDefinition(projectType).label;
}

export function getProjectKindLabelKey(
  projectType: ProjectKind,
): ProjectTypeDefinition["labelKey"] {
  return getProjectKindDefinition(projectType).labelKey;
}

export function assertNeverProjectKind(value: never): never {
  throw new Error(`Unsupported workflow project type "${String(value)}".`);
}

export function assertNeverExecutorProjectKind(value: never): never {
  throw new Error(`Unsupported workflow executor project type "${String(value)}".`);
}

export function assertProjectKind(value: unknown): asserts value is ProjectKind {
  if (!isProjectKind(value)) {
    throw new Error(
      `${formatProjectKindMigrationMessage("Executor projectType is missing or unknown")}\n\n${STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE}`,
    );
  }
}

export function assertExecutorProjectKind(
  value: unknown,
): asserts value is ExecutorProjectType {
  if (!isExecutorProjectKind(value)) {
    throw new Error(
      `${formatProjectKindMigrationMessage("Executor projectType is missing or unknown")}\n\n${STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE}`,
    );
  }
}

export function formatProjectKindMigrationMessage(reason: string): string {
  return `${reason}. Declare executor projectType as one of: ${STEAMHARNESS_EXECUTOR_PROJECT_TYPES.map((type) => `"${type}"`).join(", ")}.`;
}
