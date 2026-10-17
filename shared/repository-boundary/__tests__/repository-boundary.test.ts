import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRepositoryBoundaries, scanPreparedRepositoryMode, scanRepositoryBoundaries } from "../index";

describe("repository boundary scanner", () => {
  it("reports cross-repository imports, dependency links, and TypeScript config references", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-boundary-"));
    const root = path.join(parent, "desktop");
    await mkdir(path.join(root, "src"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "src", "index.ts"), 'import "../../core/src/index";\n'),
      writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "steamharness": "link:../harness" } })),
      writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
        extends: "../core/tsconfig.json",
        references: [{ path: "../shared" }],
        compilerOptions: { paths: { "steamharness": ["../core/src/index.ts"] } },
      })),
    ]);

    const violations = await scanRepositoryBoundaries(root);
    expect(violations.map((violation) => violation.kind)).toEqual([
      "relative-package-dependency",
      "cross-repository-import",
      "cross-repository-config-reference",
      "cross-repository-config-reference",
      "cross-repository-path-alias",
    ]);
    expect(() => assertRepositoryBoundaries(violations)).toThrow(/Repository boundary violations/);
  });

  it("allows repository-internal relatives and runtime-generated development adapters", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-boundary-allowed-"));
    const root = path.join(parent, "server");
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, "src", "pages"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "src", "types.ts"), "export type Value = string;\n"),
      writeFile(path.join(root, "src", "pages", "page.ts"), 'import type { Value } from "../types";\n'),
      writeFile(
        path.join(root, "scripts", "development-sources.mjs"),
        'import path from "node:path";\nexport const core = path.resolve(process.cwd(), "..", "core");\n',
      ),
      writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { local: "link:./src" } })),
      writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } })),
    ]);

    expect(await scanRepositoryBoundaries(root)).toEqual([]);
  });

  it("does not exempt committed development adapters from static cross-repository imports", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-boundary-adapter-"));
    const root = path.join(parent, "cli");
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, "scripts", "development-sources.mjs"), 'import "../../core/src/index.ts";\n');

    expect(await scanRepositoryBoundaries(root)).toEqual([expect.objectContaining({
      file: "scripts/development-sources.mjs",
      kind: "cross-repository-import",
    })]);
  });

  it("rejects source links only in main mode", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-boundary-main-link-"));
    const root = path.join(parent, "desktop");
    const shared = path.join(parent, "shared", "i18n");
    await mkdir(path.join(root, ".shared"), { recursive: true });
    await mkdir(shared, { recursive: true });
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(shared, path.join(root, ".shared", "i18n"), process.platform === "win32" ? "junction" : "dir"));

    expect(await scanPreparedRepositoryMode(root, "dev")).toEqual([]);
    expect(await scanPreparedRepositoryMode(root, "main")).toEqual([expect.objectContaining({
      file: ".shared/i18n",
      kind: "main-local-source-link",
    })]);
  });

  it("rejects nested links in prepared and vendored Shared packages on main", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-boundary-main-nested-link-"));
    const root = path.join(parent, "server");
    const external = path.join(parent, "external.ts");
    await Promise.all([
      mkdir(path.join(root, ".shared", "i18n", "nested"), { recursive: true }),
      mkdir(path.join(root, ".shared", "i18n", "node_modules"), { recursive: true }),
      mkdir(path.join(root, "vendor", "shared", "i18n", "nested"), { recursive: true }),
      writeFile(external, "export const external = true;\n"),
    ]);
    const { symlink } = await import("node:fs/promises");
    await Promise.all([
      symlink(external, path.join(root, ".shared", "i18n", "nested", "source.ts"), "file"),
      symlink(external, path.join(root, ".shared", "i18n", "node_modules", "dependency"), "file"),
      symlink(external, path.join(root, "vendor", "shared", "i18n", "nested", "source.ts"), "file"),
    ]);

    expect(await scanPreparedRepositoryMode(root, "main")).toEqual([
      expect.objectContaining({ file: ".shared/i18n/nested/source.ts", kind: "main-local-source-link" }),
      expect.objectContaining({ file: "vendor/shared/i18n/nested/source.ts", kind: "main-local-source-link" }),
    ]);
  });
});
