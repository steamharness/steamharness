import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { resolveRegisteredProjectEntry, readProjectDeclarationFromDirectory } from "@steamharness/project-manifest/node";
import { PROJECT_CONFIG_FILE, readProjectConfig, projectEntryDeclarationPath, selectProjectEntry } from "@steamharness/project-manifest";
import os from "node:os";
import { DATABASE_IDENTIFIER_PATTERN, DATABASE_UUID_PATTERN } from "@steamharness/project-manifest";

/** Serialize configuration updates across CLI processes and Studio tabs. */
async function withManifestLock<T>(packagePath: string, operation: () => Promise<T>): Promise<T> {
  const directory = path.join(os.homedir(), ".steamharness", "configuration-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(path.join(directory, `${createHash("sha256").update(packagePath).digest("hex")}.sqlite`));
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    const started = Date.now();
    for (;;) {
      try { lock.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (![5, 6].includes((error as { errcode: number }).errcode)) throw error;
        if (Date.now() - started >= 10_000) throw new Error("Project configuration is busy. Retry binding.");
        await delay(25);
      }
    }
    try { return await operation(); } finally { lock.exec("ROLLBACK"); }
  } finally { lock.close(); }
}

/** Knowledge uses its own resource map and independent host authorization. */
export async function bindProjectKnowledgeBase(projectDir: string, entryId: string, alias: string, knowledgeBaseId: string): Promise<void> {
  return bindProjectResource(projectDir, entryId, alias, knowledgeBaseId, "knowledgeBases");
}

async function bindProjectResource(projectDir: string, entryId: string, alias: string, databaseId: string, resource: "knowledgeBases"): Promise<void> {
  const root = await realpath(projectDir);
  if (!DATABASE_IDENTIFIER_PATTERN.test(alias) || !DATABASE_UUID_PATTERN.test(databaseId)) throw new Error("Invalid knowledge base alias or UUID.");
  const reference = { alias, databaseId: databaseId.toLowerCase() };
  const packagePath = path.join(root, "steamharness.json");
  const configPath = path.join(root, PROJECT_CONFIG_FILE);
  const readConfig = async () => {
    try {
      const file = await realpath(configPath);
      const relative = path.relative(root, file);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Project configuration must stay inside the project root (including symlinks).");
      return await readFile(file, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  await withManifestLock(configPath, async () => {
    const packageBefore = await readFile(packagePath, "utf8");
    const pkg = JSON.parse(packageBefore);
    const declaration = await readProjectDeclarationFromDirectory(root);
    const declarationPath = path.join(root, projectEntryDeclarationPath(pkg, entryId));
    const declarationBefore = await readFile(declarationPath, "utf8");
    const entryDocument = JSON.parse(declarationBefore);
    const entry = selectProjectEntry(declaration, entryId);
    // Validate entry paths before the first mapping exists.
    const paths = { ...declaration, entries: declaration.entries.map(item => ({ ...item, databases: [], knowledgeBases: [] })) };
    await resolveRegisteredProjectEntry(root, paths, selectProjectEntry(paths, entryId));
    const before = await readConfig();
    const config = readProjectConfig(before === undefined ? undefined : JSON.parse(before));
    const mapping = config[resource] ??= {};
    mapping[reference.alias] = reference.databaseId;
    const aliases = entry[resource] ?? [];
    const addAlias = !aliases.includes(reference.alias);
    if (addAlias) {
      const target = declarationPath === packagePath ? entryDocument.entries.find((item: { entryId: string }) => item.entryId === entryId) : entryDocument;
      target[resource] = [...aliases, reference.alias];
    }
    readProjectConfig(config);
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    const packageTemporary = `${declarationPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      if (addAlias) await writeFile(packageTemporary, JSON.stringify(entryDocument, null, 2) + "\n");
      if (await readFile(packagePath, "utf8") !== packageBefore || await readFile(declarationPath, "utf8") !== declarationBefore || await readConfig() !== before) throw new Error("Project configuration changed. Retry binding.");
      // An unused mapping is harmless if a concurrent package edit interrupts the second write.
      await rename(temporary, configPath);
      if (addAlias) {
        if (await readFile(packagePath, "utf8") !== packageBefore || await readFile(declarationPath, "utf8") !== declarationBefore) throw new Error("Project declaration changed. Retry binding.");
        await rename(packageTemporary, declarationPath);
      }
    } finally {
      await rm(temporary, { force: true });
      await rm(packageTemporary, { force: true });
    }
  });
}
