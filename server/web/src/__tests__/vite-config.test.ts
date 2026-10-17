// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readLocalSharedAliases } from "../../vite.config";

describe("Server Web Vite configuration", () => {
  it("aliases local Shared package entrypoints and subpaths for HMR", async () => {
    const sharedRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-server-web-vite-shared-"));
    const packageRoot = path.join(sharedRoot, "run-workspace-input");
    const releaseToolsRoot = path.join(sharedRoot, "release-tools");
    await Promise.all([
      mkdir(packageRoot, { recursive: true }),
      mkdir(releaseToolsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
        name: "@workflow-code/run-workspace-input",
        types: "./index.ts",
        exports: {
          ".": { types: "./index.ts", import: "./index.ts" },
          "./internal": { types: "./RenamedInternal.ts", import: "./RenamedInternal.ts" },
        },
      })}\n`),
      writeFile(path.join(releaseToolsRoot, "package.json"), `${JSON.stringify({
        name: "@workflow-code/release-tools",
        private: true,
        type: "module",
      })}\n`),
    ]);

    const aliases = readLocalSharedAliases(sharedRoot);

    expect(aliases).toHaveLength(3);
    expect(aliases[0]?.find.test("@workflow-code/run-workspace-input")).toBe(true);
    expect(aliases[0]?.replacement).toBe(path.join(packageRoot, "index.ts"));
    expect(aliases[1]?.find.test("@workflow-code/run-workspace-input/internal")).toBe(true);
    expect(aliases[1]?.replacement).toBe(path.join(packageRoot, "RenamedInternal.ts"));
    expect(aliases[2]?.find.test("@workflow-code/run-workspace-input/fallback")).toBe(true);
    expect(aliases[2]?.replacement).toBe(`${packageRoot}${path.sep}`);
  });
});
