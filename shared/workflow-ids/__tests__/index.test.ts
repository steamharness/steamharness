import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  assertSafeProjectId,
  createInvalidProjectUuidMessage,
  isProjectUuid,
  resolveProjectRoot,
} from "@steamharness/workflow-ids";

describe("workflow-ids package", () => {
  it("accepts safe workflow ids and resolves roots under the workflow directory", () => {
    expect(assertSafeProjectId("demo-flow")).toBe("demo-flow");
    const projectsRoot = path.resolve("workflow-id-test-root");
    expect(resolveProjectRoot(projectsRoot, "demo-flow")).toBe(path.join(projectsRoot, "demo-flow"));
  });

  it("rejects invalid workflow ids and reports invalid UUID messages", () => {
    expect(() => assertSafeProjectId("../demo")).toThrow('Invalid workflow id "../demo".');
    expect(createInvalidProjectUuidMessage("demo")).toBe('Invalid workflow id "demo". Expected a UUID.');
  });

  it("detects UUID workflow ids", () => {
    expect(isProjectUuid("9f379ef4-bdb5-45ee-8b7b-77820808d332")).toBe(true);
    expect(isProjectUuid("demo")).toBe(false);
  });
});
