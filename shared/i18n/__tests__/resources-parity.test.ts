import { describe, expect, it } from "vitest";
import { enResources } from "../resources/en";
import { zhResources } from "../resources/zh";

function collectLeafKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [];
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") return collectLeafKeys(value, path);
    return [path];
  });
}

function assertLeavesAreNonEmptyStrings(obj: unknown, path = ""): void {
  if (obj === null || typeof obj !== "object") {
    throw new TypeError(`expected object at ${path}`);
  }
  for (const [key, value] of Object.entries(obj)) {
    const full = path ? `${path}.${key}` : key;
    if (value !== null && typeof value === "object") {
      assertLeavesAreNonEmptyStrings(value, full);
    } else {
      expect(typeof value, `leaf ${full} must be a string`).toBe("string");
      expect((value as string).length, `leaf ${full} must be non-empty`).toBeGreaterThan(0);
    }
  }
}

describe("i18n resource parity", () => {
  it("exposes Desktop as a distinct namespace without the former App alias", () => {
    expect(Object.hasOwn(enResources, "desktop")).toBe(true);
    expect(Object.hasOwn(enResources, "app")).toBe(false);
    expect(Object.hasOwn(zhResources, "desktop")).toBe(true);
    expect(Object.hasOwn(zhResources, "app")).toBe(false);
  });

  it("en and zh expose identical key sets", () => {
    const enKeys = collectLeafKeys(enResources).sort();
    const zhKeys = collectLeafKeys(zhResources).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("every leaf value is a non-empty string in both languages", () => {
    assertLeavesAreNonEmptyStrings(enResources);
    assertLeavesAreNonEmptyStrings(zhResources);
  });
});
