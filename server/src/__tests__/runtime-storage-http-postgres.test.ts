import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { createDefaultProjectInfo } from "@steamharness/project-info";
import { ServerAgentStorage, RuntimeStorageError, type AgentStorageContext } from "steamharness/runtime-storage";
import { AccountRepository } from "../account-db";
import { AuthService } from "../account-auth";
import { configureProjectAuthContext } from "../auth";
import { DatabaseRepository } from "../persistence";
import { Storage } from "../storage";
import { RuntimeStorageRepository } from "../runtime-storage/repository";
import { createApiRouter } from "../routes/api";

const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL;
const context: AgentStorageContext = { abortSignal: undefined, value: () => undefined, toString: () => "runtime-test" };

async function fixture(t: TestContext) {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `runtime_http_${randomUUID().replaceAll("-", "")}`;
  const runtimeSchema = `${schema}_r`;
  await admin.query(`create schema ${schema}`);
  const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
  const connection = url.toString();
  const root = await mkdtemp(path.join(tmpdir(), "steamharness-runtime-http-"));
  const accounts = new AccountRepository(connection), db = new DatabaseRepository(connection);
  const auth = new AuthService({ databaseUrl: connection, accountDb: accounts });
  const storage = new Storage({ db, serverRoot: process.cwd(), repoRoot: process.cwd(), dataRoot: root,
    runtimeStorage: new RuntimeStorageRepository(connection, { schema: runtimeSchema }) });
  const server = createServer();
  t.after(async () => {
    configureProjectAuthContext({}); server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await storage.close(); await auth.close(); await accounts.close();
    await admin.query(`drop schema if exists ${runtimeSchema} cascade`); await admin.query(`drop schema ${schema} cascade`);
    await admin.end(); await rm(root, { recursive: true, force: true });
  });
  await accounts.init(); await storage.init();
  const bootstrap = await auth.signInBootstrapAdmin({ email: "owner@runtime.test", password: "test-only-password" });
  const invitation = await auth.inviteUser({ email: "other@runtime.test", redirectTo: "https://runtime.test" });
  const other = await auth.acceptInvitation({ token: new URL(invitation.invitationLink!).pathname.split("/").at(-1)!, password: "test-only-password" });
  const ownerToken = (await accounts.createApiKey({ userId: bootstrap.user.userId, name: "Runtime test", source: "cli" })).token;
  const otherToken = (await accounts.createApiKey({ userId: other.user.userId, name: "Runtime test", source: "cli" })).token;
  configureProjectAuthContext({ authService: auth, accountDb: accounts, dataDir: root });
  const app = express(); app.use("/api", createApiRouter(storage)); server.on("request", app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (endpoint: string, token?: string, body?: unknown) => fetch(`${base}/api/runtime-storage${endpoint}`, {
    method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { storage, accounts, db, admin, schema, runtimeSchema, base, ownerToken, otherToken, request,
    ownerId: bootstrap.user.userId, otherId: other.user.userId };
}

test("runtime HTTP isolates private histories, validates project membership and allows unpublished workspaces", { skip: !databaseUrl, timeout: 30_000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/workspaces", undefined, {})).status, 401);
  const input = { kind: "assistant" as const, projectId: randomUUID(), entryId: "main", localKey: "folder-a" };
  const a = await ServerAgentStorage.open({ serverUrl: f.base, token: f.ownerToken, workspace: input, sessionKey: "same-thread" });
  const other = await ServerAgentStorage.open({ serverUrl: f.base, token: f.otherToken, workspace: input, sessionKey: "same-thread" });
  try {
    assert.notEqual(a.workspace.id, other.workspace.id);
    assert.equal((await f.request(`/workspaces/${a.workspace.id}`, f.otherToken)).status, 404);
    assert.equal((await f.request(`/workspaces/${other.workspace.id}`, f.ownerToken)).status, 404, "system administrators do not inherit another account's private history");
    await assert.rejects(ServerAgentStorage.open({ serverUrl: f.base, token: f.ownerToken, workspace: { id: a.workspace.id }, sessionKey: "same-thread" }),
      error => error instanceof RuntimeStorageError && error.code === "RUNTIME_STORAGE_OWNER_CONFLICT");
    assert.equal(await a.mintId(), 2); assert.equal(await other.mintId(), 2);
    for (const operation of [{ kind: "sql", sql: "select 1" }, { kind: "mintId", requestId: "not-a-uuid" }, { kind: "commit", requestId: randomUUID(), writes: [{ type: "eval", value: "process.exit()" }] }]) {
      const response = await f.request(`/sessions/${a.lease.sessionId}/operations`, f.ownerToken, { ownerToken: "a".repeat(43), fence: a.lease.fence, operation });
      assert.equal(response.status, 400);
    }
    const projectId = randomUUID();
    const entries = [{ entryId: "main", name: "Main", type: "workflow" as const, root: ".", entry: "index.ts", databases: [] }];
    await f.storage.createProject({ projectId, projectName: "Runtime project", entries, defaultEntry: "main", projectInfo: createDefaultProjectInfo(), ownerUserId: f.ownerId });
    assert.equal((await f.request("/workspaces", f.otherToken, { kind: "project", projectId, entryId: "main" })).status, 403);
    assert.equal((await f.request("/workspaces", f.ownerToken, { kind: "project", projectId, entryId: "missing" })).status, 404);
    const registered = await f.request("/workspaces", f.ownerToken, { kind: "project", projectId, entryId: "main" });
    assert.equal(registered.status, 200);
    // Claiming the same project UUID as a local project only creates this
    // account's private development identity, never access to registered data.
    const local = await f.request("/workspaces", f.otherToken, { kind: "local", projectId, entryId: "main", localKey: "own-folder" });
    assert.equal(local.status, 200);
    assert.notEqual((await local.json()).data.id, (await registered.json()).data.id);
    await f.storage.accessRepository.setMember("project", projectId, f.otherId, "guest", { userId: f.ownerId, isSystemAdmin: true });
    const member = await ServerAgentStorage.open({ serverUrl: f.base, token: f.otherToken,
      workspace: { kind: "project", projectId, entryId: "main" }, sessionKey: "registered-history" });
    assert.equal(await member.mintId(), 2);
    await f.storage.accessRepository.setMember("project", projectId, f.otherId, undefined, { userId: f.ownerId, isSystemAdmin: true });
    await assert.rejects(member.mintId(), error => error instanceof RuntimeStorageError && error.code === "RUNTIME_STORAGE_ACCESS_DENIED");
    assert.equal((await f.request(`/workspaces/${member.workspace.id}`, f.otherToken)).status, 403);
    // Revoked access cannot release a project lease either; the client stops
    // its heartbeat and the Server's expiry remains the cleanup backstop.
    await assert.rejects(member.close(), error => error instanceof RuntimeStorageError && error.code === "RUNTIME_STORAGE_ACCESS_DENIED");
  } finally { await a.close(); await other.close(); }
});

test("PostgreSQL HTTP retries a committed write after response loss and restores the same session", { skip: !databaseUrl, timeout: 30_000 }, async t => {
  const f = await fixture(t);
  let dropped = false;
  const customFetch: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!dropped && JSON.parse(String(init?.body ?? "{}")).operation?.kind === "commit" && response.ok) {
      dropped = true; await response.body?.cancel(); throw new TypeError("Response lost after SQL commit");
    }
    return response;
  };
  const options = { serverUrl: f.base, token: f.ownerToken, workspace: { kind: "local" as const, projectId: randomUUID(), entryId: "main", localKey: randomUUID() }, sessionKey: "reopen", fetch: customFetch, retryDelayMs: 0 };
  const first = await ServerAgentStorage.open(options);
  const id = await first.mintId();
  await first.commit([{ type: "conversation", value: { id: 1 as never } }, { type: "entry", value: { id: id as never, conversationId: 1 as never, kind: "message", data: { text: "one copy" } } }], context);
  await first.close();
  const second = await ServerAgentStorage.open(options);
  try {
    assert.equal(second.lease.sessionId, first.lease.sessionId);
    assert.equal((await second.scanEntries({ conversationId: 1 as never }, 10, undefined, context)).items.length, 1);
    assert.equal(await second.mintId(), Number(id) + 1);
    assert.equal((await f.admin.query(`select count(*) from ${f.runtimeSchema}.agent_entries`)).rows[0].count, "1");
  } finally { await second.close(); }
});

test("complete bundled Agent storage conformance passes through account authentication, HTTP and PostgreSQL", { skip: !databaseUrl, timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const harness = fileURLToPath(new URL("../../", import.meta.resolve("steamharness/agent")));
  await new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, STEAMHARNESS_TEST_RUNTIME_SERVER_URL: f.base, STEAMHARNESS_TEST_RUNTIME_TOKEN: f.ownerToken };
    // A nested Node test runner must not inherit the parent's worker protocol.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--import", "tsx", "--conditions=development", "--test", "--test-reporter=spec", "src/__tests__/runtime-storage.test.ts"], {
      cwd: harness, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
    child.once("error", reject);
    child.once("exit", code => {
      if (code !== 0 || !output.includes("PostgreSQL HTTP conformance:") || !/skipped 0/.test(output)) reject(new Error(`Agent storage conformance did not complete:\n${output}`));
      else resolve();
    });
    t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  });
});
