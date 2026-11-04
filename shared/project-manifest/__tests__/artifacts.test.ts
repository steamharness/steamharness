// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { databaseArtifactDirectory, databaseArtifactSourceRoot, projectEntryFilePath, readProjectDeclaration } from "../index";
import { assertProjectDataDirectory, resolveProjectEntry, resolveProjectEntrySync } from "../node";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

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
  await mkdir(path.join(root, "board")); await mkdir(path.join(root, "dist/board"), { recursive: true });
  await writeFile(path.join(root, "steamharness.json"), JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", name: "Aggregate", version: "1.0.0", defaultEntry: "board", entries: [{ entryId: "board", root: "board" }] }));
  await writeFile(path.join(root, "board/steamharness.json"), JSON.stringify({ type: "kanban", name: "Board", entry: "dist/board/index.html" }));
  await writeFile(path.join(root, "dist/board/index.html"), "<!doctype html>");
  const resolved = await resolveProjectEntry(root, "board");
  expect(resolved).toEqual(resolveProjectEntrySync(root, "board"));
  expect(resolved.rootDir).toBe(path.join(await realpath(root), "board"));
  expect(resolved.modulePath).toBe(path.join(await realpath(root), "dist/board/index.html"));
  expect(projectEntryFilePath(resolved.registration)).toBe("dist/board/index.html");
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
  expect(declaration.entries[0].entry).toBe("dist/board/index.html");
});
