import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const databaseUrl = process.env.STEAMHARNESS_TEST_RELATIONAL_DATABASE_URL;

test("account-authenticated HTTP and the real CLI provision, share and migrate a database", { skip: !databaseUrl, timeout: 180_000 }, async t => {
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
  t.after(async () => {
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
  await cli("revoke", resource.id, "--user", other.user.userId);
  assert.equal((await request(`/${resource.id}`, otherToken)).status, 404);
  assert.equal(JSON.stringify((await request(`/${resource.id}`, ownerToken)).result).includes("postgresql://"), false);
});
