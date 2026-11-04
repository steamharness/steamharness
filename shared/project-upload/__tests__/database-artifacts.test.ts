import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databaseArtifactHash, DATABASE_GENERATED_DIRECTORY, isDatabaseArtifactPath, parseDatabaseArtifactManifest, readDatabaseArtifactFiles, type DatabaseArtifactManifest } from "../database-artifacts";
import { copyProjectUploadFiles, createProjectUploadPlan } from "../node";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(): Promise<{ root: string; generated: string; manifest: DatabaseArtifactManifest }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "database-static-upload-")); directories.push(root);
  const generated = path.join(root, DATABASE_GENERATED_DIRECTORY);
  const source = 'throw new Error("Static Server validation must never execute project definitions.");\n';
  await writeFile(path.join(root, "steamharness.database.ts"), source);
  await writeFile(path.join(root, "steamharness.schema"), "model User {\n id Int @id\n}\n");
  await writeFile(path.join(root, "package.json"), '{"name":"database-static","type":"module"}');
  await writeFile(path.join(root, "index.ts"), "export {};\n");
  await writeFile(path.join(root, "steamharness.json"), JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", name: "Static database", version: "0.1.0", defaultEntry: "main",
    entries: [{ entryId: "main", root: ".", entry: "index.ts", type: "workflow", name: "Main", databases: [] }] }));
  const files: DatabaseArtifactManifest["files"] = [];
  for (const target of ["node", "browser"]) {
    await mkdir(path.join(generated, target), { recursive: true });
    for (const filename of ["index.js", "index.ts", "main.js", "main.ts"]) {
      const content = "export {};\n";
      await writeFile(path.join(generated, target, filename), content);
      files.push({ path: `${target}/${filename}`, size: Buffer.byteLength(content), sha256: databaseArtifactHash(content) });
    }
  }
  const manifest: DatabaseArtifactManifest = { kind: "steamharness.database.artifacts", version: 1, generator: { name: "steamharness.database", version: 2, engineVersion: "test" },
    databases: [{ alias: "main", schema: "steamharness.schema", schemaHash: databaseArtifactHash("schema") }],
    sources: { "steamharness.database.ts": databaseArtifactHash(source), "steamharness.schema": databaseArtifactHash(await readFile(path.join(root, "steamharness.schema"))) }, files };
  await writeFile(path.join(generated, "manifest.json"), JSON.stringify(manifest));
  return { root, generated, manifest };
}

describe("static database artifacts", () => {
  it("copies only verified generated files, without executing definitions or copying host runtime state", async () => {
    const { root } = await fixture();
    const declaration = JSON.parse(await readFile(path.join(root, "steamharness.json"), "utf8"));
    declaration.entries.push({ entryId: "board", root: ".", type: "kanban", name: "Board", databases: [] });
    await writeFile(path.join(root, "steamharness.json"), JSON.stringify(declaration));
    await mkdir(path.join(root, "dist/steamharness/build/board"), { recursive: true });
    await writeFile(path.join(root, "dist/steamharness/build/board/index.html"), '<script src="app.js"></script>');
    await writeFile(path.join(root, "dist/steamharness/build/board/app.js"), "document.body.dataset.ready = 'yes';");
    await mkdir(path.join(root, "dist/steamharness/build/unregistered"), { recursive: true });
    await writeFile(path.join(root, "dist/steamharness/build/unregistered/private.json"), "{}");
    await writeFile(path.join(root, "dist/steamharness/session.json"), '{"secret":"local"}');
    const target = await mkdtemp(path.join(os.tmpdir(), "database-static-target-")); directories.push(target);
    for (const relative of ['cache/vite', 'reports/test', 'release/package', 'tmp/build', 'unregistered/output']) {
      await mkdir(path.join(root, 'dist', relative), { recursive: true });
      await writeFile(path.join(root, 'dist', relative, 'private.json'), '{}');
    }
    const plan = await copyProjectUploadFiles(root, target);
    expect(plan.files.some(file => file.path.endsWith('private.json'))).toBe(false);
    expect(plan.files.some(file => file.path === "dist/steamharness/generated/database/node/main.js")).toBe(true);
    expect(plan.files.some(file => file.path === "dist/steamharness/build/board/index.html")).toBe(true);
    expect(plan.files.some(file => file.path === "dist/steamharness/build/board/app.js")).toBe(true);
    expect(plan.files.some(file => file.path.endsWith("session.json"))).toBe(false);
    expect((await readDatabaseArtifactFiles(target))?.manifest.databases[0].alias).toBe("main");
    await writeFile(path.join(root, ".steamharnessignore"), "dist/steamharness/\n");
    await expect(createProjectUploadPlan(root)).rejects.toThrow(/Required upload path/);
    await writeFile(path.join(root, ".steamharnessignore"), "steamharness.schema\n");
    await expect(createProjectUploadPlan(root)).rejects.toThrow(/Required upload path/);
  });

  it("rejects altered, missing, extra and stale artifacts", async () => {
    const { root, generated } = await fixture();
    const entry = path.join(generated, "node/main.js"), before = await readFile(entry, "utf8");
    await writeFile(entry, "export const changed = true;\n");
    await expect(readDatabaseArtifactFiles(root)).rejects.toThrow(/changed/);
    await writeFile(entry, before);
    await writeFile(path.join(generated, "extra.json"), "{}");
    await expect(readDatabaseArtifactFiles(root)).rejects.toThrow(/Unexpected/);
    await rm(path.join(generated, "extra.json"));
    await rm(entry);
    await expect(readDatabaseArtifactFiles(root)).rejects.toThrow(/incomplete/);
    await writeFile(entry, before);
    await writeFile(path.join(root, "steamharness.schema"), "changed");
    await expect(readDatabaseArtifactFiles(root)).rejects.toThrow(/source.*changed/);
  });

  it("rejects a schema symlink before hashing files outside the project", async () => {
    const { root } = await fixture();
    const schema = path.join(root, "steamharness.schema"), bytes = await readFile(schema);
    const other = await mkdtemp(path.join(os.tmpdir(), "database-outside-")); directories.push(other);
    await writeFile(path.join(other, "schema"), bytes); await rm(schema);
    await symlink(path.join(other, "schema"), schema, "file");
    await expect(readDatabaseArtifactFiles(root)).rejects.toThrow(/regular files/);
  });

  it("rejects traversal, runtime-secret paths, duplicate files and missing targets in manifests", async () => {
    const { manifest } = await fixture();
    for (const filename of ["../token.json", "node/../../token.json", ".env", "node/.env.json", "node/token.key", "dist/steamharness/session.json"]) {
      const changed = structuredClone(manifest); changed.files[0].path = filename;
      expect(() => parseDatabaseArtifactManifest(changed)).toThrow();
    }
    const duplicate = structuredClone(manifest); duplicate.files.push(duplicate.files[0]);
    expect(() => parseDatabaseArtifactManifest(duplicate)).toThrow();
    const incomplete = structuredClone(manifest); incomplete.files = incomplete.files.filter(file => !file.path.startsWith("browser"));
    expect(() => parseDatabaseArtifactManifest(incomplete)).toThrow(/Incomplete/);
    expect(isDatabaseArtifactPath("dist/steamharness/entries/nested/generated/database/node/main.js")).toBe(true);
    expect(isDatabaseArtifactPath("dist/steamharness/session.json")).toBe(false);
  });
});
