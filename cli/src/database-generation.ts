import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolveModule } from "import-meta-resolve";
import { tsImport } from "tsx/esm/api";
import { DATABASE_ENGINE_VERSION, parseDatabaseDefinitions, type DatabaseMetadata } from "steamharness/database";
import { readProjectDeclarationFromDirectory } from "@steamharness/project-manifest/node";
import { DATABASE_ARTIFACT_MANIFEST, DATABASE_DEFINITION_FILE, DATABASE_GENERATED_DIRECTORY,
  assertRegularPath, databaseArtifactHash, readDatabaseArtifactFiles, type DatabaseArtifactManifest } from "@steamharness/project-upload/database-artifacts";

const require = createRequire(import.meta.url);
// Prisma's pinned generator currently has an extensionless ESM dependency. Its CJS export is supported on Node.
const { generateClient } = require("@prisma/client-generator-ts") as typeof import("@prisma/client-generator-ts");
const { getDMMF, getConfig } = require("@prisma/internals") as typeof import("@prisma/internals");
const ts = require("typescript") as typeof import("typescript");
const engineVersion = DATABASE_ENGINE_VERSION;
const generatorRequire = createRequire(require.resolve("@prisma/client-generator-ts"));
const engineCommit: string = generatorRequire("@prisma/engines-version").enginesVersion;

interface ValidatedSchema {
  source: string;
  schema: string;
  schemaHash: string;
  datamodel: string;
  dmmf: Awaited<ReturnType<typeof getDMMF>>;
  config: Awaited<ReturnType<typeof getConfig>>;
  metadata: DatabaseMetadata;
}
export interface ValidatedDatabases {
  databases: Array<{ alias: string; schema: string; schemaHash: string }>;
  sources: Record<string, string>;
  schemas: Map<string, ValidatedSchema>;
}
export interface DatabaseGenerationResult {
  directory: string;
  databases: ValidatedDatabases["databases"];
  cached: boolean;
}

/** Local authoring only. Server validates the static artifact manifest instead. */
export async function validateDatabases(projectDirectory: string): Promise<ValidatedDatabases> {
  const root = path.resolve(projectDirectory);
  await assertRegularPath(root, DATABASE_DEFINITION_FILE);
  const filename = path.join(root, DATABASE_DEFINITION_FILE);
  const module = await tsImport(pathToFileURL(filename).href, { parentURL: import.meta.url, tsconfig: false });
  const definitions = parseDatabaseDefinitions(module.default);
  const sources: Record<string, string> = { [DATABASE_DEFINITION_FILE]: databaseArtifactHash(await readFile(filename)) };
  const schemas = new Map<string, ValidatedSchema>();
  const databases: ValidatedDatabases["databases"] = [];
  for (const [alias, definition] of Object.entries(definitions.databases).sort(([a], [b]) => a.localeCompare(b))) {
    const schema = definition.schema.replace(/^\.\//, "");
    if (schema.split("/").some(part => part.startsWith("."))) throw new Error(`${schema}: database schemas must be authored outside hidden runtime directories.`);
    await assertRegularPath(root, schema);
    const bytes = await readFile(path.join(root, schema));
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n"); }
    catch { throw new Error(`${schema}: database schemas must use UTF-8.`); }
    sources[schema] = databaseArtifactHash(bytes);
    const schemaHash = databaseArtifactHash(`steamharness.database:1:postgresql:${engineVersion}\n${source}`);
    if (!schemas.has(schemaHash)) {
      // Remove strings and comments while preserving newlines, so diagnostics retain authored locations.
      const tokens = source.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, text => text.replace(/[^\n]/g, " "));
      const forbidden = /\b(?:datasource|generator)\s+\w+\s*\{/.exec(tokens);
      if (forbidden) throw new Error(`${schema}:${source.slice(0, forbidden.index).split("\n").length}: datasource and generator blocks are managed by SteamHarness. Define only models, enums and relations.`);
      const datamodel = `${source}\n\ngenerator client {\n  provider = "prisma-client"\n  output = "./client"\n}\ndatasource db {\n  provider = "postgresql"\n}\n`;
      try {
        const dmmf = await getDMMF({ datamodel: [[schema, datamodel]] });
        if (dmmf.datamodel.models.length === 0) throw new Error("Define at least one queryable model.");
        if (dmmf.datamodel.models.some(model => model.name[0].toLowerCase() + model.name.slice(1) === "transaction")) throw new Error("The model name Transaction conflicts with the database transaction API. Choose another model name.");
        const config = await getConfig({ datamodel });
        schemas.set(schemaHash, { source, schema, schemaHash, datamodel, dmmf, config, metadata: metadataFor(dmmf) });
      } catch (error) {
        throw new Error(`${schema}: ${authoredDiagnostic(error, schema)}`);
      }
    }
    databases.push({ alias, schema, schemaHash });
  }
  return { databases, sources, schemas };
}

function authoredDiagnostic(error: unknown, schema: string): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/schema\.prisma/g, schema).replace(/Prisma schema/g, "Database schema");
}

