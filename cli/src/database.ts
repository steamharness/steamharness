import path from "node:path";
import { lstat, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { i18n } from "@steamharness/i18n";
import { selectProjectEntry } from "@steamharness/project-manifest";
import { readProjectDeclarationFromDirectory } from "@steamharness/project-manifest/node";
import { assertRegularPath } from "@steamharness/project-upload/database-artifacts";
import { generateDatabases, validateDatabases, projectDatabaseSourceRoots } from "./database-generation";
import { manageDatabases } from "./database-management";

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(`${help()}\n`); return 0;
  }
  if (["create", "list", "inspect", "retry", "grant", "revoke", "migrate", "bind", "unbind", "bindings"].includes(command)) { await manageDatabases(argv); return 0; }
  if (!["init", "validate", "generate"].includes(command)) throw new Error(help());
  const positional: string[] = []; let entryId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--entry") { entryId = args[++index]; if (!entryId || entryId.startsWith("-")) throw new Error("--entry requires an entry ID."); }
    else if (args[index].startsWith("-")) throw new Error(help()); else positional.push(args[index]);
  }
  if (positional.length > 1) throw new Error(help());
  const directory = path.resolve(positional[0] ?? ".");
  if (command === "init") {
    const sourceRoot = entryId === undefined ? "." : selectProjectEntry(await readProjectDeclarationFromDirectory(directory), entryId).root;
    await initializeDatabase(path.resolve(directory, sourceRoot), directory, entryId);
    process.stdout.write(i18n.language.startsWith("zh") ? "已创建数据库定义与模型模板。运行 steamharness database generate 生成类型。\n" : "Created database definitions and model template. Run steamharness database generate to generate types.\n");
  } else {
    const outputs = [];
    for (const sourceRoot of await projectDatabaseSourceRoots(directory, entryId)) {
      const result = command === "validate" ? await validateDatabases(directory, sourceRoot) : await generateDatabases(directory, sourceRoot);
      outputs.push({ sourceRoot, databases: result.databases, ...("cached" in result ? { directory: result.directory, cached: result.cached } : {}) });
    }
    process.stdout.write(JSON.stringify({ command, outputs }, null, 2) + "\n");
  }
  return 0;
}

function help(): string {
  return `SteamHarness Database\n\n  steamharness database init [project-directory] [--entry <id>]\n  steamharness database validate [project-directory] [--entry <id>]\n  steamharness database generate [project-directory] [--entry <id>]\n  steamharness database create <name> [--request-id <uuid>]\n  steamharness database list\n  steamharness database inspect <database-id>\n  steamharness database retry <database-id>\n  steamharness database grant <database-id> --user <account-id> --mode <read|write>\n  steamharness database revoke <database-id> --user <account-id>\n  steamharness database bind [directory] --database <id> [--entry <id>] [--alias main] [--mode read|write]\n  steamharness database bindings [directory] [--entry <id>]\n  steamharness database unbind [directory] [--entry <id>] [--alias main]\n  steamharness database migrate dev [directory] --database <id> [--alias main] [--name init] [--draft]\n  steamharness database migrate deploy [directory] --database <id> [--alias main] [--accept-data-loss]\n  steamharness database migrate status --database <id>\n\n${i18n.language.startsWith("zh") ? "简写：steamharness db。资源与迁移命令使用 workspace login 的账号；可用 --server、--token 指定目标。定义文件：steamharness.database.ts；模型文件：steamharness.schema。" : "Alias: steamharness db. Management and migration commands use the workspace login; --server and --token override the target. Definitions: steamharness.database.ts; models: steamharness.schema."}`;
}

export async function initializeDatabase(directory: string, projectDirectory = directory, entryId?: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) throw new Error("Choose an existing project directory.");
  const aggregateRelative = path.relative(directory, projectDirectory).split(path.sep).join("/") || ".";
  if (!/^(?:\.|\.\.(?:\/\.\.)*)$/.test(aggregateRelative)) throw new Error("The database source root must be inside its aggregate project.");
  await assertRegularPath(projectDirectory, path.posix.join(path.relative(projectDirectory, directory).split(path.sep).join("/"), "package.json"));
  const ignoreInfo = await lstat(path.join(projectDirectory, ".gitignore")).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (ignoreInfo && !ignoreInfo.isFile()) throw new Error(".gitignore must be a regular file.");
  const pkgPath = path.join(directory, "package.json");
  const pkgSource = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(pkgSource);
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || pkg.scripts !== undefined && (!pkg.scripts || typeof pkg.scripts !== "object" || Array.isArray(pkg.scripts))) throw new Error("Invalid project package.json scripts.");
  for (const relative of ["database", "database/main", ".gitignore"]) {
    const info = await lstat(path.join(directory, relative)).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info && (info.isSymbolicLink() || (relative === ".gitignore" ? !info.isFile() : !info.isDirectory()))) throw new Error(`${relative} must use regular files and directories.`);
  }
  const files = {
    "steamharness.database.ts": 'import { defineDatabase } from "steamharness/database";\n\nexport default defineDatabase({ schema: "./database/main/steamharness.schema" });\n',
    "database/main/steamharness.schema": 'model User {\n  id        String   @id @default(uuid())\n  name      String\n  createdAt DateTime @default(now())\n}\n',
  };
  for (const filename of Object.keys(files)) if (await lstat(path.join(directory, filename)).catch(() => undefined)) throw new Error(`${filename} already exists. Database init does not overwrite source files.`);
  const created: string[] = [];
  try {
    for (const [filename, content] of Object.entries(files)) {
      const destination = path.join(directory, filename);
      await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, content, { flag: "wx" }); created.push(destination);
    }
    const ignore = path.join(projectDirectory, ".gitignore");
    const source = await readFile(ignore, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    if (!source.split(/\r?\n/).includes("/dist/")) await writeFile(ignore, source + (source && !source.endsWith("\n") ? "\n" : "") + "/dist/\n");
    const generate = `steamharness database generate ${aggregateRelative}${entryId ? " --entry " + entryId : ""}`;
    const hooks = Object.fromEntries(["dev", "build"].filter(name => pkg.scripts?.[name]).map(name => ["pre" + name, generate + (pkg.scripts?.["pre" + name] ? " && " + pkg.scripts["pre" + name] : "")]));
    pkg.scripts = { "database:generate": generate, ...pkg.scripts, ...hooks };
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  } catch (error) { for (const filename of created) await rm(filename, { force: true }); throw error; }
}
