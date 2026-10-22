import { expect, it } from "vitest";
import { resolveResourceAccess, isProjectRole } from "../index";
it("takes the highest direct, ancestor and public role without changing its sources", () => {
  const sources = [
    { type: "project" as const, id: "project", role: "guest" as const },
    { type: "group" as const, id: "ancestor", role: "maintainer" as const },
    { type: "group" as const, id: "parent", role: "developer" as const },
    { type: "public" as const, id: "project", role: "guest" as const },
  ];
  const result = resolveResourceAccess(sources);
  expect(result.effectiveRole).toBe("maintainer");
  expect(result.sources).toEqual(sources);
  expect(result.capabilities).toContain("manageSettings");
  expect(result.capabilities).not.toContain("delete");
  expect(resolveResourceAccess([]).effectiveRole).toBeNull();
  expect(resolveResourceAccess([], { isSystemAdmin: true }).effectiveRole).toBe(
    "owner",
  );
  for (const old of ["manager", "writer", "viewer", "admin", null, {}])
    expect(isProjectRole(old)).toBe(false);
});
