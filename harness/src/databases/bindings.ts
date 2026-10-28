import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { resolveProjectEntry } from "@steamharness/project-manifest/node";
import { readProjectManifest } from "@steamharness/project-manifest";
import { normalizeDatabaseRequirement } from "@steamharness/database-spaces";
import { localDatabaseRegistryDirectory } from "./local-registry";

/** Serialize manifest updates across CLI processes and Studio tabs. */
async function withManifestLock<T>(packagePath: string, operation: () => Promise<T>): Promise<T> {
  const directory = path.join(localDatabaseRegistryDirectory(), "manifest-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(path.join(directory, `${createHash("sha256").update(packagePath).digest("hex")}.sqlite`));
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    const started = Date.now();
    for (;;) {
      try { lock.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (![5, 6].includes((error as { errcode: number }).errcode)) throw error;
        if (Date.now() - started >= 10_000) throw new Error("Project manifest is busy. Retry binding.");
        await delay(25);
      }
    }
    try { return await operation(); } finally { lock.exec("ROLLBACK"); }
  } finally { lock.close(); }
}

/** Record an alias and database ID. Authorization is maintained exclusively by the host. */
export async function bindProjectDatabase(projectDir: string, entryId: string, alias: string, databaseId: string): Promise<void> {
  const resolved = await resolveProjectEntry(projectDir, entryId);
  const reference = normalizeDatabaseRequirement({ alias, databaseId });
  const packagePath = path.join(resolved.projectDir, "package.json");
  await withManifestLock(packagePath, async () => {
    const before = await readFile(packagePath, "utf8");
    const pkg = JSON.parse(before); const manifest = readProjectManifest(pkg);
    if (manifest.projectId !== resolved.manifest.projectId) throw new Error("Project identity changed while binding a database.");
    const entry = pkg.steamHarness.entries.find((item: { entryId: string }) => item.entryId === entryId);
    if (!entry) throw new Error("Project entry changed. Retry binding.");
    const index = entry.databases.findIndex((item: { alias: string }) => item.alias === alias);
    if (index < 0) entry.databases.push(reference); else entry.databases[index] = reference;
    readProjectManifest(pkg);
    const temporary = `${packagePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(pkg, null, 2) + "\n", { mode: 0o600 });
      if (await readFile(packagePath, "utf8") !== before) throw new Error("Project manifest changed. Retry binding.");
      await rename(temporary, packagePath);
    } finally { await rm(temporary, { force: true }); }
  });
}
