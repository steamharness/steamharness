import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { create as createTar, list as listTar } from "tar";
import { Storage, type PreparationStage, type ProjectRole } from "../storage";
import type { ArtifactStorage } from "../persistence";

const projectId = "00000000-0000-4000-8000-000000000091";
const serverPackage = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

function packageJson(version: string) {
  return {
    id: projectId, name: "Static upload", version,
    devDependencies: { "steamharness": serverPackage.dependencies["steamharness"] },
    scripts: { preinstall: "node side-effect.cjs", postinstall: "node side-effect.cjs", build: "node side-effect.cjs" },
    steamHarness: {
      projectType: "workflow",
      projectInfo: {
        localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" },
        dataStorage: { mode: "server" }, relatedProjects: [],
      },
    },
  };
}

test("creation, upload, publication and historical downloads never load or build project code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-static-upload-"));
  const dataRoot = path.join(root, "data");
  const marker = path.join(root, "executed");
  const sideEffect = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot });
  const stages: PreparationStage[] = [];
  try {
    await storage.createProjectFromFiles({ projectName: projectId, files: [
      { path: "package.json", content: JSON.stringify(packageJson("1.0.0")) },
      { path: "index.ts", content: `import 'node:fs'; throw new Error('must never execute');` },
    ] });
    const source = path.join(root, "package");
    await mkdir(source);
    await writeFile(path.join(source, "package.json"), JSON.stringify(packageJson("1.0.0")));
    await writeFile(path.join(source, "index.ts"), `${sideEffect}\nthrow new Error('must never import');`);
    await writeFile(path.join(source, "side-effect.cjs"), sideEffect);
    await writeFile(path.join(source, "image.bin"), Buffer.from([0, 1, 255]));
    const archivePath = path.join(root, "upload.tar.gz");
    await createTar({ cwd: source, file: archivePath, gzip: true }, ["."]);
    const uploaded = await storage.uploadPackage({ projectName: projectId, archiveName: "upload.tar.gz",
      archiveBuffer: await readFile(archivePath), onStage: async stage => { stages.push(stage); } });
    assert.deepEqual(stages, ["extracting", "validating", "committing"]);

    const preparedFiles = (await storage.getFiles({ projectName: projectId, target: "draft", includeBinary: true })).files;
    await storage.saveDraftFiles({ projectName: projectId, files: preparedFiles.map(file => file.path === "index.ts"
      ? { ...file, content: "replacement draft" } : file) });
    await assert.rejects(storage.publish({ projectName: projectId, expectedVersion: "1.0.0", expectedSourceHash: uploaded.sourceHash }),
      /draft changed after preparation/);
    assert.deepEqual((await storage.listVersions(projectId)).versions, []);
    assert.equal((await storage.listVersions(projectId)).latest, null);
    await storage.saveDraftFiles({ projectName: projectId, files: preparedFiles });
    await assert.rejects(storage.publish({ projectName: projectId, expectedVersion: "1.0.1", expectedSourceHash: uploaded.sourceHash }),
      /version differs/);
    const published = await storage.publish({ projectName: projectId, releaseLog: "First snapshot",
      expectedVersion: "1.0.0", expectedSourceHash: uploaded.sourceHash });
    assert.equal(published.version, "1.0.0");
    const before = await storage.getDownloadableSourceFiles({ projectName: projectId, target: "1.0.0" });
    assert.equal(before.files.find(file => file.path === "image.bin")?.content, "AAH/");
    await assert.rejects(storage.publish({ projectName: projectId }), /already exists|already published/);
    await assert.rejects(storage.uploadPackage({ projectName: projectId, archiveName: "bad.tgz", archiveBuffer: Buffer.from("invalid") }));
    assert.deepEqual(await storage.getDownloadableSourceFiles({ projectName: projectId, target: "1.0.0" }), before);
    assert.equal((await storage.listVersions(projectId)).latest, "1.0.0");

    const next = await storage.getFiles({ projectName: projectId, target: "draft", includeBinary: true });
    await storage.saveDraftFiles({ projectName: projectId, files: next.files.map(file => file.path === "package.json"
      ? { ...file, content: JSON.stringify(packageJson("1.0.1")) } : file) });
    const publications = await Promise.allSettled([
      storage.publish({ projectName: projectId }), storage.publish({ projectName: projectId }),
    ]);
    assert.equal(publications.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(publications.filter(result => result.status === "rejected").length, 1);
    assert.equal((await storage.listVersions(projectId)).latest, "1.0.1");
    assert.deepEqual(await storage.getDownloadableSourceFiles({ projectName: projectId, target: "1.0.0" }), before);
    const archive = await storage.getSourceArchive(projectId, "1.0.0");
    const downloaded = path.join(root, "download.tar.gz");
    await writeFile(downloaded, archive.archive);
    const entries: string[] = [];
    await listTar({ file: downloaded, onReadEntry: entry => { entries.push(entry.path); } });
    assert.ok(entries.some(entry => entry.endsWith("side-effect.cjs")));
    assert.equal(archive.version, "1.0.0");
    assert.equal(uploaded.sourceHash, (await storage.listVersions(projectId)).versions.find(item => item.version === "1.0.0")?.sourceHash);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal((await readdir(path.join(dataRoot, "projects", projectId, "draft"))).includes("build"), false);
    assert.equal((await readdir(path.join(dataRoot, "projects", projectId, "draft", "source"))).includes("node_modules"), false);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("draft replacement waits for a publication and preserves the snapshot's version and files", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "workflow-static-concurrent-"));
  let releaseUpload!: () => void;
  let enteredUpload!: () => void;
  const uploadEntered = new Promise<void>(resolve => { enteredUpload = resolve; });
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot,
    artifacts: { async uploadFile() { enteredUpload(); await uploadGate; } } as unknown as ArtifactStorage });
  try {
    await storage.createProjectFromFiles({ projectName: projectId, files: [
      { path: "package.json", content: JSON.stringify(packageJson("2.0.0")) },
      { path: "index.ts", content: "original snapshot" },
    ] });
    const publish = storage.publish({ projectName: projectId });
    await uploadEntered;
    let replacementFinished = false;
    const replacement = storage.saveDraftFiles({ projectName: projectId, files: [
      { path: "package.json", content: JSON.stringify(packageJson("2.0.1")) },
      { path: "index.ts", content: "replacement draft" },
    ] }).then(() => { replacementFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(replacementFinished, false);
    releaseUpload();
    assert.equal((await publish).version, "2.0.0");
    await replacement;
    const published = await storage.getDownloadableSourceFiles({ projectName: projectId, target: "2.0.0" });
    assert.equal(published.files.find(file => file.path === "index.ts")?.content, "original snapshot");
    const draft = await storage.getFiles({ projectName: projectId, target: "draft" });
    assert.equal(draft.files.find(file => file.path === "index.ts")?.content, "replacement draft");
  } finally {
    releaseUpload?.();
    await storage.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("project data roles, management and source downloads have independent permissions", () => {
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot: tmpdir() });
  for (const role of ["owner", "manager", "writer", "viewer"] as ProjectRole[]) {
    const access = { projectId: projectId, projectName: "Static upload", visibility: "private" as const,
      member: { projectId: projectId, userId: "member", role, createdAt: "2026-10-16T00:00:00.000Z" } };
    assert.equal(storage.canReadProject({ access, userId: "member" }), true);
    assert.equal(storage.canWriteProjectData({ access, userId: "member" }), role !== "viewer");
    assert.equal(storage.canManageProject({ access, userId: "member" }), role === "owner" || role === "manager");
    assert.equal(storage.canDownloadProjectSource({ access, userId: "member" }), role === "owner" || role === "manager");
    assert.equal(storage.canDownloadProjectSource({ access, userId: "member", canDownloadSource: true }), true);
  }
});
