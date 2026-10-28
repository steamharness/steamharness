// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyDatabasePermissions } from "../../database-spaces/index";
import { readProjectManifest, normalizeProjectManifest, selectProjectEntry, projectManifestForDistribution, projectManifestTypes } from "../index";
import { resolveProjectEntry } from "../node";
const id = "3bd18168-f4f6-486b-842c-ab9f8098d9d4";
const entry = (entryId: string, type = "workflow") => ({ entryId, type, name: entryId, root: ".", entry: type === "kanban" ? "dist/index.html" : "index.ts", databases: [] });
const pkg = () => ({ id, name: "aggregate", version: "0.1.0",  entries: [entry("agent", "conversation"), entry("one"), entry("two"), entry("board", "kanban")], defaultEntry: "agent"  });
describe("aggregate project manifest", () => {
  it("accepts mixed types and repeated types and selects the default", () => {
    const manifest = readProjectManifest(pkg());
    expect(selectProjectEntry(manifest).entryId).toBe("agent");
    expect(selectProjectEntry(manifest, "two").type).toBe("workflow");
    expect(projectManifestTypes(manifest)).toEqual(["conversation", "workflow", "kanban"]);
    expect(() => selectProjectEntry(manifest, "missing")).toThrow("Unknown project entry");
  });
  it("keeps entry icons independent of the aggregate and preserves them for distribution", () => {
    const p = pkg();
    Object.assign(p, { projectCard: { icon: 'brain', iconColor: '#eeeeee', iconBackgroundColor: '#111111' } });
    Object.assign(p.entries[0]!, { projectCard: { icon: 'bot', iconColor: '#123456', iconBackgroundColor: '#ABCDEF' } });
    Object.assign(p.entries[1]!, { projectCard: { icon: 'database' } });
    const manifest = readProjectManifest(projectManifestForDistribution(p));
    expect(manifest.entries[0]!.projectCard).toMatchObject({ icon: 'bot', iconColor: '#123456', iconBackgroundColor: '#abcdef' });
    expect(manifest.entries[1]!.projectCard?.icon).toBe('database');
    expect(manifest.entries[2]!.projectCard).toBeUndefined();
  });
  it("rejects entry versions and invalid icon declarations", () => {
    for (const invalid of [{ version: '2.0.0' }, { projectCard: { icon: 'invalid' } },
      { projectCard: { iconColor: 'red' } }, { projectCard: { iconBackgroundColor: 'url(javascript:alert(1))' } }]) {
      const p = pkg(); Object.assign(p.entries[0]!, invalid);
      expect(() => readProjectManifest(p)).toThrow();
    }
  });
  it("rejects duplicate identities, missing defaults and unsafe paths", () => {
    const p = pkg(); p.entries.push(entry("one"));
    expect(() => readProjectManifest(p)).toThrow("duplicate entryId");
    p.entries.pop(); p.defaultEntry = "missing";
    expect(() => readProjectManifest(p)).toThrow("defaultEntry");
    for (const root of ["../a", "/a", "C:/a", "a/../b", "a\\b", "node_modules/a", "a//b"]) {
      const p = pkg(); p.entries[0]!.root = root;
      expect(() => readProjectManifest(p)).toThrow("safe relative path");
    }
  });
  it("refuses old declarations even alongside valid entries", () => {
    for (const removed of [{ projectType: "workflow" }, { relatedProjects: [] }, { projectInfo: { dataStorage: { mode: "both" } } }, { projectInfo: { relatedProjects: [] } }]) {
      const p = pkg(); Object.assign(p, removed);
      expect(() => readProjectManifest(p)).toThrow();
    }
    expect(() => readProjectManifest({ id, name: "old" })).toThrow();
  });
  it("keeps deployment configuration out of the distributed package", () => {
    const p = pkg();
    Object.assign(p.entries[0]!, { databases: ["data"] });
    const distribution = projectManifestForDistribution(p);
    expect(distribution.entries[0]!.databases).toEqual(["data"]);
    expect(distribution.entries.slice(1).every(entry => entry.databases.length === 0)).toBe(true);
    expect(p.entries[0]!.databases).toEqual(["data"]);
  });
  it("resolves multiple aliases and shares a single configured database across entries", () => {
    const p = pkg();
    Object.assign(p.entries[0]!, { databases: ["data", "archive"] });
    Object.assign(p.entries[1]!, { databases: ["data"] });
    const manifest = readProjectManifest(p, { version: 1, databases: { data: id, archive: "00000000-0000-4000-8000-000000000001" } });
    expect(manifest.entries.map(entry => entry.databases.length)).toEqual([2, 1, 0, 0]);
    expect(manifest.entries[1]!.databases).toEqual([manifest.entries[0]!.databases[0]]);
    expect(normalizeProjectManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(() => readProjectManifest({ ...pkg(),  ...pkg(), entries: manifest.entries  })).toThrow("only alias strings");
  });
  it("rejects permission declarations, binding references, invalid IDs and duplicate aliases", () => {
    for (const database of [{ alias: "data", host: "server", permissions: emptyDatabasePermissions() }, { alias: "data", databaseId: id, permissions: emptyDatabasePermissions() }, { alias: "data", databaseId: id, bindingRef: id }, { alias: "data", databaseId: "invalid" }]) {
      const p = pkg(); Object.assign(p.entries[0]!, { databases: [database] });
      expect(() => readProjectManifest(p)).toThrow();
    }
    const p = pkg(); Object.assign(p.entries[0]!, { databases: ["data", "data"] });
    expect(() => readProjectManifest(p)).toThrow("duplicate aliases");
  });
  it("rejects entry roots and files escaping through symlinks", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "aggregate-manifest-"));
    try {
      await mkdir(path.join(temp, "project")); await mkdir(path.join(temp, "outside"));
      await writeFile(path.join(temp, "outside/index.ts"), "export default {};");
      await symlink(path.join(temp, "outside"), path.join(temp, "project/one"), "dir");
      await writeFile(path.join(temp, "project/steamharness.json"), JSON.stringify({ id, name: "aggregate", version: "0.1.0",  entries: [{entryId:"one",root:"one"}], defaultEntry: "one"  }));
      await expect(resolveProjectEntry(path.join(temp, "project"))).rejects.toThrow("inside");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
