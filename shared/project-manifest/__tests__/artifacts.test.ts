// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { databaseArtifactDirectory, databaseArtifactSourceRoot, projectEntryBuildDirectory, projectEntryFilePath, readProjectDeclaration } from "../index";
import { assertProjectDataDirectory, resolveProjectEntry, resolveProjectEntrySync } from "../node";
import { PROJECT_ARTIFACT_DIRECTORY, PROJECT_CACHE_DIRECTORY, PROJECT_REPORTS_DIRECTORY, PROJECT_RELEASE_BASE_DIRECTORY, PROJECT_TEMP_DIRECTORY, PROJECT_RELEASE_DIRECTORY, isProjectToolArtifactPath } from "../index";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it("exports path constants when the manifest is first loaded through its Node entry", async () => {
  vi.resetModules();
  await import('../node');
  const manifest = await import('../index');
  expect(manifest.PROJECT_RELEASE_BASE_DIRECTORY).toBe('dist/steamharness/release');
  expect(manifest.PROJECT_RELEASE_DIRECTORY).toBe('dist/steamharness/release/project');
});

it("loads artifact and release entry modules independently in native Node ESM", async () => {
  for (const first of ['artifacts.ts', 'release.ts', 'node.ts']) {
    const entry = new URL(`../${first}`, import.meta.url).href;
    const index = new URL('../index.ts', import.meta.url).href;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      `await import(${JSON.stringify(entry)}); const module = await import(${JSON.stringify(index)}); console.log(module.PROJECT_RELEASE_DIRECTORY);`]);
    expect(result.stdout.trim()).toBe('dist/steamharness/release/project');
  }
});

it("keeps every tool directory inside the single SteamHarness artifact namespace", () => {
  expect([PROJECT_CACHE_DIRECTORY, PROJECT_REPORTS_DIRECTORY, PROJECT_RELEASE_BASE_DIRECTORY, PROJECT_TEMP_DIRECTORY])
    .toEqual(["cache", "reports", "release", "tmp"].map(name => `${PROJECT_ARTIFACT_DIRECTORY}/${name}`));
  expect(PROJECT_RELEASE_DIRECTORY).toBe("dist/steamharness/release/project");
  for (const directory of [PROJECT_CACHE_DIRECTORY, PROJECT_REPORTS_DIRECTORY, PROJECT_RELEASE_BASE_DIRECTORY, PROJECT_TEMP_DIRECTORY]) {
    expect(isProjectToolArtifactPath(directory)).toBe(true);
    expect(isProjectToolArtifactPath(`${directory}/nested/file.json`)).toBe(true);
    expect(isProjectToolArtifactPath(`${directory.toUpperCase()}/file.json`)).toBe(true);
    expect(isProjectToolArtifactPath(`${directory}-assets/file.json`)).toBe(false);
  }
  expect(isProjectToolArtifactPath("dist/steamharness/build/board/assets/cache/data.json")).toBe(false);
});

it("isolates definitions by their complete canonical source root", () => {
  expect(databaseArtifactDirectory()).toBe("dist/steamharness/generated/database");
  const nested = databaseArtifactDirectory("apps/board");
  expect(nested).toBe("dist/steamharness/entries/apps%2Fboard/generated/database");
  expect(nested).not.toBe(databaseArtifactDirectory("apps%2Fboard"));
  expect(databaseArtifactSourceRoot(`${nested}/node/index.js`)).toBe("apps/board");
  for (const invalid of ["../outside", "/outside", "a/../b", "a\\b"]) expect(() => databaseArtifactDirectory(invalid)).toThrow();
  for (const invalid of [".steamharness/generated/database/node/index.js", "nested/dist/steamharness/generated/database/node/index.js", "dist/steamharness/entries/%2e%2e/generated/database/node/index.js"]) expect(databaseArtifactSourceRoot(invalid)).toBeUndefined();
});

