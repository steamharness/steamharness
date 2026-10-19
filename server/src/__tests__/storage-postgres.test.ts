import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { create as createTar } from "tar";
import type { DeclaredProjectInfo } from "@steamharness/project-info";
import type { ProjectGroupManifestV1 } from "@steamharness/project-dependencies";
import { LocalStorage } from "../local-storage";
import { ArtifactStorage, DatabaseRepository } from "../persistence";
import { Storage } from "../storage";

const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL?.trim();

test("PostgreSQL stores static project groups, immutable versions and independent project data", {
  skip: databaseUrl ? false : "STEAMHARNESS_TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  const schema = `storage_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`create schema ${schema}`);
  const connection = new URL(databaseUrl);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const db = new DatabaseRepository(connection.toString());
  const pool = new pg.Pool({ connectionString: connection.toString() });
  const root = await mkdtemp(path.join(tmpdir(), "workflow-storage-postgres-"));
  const objects = new LocalStorage({ root: path.join(root, "objects"), publicBaseUrl: "http://localhost/" });
  const storage = new Storage({ serverRoot: process.cwd(), repoRoot: process.cwd(),
    dataRoot: path.join(root, "data"), db, objectStorage: objects, artifacts: new ArtifactStorage(objects) });
  const boardId = randomUUID();
  const workerId = randomUUID();
  const packageVersion = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"))
    .dependencies["steamharness"] as string;
  const projectInfo = (alias: string, projectId: string): DeclaredProjectInfo => ({
    localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" }, dataStorage: { mode: "server" },
    relatedProjects: [{ alias, projectId, grantToRelatedProject: { read: { mode: "all" }, write: { mode: "all" } } }],
  });
  try {
    await db.init();
    const groupDir = path.join(root, "group");
    await mkdir(groupDir);
    for (const [id, type, info] of [
      [boardId, "kanban", projectInfo("worker", workerId)],
      [workerId, "workflow", projectInfo("board", boardId)],
    ] as const) {
      const created = await storage.createProject({ projectId: id, projectName: type,
        projectType: type, projectInfo: info, ownerUserId: "owner", createdByUserId: "owner" });
      assert.equal(created.visibility, "private");
      assert.equal((await storage.getProjectAccessSummary(id, "owner")).member?.role, "owner");
      for (const role of ["manager", "writer", "viewer"] as const) {
        await storage.setProjectMember({ projectId: id, userId: role, role });
        assert.equal((await storage.getProjectAccessSummary(id, role)).member?.role, role);
      }
      const manifest = { id, name: type, version: "1.0.0",
        devDependencies: { "steamharness": packageVersion },
        scripts: { build: "node must-not-run.cjs", postinstall: "node must-not-run.cjs" },
        steamHarness: { projectType: type, projectInfo: info, ...(type === "kanban" ? { kanban: {} } : {}) } };
      const files = [
        { path: "package.json", content: JSON.stringify(manifest) },
        { path: type === "kanban" ? "index.html" : "index.ts", content: type === "kanban"
          ? "<!doctype html><title>Static board</title>" : "throw new Error('never execute uploaded code');" },
        { path: "must-not-run.cjs", content: `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "executed"))}, 'executed');` },
      ];
      await storage.saveDraftFiles({ projectName: id, files });
      const source = path.join(root, id);
      await mkdir(source);
      for (const file of files) await writeFile(path.join(source, file.path), file.content);
      await createTar({ cwd: source, file: path.join(groupDir, `${id}.tar.gz`), gzip: true }, ["."]);
    }
    const manifest: ProjectGroupManifestV1 = { version: 1, rootProjectId: boardId,
      projects: [
        { projectId: boardId, role: "root", archivePath: `${boardId}.tar.gz`, version: "1.0.0" },
        { projectId: workerId, role: "dependency", alias: "worker", archivePath: `${workerId}.tar.gz`, version: "1.0.0" },
      ], dependencies: [{ alias: "worker", projectId: workerId, delivery: "included" }] };
    await writeFile(path.join(groupDir, "project-group.json"), JSON.stringify(manifest));
    const groupArchive = path.join(root, "group.tar.gz");
    await createTar({ cwd: groupDir, file: groupArchive, gzip: true }, ["."]);
    const deployment = await storage.createProjectGroupDeployment({ manifest, releaseLog: "Static snapshots", createdByUserId: "owner" });
    assert.equal((await storage.prepareProjectGroupDeployment({ deploymentId: deployment.id,
      archiveName: "group.tar.gz", archiveBuffer: await readFile(groupArchive) })).status, "prepared");
    assert.equal((await storage.publishProjectGroupDeployment(deployment.id)).status, "published");
    const versions = await storage.listVersions(boardId);
    assert.equal(versions.latest, "1.0.0");
    assert.equal(versions.versions[0]?.dependencies[0]?.version, "1.0.0");
    const snapshot = await storage.getDownloadableSourceFiles({ projectName: boardId, target: "1.0.0" });
    const copyId = randomUUID();
    await storage.cloneProject({ projectName: boardId, sourceTarget: "1.0.0",
      targetProjectName: copyId, ownerUserId: "copier" });
    const copied = await storage.getProjectAccessSummary(copyId, "copier");
    assert.equal(copied.ownerUserId, "copier");
    assert.equal(copied.member?.role, "owner");
    assert.equal(copied.visibility, "private");
    assert.equal((await storage.getFiles({ projectName: copyId, target: "draft" })).files.length, snapshot.files.length);
    await assert.rejects(storage.publish({ projectName: boardId }), /already published|already exists/);
    await assert.rejects(storage.uploadPackage({ projectName: boardId, archiveName: "bad.tgz", archiveBuffer: Buffer.from("invalid") }));
    assert.deepEqual(await storage.getDownloadableSourceFiles({ projectName: boardId, target: "1.0.0" }), snapshot);
    assert.equal((await storage.getProjectGroupDownload({ projectName: boardId, canDownloadProject: async () => true })).projects.length, 2);
    const skipped = await storage.getProjectGroupDownload({ projectName: boardId, canDownloadProject: async () => false });
    assert.equal(skipped.skippedDependencies[0]?.reason, "permission_required");
    assert.equal(skipped.copyAllowed, false);

    const entry = { storageKind: "kv" as const, scope: "project" as const, projectId: workerId, key: "stock" };
    await storage.setProjectStorageValue({ ...entry, value: 1, source: { projectId: workerId, runId: "local-run" } });
    const initial = await storage.getProjectStorageValue(entry);
    const outcomes = await Promise.all([2, 3].map(value => storage.compareAndSetProjectStorageValue({
      ...entry, value, expectedRevision: initial.revision!, source: { projectId: workerId, runId: "local-run" },
    })));
    assert.equal(outcomes.filter(item => item.applied).length, 1);
    assert.equal((await storage.getProjectKVEntry({ projectId: workerId, scope: "project", key: "stock" })).lastRunId, "local-run");
    assert.equal((await storage.resolveRelatedProjectKVAccess({ consumerProjectId: boardId, alias: "worker", key: "stock", operation: "write" })).targetProjectId, workerId);
    await storage.removeRelatedProject({ projectId: workerId, alias: "board", updateTarget: false });
    await assert.rejects(storage.resolveRelatedProjectKVAccess({ consumerProjectId: boardId, alias: "worker", key: "stock", operation: "read" }), /unavailable|confirmation/);

    const document = await storage.createKnowledgeDocument({ projectName: workerId, title: "Guide", markdown: "# Guide\nStorage only" });
    await storage.editKnowledgeDocument({ projectName: workerId, documentId: document.id, markdown: "# Guide\nUpdated storage" });
    assert.equal((await storage.listKnowledgeDocuments(workerId)).total, 1);
    assert.equal((await storage.searchKnowledgeDocuments({ projectName: workerId, query: "Updated" })).matches.length, 1);
    const file = (await storage.saveManagedFiles({ projectName: workerId, files: [{ name: "note.txt", buffer: Buffer.from("saved") }] }))[0]!;
    assert.equal(await readFile((await storage.getManagedFile(file.id)).filePath, "utf8"), "saved");
    await storage.deleteManagedFile(file.id);
    await assert.rejects(storage.getManagedFile(file.id));
    await storage.deleteKnowledgeDocument({ projectName: workerId, documentId: document.id });
    assert.equal((await storage.listKnowledgeDocuments(workerId)).total, 0);

    await pool.query("create table project_runs (record text); insert into project_runs values ('historical data')");
    await db.init();
    assert.equal((await pool.query("select record from project_runs")).rows[0]?.record, "historical data");
    assert.equal((await storage.listVersions(boardId)).latest, "1.0.0");
    await assert.rejects(readFile(path.join(root, "executed")), { code: "ENOENT" });
  } finally {
    await storage.close();
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
