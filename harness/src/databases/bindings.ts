import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveProjectEntry } from "@steamharness/project-manifest/node";
import { readProjectManifest } from "@steamharness/project-manifest";
import { createDatabasesContext, type DatabaseResolver } from "./index";

/** Persist only a non-secret binding reference after host approval. */
export async function bindProjectDatabase(projectDir: string, entryId: string, alias: string, bindingRef: string, resolver: DatabaseResolver): Promise<void> {
  const resolved = await resolveProjectEntry(projectDir, entryId);
  const requirement = resolved.registration.databases.find((item) => item.alias === alias);
  if (!requirement) throw new Error("The entry does not declare this database alias.");
  await createDatabasesContext({ projectId: resolved.manifest.projectId, entryId, requirements: [{ ...requirement, bindingRef }], resolver }).get(alias).getBinding();
  const packagePath = path.join(resolved.projectDir, "package.json");
  const before = await readFile(packagePath, "utf8");
  const pkg = JSON.parse(before); const manifest = readProjectManifest(pkg);
  if (manifest.projectId !== resolved.manifest.projectId) throw new Error("Project identity changed while binding a database.");
  const entry = pkg.steamHarness.entries.find((item: { entryId: string }) => item.entryId === entryId);
  const declared = entry?.databases.find((item: { alias: string }) => item.alias === alias);
  const normalized = manifest.entries.find(item => item.entryId === entryId)?.databases.find(item => item.alias === alias);
  if (!declared || !normalized || JSON.stringify({ ...normalized, bindingRef: undefined }) !== JSON.stringify({ ...requirement, bindingRef: undefined })) throw new Error("Database declaration changed. Retry binding.");
  declared.bindingRef = bindingRef;
  readProjectManifest(pkg);
  const temporary = `${packagePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(pkg, null, 2) + "\n", { mode: 0o600 });
    if (await readFile(packagePath, "utf8") !== before) throw new Error("Project manifest changed. Retry binding.");
    await rename(temporary, packagePath);
  } finally { await rm(temporary, { force: true }); }
}
