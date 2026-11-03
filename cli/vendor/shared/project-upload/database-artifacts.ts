import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeProjectUploadPath } from "./index";

export const DATABASE_DEFINITION_FILE = "steamharness.database.ts";
export const DATABASE_GENERATED_DIRECTORY = ".steamharness/generated/database";
export const DATABASE_ARTIFACT_MANIFEST = "manifest.json";

export interface DatabaseArtifactManifest {
  kind: "steamharness.database.artifacts";
  version: 1;
  generator: { name: "steamharness.database"; version: 2; engineVersion: string };
  databases: Array<{ alias: string; schema: string; schemaHash: string }>;
  sources: Record<string, string>;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export function databaseArtifactHash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Only this generated subtree may pass through a project's private runtime directory. */
export function isDatabaseArtifactPath(filename: string): boolean {
  const parts = filename.replaceAll("\\", "/").split("/");
  const index = parts.indexOf(".steamharness");
  return index >= 0 && parts[index + 1] === "generated" && parts[index + 2] === "database" && parts.length > index + 3
    && parts.every((part, i) => !!part && part !== "." && part !== ".." && !part.includes(":") && !part.includes("\0") && (i === index || !part.startsWith(".")))
    && /\.(?:ts|js|mjs|json|prisma)$/.test(filename);
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const hashPattern = /^[a-f0-9]{64}$/;

export function parseDatabaseArtifactManifest(value: unknown): DatabaseArtifactManifest {
  if (!record(value) || value.kind !== "steamharness.database.artifacts" || value.version !== 1
    || !record(value.generator) || value.generator.name !== "steamharness.database" || value.generator.version !== 2 || typeof value.generator.engineVersion !== "string"
    || !Array.isArray(value.databases) || value.databases.length === 0 || !record(value.sources) || !Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("Invalid database artifact manifest. Run steamharness database generate.");
  }
  const aliases = new Set<string>();
  for (const item of value.databases) {
    if (!record(item) || typeof item.alias !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(item.alias) || aliases.has(item.alias)
      || typeof item.schema !== "string" || !item.schema.endsWith("steamharness.schema") || normalizeProjectUploadPath(item.schema) !== item.schema
      || typeof item.schemaHash !== "string" || !hashPattern.test(item.schemaHash)) throw new Error("Invalid database artifact definition.");
    aliases.add(item.alias);
  }
  if (!hashPattern.test(String(value.sources[DATABASE_DEFINITION_FILE]))) throw new Error("Missing database definition fingerprint.");
  for (const [filename, hash] of Object.entries(value.sources)) {
    if (normalizeProjectUploadPath(filename) !== filename || filename.split("/").some(part => part.startsWith("."))
      || filename !== DATABASE_DEFINITION_FILE && !filename.endsWith("/steamharness.schema") && filename !== "steamharness.schema"
      || typeof hash !== "string" || !hashPattern.test(hash)) throw new Error("Invalid database source fingerprint.");
  }
  for (const item of value.databases) if (!(item.schema in value.sources)) throw new Error("Missing database schema fingerprint.");
  const files = new Set<string>();
  for (const file of value.files) {
    if (!record(file) || typeof file.path !== "string" || normalizeProjectUploadPath(file.path) !== file.path || file.path === DATABASE_ARTIFACT_MANIFEST
      || !isDatabaseArtifactPath(`${DATABASE_GENERATED_DIRECTORY}/${file.path}`) || files.has(file.path.toLowerCase())
      || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || typeof file.sha256 !== "string" || !hashPattern.test(file.sha256)) throw new Error("Invalid database artifact file.");
    files.add(file.path.toLowerCase());
  }
  for (const alias of aliases) for (const target of ["node", "browser"]) {
    if (!files.has(`${target}/${alias}.js`) || !files.has(`${target}/${alias}.ts`) || !files.has(`${target}/index.js`) || !files.has(`${target}/index.ts`)) throw new Error("Incomplete database artifact targets.");
  }
  return value as unknown as DatabaseArtifactManifest;
}

/** Server uses this static reader; it never imports the project's executable definition. */
export async function readDatabaseArtifactFiles(projectDir: string): Promise<{ manifest: DatabaseArtifactManifest; files: string[] } | undefined> {
  const generated = path.join(projectDir, DATABASE_GENERATED_DIRECTORY);
  const manifestPath = path.join(generated, DATABASE_ARTIFACT_MANIFEST);
  const manifestStat = await lstat(manifestPath).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!manifestStat) return undefined;
  await assertRegularPath(projectDir, `${DATABASE_GENERATED_DIRECTORY}/${DATABASE_ARTIFACT_MANIFEST}`);
  const manifest = parseDatabaseArtifactManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  for (const [filename, hash] of Object.entries(manifest.sources)) {
    await assertRegularPath(projectDir, filename);
    if (databaseArtifactHash(await readFile(path.join(projectDir, filename))) !== hash) throw new Error(`Database source ${filename} changed. Run steamharness database generate.`);
  }
  const expected = new Set([...manifest.files.map(file => file.path), DATABASE_ARTIFACT_MANIFEST]);
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) { await walk(path.join(directory, entry.name), `${relative}/`); continue; }
      if (!entry.isFile() || !expected.delete(relative)) throw new Error(`Unexpected database artifact ${relative}. Run steamharness database generate.`);
    }
  };
  await walk(generated);
  if (expected.size) throw new Error("Database artifacts are incomplete. Run steamharness database generate.");
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(generated, file.path));
    if (bytes.length !== file.size || databaseArtifactHash(bytes) !== file.sha256) throw new Error(`Database artifact ${file.path} changed. Run steamharness database generate.`);
  }
  return { manifest, files: [...manifest.files.map(file => `${DATABASE_GENERATED_DIRECTORY}/${file.path}`), `${DATABASE_GENERATED_DIRECTORY}/${DATABASE_ARTIFACT_MANIFEST}`] };
}

export async function assertRegularPath(root: string, relative: string): Promise<void> {
  const parts = normalizeProjectUploadPath(relative).split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new Error(`Database path ${relative} must use regular files and directories.`);
  }
}
