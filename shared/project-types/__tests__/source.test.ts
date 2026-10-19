import { describe, expect, it } from "vitest";
import {
  inspectProjectTypeSources,
  readProjectTypeFromSources,
} from "@steamharness/project-types/source";

describe("project type source inspection", () => {
  it("extracts both supported project types", () => {
    expect(readProjectTypeFromSources([{ fileName: "index.ts", sourceText: executor('projectType: "workflow",') }]))
      .toBe("workflow");
    expect(readProjectTypeFromSources([{ fileName: "index.ts", sourceText: executor(`
      projectType: "conversation",
      conversation: { inputQueue: { enabled: true } },
    `) }])).toBe("conversation");
  });

  it("extracts project type from the named defineProjectExecutor entry", () => {
    expect(readProjectTypeFromSources([{
      fileName: "index.ts",
      sourceText: executor('projectType: "workflow",').replace(
        "steamharness.defineExecutor",
        "defineProjectExecutor",
      ),
    }])).toBe("workflow");
  });

  it("accepts quoted static property names", () => {
    expect(readProjectTypeFromSources([{
      fileName: "index.ts",
      sourceText: executor(`
        "projectType": "conversation",
        "conversation": { "attachments": { images: true } },
      `),
    }])).toBe("conversation");
  });

  it("rejects missing and unknown project types with a migration example", () => {
    expect(() => readProjectTypeFromSources([{ fileName: "index.ts", sourceText: executor("") }]))
      .toThrow(/Migration example:[\s\S]*projectType: "conversation"/);
    expect(() => readProjectTypeFromSources([{ fileName: "index.ts", sourceText: executor('projectType: "agent",') }]))
      .toThrow(/Unknown executor projectType "agent"/);
  });

  it("rejects legacy enabled and workflow conversation settings", () => {
    const inspection = inspectProjectTypeSources([{ fileName: "index.ts", sourceText: executor(`
      projectType: "workflow",
      conversation: { enabled: true },
    `) }]);
    expect(inspection.violations.map((violation) => violation.type)).toEqual([
      "legacy_conversation_enabled",
      "project_type_configuration_conflict",
    ]);
  });

  it("rejects conflicting project types across source files", () => {
    const inspection = inspectProjectTypeSources([
      { fileName: "index.ts", sourceText: executor('projectType: "workflow",') },
      { fileName: "secondary.ts", sourceText: executor('projectType: "conversation",') },
    ]);

    expect(inspection.projectType).toBeUndefined();
    expect(inspection.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "project_type_configuration_conflict",
        message: expect.stringContaining("conflicting executor project types"),
      }),
    ]));
  });
});

it.each([true, false])("rejects removed defaultInput settings with enabled=%s", enabled => {
  expect(() => readProjectTypeFromSources([{
    fileName: "index.ts",
    sourceText: executor(`projectType: "conversation", conversation: { defaultInput: { enabled: ${enabled} } },`),
  }])).toThrow(/conversation\.defaultInput was removed/);
});

function executor(properties: string): string {
  return `steamharness.defineExecutor({
    ${properties}
    workflow: demo,
    createInput() { return {}; },
  });`;
}
