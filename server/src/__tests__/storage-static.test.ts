import { projectFixtureFiles } from '../../scripts/test-project-fixture.mjs';
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { create as createTar, list as listTar } from "tar";
import { Storage, type PreparationStage } from "../storage";
import type { ArtifactStorage } from "../persistence";
import { databaseArtifactDirectory } from "@steamharness/project-manifest";

const projectId = "00000000-0000-4000-8000-000000000091";
const serverPackage = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

function packageJson(version: string) {
  return {
    id: projectId, name: "Static upload", version,
    devDependencies: { "steamharness": serverPackage.dependencies["steamharness"] },
    scripts: { preinstall: "node side-effect.cjs", postinstall: "node side-effect.cjs", build: "node side-effect.cjs" },

      defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"workflow",root:".",entry:"index.ts",databases:[]}],
      projectInfo: {
        localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" },
      },
  };
}

test("file creation and draft replacement statically verify child database artifacts", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "database-static-storage-"));
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot });
  const sourceRoot = "apps/billing", generated = databaseArtifactDirectory(sourceRoot);
  const hash = (content: string) => createHash("sha256").update(content).digest("hex");
  const definition = "throw new Error('database definitions must never execute on Server');\n";
  const schema = "model User {\n id Int @id\n}\n", content = "export {};\n";
  const outputs = ["node", "browser"].flatMap(target => ["index.js", "index.ts", "main.js", "main.ts"]
    .map(filename => ({ path: `${target}/${filename}`, size: Buffer.byteLength(content), sha256: hash(content) })));
  const manifest = { kind: "steamharness.database.artifacts", version: 1,
    generator: { name: "steamharness.database", version: 2, engineVersion: "test" },
    databases: [{ alias: "main", schema: "steamharness.schema", schemaHash: hash(schema) }],
    sources: { "steamharness.database.ts": hash(definition), "steamharness.schema": hash(schema) }, files: outputs };
  const pkg = packageJson("1.0.0");
  const files = projectFixtureFiles([
    { path: "package.json", content: JSON.stringify({ ...pkg, entries: [{ ...pkg.entries[0], root: sourceRoot, databases: ["main"] }] }) },
    { path: `${sourceRoot}/index.ts`, content: "throw new Error('source must stay static');" },
    { path: `${sourceRoot}/steamharness.database.ts`, content: definition },
    { path: `${sourceRoot}/steamharness.schema`, content: schema },
    ...outputs.map(file => ({ path: `${generated}/${file.path}`, content })),
    { path: `${generated}/manifest.json`, content: JSON.stringify(manifest) },
  ]);
  try {
    await assert.rejects(storage.createProjectFromFiles({ projectName: projectId,
      files: files.filter(file => file.path !== `${generated}/manifest.json`) }), /Missing database artifacts/);
    await storage.createProjectFromFiles({ projectName: projectId, files });
    const before = await storage.getFiles({ projectName: projectId, target: "draft" });
    for (const changedPath of [`${generated}/node/main.js`, `${sourceRoot}/steamharness.schema`]) {
      await assert.rejects(storage.saveDraftFiles({ projectName: projectId,
        files: [{ path: changedPath, content: "tampered" }] }), /changed/);
      assert.deepEqual(await storage.getFiles({ projectName: projectId, target: "draft" }), before);
    }
    await assert.rejects(storage.saveDraftFiles({ projectName: projectId,
      files: [], removePaths: [`${generated}/browser/main.js`] }), /incomplete/);
    assert.deepEqual(await storage.getFiles({ projectName: projectId, target: "draft" }), before);
  } finally {
    await storage.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("source configuration resolves aliases while version snapshots retain authored IDs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-config-storage-"));
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot: root });
  const first = "00000000-0000-4000-8000-000000000001", second = "00000000-0000-4000-8000-000000000002";
  const archive = "00000000-0000-4000-8000-000000000003";
  const config = (id: string) => ({ version: 1, knowledgeBases: { data: id, archive } });
  const previous = process.env.STEAMHARNESS_PROJECT_CONFIG;
  delete process.env.STEAMHARNESS_PROJECT_CONFIG;
  try {
    const pkg = packageJson("1.0.0");
    Object.assign(pkg.entries[0]!, {knowledgeBases: ["data"]});
    pkg.entries.push({ ...pkg.entries[0]!, entryId: "archive-reader", name: "Archive reader" });
    Object.assign(pkg.entries[1]!, { knowledgeBases: ["archive"] });
    await storage.createProjectFromFiles({ projectName: projectId, files: projectFixtureFiles([
      { path: "package.json", content: JSON.stringify(pkg) },
      { path: "config.json", content: JSON.stringify(config(first)) },
      { path: "index.ts", content: "throw new Error('configuration must stay static');" },
    ]) });
    assert.deepEqual(await storage.entryKnowledgeBaseRequirements(projectId, "main"), [{ alias: "data", knowledgeBaseId: first }]);
    process.env.STEAMHARNESS_PROJECT_CONFIG = JSON.stringify({ knowledgeBases: { data: second, unused: "00000000-0000-4000-8000-000000000004" } });
    assert.deepEqual(await storage.entryKnowledgeBaseRequirements(projectId, "main"), [{ alias: "data", knowledgeBaseId: second }]);
    assert.deepEqual(await storage.entryKnowledgeBaseRequirements(projectId, "archive-reader"), [{ alias: "archive", knowledgeBaseId: archive }]);
    process.env.STEAMHARNESS_PROJECT_CONFIG = "{";
    await storage.publish({ projectName: projectId, expectedVersion: "1.0.0", releaseLog: "Configured snapshot" });
    const published = await storage.getDownloadableSourceFiles({ projectName: projectId, target: "1.0.0" });
    assert.deepEqual(JSON.parse(published.files.find(file => file.path === "config.json")!.content), config(first));
    delete process.env.STEAMHARNESS_PROJECT_CONFIG;
    const draft = await storage.getFiles({ projectName: projectId, target: "draft" });
    await storage.saveDraftFiles({ projectName: projectId, files: draft.files.map(file => file.path === "config.json" ? { ...file, content: JSON.stringify(config(second)) } : file) });
    assert.deepEqual(await storage.entryKnowledgeBaseRequirements(projectId, "main"), [{ alias: "data", knowledgeBaseId: second }]);
    assert.deepEqual(await storage.entryKnowledgeBaseRequirements(projectId, "main", "1.0.0"), [{ alias: "data", knowledgeBaseId: first }]);
  } finally {
    if (previous === undefined) delete process.env.STEAMHARNESS_PROJECT_CONFIG; else process.env.STEAMHARNESS_PROJECT_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("creation, upload, publication and historical downloads never load or build project code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-static-upload-"));
  const dataRoot = path.join(root, "data");
  const marker = path.join(root, "executed");
  const sideEffect = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot });
  const stages: PreparationStage[] = [];
  try {
    await storage.createProjectFromFiles({ projectName: projectId, files: projectFixtureFiles([
      { path: "package.json", content: JSON.stringify(packageJson("1.0.0")) },
      { path: "index.ts", content: `import 'node:fs'; throw new Error('must never execute');` },
    ]) });
    const source = path.join(root, "package");
    await mkdir(source);
    await writeProjectFixture(path.join(source, "package.json"), JSON.stringify(packageJson("1.0.0")));
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
    await storage.saveDraftFiles({ projectName: projectId, files: projectFixtureFiles(next.files.map(file => file.path === "steamharness.json"
      ? { ...file, content: JSON.stringify({...JSON.parse(file.content!),version:"1.0.1"}) } : file)) });
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
    await storage.createProjectFromFiles({ projectName: projectId, files: projectFixtureFiles([
      { path: "package.json", content: JSON.stringify(packageJson("2.0.0")) },
      { path: "index.ts", content: "original snapshot" },
    ]) });
    const publish = storage.publish({ projectName: projectId });
    await uploadEntered;
    let replacementFinished = false;
    const replacement = storage.saveDraftFiles({ projectName: projectId, files: projectFixtureFiles([
      { path: "package.json", content: JSON.stringify(packageJson("2.0.1")) },
      { path: "index.ts", content: "replacement draft" },
    ]) }).then(() => { replacementFinished = true; });
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
