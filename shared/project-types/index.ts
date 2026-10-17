// Project type identity, labels, defaults, and executor capability
// live here so filters and project surfaces cannot drift from the public union.
export const WORKFLOW_PROJECT_TYPE_DEFINITIONS = [
  {
    id: "workflow",
    label: "Workflow",
    labelKey: "projectTypeWorkflow",
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

export type WorkflowProjectTypeDefinition = (typeof WORKFLOW_PROJECT_TYPE_DEFINITIONS)[number];
export type WorkflowProjectType = WorkflowProjectTypeDefinition["id"];
export type WorkflowProjectTypeIcon = WorkflowProjectTypeDefinition["defaultIcon"];
export type WorkflowExecutorProjectType = {
  [ProjectType in WorkflowProjectType]: Extract<
    WorkflowProjectTypeDefinition,
    { id: ProjectType }
  >["hasExecutor"] extends true
    ? ProjectType
    : never;
}[WorkflowProjectType];

export const WORKFLOW_PROJECT_TYPES: readonly WorkflowProjectType[] =
  WORKFLOW_PROJECT_TYPE_DEFINITIONS.map((definition) => definition.id);

export const WORKFLOW_EXECUTOR_PROJECT_TYPES: readonly WorkflowExecutorProjectType[] =
  WORKFLOW_PROJECT_TYPE_DEFINITIONS
    .filter((definition) => definition.hasExecutor)
    .map((definition) => definition.id as WorkflowExecutorProjectType);

const WORKFLOW_PROJECT_TYPE_DEFINITIONS_BY_ID = Object.fromEntries(
  WORKFLOW_PROJECT_TYPE_DEFINITIONS.map((definition) => [definition.id, definition]),
) as {
  [ProjectType in WorkflowProjectType]: Extract<
    WorkflowProjectTypeDefinition,
    { id: ProjectType }
  >;
};

export const WORKFLOW_PROJECT_TYPE_MIGRATION_EXAMPLE = `workflow.defineExecutor({
  projectType: "conversation",
  conversation: {
    inputQueue: { enabled: true },
  },
  // ...
})`;

export function isWorkflowProjectType(value: unknown): value is WorkflowProjectType {
  return typeof value === "string" && WORKFLOW_PROJECT_TYPES.includes(value as WorkflowProjectType);
}

export function isWorkflowExecutorProjectType(value: unknown): value is WorkflowExecutorProjectType {
  return typeof value === "string" &&
    WORKFLOW_EXECUTOR_PROJECT_TYPES.includes(value as WorkflowExecutorProjectType);
}

export function getWorkflowProjectTypeDefinition<ProjectType extends WorkflowProjectType>(
  projectType: ProjectType,
): Extract<WorkflowProjectTypeDefinition, { id: ProjectType }> {
  return WORKFLOW_PROJECT_TYPE_DEFINITIONS_BY_ID[projectType];
}

export function getWorkflowProjectTypeLabel(projectType: WorkflowProjectType): string {
  return getWorkflowProjectTypeDefinition(projectType).label;
}

export function getWorkflowProjectTypeLabelKey(
  projectType: WorkflowProjectType,
): WorkflowProjectTypeDefinition["labelKey"] {
  return getWorkflowProjectTypeDefinition(projectType).labelKey;
}

export function assertNeverWorkflowProjectType(value: never): never {
  throw new Error(`Unsupported workflow project type "${String(value)}".`);
}

export function assertNeverWorkflowExecutorProjectType(value: never): never {
  throw new Error(`Unsupported workflow executor project type "${String(value)}".`);
}

export function assertWorkflowProjectType(value: unknown): asserts value is WorkflowProjectType {
  if (!isWorkflowProjectType(value)) {
    throw new Error(
      `${formatWorkflowProjectTypeMigrationMessage("Executor projectType is missing or unknown")}\n\n${WORKFLOW_PROJECT_TYPE_MIGRATION_EXAMPLE}`,
    );
  }
}

export function assertWorkflowExecutorProjectType(
  value: unknown,
): asserts value is WorkflowExecutorProjectType {
  if (!isWorkflowExecutorProjectType(value)) {
    throw new Error(
      `${formatWorkflowProjectTypeMigrationMessage("Executor projectType is missing or unknown")}\n\n${WORKFLOW_PROJECT_TYPE_MIGRATION_EXAMPLE}`,
    );
  }
}

export function formatWorkflowProjectTypeMigrationMessage(reason: string): string {
  return `${reason}. Declare executor projectType as one of: ${WORKFLOW_EXECUTOR_PROJECT_TYPES.map((type) => `"${type}"`).join(", ")}.`;
}
