import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { listWorkspaceProjects, resolveDefaultWorkspaceRoot } from "../migrate-workspace-projects.mjs";

const manifest = {
  id: "00000000-0000-4000-8000-000000000001", name: "Project name", version: "1.2.3",
  defaultEntry: "child", entries: [{ entryId: "child", root: "child" }],
};

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-project-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, "project");
  await mkdir(path.join(project, "child"), { recursive: true });
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "npm-name", version: "9.9.9" }));
  return { directory, project };
}

test("workspace migration reads project identity from steamharness.json and validates registered children", async t => {
  const { directory, project } = await workspace(t);
  await writeFile(path.join(project, "steamharness.json"), JSON.stringify(manifest));
  await writeFile(path.join(project, "child", "steamharness.json"), JSON.stringify({ type: "workflow", name: "Child", entry: "index.ts" }));
  assert.deepEqual(await listWorkspaceProjects(directory), [{ dirName: "project", projectDir: project, projectId: manifest.id, projectName: manifest.name }]);
  await rm(path.join(project, "child", "steamharness.json"));
  await assert.rejects(listWorkspaceProjects(directory), /steamharness\.json/);
});

test("workspace migration rejects package-only project declarations", async t => {
  const { directory, project } = await workspace(t);
  await writeFile(path.join(project, "package.json"), JSON.stringify({ id: manifest.id, name: "Legacy", steamHarness: { entries: [] } }));
  await assert.rejects(listWorkspaceProjects(directory), /requires steamharness\.json/);
});

test("workspace migration applies the shared root declaration validation", async t => {
  const { directory, project } = await workspace(t);
  await writeFile(path.join(project, "steamharness.json"), JSON.stringify({ ...manifest, version: "invalid" }));
  await assert.rejects(listWorkspaceProjects(directory), /steamharness\.json\.version/);
});

test("workspace migration accepts an explicit cross-platform workspace root", () => {
  const explicit = path.join(path.parse(process.cwd()).root, "workflow-fixtures", "workspace");
  assert.equal(
    resolveDefaultWorkspaceRoot({ STEAMHARNESS_WORKSPACE_ROOT: explicit }),
    path.resolve(explicit),
  );
});

test("workspace migration defaults to the sibling Core repository workspace", () => {
  const expected = path.resolve(import.meta.dirname, "..", "..", "..", "harness", "workspace", "workflow");
  assert.equal(resolveDefaultWorkspaceRoot({}), expected);
});
