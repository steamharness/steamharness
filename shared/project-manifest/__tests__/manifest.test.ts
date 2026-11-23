// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProjectManifest, selectProjectEntry, projectManifestForDistribution, projectManifestTypes } from "../index";
import { resolveProjectEntry } from "../node";
const id = "3bd18168-f4f6-486b-842c-ab9f8098d9d4";
const entry = (entryId: string, type = "workflow") => ({ entryId, type, name: entryId, root: ".", entry: type === "kanban" ? `dist/steamharness/build/${entryId}/index.html` : "index.ts" });
const pkg = () => ({ id, name: "aggregate", version: "0.1.0",  entries: [entry("agent", "bot"), entry("one"), entry("two"), entry("board", "kanban")], defaultEntry: "agent"  });
describe("aggregate project manifest", () => {
  it("accepts mixed types and repeated types and selects the default", () => {
    const manifest = readProjectManifest(pkg());
    expect(selectProjectEntry(manifest).entryId).toBe("agent");
    expect(selectProjectEntry(manifest, "two").type).toBe("workflow");
    expect(projectManifestTypes(manifest)).toEqual(["bot", "workflow", "kanban"]);
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
  it("reads folder context from either Bot entry declaration and rejects it on other entry types", () => {
    const root = { ...pkg(), entries: [{ ...entry('agent', 'bot'), folderContext: true }] };
    expect(selectProjectEntry(readProjectManifest(root)).folderContext).toBe(true);
    const child = { ...root, entries: [{ entryId: 'agent', root: 'assistant' }] };
    expect(selectProjectEntry(readProjectManifest(child, { assistant: { type: 'bot', name: 'Assistant', entry: 'index.ts', folderContext: true } })).folderContext).toBe(true);
    for (const invalid of [{ ...entry('agent'), folderContext: true }, { ...entry('agent', 'bot'), folderContext: 'true' }]) {
      expect(() => readProjectManifest({ ...root, entries: [invalid] })).toThrow('folderContext');
    }
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
    const withDatabase = pkg();
    Object.assign(withDatabase.entries[0]!, { databases: [] });
    expect(() => readProjectManifest(withDatabase)).toThrow("unsupported fields");
    expect(() => readProjectManifest({ id, name: "old" })).toThrow();
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
