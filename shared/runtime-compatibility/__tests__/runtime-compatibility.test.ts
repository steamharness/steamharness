import { describe, expect, it } from "vitest";
import {
  assertCoreCompatibility,
  classifyVersionReference,
  evaluateCoreCompatibility,
  formatSupportedProjectCoreRange,
  readExactDevDependency,
  readRequiredCoreVersion,
  resolveReleaseMode,
  resolveRequiredCoreVersion,
  resolveSiblingDirectory,
} from "../index";

describe("workflow Core compatibility", () => {
  it("reads only an exact Core version from devDependencies", () => {
    expect(readRequiredCoreVersion({ devDependencies: { "workflow-code": "0.1.2" } })).toBe("0.1.2");
    for (const version of ["^0.1.2", ">=0.1.0 <0.2.0", "workspace:*", "file:../core", "v0.1.2"]) {
      expect(() => readRequiredCoreVersion({ devDependencies: { "workflow-code": version } })).toThrow(/exact SemVer/);
    }
    expect(() => readRequiredCoreVersion({})).toThrow(/devDependencies\.workflow-code/);
  });

  it("accepts every patch in the same major.minor compatibility line", () => {
    expect(evaluateCoreCompatibility("0.1.3", "0.1.0").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.1.3", "0.1.4").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.1.0", "0.1.999").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.0.3", "0.0.2").compatible).toBe(true);
    expect(evaluateCoreCompatibility("1.3.0", "1.3.99").compatible).toBe(true);
  });

  it("rejects major or minor changes in either direction", () => {
    expect(evaluateCoreCompatibility("0.2.0", "0.1.0").compatible).toBe(false);
    expect(evaluateCoreCompatibility("0.1.9", "0.2.0").compatible).toBe(false);
    expect(evaluateCoreCompatibility("1.3.0", "1.2.99").compatible).toBe(false);
    expect(evaluateCoreCompatibility("2.0.0", "1.9.0").compatible).toBe(false);
  });

  it("applies the same line rule to stable and prerelease versions", () => {
    expect(evaluateCoreCompatibility("0.1.4-20260814004", "0.1.0").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.1.4-20260814004", "0.1.5").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.1.4-20260814004", "0.1.4-20260814003").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.1.4-20260814003", "0.1.4-20260814005").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.1.5-20260825001", "0.1.4-20260818001").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.1.3-20260825001", "0.1.4-20260818001").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.1.4-beta.1", "0.1.9").compatible).toBe(true);
    expect(evaluateCoreCompatibility("0.2.0-20260825001", "0.1.4-20260818001").compatible).toBe(false);
  });

  it("reports actionable incompatibility and display ranges", () => {
    expect(() => assertCoreCompatibility("0.1.9", "0.2.3")).toThrow(
      /requires exact Core 0\.2\.3 \(0\.2\.x compatibility line\).*provides Core 0\.1\.9/,
    );
    expect(formatSupportedProjectCoreRange("0.0.3")).toBe("0.0.x");
    expect(formatSupportedProjectCoreRange("0.1.3")).toBe("0.1.x");
    expect(formatSupportedProjectCoreRange("1.2.3")).toBe("1.2.x");
    expect(formatSupportedProjectCoreRange("0.1.4-20260814004")).toBe("0.1.x");
  });

  it("reads any package's exact devDependency", () => {
    expect(readExactDevDependency({ devDependencies: { "@workflow-code/cli": "0.1.2" } }, "@workflow-code/cli")).toBe("0.1.2");
    expect(() => readExactDevDependency({}, "@workflow-code/cli")).toThrow(/devDependencies\.@workflow-code\/cli/);
  });

  it("classifies local sibling references apart from exact versions", () => {
    const manifest = (value: string) => ({ devDependencies: { "workflow-code": value } });
    expect(classifyVersionReference(manifest("0.2.4-20260921001"), "workflow-code"))
      .toEqual({ kind: "exact", version: "0.2.4-20260921001", specifier: "0.2.4-20260921001" });
    expect(classifyVersionReference(manifest("link:../core"), "workflow-code"))
      .toEqual({ kind: "local", specifier: "link:../core", relative: "../core" });
    for (const value of ["file:core", "file:/abs/core", "workspace:*"]) {
      expect(() => classifyVersionReference(manifest(value), "workflow-code")).toThrow(/relative file:|exact SemVer/);
    }
  });

  it("treats main, alpha and tagged pipelines as release mode", () => {
    expect(resolveReleaseMode({})).toBe("dev");
    expect(resolveReleaseMode({ CI_COMMIT_BRANCH: "codex/pi-agent" })).toBe("dev");
    // alpha publishes, so it must not be classified as a development branch.
    expect(resolveReleaseMode({ CI_COMMIT_BRANCH: "alpha" })).toBe("main");
    expect(resolveReleaseMode({ CI_COMMIT_BRANCH: "main" })).toBe("main");
    expect(resolveReleaseMode({ CI_COMMIT_TAG: "workflow-code/v0.2.4" })).toBe("main");
    expect(() => resolveReleaseMode({ WORKFLOW_REPOSITORY_MODE: "dev" })).toThrow(/fail-closed override/);
  });

  it("normalises sibling references against the workspace root", () => {
    expect(resolveSiblingDirectory("../core", "build-in-codex")).toBe("core");
    expect(resolveSiblingDirectory("./core", "cli")).toBe("cli/core");
    expect(resolveSiblingDirectory("../shared/i18n", "cli")).toBe("shared/i18n");
    expect(() => resolveSiblingDirectory("../..", "build-in-codex")).toThrow(/inside the workspace root/);
    expect(() => resolveSiblingDirectory("../../etc", "build-in-codex")).toThrow(/inside the workspace root/);
    expect(() => resolveSiblingDirectory("..", "build-in-codex")).toThrow(/workspace root/);
  });

  it("resolves a local Core reference on dev and refuses it on main", () => {
    const manifest = { devDependencies: { "workflow-code": "link:../core" } };
    const readSiblingManifest = (directory: string) => {
      expect(directory).toBe("core");
      return { name: "workflow-code", version: "0.2.4-20260921001" };
    };

    expect(resolveRequiredCoreVersion(manifest, {
      mode: "dev",
      repositoryDirectory: "build-in-codex",
      readSiblingManifest,
    })).toBe("0.2.4-20260921001");

    expect(() => resolveRequiredCoreVersion(manifest, {
      mode: "main",
      repositoryDirectory: "build-in-codex",
      readSiblingManifest,
    })).toThrow(/must declare an exact published version on main and alpha/);

    // An exact declaration never consults the sibling.
    expect(resolveRequiredCoreVersion({ devDependencies: { "workflow-code": "0.2.4" } }, {
      mode: "dev",
      repositoryDirectory: "build-in-codex",
      readSiblingManifest: () => {
        throw new Error("must not read the sibling for an exact declaration");
      },
    })).toBe("0.2.4");
  });
});