it("resolves a child Kanban from aggregate dist in sync and async readers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aggregate-artifacts-")); directories.push(root);
  await mkdir(path.join(root, "board")); await mkdir(path.join(root, "dist/steamharness/entries/board/build/board"), { recursive: true });
  await writeFile(path.join(root, "steamharness.json"), JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", name: "Aggregate", version: "1.0.0", defaultEntry: "board", entries: [{ entryId: "board", root: "board" }] }));
  await writeFile(path.join(root, "board/steamharness.json"), JSON.stringify({ type: "kanban", name: "Board", entry: "dist/steamharness/entries/board/build/board/index.html" }));
  await writeFile(path.join(root, "dist/steamharness/entries/board/build/board/index.html"), "<!doctype html>");
  const resolved = await resolveProjectEntry(root, "board");
  expect(resolved).toEqual(resolveProjectEntrySync(root, "board"));
  expect(resolved.rootDir).toBe(path.join(await realpath(root), "board"));
  expect(resolved.modulePath).toBe(path.join(await realpath(root), "dist/steamharness/entries/board/build/board/index.html"));
  expect(projectEntryFilePath(resolved.registration)).toBe("dist/steamharness/entries/board/build/board/index.html");
});

it("rejects runtime data inside source and symlinks that lead back into source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "external-project-data-")); directories.push(root);
  const source = path.join(root, "project"); await mkdir(source);
  expect(() => assertProjectDataDirectory(source, path.join(source, "dist/runtime"))).toThrow(/outside/);
  await symlink(source, path.join(root, "alias"), "dir");
  expect(() => assertProjectDataDirectory(source, path.join(root, "alias/new/runtime"))).toThrow(/outside/);
  expect(() => assertProjectDataDirectory(source, path.join(root, "app-data/new"))).not.toThrow();
});


it("defaults each Kanban to its own aggregate artifact directory", () => {
  const declaration = readProjectDeclaration({ id: "00000000-0000-4000-8000-000000000001", name: "Board", version: "1.0.0", defaultEntry: "board",
    entries: [{ entryId: "board", root: ".", name: "Board", type: "kanban" }] });
  expect(declaration.entries[0].entry).toBe("dist/steamharness/build/board/index.html");
});

it("groups builds with their source root while isolating entries that share generated code", () => {
  const root = "apps/board";
  expect(projectEntryBuildDirectory({ root, entryId: "viewer" })).toBe("dist/steamharness/entries/apps%2Fboard/build/viewer");
  expect(projectEntryBuildDirectory({ root, entryId: "editor" })).toBe("dist/steamharness/entries/apps%2Fboard/build/editor");
  expect(databaseArtifactDirectory(root)).toBe("dist/steamharness/entries/apps%2Fboard/generated/database");
  const declaration = readProjectDeclaration({ id: "00000000-0000-4000-8000-000000000001", name: "Shared source", version: "1.0.0", defaultEntry: "viewer",
    entries: [{ entryId: "viewer", root }, { entryId: "editor", root }] }, { [root]: { type: "kanban", name: "Board" } });
  expect(declaration.entries.map(entry => entry.entry)).toEqual([
    "dist/steamharness/entries/apps%2Fboard/build/viewer/index.html",
    "dist/steamharness/entries/apps%2Fboard/build/editor/index.html",
  ]);
});

it.each(["steamharness", "cache", "reports", "release", "tmp", "con", "aux", "nul", "prn", "com1", "lpt9"])("rejects entry ID %s before it can collide with managed or nonportable directories", entryId => {
  const source = { id: "00000000-0000-4000-8000-000000000001", name: "Board", version: "1.0.0", defaultEntry: entryId,
    entries: [{ entryId, root: ".", name: "Board", type: "kanban" }] };
  expect(() => readProjectDeclaration(source)).toThrow(/reserved/i);
});

it.each(["dist/board/index.html", "dist/steamharness/index.html", "dist/steamharness/build/other/index.html", "dist/steamharness/cache/index.html", "dist/steamharness/reports/index.html", "dist/steamharness/release/index.html", "dist/steamharness/tmp/index.html"])("rejects an entry outside its own managed build directory %s", entry => {
  const source = { id: "00000000-0000-4000-8000-000000000001", name: "Board", version: "1.0.0", defaultEntry: "board",
    entries: [{ entryId: "board", root: ".", name: "Board", type: "kanban", entry }] };
  expect(() => readProjectDeclaration(source)).toThrow(/reserved/i);
});
