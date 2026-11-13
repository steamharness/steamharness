import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Storage } from "../storage";
import { resolveResourceAccess } from "@steamharness/project-access";
import { readProjectReleaseSync, sealProjectRelease } from "@steamharness/project-manifest/release-node";
import type { ProjectConfigurationState } from "@steamharness/project-configuration";

test("Server publishes and downloads a compiled release without executing its code or restoring excluded profiles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "release-publication-"));
  const project = path.join(root, "compiled"), data = path.join(root, "server");
  const projectId = "72e34bc3-7bbd-4d45-b38b-f941ff856424";
  const coreVersion = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).dependencies.steamharness;
  const definition = { version: 2, fields: [{ name: "mode", type: "string", defaultValue: "ask", sharing: { publish: true, includeValue: true, editable: false } }],
    profilePolicy: { version: 1, defaultProfileKey: "ask", manageMinimumRole: "developer", profiles: [{ key: "ask", name: "Ask", minimumRole: "guest", fixedValues: { mode: "ask" } }] } };
  try {
    const files: Record<string, string> = {
      "steamharness.json": JSON.stringify({ id: projectId, name: "Compiled", version: "1.0.0", defaultEntry: "main", entries: [{ entryId: "main", root: "entries/main" }] }),
      "package.json": JSON.stringify({ name: "compiled", type: "module", devDependencies: { steamharness: coreVersion } }),
      "entries/main/steamharness.json": JSON.stringify({ name: "Main", type: "workflow", entry: "index.mjs", configuration: "configuration.json", databases: [] }),
      "entries/main/index.mjs": 'throw new Error("Server must never execute a release");',
      "entries/main/configuration.json": JSON.stringify(definition),
      "entries/main/structure.json": JSON.stringify({ version: 1, report: { projectId, entryId: "main", projectType: "workflow", workflow: { name: "Main", dir: ".", files: [] }, definitions: { nodes: {}, apiCalls: [], variables: {}, registry: {} }, diagnostics: { violations: [], warnings: [] }, entrypoints: [{ id: "main", title: "Main" }] }, scripts: { violations: [], definedNodes: [] } }),
    };
    for (const [filename, bytes] of Object.entries(files)) { await mkdir(path.dirname(path.join(project, filename)), { recursive: true }); await writeFile(path.join(project, filename), bytes); }
    const release = sealProjectRelease(project, { kind: "steamharness.project.release", version: 1, projectId, projectVersion: "1.0.0", buildId: "1".repeat(64), inputHash: "2".repeat(64), entries: [{ entryId: "main", root: "entries/main", entry: "index.mjs", configuration: "configuration.json", profiles: ["ask"], structure: "entries/main/structure.json" }] });
    const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot: data });
    storage.getProjectAccessSummary = async () => ({ projectId, projectName: "Compiled", visibility: "private", access: resolveResourceAccess([{ type: "project", id: projectId, role: "owner" }]) });
    const sourceDefinition = { ...definition, fields: [...definition.fields, { name: "buildSecret", type: "string", defaultValue: "must-not-ship" }],
      profilePolicy: { ...definition.profilePolicy, profiles: [...definition.profilePolicy.profiles, { key: "build", name: "Build", minimumRole: "developer", fixedValues: { mode: "build" } }] } };
    const sourceDeclaration = { id: projectId, name: "Compiled", version: "1.0.0", defaultEntry: "main", entries: [{ entryId: "main", root: "entries/main" }] };
    await storage.createProjectFromFiles({ projectName: projectId, files: [
      { path: "steamharness.json", content: JSON.stringify(sourceDeclaration) }, { path: "package.json", content: files["package.json"] },
      { path: "entries/main/steamharness.json", content: JSON.stringify({ name: "Main", type: "workflow", entry: "index.ts", configuration: "configuration.json", databases: [] }) },
      { path: "entries/main/index.ts", content: 'throw new Error("Server must never execute source");' },
      { path: "entries/main/configuration.json", content: JSON.stringify(sourceDefinition) },
    ] });
    const author = { projectName: projectId, entryId: "main", actorId: "author" };
    const state = await storage.projectConfigurations(author, { action: "get" }) as ProjectConfigurationState;
    const saved = await storage.projectConfigurations(author, { action: "publication.save", revision: state.revision, publication: state.publication! }) as ProjectConfigurationState;
    await storage.saveDraftFiles({ projectName: projectId, removePaths: ["entries/main/index.ts"], files: await Promise.all([...release.files.map(file => file.path), "steamharness.release.json"].map(async filename => ({ path: filename, content: await readFile(path.join(project, filename), "utf8") }))) });
    const draft = await storage.getFiles({ projectName: projectId, target: "draft" });
    await storage.publish({ projectName: projectId, createdByUserId: "author", expectedSourceHash: draft.sourceHash, expectedConfigurationRevisions: { main: saved.publication!.revision } });
    const downloaded = await storage.getDownloadableSourceFiles({ projectName: projectId, target: "1.0.0" });
    const target = path.join(root, "download");
    for (const file of downloaded.files) { await mkdir(path.dirname(path.join(target, file.path)), { recursive: true }); await writeFile(path.join(target, file.path), file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content); }
    assert.equal(readProjectReleaseSync(target)?.buildId, release.buildId);
    assert.ok(downloaded.files.some(file => file.path.startsWith("configuration-templates/") && file.path.endsWith(".json")));
    for (const file of downloaded.files.filter(file => file.path.endsWith(".json"))) {
      const text = await readFile(path.join(target, file.path), "utf8");
      assert.equal(text, JSON.stringify(JSON.parse(text)), `Published release JSON must remain compact: ${file.path}`);
    }
    const content = JSON.stringify(downloaded.files);
    assert.ok(!content.includes("must-not-ship"));
    assert.ok(!content.includes("buildSecret"));
    const published = JSON.parse(await readFile(path.join(target, "entries/main/configuration.json"), "utf8"));
    assert.deepEqual(published.profilePolicy.profiles.map((profile: any) => profile.key), ["ask"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
