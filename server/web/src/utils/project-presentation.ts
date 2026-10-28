
import { STEAMHARNESS_PROJECT_DECLARATION_DEFINITIONS, STEAMHARNESS_PROJECT_PLATFORM_DEFINITIONS, resolveProjectName } from "@steamharness/project-info";
import type { Summary } from "../types";



export interface ProjectPresentationLabel {
  id: string;
  labelKey?: string;
}

const DECLARATION_LABEL_KEYS = new Map<string, string>(
  STEAMHARNESS_PROJECT_DECLARATION_DEFINITIONS.map((definition) => [definition.id, definition.labelKey]),
);

const PLATFORM_LABEL_KEYS = new Map<string, string>(
  STEAMHARNESS_PROJECT_PLATFORM_DEFINITIONS.map((definition) => [definition.id, definition.labelKey]),
);

export function getProjectDisplayName(
  project: Pick<Summary, "name" | "projectInfo">,
  locale: string,
): string {
  return resolveProjectName(project.name, project.projectInfo, locale);
}



export function listProjectDeclarationLabels(
  project: Pick<Summary, "projectInfo">,
): ProjectPresentationLabel[] {
  return project.projectInfo.declarations.map((id) => ({
    id,
    labelKey: DECLARATION_LABEL_KEYS.get(id),
  }));
}

export function listProjectPlatformLabels(
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
