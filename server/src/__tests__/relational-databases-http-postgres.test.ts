import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import express from "express";
import pg from "pg";
import { AccountRepository } from "../account-db";
import { AuthService } from "../account-auth";
import { configureProjectAuthContext } from "../auth";
import { DatabaseRepository } from "../persistence";
import { Storage } from "../storage";
import { createApiRouter } from "../routes/api";
import { databaseNames } from "../relational-databases/cluster";
import { RelationalDatabaseRepository } from "../relational-databases/repository";
import { createDatabaseConnector, createRemoteRelationalDatabaseHost, runLocalProjectWithReport, inspectProjectScripts } from "steamharness";
import type { NodeDatabaseDescriptor } from "steamharness/database";

const databaseUrl = process.env.STEAMHARNESS_TEST_RELATIONAL_DATABASE_URL;

test("account-authenticated HTTP, CLI bindings and generated Core clients use isolated databases", { skip: !databaseUrl, timeout: 240_000 }, async t => {
  const schema = `relational_http_${randomUUID().replaceAll("-", "")}`;
  const catalog = `${schema}_r`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`create schema "${schema}"`);
  const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
  const connection = url.toString();
  const root = await mkdtemp(path.join(tmpdir(), "steamharness-database-http-"));
  const accounts = new AccountRepository(connection), db = new DatabaseRepository(connection);
  const auth = new AuthService({ databaseUrl: connection, accountDb: accounts });
  const repository = new RelationalDatabaseRepository(connection, { adminConnectionString: databaseUrl!, schema: catalog });
  const storage = new Storage({ db, relationalDatabases: repository, serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot: root });
  const server = createServer();
  let ownerId: string | undefined;
  const connectors: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    await Promise.all(connectors.map(connector => connector.close()));
    configureProjectAuthContext({}); server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    const resources = ownerId ? await repository.list(ownerId) : [];
    await storage.close(); await auth.close(); await accounts.close();
    for (const resource of resources) {
      const names = databaseNames(resource.id);
      await admin.query(`drop database if exists "${names.database}" with (force)`);
      for (const role of [names.owner, names.write, names.read]) await admin.query(`drop role if exists "${role}"`);
    }
    await admin.query(`drop schema if exists "${catalog}" cascade`);
    await admin.query(`drop schema if exists "${schema}" cascade`);
    // Storage's default runtime catalog is independent from business databases.
    await admin.query('drop schema if exists steamharness_runtime cascade');
    await admin.end(); await rm(root, { recursive: true, force: true });
  });
  await accounts.init(); await storage.init();
  const owner = await auth.signInBootstrapAdmin({ email: "owner@database.test", password: "test-only-password" });
  ownerId = owner.user.userId;
  const invitation = await auth.inviteUser({ email: "reader@database.test", redirectTo: "https://database.test" });
  const other = await auth.acceptInvitation({ token: new URL(invitation.invitationLink!).pathname.split("/").at(-1)!, password: "test-only-password" });
  const ownerToken = (await accounts.createApiKey({ userId: ownerId, name: "Database test", source: "cli" })).token;
  const otherToken = (await accounts.createApiKey({ userId: other.user.userId, name: "Database test", source: "cli" })).token;
  configureProjectAuthContext({ authService: auth, accountDb: accounts, dataDir: root });
  const app = express(); app.use("/api", createApiRouter(storage)); server.on("request", app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (endpoint: string, token?: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}/api/databases${endpoint}`, { method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, result: await response.json() as any };
  };
  assert.equal((await request("")).status, 401);
  const cli = async (...args: string[]) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--conditions=development",
      fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)), "database", ...args], {
      env: { ...process.env, STEAMHARNESS_SERVER_URL: base, STEAMHARNESS_SERVER_ADMIN_KEY: ownerToken,
        STEAMHARNESS_CLI_AUTH_DIR: path.join(root, "auth") }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("exit", code => {
      if (code !== 0) { reject(new Error(`CLI exited ${code}: ${stderr}`)); return; }
      try { resolve(args[0] === "init" ? stdout : stdout.trim() ? JSON.parse(stdout) : undefined); } catch (error) { reject(error); }
    });
  });
  const requestId = randomUUID();
  const resource = await cli("create", "CLI database", "--request-id", requestId);
  assert.equal(resource.status, "ready");
  assert.equal((await cli("create", "CLI database", "--request-id", requestId)).id, resource.id);
  assert.equal((await cli("inspect", resource.id)).id, resource.id);
  assert.equal((await cli("list")).items.length, 1);
  assert.equal((await request(`/${resource.id}`, otherToken)).status, 404);
  assert.equal((await request("", ownerToken, "POST", { name: "bad", requestId: randomUUID(), connectionString: "forbidden" })).status, 400);
  await cli("grant", resource.id, "--user", other.user.userId, "--mode", "read");
  assert.equal((await request(`/${resource.id}`, otherToken)).status, 200);
  assert.equal((await request(`/${resource.id}/retry`, otherToken, "POST", {})).status, 403);
  assert.equal((await request(`/${resource.id}/grants`, otherToken)).status, 403);
  const project = path.join(root, "project"); await mkdir(project);
  await writeFile(path.join(project, "package.json"), '{"name":"migration-http-test","type":"module"}\n');
  await mkdir(path.join(project, "node_modules"));
  await symlink(fileURLToPath(new URL("../../../harness", import.meta.url)), path.join(project, "node_modules/steamharness"), process.platform === "win32" ? "junction" : "dir");
  await cli("init", project);
  const projectId = randomUUID();
  await writeFile(path.join(project, "steamharness.json"), JSON.stringify({ id: projectId, name: "database-runtime-test", version: "0.1.0", defaultEntry: "main", entries: [
    { entryId: "main", type: "workflow", name: "Main", root: ".", entry: "index.ts", databases: [] },
    { entryId: "other", type: "workflow", name: "Other", root: ".", entry: "index.ts", databases: [] },
  ] }));
  await writeFile(path.join(project, "index.ts"), `import { main } from "./.steamharness/generated/database/node/index.js";
const flow = steamharness.defineProject({ name: "database-runtime", async run(_input, context) {
  const database = await context.databases.connect(main);
  const record = await database.user.create({ data: { name: "executor" } });
  return { errCode: 0, errMessage: "", name: record.name };
} });
export const executor = steamharness.defineExecutor({ projectType: "workflow", defaultEntrypoint: "write", entrypoints: [steamharness.defineEntrypoint({ id: "write", title: "Write", workflow: flow, createInput() { return {}; } })] });
`);
  await writeFile(path.join(project, "database/main/steamharness.schema"), `enum Status {\n ACTIVE\n DISABLED\n}\nmodel User {\n id String @id @default(uuid())\n name String @unique\n createdAt DateTime @default(now())\n count BigInt @default(0)\n balance Decimal @default(0) @db.Decimal(12,2)\n payload Bytes?\n meta Json?\n status Status @default(ACTIVE)\n posts Post[]\n}\nmodel Post {\n id Int @id @default(autoincrement())\n title String\n userId String\n user User @relation(fields: [userId], references: [id])\n @@unique([userId,title])\n}\n`);
  const draft = await cli("migrate", "dev", project, "--database", resource.id, "--name", "init", "--draft");
  assert.equal(draft.applied, false); assert.equal((await cli("migrate", "status", "--database", resource.id)).length, 0);
  const first = await cli("migrate", "deploy", project, "--database", resource.id);
  assert.equal(first.migrations.length, 1);
  assert.equal((await cli("migrate", "deploy", project, "--database", resource.id)).migrations.length, 1);
  assert.equal((await cli("migrate", "dev", project, "--database", resource.id)).unchanged, true);
  await repository.cluster.withAdminDatabase(databaseNames(resource.id).database, async client => {
    assert.equal((await client.query('SELECT count(*)::int AS count FROM "User"')).rows[0].count, 0);
  });
  assert.equal((await request(`/${resource.id}/migrations/plan`, otherToken, "POST", {
    schema: await readFile(path.join(project, "database/main/steamharness.schema"), "utf8"), migrations: [],
  })).status, 403);
  assert.equal((await request(`/${resource.id}/migrations/deploy`, ownerToken, "POST", { migrations: [], schemaHash: "bad" })).status, 400);

  const binding = await cli("bind", project, "--database", resource.id);
  assert.equal(binding.projectId, projectId); assert.equal(binding.entryId, "main"); assert.equal(binding.alias, "main");
  assert.equal((await cli("bindings", project))[0].databaseId, resource.id);
  assert.equal((await cli("bind", project, "--database", resource.id)).revision, binding.revision, "unchanged binds are idempotent");
  assert.equal(await readFile(path.join(project, "config.json"), "utf8").catch(() => null), null, "relational bindings are host-owned");
  const descriptors = await import(pathToFileURL(path.join(project, ".steamharness/generated/database/node/index.js")).href);
  interface Models { user: { create(input: any): Promise<any>; findMany(input?: any): Promise<any[]>; count(input?: any): Promise<number>; update(input: any): Promise<any>; deleteMany(input?: any): Promise<any> }; post: { count(): Promise<number> } }
  interface Client extends Models { transaction<T>(work: (tx: Models) => Promise<T>): Promise<T> }
  const descriptor = descriptors.main as NodeDatabaseDescriptor<"main", Client>;
  const host = createRemoteRelationalDatabaseHost({ serverUrl: base, token: ownerToken });
  const connector = createDatabaseConnector({ projectId, entryId: "main", host });
  const otherConnector = createDatabaseConnector({ projectId, entryId: "other", host });
  const readerConnector = createDatabaseConnector({ projectId, entryId: "main", host: createRemoteRelationalDatabaseHost({ serverUrl: base, token: otherToken }) });
  connectors.push(connector, otherConnector, readerConnector);
  const dbClient = await connector.connect(descriptor);
  assert.equal(Reflect.get(dbClient, "$queryRaw"), undefined); assert.equal(Reflect.get(dbClient, "$disconnect"), undefined);
  const row = await dbClient.user.create({ data: { name: "Alice", count: 9007199254740993n, balance: "12.34", meta: { labels: ["test"] }, payload: new Uint8Array([0, 1, 255]), posts: { create: [{ title: "First" }] } }, include: { posts: true } });
  assert.equal(row.count, 9007199254740993n); assert.equal(String(row.balance), "12.34"); assert.ok(row.createdAt instanceof Date);
  assert.deepEqual(row.meta, { labels: ["test"] }); assert.deepEqual([...row.payload], [0, 1, 255]); assert.equal(row.posts[0].title, "First");
  assert.equal((await dbClient.user.findMany({ where: { posts: { some: { title: "First" } } }, select: { name: true } }))[0].name, "Alice");
  assert.deepEqual(await Promise.all([dbClient.user.count(), dbClient.user.count(), dbClient.post.count()]), [1, 1, 1]);
  await assert.rejects(dbClient.transaction(async tx => { await tx.user.create({ data: { name: "rollback" } }); throw new Error("rollback-test"); }), /rollback-test/);
  assert.equal(await dbClient.user.count(), 1);
  await dbClient.transaction(async tx => { await tx.user.create({ data: { name: "commit" } }); await tx.user.update({ where: { name: "Alice" }, data: { status: "DISABLED" } }); });
  assert.equal(await dbClient.user.count(), 2);
  await assert.rejects(dbClient.user.create({ data: { name: "Alice" } }), { code: "DATABASE_QUERY_FAILED", queryCode: "P2002" });
  await assert.rejects(connector.connect({ ...descriptor, schemaHash: "0".repeat(64) }), { code: "DATABASE_SCHEMA_MISMATCH" });
  await assert.rejects(otherConnector.connect(descriptor), { code: "DATABASE_UNBOUND" });
  await cli("bind", project, "--database", resource.id, "--entry", "other", "--mode", "read");
  const shared = await otherConnector.connect(descriptor);
  assert.equal(await shared.user.count(), 2); await assert.rejects(shared.user.create({ data: { name: "not-allowed" } }), { code: "DATABASE_ACCESS_DENIED" });
  const scope = { projectId, entryId: "main", alias: "main" };
  const readerBinding = await request("/bindings", otherToken, "POST", { ...scope, databaseId: resource.id, schemaHash: descriptor.schemaHash });
  assert.equal(readerBinding.status, 200); assert.equal(readerBinding.result.data.mode, "read");
  assert.equal((await request("/bindings", otherToken, "POST", { ...scope, databaseId: resource.id, schemaHash: descriptor.schemaHash, mode: "write" })).status, 403);
  const reader = await readerConnector.connect(descriptor); assert.equal(await reader.user.count(), 2);
  const browserAttempt = await fetch(`${base}/api/databases/connections`, { method: "POST", headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json", Origin: "https://browser.example.test" }, body: JSON.stringify({ ...scope, schemaHash: descriptor.schemaHash }) });
  assert.equal(browserAttempt.status, 403);
  assert.deepEqual(inspectProjectScripts({ cwd: project, projectDir: project, projectName: "database-runtime-test", entryFile: path.join(project, "index.ts") }).violations, []);
  const report = await runLocalProjectWithReport({ projectDir: project, env: { STEAMHARNESS_SERVER_URL: base, STEAMHARNESS_SERVER_ADMIN_KEY: ownerToken },
    storage: { host: "local", local: { kvStoreDir: path.join(root, "runtime"), persistentValueStoreDir: path.join(root, "runtime") } } });
  assert.equal(report.status, "success", JSON.stringify(report.result)); assert.equal(await dbClient.user.count(), 3);
  const credentialCount = async () => (await admin.query(`select count(*)::int as count from "${catalog}".credentials`)).rows[0].count;
  assert.equal(await credentialCount(), 3, "the executor releases its credential at run completion");

  const second = await cli("create", "Independent database");
  const secondProject = path.join(root, "second"); await mkdir(secondProject);
  await writeFile(path.join(secondProject, "package.json"), '{"name":"second-database","type":"module"}\n');
  await mkdir(path.join(secondProject, "node_modules"));
  await symlink(fileURLToPath(new URL("../../../harness", import.meta.url)), path.join(secondProject, "node_modules/steamharness"), process.platform === "win32" ? "junction" : "dir");
  await cli("init", secondProject);
  await writeFile(path.join(secondProject, "database/main/steamharness.schema"), 'model User {\n id Int @id @default(autoincrement())\n event String\n}\n');
  const secondId = randomUUID();
  await writeFile(path.join(secondProject, "steamharness.json"), JSON.stringify({ id: secondId, name: "second-database", version: "0.1.0", defaultEntry: "main", entries: [{ entryId: "main", name: "Main", type: "workflow", root: ".", entry: "index.ts", databases: [] }] }));
  await writeFile(path.join(secondProject, "index.ts"), "export {};\n");
  await cli("migrate", "dev", secondProject, "--database", second.id, "--name", "init");
  await cli("bind", secondProject, "--database", second.id);
  const secondDescriptor = (await import(pathToFileURL(path.join(secondProject, ".steamharness/generated/database/node/index.js")).href)).main as NodeDatabaseDescriptor<"main", Client>;
  const secondConnector = createDatabaseConnector({ projectId: secondId, entryId: "main", host }); connectors.push(secondConnector);
  const secondClient = await secondConnector.connect(secondDescriptor);
  const secondRow = await secondClient.user.create({ data: { event: "independent" } }); assert.equal(typeof secondRow.id, "number");
  assert.equal(await secondClient.user.count(), 1); assert.equal(await dbClient.user.count(), 3);
  await cli("unbind", project);
  await assert.rejects(dbClient.user.create({ data: { name: "stale" } }), { code: "DATABASE_BINDING_CHANGED" });
  await assert.rejects(connector.connect(descriptor), { code: "DATABASE_UNBOUND" });
  await cli("bind", project, "--database", resource.id);
  await assert.rejects(dbClient.user.findMany(), { code: "DATABASE_BINDING_CHANGED" });
  const fresh = await connector.connect(descriptor); assert.equal(await fresh.user.count(), 3);
  const third = await cli("create", "Replacement with the same schema");
  await cli("migrate", "deploy", project, "--database", third.id);
  await cli("bind", project, "--database", third.id);
  await assert.rejects(fresh.user.create({ data: { name: "stale-replacement" } }), { code: "DATABASE_BINDING_CHANGED" });
  const replacement = await connector.connect(descriptor); assert.equal(await replacement.user.count(), 0);
  await replacement.user.create({ data: { name: "replacement" } }); assert.equal(await shared.user.count(), 3);
  await cli("grant", resource.id, "--user", other.user.userId, "--mode", "write");
  await assert.rejects(reader.user.findMany(), { code: "DATABASE_BINDING_CHANGED" });
  assert.equal((await request("/bindings", otherToken, "POST", { ...scope, databaseId: resource.id, schemaHash: descriptor.schemaHash, mode: "write" })).status, 200);
  const writer = await readerConnector.connect(descriptor);
  await assert.rejects(writer.transaction(async tx => {
    await tx.user.create({ data: { name: "must-rollback-on-revoke" } });
    await cli("revoke", resource.id, "--user", other.user.userId);
  }), { code: "DATABASE_BINDING_CHANGED" });
  assert.equal(await shared.user.count(), 3, "revoking an active transaction rolls back its writes");
  await assert.rejects(reader.user.findMany(), { code: "DATABASE_BINDING_CHANGED" });
  assert.equal((await request(`/${resource.id}`, otherToken)).status, 404);
  assert.equal(JSON.stringify((await request(`/${resource.id}`, ownerToken)).result).includes("postgresql://"), false);
  await Promise.all([connector.close(), otherConnector.close(), readerConnector.close(), secondConnector.close()]);
  assert.equal(await credentialCount(), 0, "all client pools and server credentials are released");
});
