// @vitest-environment node
import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProjectConfig, readProjectManifest } from "../index";
import { readProjectManifestFromDirectory, readProjectManifestFromDirectorySync, resolveProjectDeclarationEntrySync } from "../node";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const pkg = { id: first, name: "configured", version: "0.1.0",  defaultEntry: "one", entries: ["one", "two"].map(entryId => ({ entryId, type: "workflow", name: entryId, root: ".", entry: "index.ts", databases: ["data"] }))  };
const config = () => ({ version: 1, databases: { data: first } });

it("changes every consumer by overriding a single alias without changing authored files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-config-"));
  try {
    await writeFile(path.join(root, "steamharness.json"), JSON.stringify(pkg));
    const authored = JSON.stringify(config());
    await writeFile(path.join(root, "config.json"), authored);
    const env = { STEAMHARNESS_PROJECT_CONFIG: JSON.stringify({ databases: { data: second } }) };
    const live = await readProjectManifestFromDirectory(root, env);
    expect(live.entries.map(entry => entry.databases)).toEqual([[{ alias: "data", databaseId: second }], [{ alias: "data", databaseId: second }]]);
    expect(readProjectManifestFromDirectorySync(root, env)).toEqual(live);
    expect((await readProjectManifestFromDirectory(root, {})).entries[0]!.databases[0]!.databaseId).toBe(first);
    await writeFile(path.join(root, "config.json"), JSON.stringify({ ...config(), databases: { data: second } }));
    expect((await readProjectManifestFromDirectory(root, {})).entries.every(entry => entry.databases[0]!.databaseId === second)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("supports IDs from the environment and resolves only each entry's declared aliases", () => {
  expect(readProjectManifest(pkg, undefined, { STEAMHARNESS_PROJECT_CONFIG: JSON.stringify(config()) }).entries[0]!.databases).toEqual([{ alias: "data", databaseId: first }]);
  const manifest = readProjectManifest(pkg, config(), { STEAMHARNESS_PROJECT_CONFIG: JSON.stringify({ databases: { archive: second } }) });
  expect(manifest.entries.every(entry => entry.databases.length === 1)).toBe(true);
  expect(() => readProjectManifest(pkg)).toThrow('unconfigured database alias "data"');
  expect(Object.keys(config())).toEqual(["version", "databases"]);
});

it("rejects entry associations, permission declarations, invalid IDs and duplicate IDs", () => {
  for (const invalid of [
    { ...config(), databases: { data: "invalid" } },
    { ...config(), databases: { data: first, duplicate: first } },
    { ...config(), entries: { one: { databases: ["data"] } } },
    { ...config(), permissions: {} },
    { ...config(), entries: { one: { databases: ["data"], permissions: {} } } },
  ]) expect(() => readProjectManifest(pkg, invalid)).toThrow();
  expect(() => readProjectConfig(config(), { STEAMHARNESS_PROJECT_CONFIG: "{" })).toThrow("STEAMHARNESS_PROJECT_CONFIG");
  expect(() => readProjectConfig(config(), { STEAMHARNESS_PROJECT_CONFIG: JSON.stringify({ databases: { data: "invalid" } }) })).toThrow("UUID");
  expect(() => readProjectConfig(config(), { STEAMHARNESS_PROJECT_CONFIG: JSON.stringify({ entries: {} }) })).toThrow("STEAMHARNESS_PROJECT_CONFIG");
});

it("does not hide malformed files or follow configuration outside the project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-config-symlink-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "project-config-external-"));
  try {
    await writeFile(path.join(root, "steamharness.json"), JSON.stringify(pkg));
    await writeFile(path.join(root, "index.ts"), "export {};");
    await expect(readProjectManifestFromDirectory(root, {})).rejects.toThrow('unconfigured database alias "data"');
    expect(resolveProjectDeclarationEntrySync(root).registration.databases).toEqual(["data"]);
    await writeFile(path.join(root, "config.json"), "{");
    await expect(readProjectManifestFromDirectory(root, {})).rejects.toThrow();
    await rm(path.join(root, "config.json"));
    await writeFile(path.join(external, "config.json"), JSON.stringify(config()));
    await symlink(path.join(external, "config.json"), path.join(root, "config.json"));
    await expect(readProjectManifestFromDirectory(root, {})).rejects.toThrow("inside");
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});
