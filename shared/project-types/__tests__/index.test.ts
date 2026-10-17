import { describe, expect, it } from "vitest";
import {
  getWorkflowProjectTypeDefinition,
  getWorkflowProjectTypeLabel,
  getWorkflowProjectTypeLabelKey,
  isWorkflowExecutorProjectType,
  isWorkflowProjectType,
  WORKFLOW_EXECUTOR_PROJECT_TYPES,
  WORKFLOW_PROJECT_TYPE_DEFINITIONS,
  WORKFLOW_PROJECT_TYPES,
} from "../index";

describe("project type registry", () => {
  it("derives the public type list from one unique ordered registry", () => {
    const registeredTypes = WORKFLOW_PROJECT_TYPE_DEFINITIONS.map((definition) => definition.id);

    expect(WORKFLOW_PROJECT_TYPES).toEqual(registeredTypes);
    expect(new Set(registeredTypes).size).toBe(registeredTypes.length);
    expect(registeredTypes).toEqual(["workflow", "conversation", "kanban"]);
  });

  it("derives the executor subset without treating Kanban as runnable", () => {
    const registeredExecutorTypes = WORKFLOW_PROJECT_TYPE_DEFINITIONS
      .filter((definition) => definition.hasExecutor)
      .map((definition) => definition.id);

    expect(WORKFLOW_EXECUTOR_PROJECT_TYPES).toEqual(registeredExecutorTypes);
    expect(WORKFLOW_EXECUTOR_PROJECT_TYPES).toEqual(["workflow", "conversation"]);
    expect(isWorkflowExecutorProjectType("kanban")).toBe(false);
    expect(getWorkflowProjectTypeDefinition("kanban").hasExecutor).toBe(false);
  });

  it("provides labels and card defaults through the same registry", () => {
    expect(getWorkflowProjectTypeLabel("conversation")).toBe("Conversation");
    expect(getWorkflowProjectTypeLabelKey("workflow")).toBe("projectTypeWorkflow");
    expect(getWorkflowProjectTypeLabelKey("conversation")).toBe("projectTypeConversation");
    expect(getWorkflowProjectTypeDefinition("kanban")).toMatchObject({
      label: "Kanban",
      labelKey: "projectTypeKanban",
      defaultIcon: "boxes",
      defaultIconBackgroundColor: "#b45309",
    });
  });

  it("keeps runtime guards aligned with registered types", () => {
    for (const projectType of WORKFLOW_PROJECT_TYPES) {
      expect(isWorkflowProjectType(projectType)).toBe(true);
    }
    expect(isWorkflowProjectType("dashboard")).toBe(false);
    expect(isWorkflowProjectType(undefined)).toBe(false);
  });
});
