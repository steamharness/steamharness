import { describe, expect, it } from "vitest";
import {
  getProjectKindDefinition,
  getProjectKindLabel,
  getProjectKindLabelKey,
  isExecutorProjectKind,
  isProjectKind,
  STEAMHARNESS_EXECUTOR_PROJECT_TYPES,
  STEAMHARNESS_PROJECT_TYPE_DEFINITIONS,
  STEAMHARNESS_PROJECT_TYPES,
} from "../index";

describe("project type registry", () => {
  it("derives the public type list from one unique ordered registry", () => {
    const registeredTypes = STEAMHARNESS_PROJECT_TYPE_DEFINITIONS.map((definition) => definition.id);

    expect(STEAMHARNESS_PROJECT_TYPES).toEqual(registeredTypes);
    expect(new Set(registeredTypes).size).toBe(registeredTypes.length);
    expect(registeredTypes).toEqual(["workflow", "conversation", "kanban"]);
  });

  it("derives the executor subset without treating Kanban as runnable", () => {
    const registeredExecutorTypes = STEAMHARNESS_PROJECT_TYPE_DEFINITIONS
      .filter((definition) => definition.hasExecutor)
      .map((definition) => definition.id);

    expect(STEAMHARNESS_EXECUTOR_PROJECT_TYPES).toEqual(registeredExecutorTypes);
    expect(STEAMHARNESS_EXECUTOR_PROJECT_TYPES).toEqual(["workflow", "conversation"]);
    expect(isExecutorProjectKind("kanban")).toBe(false);
    expect(getProjectKindDefinition("kanban").hasExecutor).toBe(false);
  });

  it("provides labels and card defaults through the same registry", () => {
    expect(getProjectKindLabel("conversation")).toBe("Conversation");
    expect(getProjectKindLabelKey("workflow")).toBe("projectTypeProject");
    expect(getProjectKindLabelKey("conversation")).toBe("projectTypeConversation");
    expect(getProjectKindDefinition("kanban")).toMatchObject({
      label: "Kanban",
      labelKey: "projectTypeKanban",
      defaultIcon: "boxes",
      defaultIconBackgroundColor: "#b45309",
    });
  });

  it("keeps runtime guards aligned with registered types", () => {
    for (const projectType of STEAMHARNESS_PROJECT_TYPES) {
      expect(isProjectKind(projectType)).toBe(true);
    }
    expect(isProjectKind("dashboard")).toBe(false);
    expect(isProjectKind(undefined)).toBe(false);
  });
});
