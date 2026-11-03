import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATABASE_ENGINE_VERSION, type DatabaseMigration } from "steamharness/database";
import { assertRegularPath, databaseArtifactHash } from "@steamharness/project-upload/database-artifacts";

export const migrationNamePattern = /^[0-9]{17}_[a-z][a-z0-9_]{0,63}$/;
export function migrationModelHash(source: string): string {
  return databaseArtifactHash(`steamharness.database:1:postgresql:${DATABASE_ENGINE_VERSION}\n${source.replace(/\r\n/g, "\n")}`);
}

function migrationDirectory(schema: string): string {
  if (path.posix.isAbsolute(schema) || /^[a-z]:/i.test(schema) || schema.includes("\\") || schema.includes("\0")
    || schema.split("/").includes("..") || path.posix.basename(schema) !== "steamharness.schema") throw new Error("Use a project-relative steamharness.schema path.");
  return path.posix.join(path.posix.dirname(schema), "migrations");
}

async function regularDirectories(root: string, relative: string, create = false): Promise<void> {
  let current = root;
  for (const part of relative.split("/").filter(value => value && value !== ".")) {
    if (part === ".." || part.includes("\\")) throw new Error("Migration paths must stay inside the project.");
    current = path.join(current, part);
    let info = await lstat(current).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info && create) { await mkdir(current); info = await lstat(current); }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Migration paths must use regular directories.");
  }
}

export async function readDatabaseMigrations(root: string, schema: string): Promise<{ migrations: DatabaseMigration[]; sources: Record<string, string> }> {
  const relative = migrationDirectory(schema);
  await regularDirectories(root, relative);
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const migrations: DatabaseMigration[] = [], sources: Record<string, string> = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !migrationNamePattern.test(entry.name)) throw new Error(`Unexpected migration entry ${entry.name}. Use versioned migration directories.`);
    const directory = `${relative}/${entry.name}`;
    const contents: Record<string, string> = {};
    const expected = ["migration.sql", "steamharness.schema", "steamharness.migration.json"];
    const actual = await readdir(path.join(root, directory));
    if (actual.length !== expected.length || actual.some(filename => !expected.includes(filename))) throw new Error(`Incomplete migration ${entry.name}.`);
    for (const filename of expected) {
      const relativeFile = `${directory}/${filename}`; await assertRegularPath(root, relativeFile);
      const bytes = await readFile(path.join(root, relativeFile));
      sources[relativeFile] = databaseArtifactHash(bytes);
      contents[filename] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    const record = JSON.parse(contents["steamharness.migration.json"]);
    if (!record || record.kind !== "steamharness.database.migration" || record.version !== 1 || record.name !== entry.name
      || Object.keys(record).some(key => !["kind", "version", "name", "checksum", "schemaHash"].includes(key))
      || record.checksum !== databaseArtifactHash(contents["migration.sql"]) || record.schemaHash !== migrationModelHash(contents["steamharness.schema"])) {
      throw new Error(`Migration ${entry.name} has inconsistent SQL or model fingerprints.`);
    }
    migrations.push({ name: entry.name, sql: contents["migration.sql"], schema: contents["steamharness.schema"], checksum: record.checksum, schemaHash: record.schemaHash });
  }
  return { migrations, sources };
}

export async function writeDatabaseMigration(root: string, schemaPath: string, migration: DatabaseMigration): Promise<string> {
  if (!migrationNamePattern.test(migration.name)) throw new Error("Invalid migration name.");
  const relative = migrationDirectory(schemaPath);
  await regularDirectories(root, relative, true);
  const parent = path.join(root, relative), destination = path.join(parent, migration.name);
  if (await lstat(destination).catch(() => undefined)) throw new Error(`Migration ${migration.name} already exists.`);
  const stage = await mkdtemp(path.join(parent, `.migration-${randomUUID()}-`));
  try {
    await writeFile(path.join(stage, "migration.sql"), migration.sql);
    await writeFile(path.join(stage, "steamharness.schema"), migration.schema);
    await writeFile(path.join(stage, "steamharness.migration.json"), JSON.stringify({ kind: "steamharness.database.migration", version: 1,
      name: migration.name, checksum: migration.checksum, schemaHash: migration.schemaHash }, null, 2) + "\n");
    await rename(stage, destination); return path.join(relative, migration.name);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