function metadataFor(dmmf: ValidatedSchema["dmmf"]): DatabaseMetadata {
  return {
    models: dmmf.datamodel.models.map(model => ({
      name: model.name, delegate: model.name[0].toLowerCase() + model.name.slice(1), table: model.dbName ?? model.name,
      fields: model.fields.map(field => ({
        name: field.name, column: field.dbName ?? field.name, kind: field.kind, type: field.type,
        required: field.isRequired, list: field.isList, id: field.isId, unique: field.isUnique,
        ...(field.relationName ? { relation: { name: field.relationName, from: field.relationFromFields ?? [], to: field.relationToFields ?? [] } } : {}),
      })),
      primaryKey: model.primaryKey?.fields ?? model.fields.filter(field => field.isId).map(field => field.name),
      uniqueKeys: [...model.uniqueFields, ...model.fields.filter(field => field.isUnique).map(field => [field.name])],
    })),
    enums: dmmf.datamodel.enums.map(item => ({ name: item.name, values: item.values.map(value => value.name) })),
  };
}

export async function generateDatabases(projectDirectory: string): Promise<DatabaseGenerationResult> {
  const root = path.resolve(projectDirectory);
  const validated = await validateDatabases(root);
  const directory = path.join(root, DATABASE_GENERATED_DIRECTORY);
  const current = await readDatabaseArtifactFiles(root).catch(() => undefined);
  if (current && current.manifest.generator.engineVersion === engineVersion
    && JSON.stringify(current.manifest.databases) === JSON.stringify(validated.databases)
    && JSON.stringify(current.manifest.sources) === JSON.stringify(validated.sources)) {
    return { directory, databases: validated.databases, cached: true };
  }
  // A per-project lock prevents two generators from replacing each other's result.
  const parent = path.dirname(directory);
  await assertOutputDirectories(root);
  await mkdir(parent, { recursive: true });
  const lock = `${directory}.lock`;
  try { await mkdir(lock); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Database generation is already running. If an interrupted process left the lock, remove .steamharness/generated/database.lock and retry."); throw error; }
  let stage: string | undefined;
  const backup = `${directory}.previous`;
  let backedUp = false;
  try {
    stage = await mkdtemp(path.join(parent, ".database-build-"));
    await save(stage, "package.json", '{"type":"module"}\n');
    for (const schema of validated.schemas.values()) {
      try { await generateSchema(stage, schema); } catch (error) { throw new Error(`${schema.schema}: ${authoredDiagnostic(error, schema.schema)}`); }
    }
    for (const target of ["node", "browser"] as const) {
      for (const database of validated.databases) await generateDescriptor(stage, target, database, validated.schemas.get(database.schemaHash)!);
      await save(stage, `${target}/index.ts`, banner + validated.databases.map(({ alias }) => `export { database as ${alias} } from "./${alias}.js";`).join("\n") + "\n"
        + validated.databases.map(({ alias }) => `import { database as ${alias} } from "./${alias}.js";`).join("\n") + "\n"
        + `export const databases = Object.freeze({ ${validated.databases.map(item => item.alias).join(", ")} });\n`);
    }
    // Ship executable ESM alongside TypeScript, so projects need no generator or TS loader at runtime.
    for (const file of await listFiles(stage)) {
      if (!file.endsWith(".ts")) continue;
      const source = await readFile(path.join(stage, file), "utf8");
      const output = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true } });
      await save(stage, file.replace(/\.ts$/, ".js"), output.outputText);
    }
    const files: DatabaseArtifactManifest["files"] = [];
    for (const file of await listFiles(stage)) {
      const bytes = await readFile(path.join(stage, file));
      files.push({ path: file, size: bytes.length, sha256: databaseArtifactHash(bytes) });
    }
    const manifest: DatabaseArtifactManifest = { kind: "steamharness.database.artifacts", version: 1,
      generator: { name: "steamharness.database", version: 1, engineVersion }, databases: validated.databases, sources: validated.sources, files };
    await save(stage, DATABASE_ARTIFACT_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    for (const [filename, hash] of Object.entries(validated.sources)) {
      if (databaseArtifactHash(await readFile(path.join(root, filename))) !== hash) throw new Error(`${filename} changed during generation. Retry the command.`);
    }
    if (await lstat(backup).catch(() => undefined)) throw new Error("A previous database artifact backup exists. Review .steamharness/generated/database.previous before retrying.");
    if (await lstat(directory).catch(() => undefined)) { await rename(directory, backup); backedUp = true; }
    try { await rename(stage, directory); stage = undefined; }
    catch (error) { if (backedUp) { await rename(backup, directory); backedUp = false; } throw error; }
    if (backedUp) await rm(backup, { recursive: true, force: true });
    return { directory, databases: validated.databases, cached: false };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

const banner = "// Generated by SteamHarness Database. Run steamharness database generate; do not edit.\n";
async function generateSchema(stage: string, schema: ValidatedSchema): Promise<void> {
  const engineDir = path.join(stage, "engines", schema.schemaHash);
  await save(stage, `schemas/${schema.schemaHash}.prisma`, schema.datamodel);
  await save(stage, `metadata/${schema.schemaHash}.json`, JSON.stringify(schema.metadata, null, 2) + "\n");
  await generateClient({ datamodel: schema.datamodel, schemaPath: schema.schema, outputDir: engineDir, runtimeBase: "@prisma/client/runtime",
    generator: schema.config.generators[0], dmmf: schema.dmmf, datasources: schema.config.datasources, binaryPaths: {}, engineVersion: engineCommit,
    clientVersion: engineVersion, activeProvider: "postgresql", target: "nodejs", moduleFormat: "esm", generatedFileExtension: "ts", importFileExtension: "js", tsNoCheckPreamble: true, compilerBuild: "fast" });
  const engineRequire = createRequire(resolveModule("steamharness/database/engine", import.meta.url));
  for (const name of ["query_compiler_fast_bg.postgresql.mjs", "query_compiler_fast_bg.postgresql.wasm-base64.mjs"]) {
    await copyFile(engineRequire.resolve(`@prisma/client/runtime/${name}`), path.join(engineDir, "internal", name));
  }
  for (const file of await listFiles(engineDir)) {
    if (!file.endsWith(".ts")) continue;
    const filename = path.join(engineDir, file);
    const content = (await readFile(filename, "utf8"))
      .replaceAll("@prisma/client/runtime/client", "steamharness/database/engine")
      .replaceAll("@prisma/client/runtime/index-browser", "steamharness/database/engine-browser")
      .replaceAll("@prisma/client/runtime/query_compiler_fast_bg.postgresql", "./query_compiler_fast_bg.postgresql");
    if (content.includes("@prisma/client/runtime/")) throw new Error("Unsupported generated runtime import. Review the pinned database engine version.");
    await writeFile(filename, content);
  }
}

async function generateDescriptor(stage: string, target: "node" | "browser", database: ValidatedDatabases["databases"][number], schema: ValidatedSchema): Promise<void> {
  const { alias, schemaHash } = database;
  const reserved = new Set(["Client", "TransactionClient", "EngineClient", "Models", "Enums", "DatabaseDescriptor", "NodeDatabaseDescriptor", "DatabaseModelDelegate", "Decimal", "DbNull", "JsonNull", "AnyNull", "database"]);
  const modelNames = schema.metadata.models.map(model => model.name).filter(name => !reserved.has(name));
  const enumNames = schema.metadata.enums.map(item => item.name).filter(name => !reserved.has(name));
  const delegates = schema.metadata.models.map(model => `  readonly ${JSON.stringify(model.delegate)}: DatabaseModelDelegate<EngineClient[${JSON.stringify(model.delegate)}]>;`).join("\n");
  const descriptorType = target === "node" ? `NodeDatabaseDescriptor<${JSON.stringify(alias)}, Client>` : `DatabaseDescriptor<${JSON.stringify(alias)}, Client, "browser">`;
  await save(stage, `${target}/${alias}.ts`, `${banner}import type { DatabaseDescriptor, NodeDatabaseDescriptor, DatabaseModelDelegate } from "steamharness/database";
import type { PrismaClient as EngineClient } from "../engines/${schemaHash}/client.js";
${modelNames.length ? `export type { ${modelNames.join(", ")} } from "../engines/${schemaHash}/browser.js";` : ""}
export type * as Models from "../engines/${schemaHash}/browser.js";
export type * from "../engines/${schemaHash}/models.js";
${enumNames.length ? `export { ${enumNames.join(", ")} } from "../engines/${schemaHash}/enums.js";` : ""}
export * as Enums from "../engines/${schemaHash}/enums.js";
export { Decimal, DbNull, JsonNull, AnyNull } from "steamharness/database";
export interface TransactionClient {
${delegates}
}
export interface Client extends TransactionClient {
  transaction<Result>(work: (transaction: TransactionClient) => Promise<Result>): Promise<Result>;
}
export const database: ${descriptorType} = Object.freeze({
  kind: "steamharness.database", version: 1, alias: ${JSON.stringify(alias)}, target: ${JSON.stringify(target)},
  provider: "postgresql", schemaHash: ${JSON.stringify(schemaHash)},
  metadata: ${JSON.stringify(schema.metadata)} as const,${target === "node" ? `\n  loadEngine: () => import("../engines/${schemaHash}/client.js"),` : ""}
});
`);
}

async function save(root: string, relative: string, content: string): Promise<void> {
  const filename = path.join(root, relative); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, content);
}
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(root, relative + "/"));
    else if (entry.isFile()) files.push(relative);
    else throw new Error("Generated database artifacts must be regular files.");
  }
  return files.sort();
}
async function assertOutputDirectories(root: string): Promise<void> {
  for (const relative of [".steamharness", ".steamharness/generated", DATABASE_GENERATED_DIRECTORY]) {
    const info = await lstat(path.join(root, relative)).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`${relative} must be a regular directory.`);
  }
}

/** Build each registered entry's local declarations before copying an aggregate package. */
export async function prepareProjectDatabaseArtifacts(projectDirectory: string): Promise<void> {
  const roots = new Set([path.resolve(projectDirectory)]);
  const declaration = await readProjectDeclarationFromDirectory(projectDirectory);
  for (const entry of declaration.entries) roots.add(path.resolve(projectDirectory, entry.root));
  for (const root of roots) {
    if (await lstat(path.join(root, DATABASE_DEFINITION_FILE)).catch(() => undefined)) await generateDatabases(root);
  }
}
