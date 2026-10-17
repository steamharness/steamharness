
import { WORKFLOW_PROJECT_DECLARATION_DEFINITIONS, WORKFLOW_PROJECT_PLATFORM_DEFINITIONS, isWorkflowProjectDataStorageLocationAllowed, resolveWorkflowProjectName } from "@workflow-code/project-info";
import type { WorkflowSummary } from "../types";



export interface WorkflowProjectPresentationLabel {
  id: string;
  labelKey?: string;
}

export type WorkflowProjectServerStorageAccess =
  | { allowed: true; mode: "server" | "both" }
  | { allowed: false; mode: "local" | null };

const DECLARATION_LABEL_KEYS = new Map<string, string>(
  WORKFLOW_PROJECT_DECLARATION_DEFINITIONS.map((definition) => [definition.id, definition.labelKey]),
);

const PLATFORM_LABEL_KEYS = new Map<string, string>(
  WORKFLOW_PROJECT_PLATFORM_DEFINITIONS.map((definition) => [definition.id, definition.labelKey]),
);

export function getWorkflowProjectDisplayName(
  project: Pick<WorkflowSummary, "name" | "projectInfo">,
  locale: string,
): string {
  return resolveWorkflowProjectName(project.name, project.projectInfo, locale);
}



export function getWorkflowProjectServerStorageAccess(
  project: Pick<WorkflowSummary, "projectInfo">,
): WorkflowProjectServerStorageAccess {
  const mode = project.projectInfo.dataStorage?.mode ?? null;
  if (isWorkflowProjectDataStorageLocationAllowed(project.projectInfo, "server")) {
    return { allowed: true, mode: mode as "server" | "both" };
  }
  return { allowed: false, mode: mode === "local" ? "local" : null };
}

export function listWorkflowProjectDeclarationLabels(
  project: Pick<WorkflowSummary, "projectInfo">,
): WorkflowProjectPresentationLabel[] {
  return project.projectInfo.declarations.map((id) => ({
    id,
    labelKey: DECLARATION_LABEL_KEYS.get(id),
  }));
}

export function listWorkflowProjectPlatformLabels(
  project: Pick<WorkflowSummary, "projectInfo">,
): WorkflowProjectPresentationLabel[] {
  if (project.projectInfo.platformSupport.mode === "agnostic") {
    return [{ id: "agnostic", labelKey: "projectPlatformAgnostic" }];
  }
  return project.projectInfo.platformSupport.platforms.map((id) => ({
    id,
    labelKey: PLATFORM_LABEL_KEYS.get(id),
  }));
}
