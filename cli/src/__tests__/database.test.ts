import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import ts from "typescript";
import { initializeDatabase } from "../database";
import { generateDatabases, validateDatabases } from "../database-generation";
import { materializeAggregateDownload, stageProjectSource } from "../workspace";
import { readDatabaseArtifactFiles } from "@steamharness/project-upload/database-artifacts";
import { resolveHarnessRoot } from "./harness-source";
import { writeProjectFixture } from "../../scripts/test-project-fixture.mjs";

const mainSchema = `enum Status {\n  ACTIVE\n  DISABLED\n}\nmodel User {\n  id String @id @default(uuid())\n  email String @unique\n  status Status @default(ACTIVE)\n  posts Post[]\n}\nmodel Post {\n  id Int @id @default(autoincrement())\n  title String\n  authorId String\n  author User @relation(fields: [authorId], references: [id])\n  @@unique([authorId, title])\n}\nmodel Client {\n  id String @id\n}\n`;
const auditSchema = `model User {\n  id Int @id @default(autoincrement())\n  actor String\n  event String\n  detail Json?\n}\n`;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "steamharness-database-"));
  await writeProjectFixture(path.join(root, "package.json"), JSON.stringify({ name: "database-example", type: "module", id: "75e1a2fc-a2af-47f2-9acf-0889317b2a05", version: "0.1.0", defaultEntry: "main",
    entries: [{ entryId: "main", type: "workflow", name: "Main", root: ".", entry: "index.ts", databases: [] }],
    projectInfo: { localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" } }, dependencies: { steamharness: "0.1.2-dev.20261031002" } }));
  await writeFile(path.join(root, "index.ts"), "export {};\n");
  await mkdir(path.join(root, "node_modules"));
  await symlink(await resolveHarnessRoot(), path.join(root, "node_modules/steamharness"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(path.join(root, "database/main"), { recursive: true });
  await mkdir(path.join(root, "database/audit"), { recursive: true });
  await writeFile(path.join(root, "database/main/steamharness.schema"), mainSchema);
  await writeFile(path.join(root, "database/audit/steamharness.schema"), auditSchema);
  await writeFile(path.join(root, "steamharness.database.ts"), `import { defineDatabases } from "steamharness/database";\nexport default defineDatabases({ main: {schema:"./database/main/steamharness.schema"}, audit: {schema:"./database/audit/steamharness.schema"}, archive: {schema:"./database/main/steamharness.schema"} });\n`);
  return root;
}
function typecheck(root: string, filename: string, browser = false): string[] {
  const program = ts.createProgram([path.join(root, filename)], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
    strict: true, skipLibCheck: true, noEmit: true, types: [], lib: browser ? ["lib.es2022.d.ts", "lib.dom.d.ts"] : ["lib.es2022.d.ts"] });
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("SteamHarness Database authoring", () => {
  it("generates independent typed clients, relations and enums for both targets without opening a database", async () => {
    const root = await fixture();
    try {
      const generated = await generateDatabases(root);
      expect(generated.cached).toBe(false);
      expect((await generateDatabases(root)).cached).toBe(true);
      const schemas = await readdir(path.join(generated.directory, "engines"));
      expect(schemas).toHaveLength(2);
      const descriptors = await import(pathToFileURL(path.join(generated.directory, "node/index.js")).href);
      expect(descriptors.main.alias).toBe("main"); expect(descriptors.archive.alias).toBe("archive");
      expect(descriptors.main.schemaHash).toBe(descriptors.archive.schemaHash);
      expect(descriptors.main.schemaHash).not.toBe(descriptors.audit.schemaHash);
      expect(descriptors.main.metadata.models.find((model: { name: string }) => model.name === "Post").uniqueKeys).toEqual([["authorId", "title"]]);
      const engine = await descriptors.main.loadEngine();
      expect(typeof engine.PrismaClient).toBe("function");
      const client = new engine.PrismaClient({ adapter: { provider: "postgres", adapterName: "phase-two-test", connect() { throw new Error("No database connection is expected during generation."); } } });
      expect(typeof client.user.findMany).toBe("function");
      await client.$disconnect();
      for (const target of ["node", "browser"]) {
        await writeFile(path.join(root, `${target}.ts`), `import type { DatabaseClient } from "steamharness/database";
import { main, audit, archive } from "./.steamharness/generated/database/${target}/index.js";
import { Status } from "./.steamharness/generated/database/${target}/main.js";
import type { Models, ClientModel } from "./.steamharness/generated/database/${target}/main.js";
declare const customer: Models.Client;
const customerRecord: ClientModel = customer;
declare const db: DatabaseClient<typeof main>;
declare const log: DatabaseClient<typeof audit>;
declare const old: DatabaseClient<typeof archive>;
const rows = await db.user.findMany({ where: { status: Status.ACTIVE }, select: { email: true, posts: { select: { title: true } } } });
const title: string = rows[0].posts[0].title;
const email: string = rows[0].email;
await log.user.create({data:{actor:"a",event:"test"}});
await old.post.findUnique({where:{authorId_title:{authorId:"a",title:"test"}}});
await db.transaction(async tx => { return tx.user.findUnique({where:{email:"a"},select:{email:true}}); });
// @ts-expect-error Selected results must not expose omitted fields.
rows[0].id;
// @ts-expect-error Main and audit define different User models.
await log.user.create({data:{email:"a"}});
// @ts-expect-error Main does not contain Audit's fields.
await db.user.findMany({where:{event:"a"}});
// @ts-expect-error Raw SQL is not part of the project client.
db.$queryRaw;
// @ts-expect-error The runtime owns connection lifecycle.
db.$disconnect;
`);
        expect(typecheck(root, `${target}.ts`, target === "browser")).toEqual([]);
      }
      const bundle = await build({ entryPoints: [path.join(generated.directory, "browser/index.js")], bundle: true, platform: "browser", format: "iife", globalName: "GeneratedDatabases", write: false, metafile: true });
      expect(bundle.outputFiles[0].text).not.toMatch(/["']node:|class PrismaClient\b|loadEngine|connectionString|postgres:\/\//);
      const browserGlobal: Record<string, any> = {};
      vm.runInNewContext(bundle.outputFiles[0].text, browserGlobal);
      expect(browserGlobal.GeneratedDatabases.main.target).toBe("browser");
      expect(Object.keys(bundle.metafile!.inputs).some(filename => /internal\/class|runtime\/client/.test(filename))).toBe(false);
      expect((await readDatabaseArtifactFiles(root))?.manifest.databases).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it("maps schema errors to the authored file and keeps the previous generation after failure", async () => {
    const root = await fixture();
    try {
      const output = (await generateDatabases(root)).directory;
      const before = await readFile(path.join(output, "manifest.json"), "utf8");
      await writeFile(path.join(root, "database/main/steamharness.schema"), "model User {\n  id MissingType @id\n}\n");
      await expect(generateDatabases(root)).rejects.toThrow(/database\/main\/steamharness\.schema/);
      await expect(validateDatabases(root)).rejects.toThrow(/steamharness\.schema:2/);
      expect(await readFile(path.join(output, "manifest.json"), "utf8")).toBe(before);
      await expect(readDatabaseArtifactFiles(root)).rejects.toThrow(/changed/);
      await writeFile(path.join(root, "database/main/steamharness.schema"), mainSchema + '\ndatasource external {\n provider = "mysql"\n}\n');
      await expect(generateDatabases(root)).rejects.toThrow(/managed by SteamHarness/);
      await writeFile(path.join(root, "database/main/steamharness.schema"), mainSchema);
      await writeFile(path.join(root, "steamharness.database.ts"), 'import {defineDatabase} from "steamharness/database"; export default defineDatabase({schema:"./database/main/steamharness.schema"});\n');
      await generateDatabases(root);
      expect(await readdir(path.join(output, "node"))).toEqual(["index.js", "index.ts", "main.js", "main.ts"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("automatically generates packaged artifacts, restores them on download, and excludes runtime files", async () => {
    const root = await fixture(), stageRoot = await mkdtemp(path.join(os.tmpdir(), "steamharness-database-pack-"));
    try {
      await mkdir(path.join(root, ".steamharness"), { recursive: true });
      await writeFile(path.join(root, ".steamharness/runtime-token.json"), '{"token":"must-stay-local"}');
      await writeFile(path.join(root, ".steamharnessignore"), ".env\nnode_modules/\n");
      await stageProjectSource({ projectDir: root, projectName: "project", stagingRoot: stageRoot });
      const packaged = path.join(stageRoot, "project");
      expect((await readDatabaseArtifactFiles(packaged))?.manifest.databases).toHaveLength(3);
      expect(await readdir(path.join(packaged, ".steamharness"))).toEqual(["generated"]);
      // The Server/static copy must never execute this authored file.
      const files: Array<{ path: string; content: string }> = [];
      async function walk(dir: string, prefix = ""): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), prefix + entry.name + "/");
          else files.push({ path: prefix + entry.name, content: await readFile(path.join(dir, entry.name), "utf8") });
        }
      }
      await walk(packaged);
      const download = path.join(stageRoot, "downloaded");
      await materializeAggregateDownload({ projectId: "75e1a2fc-a2af-47f2-9acf-0889317b2a05", files }, download);
      await mkdir(path.join(download, "node_modules"));
      await symlink(await resolveHarnessRoot(), path.join(download, "node_modules/steamharness"), process.platform === "win32" ? "junction" : "dir");
      const result = execFileSync(process.execPath, ["--input-type=module", "-e", 'const {main,audit}=await import("./.steamharness/generated/database/node/index.js"); const engine=await main.loadEngine(); console.log(main.alias,audit.alias,typeof engine.PrismaClient)'], { cwd: download, encoding: "utf8" });
      expect(result.trim()).toBe("main audit function");
      const tampered = files.map(file => file.path.endsWith("browser/main.js") ? { ...file, content: file.content + "// modified\n" } : file);
      await expect(materializeAggregateDownload({ projectId: "75e1a2fc-a2af-47f2-9acf-0889317b2a05", files: tampered }, path.join(stageRoot, "invalid"))).rejects.toThrow(/changed/);
      await writeFile(path.join(root, ".steamharnessignore"), "database/\n");
      await expect(stageProjectSource({ projectDir: root, projectName: "ignored", stagingRoot: stageRoot })).rejects.toThrow(/Required upload path/);
    } finally { await rm(root, { recursive: true, force: true }); await rm(stageRoot, { recursive: true, force: true }); }
  }, 30_000);

  it("initializes a portable template, hooks generation into builds, and refuses overwrites", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "steamharness-database-init-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { dev: "steamharness web .", build: "tsc", prebuild: "echo before" } }));
      await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
      await initializeDatabase(root);
      expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts.prebuild).toBe("steamharness database generate . && echo before");
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toContain(".steamharness/generated/");
      await expect(initializeDatabase(root)).rejects.toThrow(/already exists/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("generates each registered entry's main alias independently", async () => {
    const root = await fixture(), stageRoot = await mkdtemp(path.join(os.tmpdir(), "database-entry-pack-"));
    try {
      const child = path.join(root, "billing"); await mkdir(child);
      await writeFile(path.join(child, "steamharness.json"), JSON.stringify({ type: "workflow", name: "Billing", entry: "index.ts", databases: [] }));
      await writeFile(path.join(child, "index.ts"), "export {};\n");
      await writeFile(path.join(child, "steamharness.schema"), auditSchema);
      await writeFile(path.join(child, "steamharness.database.ts"), 'import {defineDatabase} from "steamharness/database"; export default defineDatabase({schema:"steamharness.schema"});\n');
      const manifest = JSON.parse(await readFile(path.join(root, "steamharness.json"), "utf8"));
      manifest.entries.push({ entryId: "billing", root: "billing" });
      await writeFile(path.join(root, "steamharness.json"), JSON.stringify(manifest));
      await stageProjectSource({ projectDir: root, projectName: "aggregate", stagingRoot: stageRoot });
      const project = path.join(stageRoot, "aggregate");
      const parentArtifacts = await readDatabaseArtifactFiles(project), childArtifacts = await readDatabaseArtifactFiles(path.join(project, "billing"));
      expect(parentArtifacts?.manifest.databases.find(item => item.alias === "main")?.schemaHash).not.toBe(childArtifacts?.manifest.databases[0].schemaHash);
      expect(childArtifacts?.manifest.databases[0].alias).toBe("main");
    } finally { await rm(root, { recursive: true, force: true }); await rm(stageRoot, { recursive: true, force: true }); }
  }, 30_000);

  it("supports the published CLI command and its short alias offline", async () => {
    const entry = path.resolve("dist/index.js");
    for (const command of ["database", "db"]) expect(execFileSync(process.execPath, [entry, command, "--help"], { encoding: "utf8" })).toContain("steamharness database generate");
    const root = await fixture();
    try {
      expect(JSON.parse(execFileSync(process.execPath, [entry, "database", "generate", root], { encoding: "utf8" })).databases).toHaveLength(3);
      expect(JSON.parse(execFileSync(process.execPath, [entry, "db", "validate", root], { encoding: "utf8" })).command).toBe("validate");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
