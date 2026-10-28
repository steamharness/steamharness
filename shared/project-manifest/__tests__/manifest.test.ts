// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyDatabasePermissions } from "../../database-spaces/index";
import { readProjectManifest, selectProjectEntry, projectManifestForDistribution, projectManifestTypes } from "../index";
import { resolveProjectEntry } from "../node";
const id = "3bd18168-f4f6-486b-842c-ab9f8098d9d4";
const entry = (entryId: string, type = "workflow") => ({ entryId, type, name: entryId, root: entryId, entry: type === "kanban" ? "dist/index.html" : "index.ts", databases: [] });
const pkg = () => ({ id, name: "aggregate", steamHarness: { entries: [entry("agent", "conversation"), entry("one"), entry("two"), entry("board", "kanban")], defaultEntry: "agent" } });
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
    Object.assign(p.steamHarness, { projectCard: { icon: 'brain', iconColor: '#eeeeee', iconBackgroundColor: '#111111' } });
    Object.assign(p.steamHarness.entries[0]!, { projectCard: { icon: 'bot', iconColor: '#123456', iconBackgroundColor: '#ABCDEF' } });
    Object.assign(p.steamHarness.entries[1]!, { projectCard: { icon: 'database' } });
    const manifest = readProjectManifest(projectManifestForDistribution(p));
    expect(manifest.entries[0]!.projectCard).toMatchObject({ icon: 'bot', iconColor: '#123456', iconBackgroundColor: '#abcdef' });
    expect(manifest.entries[1]!.projectCard?.icon).toBe('database');
    expect(manifest.entries[2]!.projectCard).toBeUndefined();
  });
  it("rejects entry versions and invalid icon declarations", () => {
    for (const invalid of [{ version: '2.0.0' }, { projectCard: { icon: 'invalid' } },
      { projectCard: { iconColor: 'red' } }, { projectCard: { iconBackgroundColor: 'url(javascript:alert(1))' } }]) {
      const p = pkg(); Object.assign(p.steamHarness.entries[0]!, invalid);
      expect(() => readProjectManifest(p)).toThrow();
    }
  });
  it("rejects duplicate identities, missing defaults and unsafe paths", () => {
    const p = pkg(); p.steamHarness.entries.push(entry("one"));
    expect(() => readProjectManifest(p)).toThrow("duplicate entryId");
    p.steamHarness.entries.pop(); p.steamHarness.defaultEntry = "missing";
    expect(() => readProjectManifest(p)).toThrow("defaultEntry");
    for (const root of ["../a", "/a", "C:/a", "a/../b", "a\\b", "node_modules/a", "a//b"]) {
      const p = pkg(); p.steamHarness.entries[0]!.root = root;
      expect(() => readProjectManifest(p)).toThrow("safe relative path");
    }
  });
  it("refuses old declarations even alongside valid entries", () => {
    for (const removed of [{ projectType: "workflow" }, { relatedProjects: [] }, { projectInfo: { dataStorage: { mode: "both" } } }, { projectInfo: { relatedProjects: [] } }]) {
      const p = pkg(); Object.assign(p.steamHarness, removed);
      expect(() => readProjectManifest(p)).toThrow("removed");
    }
    expect(() => readProjectManifest({ id, name: "old" })).toThrow();
  });
  it("strips publisher bindings without modifying source", () => {
    const p = pkg(); Object.assign(p.steamHarness.entries[0]!, { databases: [{ alias: "data", host: "server", permissions: emptyDatabasePermissions(), bindingRef: id }] });
    const distribution = projectManifestForDistribution(p);
    expect(readProjectManifest(distribution).entries[0]!.databases[0]!.bindingRef).toBeUndefined();
    expect(readProjectManifest(p).entries[0]!.databases[0]!.bindingRef).toBe(id);
  });
  it("rejects entry roots and files escaping through symlinks", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "aggregate-manifest-"));
    try {
      await mkdir(path.join(temp, "project")); await mkdir(path.join(temp, "outside"));
      await writeFile(path.join(temp, "outside/index.ts"), "export default {};");
      await symlink(path.join(temp, "outside"), path.join(temp, "project/one"), "dir");
      await writeFile(path.join(temp, "project/package.json"), JSON.stringify({ id, name: "aggregate", steamHarness: { entries: [entry("one")], defaultEntry: "one" } }));
      await expect(resolveProjectEntry(path.join(temp, "project"))).rejects.toThrow("inside");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
