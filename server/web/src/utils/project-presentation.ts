
import { STEAMHARNESS_PROJECT_DECLARATION_DEFINITIONS, STEAMHARNESS_PROJECT_PLATFORM_DEFINITIONS, isWorkflowProjectDataStorageLocationAllowed, resolveWorkflowProjectName } from "@steamharness/project-info";
import type { Summary } from "../types";



export interface ProjectPresentationLabel {
  id: string;
  labelKey?: string;
}

export type ProjectServerStorageAccess =
  | { allowed: true; mode: "server" | "both" }
  | { allowed: false; mode: "local" | null };

const DECLARATION_LABEL_KEYS = new Map<string, string>(
  STEAMHARNESS_PROJECT_DECLARATION_DEFINITIONS.map((definition) => [definition.id, definition.labelKey]),
);

const PLATFORM_LABEL_KEYS = new Map<string, string>(
  STEAMHARNESS_PROJECT_PLATFORM_DEFINITIONS.map((definition) => [definition.id, definition.labelKey]),
);

export function getWorkflowProjectDisplayName(
  project: Pick<Summary, "name" | "projectInfo">,
  locale: string,
): string {
  return resolveWorkflowProjectName(project.name, project.projectInfo, locale);
}



export function getWorkflowProjectServerStorageAccess(
  project: Pick<Summary, "projectInfo">,
): ProjectServerStorageAccess {
  const mode = project.projectInfo.dataStorage?.mode ?? null;
  if (isWorkflowProjectDataStorageLocationAllowed(project.projectInfo, "server")) {
    return { allowed: true, mode: mode as "server" | "both" };
  }
  return { allowed: false, mode: mode === "local" ? "local" : null };
}

export function listWorkflowProjectDeclarationLabels(
  project: Pick<Summary, "projectInfo">,
): ProjectPresentationLabel[] {
  return project.projectInfo.declarations.map((id) => ({
    id,
    labelKey: DECLARATION_LABEL_KEYS.get(id),
  }));
}

export function listWorkflowProjectPlatformLabels(
  project: Pick<Summary, "projectInfo">,
): ProjectPresentationLabel[] {
  if (project.projectInfo.platformSupport.mode === "agnostic") {
    return [{ id: "agnostic", labelKey: "projectPlatformAgnostic" }];
  }
  return project.projectInfo.platformSupport.platforms.map((id) => ({
    id,
    labelKey: PLATFORM_LABEL_KEYS.get(id),
  }));
}
