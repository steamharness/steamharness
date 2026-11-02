import { bindProjectKnowledgeBase } from "../knowledge-bases/bindings";
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("child bindings write aliases to the registered child and IDs only to the root config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "child-database-bindings-"));
  const previous = process.env.STEAMHARNESS_DATABASES_DIR;
  process.env.STEAMHARNESS_DATABASES_DIR = path.join(directory, "registry");
  try {
    const parent = JSON.stringify({ id: randomUUID(), name: "Aggregate", version: "2.3.4", defaultEntry: "first", entries: [
      { entryId: "first", root: "first" }, { entryId: "second", root: "second" },
    ] });
    const npm = JSON.stringify({ name: "npm-only", version: "9.8.7", scripts: { build: "tsc" } });
    await writeFile(path.join(directory, "steamharness.json"), parent);
    await writeFile(path.join(directory, "package.json"), npm);
    for (const child of ["first", "second", "unregistered"]) {
      await mkdir(path.join(directory, child));
      await writeFile(path.join(directory, child, "steamharness.json"), JSON.stringify({
        type: "workflow", name: child, entry: "index.ts", knowledgeBases: [], projectCard: { icon: "database" },
      }));
      await writeFile(path.join(directory, child, "index.ts"), "export {};\n");
    }
    const databaseId = randomUUID();
    await Promise.all(["first", "second"].map(entryId => bindProjectKnowledgeBase(directory, entryId, "data", databaseId)));
    for (const child of ["first", "second"]) {
      const declaration = JSON.parse(await readFile(path.join(directory, child, "steamharness.json"), "utf8"));
      assert.deepEqual(declaration.knowledgeBases, ["data"]);
      assert.equal(declaration.projectCard.icon, "database");
      assert.equal(declaration.id, undefined);
    }
    assert.equal(await readFile(path.join(directory, "steamharness.json"), "utf8"), parent);
    assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), npm);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")), { version: 1, knowledgeBases: { data: databaseId } });
    const childBefore = await readFile(path.join(directory, "first", "steamharness.json"), "utf8");
    const replacementId = randomUUID();
    await bindProjectKnowledgeBase(directory, "first", "data", replacementId);
    assert.equal(await readFile(path.join(directory, "first", "steamharness.json"), "utf8"), childBefore);
    assert.equal(JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")).knowledgeBases.data, replacementId);
    await assert.rejects(bindProjectKnowledgeBase(directory, "unregistered", "data", databaseId), /Unknown project entry/);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "unregistered", "steamharness.json"), "utf8")).knowledgeBases, []);
  } finally {
    if (previous === undefined) delete process.env.STEAMHARNESS_DATABASES_DIR;
    else process.env.STEAMHARNESS_DATABASES_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("binds declared aliases incrementally and rejects configuration symlinks outside the project", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "declared-database-binding-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "external-database-binding-"));
  const previous = process.env.STEAMHARNESS_DATABASES_DIR;
  process.env.STEAMHARNESS_DATABASES_DIR = path.join(directory, "registry");
  try {
    const pkg = { version: "0.1.0", id: randomUUID(), name: "declared-bindings", defaultEntry: "main", entries: [
      { entryId: "main", type: "workflow", name: "Main", root: ".", entry: "index.ts", knowledgeBases: ["data", "archive"] },
    ]  };
    const authored = JSON.stringify(pkg);
    await writeProjectFixture(path.join(directory, "package.json"), authored);
    await writeFile(path.join(directory, "index.ts"), "export {};");
    const data = randomUUID(), archive = randomUUID();
    await bindProjectKnowledgeBase(directory, "main", "data", data);
    await bindProjectKnowledgeBase(directory, "main", "archive", archive);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")), { version: 1, knowledgeBases: { data, archive } });
    assert.equal(await readFile(path.join(directory, "steamharness.json"), "utf8"), authored);
    await assert.rejects(bindProjectKnowledgeBase(directory, "missing", "data", data), /Unknown project entry/);
    await rm(path.join(directory, "config.json"));
    const outside = path.join(external, "config.json");
    await writeFile(outside, JSON.stringify({ version: 1, knowledgeBases: { data } }));
    await symlink(outside, path.join(directory, "config.json"));
    await assert.rejects(bindProjectKnowledgeBase(directory, "main", "archive", archive), /inside the project root/);
    assert.deepEqual(JSON.parse(await readFile(outside, "utf8")), { version: 1, knowledgeBases: { data } });
  } finally {
    if (previous === undefined) delete process.env.STEAMHARNESS_DATABASES_DIR;
    else process.env.STEAMHARNESS_DATABASES_DIR = previous;
    await rm(directory, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
