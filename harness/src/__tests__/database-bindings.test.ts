import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindProjectDatabase, createLocalDatabaseResolver, LocalDatabaseRegistry } from "../databases/index";

test("concurrent entry bindings preserve every approved binding and unrelated manifest fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "database-bindings-"));
  const previous = process.env.STEAMHARNESS_DATABASES_DIR;
  process.env.STEAMHARNESS_DATABASES_DIR = path.join(directory, "registry");
  try {
    const projectId = randomUUID();
    const all = { mode: "all" as const };
    const permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };
    const entries = Array.from({ length: 8 }, (_, index) => ({
      entryId: `entry-${index}`, type: "workflow", name: `Entry ${index}`, root: ".", entry: "index.ts",
      databases: [{ alias: "data", host: "local", permissions }],
    }));
    const packagePath = path.join(directory, "package.json");
    await writeFile(packagePath, JSON.stringify({ id: projectId, name: "bindings", custom: { preserved: true }, steamHarness: { entries, defaultEntry: entries[0]!.entryId } }));
    await writeFile(path.join(directory, "index.ts"), "export {};");
    const registry = new LocalDatabaseRegistry(path.join(directory, "registry"));
    const resolver = createLocalDatabaseResolver(registry);
    const approvals = entries.map(entry => {
      const request = registry.request({ projectId, entryId: entry.entryId, alias: "data", permissions, target: { kind: "create", name: entry.name } });
      return registry.review(request.requestId, { approve: true });
    });
    await Promise.all(entries.map((entry, index) => bindProjectDatabase(directory, entry.entryId, "data", approvals[index]!.bindingRef!, resolver)));
    const saved = JSON.parse(await readFile(packagePath, "utf8"));
    assert.deepEqual(saved.custom, { preserved: true });
    assert.deepEqual(saved.steamHarness.entries.map((entry: { databases: Array<{ bindingRef: string }> }) => entry.databases[0]!.bindingRef), approvals.map(item => item.bindingRef));
    registry.revoke(registry.authorization(approvals[0]!.bindingRef!)!.grant.grantId);
    await assert.rejects(bindProjectDatabase(directory, entries[0]!.entryId, "data", approvals[0]!.bindingRef!, resolver), /no longer valid/);
    assert.equal(await readFile(packagePath, "utf8"), JSON.stringify(saved, null, 2) + "\n");
  } finally {
    if (previous === undefined) delete process.env.STEAMHARNESS_DATABASES_DIR;
    else process.env.STEAMHARNESS_DATABASES_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
