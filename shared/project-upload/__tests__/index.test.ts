import { describe, expect, it } from "vitest";
import {
  STEAMHARNESS_IGNORE_FILE,
  createProjectUploadPortablePathKey,
  createProjectUploadMatcher,
  hasProjectIgnoreRules,
  normalizeProjectUploadPath,
  resolveProjectUploadRequiredPaths,
} from "../index";

describe("workflow upload ignore", () => {
  it("treats missing, empty, and comment-only ignore files as unconfigured", () => {
    expect(hasProjectIgnoreRules(undefined)).toBe(false);
    expect(hasProjectIgnoreRules("\n# explanation\r\n  ")).toBe(false);
    expect(hasProjectIgnoreRules("# explanation\ndist/**/*.map\n")).toBe(true);
  });
  it("uploads every regular path when .steamharnessignore is missing or empty", () => {
    for (const content of [undefined, ""]) {
      const matcher = createProjectUploadMatcher(content);
      expect(matcher.ignores("node_modules/pkg/index.js")).toBe(false);
      expect(matcher.ignores(".git/config")).toBe(false);
      expect(matcher.ignores(".env")).toBe(false);
      expect(matcher.ignores("dist/index.html")).toBe(false);
    }
  });

  it("supports Dockerignore-style globs, directories, and negation", () => {
    const matcher = createProjectUploadMatcher([
      "node_modules/",
      "dist/**/*.map",
      "reports/**",
      "!reports/public/",
      "!reports/public/**",
    ].join("\n"));

    expect(matcher.ignores("node_modules/pkg/index.js")).toBe(true);
    expect(matcher.ignores("dist/assets/app.js")).toBe(false);
    expect(matcher.ignores("dist/assets/app.js.map")).toBe(true);
    expect(matcher.ignores("reports/private/result.json")).toBe(true);
    expect(matcher.ignores("reports/public/result.json")).toBe(false);
  });

  it("normalizes Windows separators and always retains .steamharnessignore", () => {
    const matcher = createProjectUploadMatcher("assets/**\n.steamharnessignore\n");
    expect(matcher.ignores("assets\\app.js")).toBe(true);
    expect(matcher.ignores(STEAMHARNESS_IGNORE_FILE)).toBe(false);
    expect(normalizeProjectUploadPath("dist\\index.html")).toBe("dist/index.html");
  });

  it("rejects required paths excluded by the effective rule", () => {
    const matcher = createProjectUploadMatcher("dist/\n!dist/\n!dist/assets/**\ndist/index.html\n");
    expect(() => matcher.assertRequiredPaths(["package.json", "dist/index.html"]))
      .toThrow('Required upload path "dist/index.html" is excluded by .steamharnessignore by rule "dist/index.html".');
  });

  it("requires only package metadata and the project entry for executable projects", () => {
    expect(resolveProjectUploadRequiredPaths({}, ["package.json", "index.ts", "README.md"]))
      .toEqual(["package.json", "index.ts"]);
  });

  it("rejects absolute and traversal paths before matching", () => {
    for (const value of ["../secret", "/absolute", "C:\\secret", "a/../b"]) {
      expect(() => normalizeProjectUploadPath(value)).toThrow("Invalid workflow upload path");
    }
  });

  it("uses a case-insensitive normalized key for cross-platform path collisions", () => {
    expect(createProjectUploadPortablePathKey("Assets\\Cafe\u0301.PNG"))
      .toBe(createProjectUploadPortablePathKey("assets/Caf\u00e9.png"));
  });
});
