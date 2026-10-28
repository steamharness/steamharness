import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindProjectDatabase, LocalDatabaseRegistry } from "../databases/index";

test("concurrent bindings preserve mappings and each entry's aliases; replacing an ID changes only config.json", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "database-bindings-"));
  const previous = process.env.STEAMHARNESS_DATABASES_DIR;
  process.env.STEAMHARNESS_DATABASES_DIR = path.join(directory, "registry");
  try {
    const projectId = randomUUID();
    const all = { mode: "all" as const };
    const permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };
    const entries = Array.from({ length: 8 }, (_, index) => ({
      entryId: `entry-${index}`, type: "workflow", name: `Entry ${index}`, root: ".", entry: "index.ts",
      databases: [],
    }));
    const packagePath = path.join(directory, "package.json");
    await writeFile(packagePath, JSON.stringify({ id: projectId, name: "bindings", custom: { preserved: true }, steamHarness: { entries, defaultEntry: entries[0]!.entryId } }));
    await writeFile(path.join(directory, "index.ts"), "export {};");
    const registry = new LocalDatabaseRegistry(path.join(directory, "registry"));
    const approvals = entries.map(entry => {
      const request = registry.request({ projectId, entryId: entry.entryId, alias: entry.entryId, permissions, target: { kind: "create", name: entry.name } });
      return registry.review(request.requestId, { approve: true });
    });
    await Promise.all(entries.map((entry, index) => bindProjectDatabase(directory, entry.entryId, entry.entryId, approvals[index]!.databaseId!)));
    const declared = JSON.parse(await readFile(packagePath, "utf8"));
    const configPath = path.join(directory, "config.json");
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    for (const [index, entry] of entries.entries()) {
      assert.equal(saved.databases[entry.entryId], approvals[index]!.databaseId);
      assert.deepEqual(declared.steamHarness.entries[index].databases, [entry.entryId]);
    }
    assert.deepEqual(Object.keys(saved), ["version", "databases"]);
    // A shared alias has one value, regardless of the number of consumers.
    const shared = randomUUID();
    await bindProjectDatabase(directory, entries[0]!.entryId, "shared", shared);
    await bindProjectDatabase(directory, entries[1]!.entryId, "shared", shared);
    const before = await readFile(packagePath, "utf8");
    const sharedEntries = JSON.parse(before).steamHarness.entries;
    assert.deepEqual(sharedEntries[0].databases, [entries[0]!.entryId, "shared"]);
    assert.deepEqual(sharedEntries[1].databases, [entries[1]!.entryId, "shared"]);
    const replacement = randomUUID();
    await bindProjectDatabase(directory, entries[0]!.entryId, "shared", replacement);
    const updated = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(updated.databases.shared, replacement);
    assert.equal(updated.entries, undefined);
    assert.equal(await readFile(packagePath, "utf8"), before);
    await assert.rejects(bindProjectDatabase(directory, entries[0]!.entryId, "shared", "invalid"), /UUID/);
    await assert.rejects(bindProjectDatabase(directory, entries[0]!.entryId, "duplicate", replacement), /one alias/);
    assert.equal(await readFile(configPath, "utf8"), JSON.stringify(updated, null, 2) + "\n");
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
    const pkg = { id: randomUUID(), name: "declared-bindings", steamHarness: { defaultEntry: "main", entries: [
      { entryId: "main", type: "workflow", name: "Main", root: ".", entry: "index.ts", databases: ["data", "archive"] },
    ] } };
    const authored = JSON.stringify(pkg);
    await writeFile(path.join(directory, "package.json"), authored);
    await writeFile(path.join(directory, "index.ts"), "export {};");
    const data = randomUUID(), archive = randomUUID();
    await bindProjectDatabase(directory, "main", "data", data);
    await bindProjectDatabase(directory, "main", "archive", archive);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")), { version: 1, databases: { data, archive } });
    assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), authored);
    await assert.rejects(bindProjectDatabase(directory, "missing", "data", data), /Unknown project entry/);
    await rm(path.join(directory, "config.json"));
    const outside = path.join(external, "config.json");
    await writeFile(outside, JSON.stringify({ version: 1, databases: { data } }));
    await symlink(outside, path.join(directory, "config.json"));
    await assert.rejects(bindProjectDatabase(directory, "main", "archive", archive), /inside the project root/);
    assert.deepEqual(JSON.parse(await readFile(outside, "utf8")), { version: 1, databases: { data } });
  } finally {
    if (previous === undefined) delete process.env.STEAMHARNESS_DATABASES_DIR;
    else process.env.STEAMHARNESS_DATABASES_DIR = previous;
    await rm(directory, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
