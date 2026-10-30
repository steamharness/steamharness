import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";
import pg from "pg";
import { AccountRepository } from "../account-db";
import { AuthService } from "../account-auth";
import { configureProjectAuthContext, getProjectAuthContext } from "../auth";
import { DatabaseRepository } from "../persistence";
import { AccountMemory } from "../memory";
import { createMemoryRouter } from "../routes/memory";
import { HttpError } from "../protocol";
import { createServerAgentMemoryProvider } from "steamharness";
import { createAgentRuntime } from "steamharness/agent";
const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL;
const listen = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as any).port}`),
    ),
  );
const close = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
test(
  "account memory HTTP grants isolate accounts, projects and directories, revalidate access and retain durable jobs with one DB connection",
  { skip: !databaseUrl, timeout: 60000 },
  async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl }),
      schema = "memory_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(databaseUrl!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const url = connection.toString();
    const pool = new pg.Pool({ connectionString: url });
    const accounts = new AccountRepository(url),
      database = new DatabaseRepository(url);
    const dir = await mkdtemp(path.join(tmpdir(), "memory-http-"));
    const serviceModule = new URL(
      "../../../memory-service/src/server.ts",
      import.meta.url,
    ).href;
    let extraction: ((turn: any) => Promise<any>) | undefined;
    const { createMemoryHttpServer } = await import(serviceModule);
    const service = createMemoryHttpServer({
      root: dir,
      token: "test-service-token-32-characters-long",
      automatic: true,
      extractTurn: async (_store: any, turn: any) =>
        extraction
          ? extraction(turn)
          : [
              {
                scope: turn.scope,
                content: "自动保存中文约定",
                sources: [turn.messages[0]],
              },
            ],
    });
    const serviceUrl = await listen(service);
    const memory = (() => {
      const previousMax = process.env.STEAMHARNESS_SERVER_DATABASE_POOL_MAX;
      try {
        process.env.STEAMHARNESS_SERVER_DATABASE_POOL_MAX = "1";
        return new AccountMemory(url, serviceUrl, "test-service-token-32-characters-long");
      } finally {
        if (previousMax === undefined) delete process.env.STEAMHARNESS_SERVER_DATABASE_POOL_MAX;
        else process.env.STEAMHARNESS_SERVER_DATABASE_POOL_MAX = previousMax;
      }
    })();
    let web: Server | undefined;
    let auth: AuthService | undefined;
    const previousAuth = getProjectAuthContext();
    try {
      await accounts.init();
      await database.init();
      await memory.init();
      auth = new AuthService({ databaseUrl: url, accountDb: accounts });
      configureProjectAuthContext({ authService: auth, accountDb: accounts });
      for (const userId of ["a", "b"]) {
        await accounts.upsertUserProfile({
          userId,
          email: `${userId}@memory.test`,
        });
        await pool.query(
          "UPDATE user_profiles SET status='active' WHERE user_id=$1",
          [userId],
        );
      }
      const keyA = await accounts.createApiKey({
          userId: "a",
          name: "host",
          source: "cli",
          scopes: [],
        }),
        keyB = await accounts.createApiKey({
          userId: "b",
          name: "host",
          source: "cli",
          scopes: [],
        });
      const a = await memory.issue("a", keyA.record.id),
        b = await memory.issue("b", keyB.record.id);
      for (const id of ["p", "q"]) {
        await pool.query(
          "INSERT INTO projects(id,name,owner_user_id,entries,default_entry) VALUES($1,$1,'a',$2::jsonb,'main')",
          [
            id,
            JSON.stringify([
              {
                entryId: "main",
                name: "Main",
                type: "conversation",
                root: ".",
                entry: "index.ts",
                databases: [],
              },
            ]),
          ],
        );
        await pool.query(
          "INSERT INTO project_members(project_id,user_id,role) VALUES($1,'a','owner'),($1,'b','guest')",
          [id],
        );
      }
      const app = express();
      app.use("/api/me", createMemoryRouter(memory));
      app.use((e: any, _req: any, res: any, _next: any) =>
        res
          .status(e instanceof HttpError ? e.statusCode : 500)
          .json({ errCode: e.errCode ?? 500, errMessage: e.message }),
      );
      web = createServer(app);
      const origin = await listen(web);
      const invitation = await auth.inviteUser({ email: "session@memory.test", displayName: "Session account", redirectTo: origin });
      const session = await auth.acceptInvitation({ token: new URL(invitation.invitationLink!).pathname.split("/").at(-1)!, password: "test-password" });
      let sessionCookie = "";
      auth.setAuthCookie({ append(_name, value) { sessionCookie = value.split(";", 1)[0]!; } }, session);
      const accountCall = async (endpoint: string, body?: unknown) => {
        const response = await fetch(origin + "/api/me" + endpoint, {
          method: body ? "POST" : "GET", redirect: "error",
          headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() };
      };
      assert.equal((await accountCall("/memory/capabilities")).body.data.status, "ready", "An existing account cookie can manage memory without a separate memory token");
      assert.equal((await accountCall("/memories", { scope: "global", content: "既有账号会话保存的记忆", operationId: randomUUID() })).status, 200);
      assert.equal((await accountCall("/memories")).body.data.items[0].content, "既有账号会话保存的记忆");
      const deniedProjectKey = await fetch(origin + "/api/me/memories", { headers: { Authorization: `Bearer ${keyA.token}` } });
      assert.equal(deniedProjectKey.status, 401, "A project API key is never an account memory credential");
      await auth.revokeSession(session.refreshToken);
      assert.equal((await accountCall("/memories")).status, 401, "Revoking the login also revokes cookie memory access immediately");
      for (const requestOrigin of ["null", "invalid-origin", "https://other.test"]) {
        const response = await fetch(origin + "/api/me/memory/capabilities", { headers: { Origin: requestOrigin } });
        assert.equal(response.status, 403, "invalid and cross-site cookie requests fail before account access");
      }
      const call = async (
        token: string,
        endpoint: string,
        method = "GET",
        body?: unknown,
      ) => {
        const response = await fetch(origin + "/api/me" + endpoint, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          body: (await response.json()) as any,
        };
      };
      assert.equal(
        (await call(keyA.token, "/memories")).status,
        401,
        "project API keys cannot manage account memory",
      );
      const grantA = (
        await call(a, "/memory/grants", "POST", { scope: "project:p" })
      ).body.data;
      const grantB = (
        await call(b, "/memory/grants", "POST", { scope: "project:p" })
      ).body.data;
      const concurrent = await Promise.all(Array.from({ length: 6 }, () => call(a, "/memory/preferences")));
      assert.ok(concurrent.every(response => response.status === 200), "transactions reuse their checked-out connection under contention");
      assert.equal(
        (
          await call(grantA.token, "/memory/grants", "POST", {
            scope: "project:q",
          })
        ).status,
        403,
        "a worker cannot mint credentials",
      );
      assert.equal(
        (
          await call(grantA.token, "/memories", "POST", {
            scope: "project:q",
            content: "forbidden",
            operationId: "no",
          })
        ).status,
        403,
      );
      const created = (
        await call(grantA.token, "/memories", "POST", {
          scope: "project:p",
          content: "私有中文项目决策",
          operationId: "remember-p",
        })
      ).body.data;
      assert.equal(
        (await call(grantB.token, "/memories/" + created.id)).status,
        404,
      );
      assert.equal(
        (await call(grantB.token, "/memories")).body.data.items.length,
        0,
      );
      const grantQ = (
        await call(a, "/memory/grants", "POST", { scope: "project:q" })
      ).body.data;
      assert.equal(
        (await call(grantQ.token, "/memories/" + created.id)).status,
        404,
      );
      const d1 = (
          await call(a, "/memory/grants", "POST", {
            directory: true,
            directoryId: randomUUID(),
            label: "same",
          })
        ).body.data,
        d2 = (
          await call(a, "/memory/grants", "POST", {
            directory: true,
            directoryId: randomUUID(),
            label: "same",
          })
        ).body.data;
      await call(d1.token, "/memories", "POST", {
        scope: d1.scope,
        content: "folder private",
        operationId: "directory",
      });
      assert.equal(
        (await call(d2.token, "/memories")).body.data.items.length,
        0,
      );
      const readOnly = (
        await call(a, "/memory/grants", "POST", {
          scope: "project:p",
          readOnly: true,
        })
      ).body.data;
      assert.equal(
        (
          await call(readOnly.token, "/memories", "POST", {
            scope: "global",
            content: "forbidden",
            operationId: "read-only",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(a, "/memories/" + created.id, "PATCH", {
            content: "人工修改",
            version: 1,
            operationId: "edit",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(a, "/memories/" + created.id, "PATCH", {
            content: "冲突",
            version: 1,
            operationId: "edit-stale",
          })
        ).status,
        409,
      );
      await pool.query(
        "DELETE FROM project_members WHERE project_id='p' AND user_id='a'",
      );
      assert.equal((await call(grantA.token, "/memories")).status, 403);
      const page = (await call(a, "/memories")).body.data;
      assert.equal(
        page.items.some((item: any) => item.id === created.id),
        false,
      );
      assert.equal(page.locked["project:p"], 1);
      const search = (await call(a, "/memories?query=人工修改")).body.data;
      assert.deepEqual(search.locked, {});
      assert.equal(search.items.length, 0);
      assert.equal((await call(a, "/memories/" + created.id)).status, 404);
      await pool.query(
        "INSERT INTO project_members(project_id,user_id,role) VALUES('p','a','owner')",
      );
      assert.equal(
        (await call(grantA.token, "/memories/" + created.id)).body.data.content,
        "人工修改",
      );
      const pastDirectories = Array.from({ length: 80 }, () => `directory:${randomUUID()}`);
      await pool.query(
        "INSERT INTO memory_scopes(user_id,scope,label) SELECT 'a',scope,'Past folder' FROM unnest($1::text[]) AS scope",
        [pastDirectories],
      );
      const memoryConnection = await (memory as any).pool.connect();
      const originalQuery = memoryConnection.query;
      let settingsQueries = 0;
      memoryConnection.query = function (...args: any[]) {
        settingsQueries++;
        return originalQuery.apply(this, args);
      };
      memoryConnection.release();
      try {
        const settings = await Promise.all([
          call(a, "/memory/preferences"), call(a, "/memory/scopes"),
          call(a, "/memory/jobs"), call(a, "/memories?scope=global"),
        ]);
        assert.ok(settings.every(r => r.status === 200));
        assert.ok(settingsQueries < 60, `Settings must not issue one authorization query per past folder (${settingsQueries} queries)`);
      } finally {
        memoryConnection.query = originalQuery;
        await pool.query("DELETE FROM memory_scopes WHERE user_id='a' AND scope=ANY($1::text[])", [pastDirectories]);
      }
      const turn = {
        turnId: "stable-turn",
        messages: [
          {
            id: "stable-turn:u",
            role: "user",
            content: "以后使用中文",
            timestamp: Date.now(),
          },
          {
            id: "stable-turn:a",
            role: "assistant",
            content: "好的",
            timestamp: Date.now(),
          },
        ],
      };
      const first = await call(grantA.token, "/memory/turns", "POST", turn),
        again = await call(grantA.token, "/memory/turns", "POST", turn);
      assert.equal(first.body.data.jobId, again.body.data.jobId);
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const tick = async () => {
          const state = (
            await pool.query("SELECT status FROM memory_jobs WHERE id=$1", [
              first.body.data.jobId,
            ])
          ).rows[0]?.status;
          if (state === "done") return resolve();
          if (Date.now() > deadline)
            return reject(new Error("Memory job did not complete: " + state));
          setTimeout(() => void tick().catch(reject), 100);
        };
        void tick().catch(reject);
      });
      const recalled = (
        await call(grantA.token, "/memory/recall", "POST", {
          query: "中文约定",
        })
      ).body.data;
      assert.equal(recalled[0]?.content, "自动保存中文约定");
      assert.equal(
        (
          await call(grantA.token, "/memory/turns", "POST", {
            ...turn,
            messages: [
              { ...turn.messages[0], content: "changed" },
              turn.messages[1],
            ],
          })
        ).status,
        409,
      );

      const waitJob = async (id: string, status: string) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const row = (
            await pool.query("SELECT status FROM memory_jobs WHERE id=$1", [id])
          ).rows[0];
          if (row?.status === status) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Memory job did not reach " + status);
      };
      assert.equal(
        (
          await call(a, "/memories/" + created.id, "DELETE", {
            operationId: "forget-repeat",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(a, "/memories/" + created.id, "DELETE", {
            operationId: "forget-repeat",
          })
        ).status,
        200,
        "lost forget acknowledgement can be replayed",
      );
      const rememberedAgain = await call(grantA.token, "/memories", "POST", {
        scope: "project:p",
        content: "私有中文项目决策",
        operationId: "remember-p",
      });
      assert.equal(rememberedAgain.body.data.deleted, true);
      assert.equal("content" in rememberedAgain.body.data, false);
      const dirId = d1.scope.slice("directory:".length);
      assert.equal(
        (
          await call(a, "/memory/grants", "POST", {
            directory: true,
            directoryId: dirId,
          })
        ).body.data.scope,
        d1.scope,
        "grant refresh reuses registered directory",
      );
      assert.equal((await call(a, "/memories?cursor=e30")).status, 400);
      const defer = () => {
        let started!: () => void, release!: (value: any) => void;
        const began = new Promise<void>((resolve) => (started = resolve));
        extraction = async () => {
          started();
          return new Promise((resolve) => (release = resolve));
        };
        return { began, release: (value: any) => release(value) };
      };
      const cleared = defer();
      const clearJob = (
        await call(grantA.token, "/memory/turns", "POST", {
          ...turn,
          turnId: "clear-while-extracting",
        })
      ).body.data.jobId;
      await cleared.began;
      await call(a, "/memory/clear", "POST", {
        scope: "project:p",
        operationId: "clear-concurrent",
      });
      cleared.release([
        {
          scope: "project:p",
          content: "必须不再生的旧记忆",
          sources: [turn.messages[0]],
        },
      ]);
      await waitJob(clearJob, "done");
      assert.equal(
        (
          await call(
            grantA.token,
            "/memories?query=" + encodeURIComponent("旧记忆"),
          )
        ).body.data.items.length,
        0,
      );
      const denied = defer();
      const deniedJob = (
        await call(grantA.token, "/memory/turns", "POST", {
          ...turn,
          turnId: "revoke-while-extracting",
        })
      ).body.data.jobId;
      await denied.began;
      await pool.query(
        "DELETE FROM project_members WHERE project_id='p' AND user_id='a'",
      );
      denied.release([
        {
          scope: "project:p",
          content: "权限撤销后不能写入",
          sources: [turn.messages[0]],
        },
      ]);
      await waitJob(deniedJob, "failed");
      const retryPath = `/memory/jobs/${deniedJob}/retry`;
      assert.equal((await call(grantA.token, retryPath, "POST", {})).status, 403,
        "a project worker cannot authorize retries");
      assert.equal((await call(b, retryPath, "POST", {})).status, 404,
        "another account cannot retry this task");
      assert.equal((await call(a, retryPath, "POST", {})).status, 403,
        "retry must recheck current project access");
      const lockedJobs = (await call(a, "/memory/jobs")).body.data;
      assert.equal(lockedJobs.find((j: any) => j.id === deniedJob).reason, "scope_locked");
      assert.equal(lockedJobs.find((j: any) => j.id === deniedJob).retryable, false);
      await pool.query(
        "INSERT INTO project_members(project_id,user_id,role) VALUES('p','a','owner')",
      );
      assert.equal(
        (
          await call(
            grantA.token,
            "/memories?query=" + encodeURIComponent("权限撤销"),
          )
        ).body.data.items.length,
        0,
      );
      const snapshot = (await pool.query("SELECT states,payload_hash FROM memory_jobs WHERE id=$1", [deniedJob])).rows[0];
      await call(a, "/memory/preferences", "PATCH", { enabled: true, automatic: false });
      assert.equal((await call(a, retryPath, "POST", {})).status, 409,
        "disabled automatic saving cannot be bypassed by retry");
      await call(a, "/memory/preferences", "PATCH", { enabled: true, automatic: true });
      await call(a, "/memory/clear", "POST", { scope: "project:p", operationId: "clear-before-retry" });
      assert.equal((await call(a, retryPath, "POST", {})).status, 200);
      assert.equal((await call(a, retryPath, "POST", {})).status, 200,
        "a repeated retry acknowledgement does not duplicate work");
      await waitJob(deniedJob, "done");
      assert.deepEqual((await pool.query("SELECT states,payload_hash FROM memory_jobs WHERE id=$1", [deniedJob])).rows[0], snapshot,
        "retry keeps the original deletion/edit snapshot and stable payload identity");
      assert.equal((await call(a, "/memories?query=" + encodeURIComponent("权限撤销"))).body.data.items.length, 0,
        "retrying a cleared task cannot recreate its old candidates");

      const oldKey = await accounts.createApiKey({ userId: "a", name: "old login", source: "cli", scopes: [] });
      const oldManager = await memory.issue("a", oldKey.record.id);
      const oldGrant = (await call(oldManager, "/memory/grants", "POST", { directory: true })).body.data;
      const revoked = defer();
      const revokedJob = (await call(oldGrant.token, "/memory/turns", "POST", {
        ...turn, turnId: "revoked-login-retry",
      })).body.data.jobId;
      await revoked.began;
      await pool.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1", [oldKey.record.id]);
      revoked.release([{ scope: oldGrant.scope, content: "重新授权后保存的约定", sources: [turn.messages[0]] }]);
      await waitJob(revokedJob, "failed");
      const failedJob = (await call(a, "/memory/jobs")).body.data.find((j: any) => j.id === revokedJob);
      assert.equal(failedJob.reason, "authorization_changed");
      assert.equal(failedJob.retryable, true);
      assert.equal((await call(oldManager, `/memory/jobs/${revokedJob}/retry`, "POST", {})).status, 401);
      assert.equal((await call(a, `/memory/jobs/${revokedJob}/retry`, "POST", {})).status, 200,
        "explicit retry replaces a revoked parent with the current manager authorization");
      await waitJob(revokedJob, "done");
      const recovered = (await call(a, "/memories?query=" + encodeURIComponent("重新授权"))).body.data.items;
      assert.equal(recovered[0]?.content, "重新授权后保存的约定");
      assert.equal(recovered[0]?.scope, oldGrant.scope);
      const privatePayloads = (
        await pool.query("SELECT payload FROM memory_jobs WHERE user_id=$1", [
          "a",
        ])
      ).rows;
      assert.ok(
        privatePayloads.every(
          (row) => !JSON.stringify(row.payload).includes("以后使用中文"),
        ),
        "PostgreSQL tasks hold L0 references, not raw turns",
      );
      extraction = undefined;
      await pool.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1", [
        keyA.record.id,
      ]);
      assert.equal((await call(a, "/memories")).status, 401);
      assert.equal((await call(grantA.token, "/memories")).status, 401);
      await pool.query(
        "UPDATE user_profiles SET status='disabled' WHERE user_id='b'",
      );
      assert.equal((await call(grantB.token, "/memories")).status, 403);
    } finally {
      configureProjectAuthContext(previousAuth);
      if (web) await close(web);
      await memory.close();
      await auth?.close();
      await accounts.close();
      await database.close();
      await pool.end();
      await close(service);
      await rm(dir, { recursive: true, force: true });
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test("real extraction HTTP and Core provider preserve global preferences across scopes without queuing unconfigured extraction", { skip: !databaseUrl, timeout: 60000 }, async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = "memory_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connection = new URL(databaseUrl!);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const url = connection.toString();
  const pool = new pg.Pool({ connectionString: url });
  const accounts = new AccountRepository(url), database = new DatabaseRepository(url);
  const root = await mkdtemp(path.join(tmpdir(), "memory-extraction-http-"));
  const modelKeys = ["STEAMHARNESS_MEMORY_MODEL_BASE_URL", "STEAMHARNESS_MEMORY_MODEL_API_KEY", "STEAMHARNESS_MEMORY_MODEL"];
  const previous = modelKeys.map(key => process.env[key]);
  const { createMemoryHttpServer } = await import(new URL("../../../memory-service/src/server.ts", import.meta.url).href);
  const serviceToken = "isolated-memory-service-token-at-least-32";
  let service: Server = createMemoryHttpServer({ root, token: serviceToken, automatic: false });
  const serviceUrl = await listen(service);
  const memory = new AccountMemory(url, serviceUrl, serviceToken);
  let web: Server | undefined, model: Server | undefined;
  let extractionCalls = 0;
  let dedupCalls = 0;
  const agentRequests: any[] = [];
  try {
    await accounts.init();
    await database.init();
    await memory.init();
    for (const userId of ["a", "b"]) {
      await accounts.upsertUserProfile({ userId, email: `${userId}@extraction.test` });
      await pool.query("UPDATE user_profiles SET status='active' WHERE user_id=$1", [userId]);
    }
    const key = await accounts.createApiKey({ userId: "a", name: "host", source: "cli", scopes: [] });
    const manager = await memory.issue("a", key.record.id);
    for (const id of ["p", "q"]) {
      await pool.query("INSERT INTO projects(id,name,owner_user_id,entries,default_entry) VALUES($1,$1,'a','[]'::jsonb,'main')", [id]);
      await pool.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,'a','owner')", [id]);
    }
    const app = express();
    app.use("/api/me", createMemoryRouter(memory));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error instanceof HttpError ? error.statusCode : 500).json({ errCode: error.errCode ?? 500, errMessage: error.message }));
    web = createServer(app);
    const origin = await listen(web);
    const identity = await memory.identify(manager);
    const grant = await memory.grant(identity, { scope: "project:p" });
    const provider = createServerAgentMemoryProvider({ serverUrl: origin, getGrant: async () => grant });
    const turn = { turnId: "real-http-turn", messages: [
      { id: "real-user", role: "user" as const, content: "以后所有项目都用简洁中文回答；本项目使用 PostgreSQL。", timestamp: Date.now() },
      { id: "real-answer", role: "assistant" as const, content: "好的。", timestamp: Date.now() },
    ] };
    assert.equal((await provider.capabilities()).automatic, false);
    assert.deepEqual(await provider.submitTurn(turn), { accepted: false }, "manual-only service must not accumulate guaranteed-to-fail jobs");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM memory_jobs")).rows[0].n, 0);
    const manual = await provider.remember({ scope: "current", content: "Manual memory works without an extraction model.", operationId: "manual-only" });
    assert.equal((await provider.get(manual.id)).content, manual.content);

    model = createServer(async (req, res) => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer isolated-model-key");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.model === "agent-wire-check") {
        agentRequests.push(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ id: "agent-wire-check", choices: [{ index: 0, delta: { role: "assistant", content: "Verified final answer" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "agent-wire-check", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      let result: unknown;
      if (body.messages[0].content.includes("情境切分")) {
        extractionCalls++;
        assert.match(body.messages[1].content, /\[real-user\] \[user\]/);
        result = [{ memories: [
          { type: "instruction", content: "用户要求跨项目用简洁中文回答。", source_message_ids: ["real-user"], metadata: { personal_preference: true, explicit_user_preference: true } },
          { type: "instruction", content: "本项目使用 PostgreSQL。", source_message_ids: ["real-user"], metadata: {} },
        ] }];
      } else {
        dedupCalls++;
        result = [...body.messages[1].content.matchAll(/### 第 \d+ 条新记忆 \(record_id: ([^)]+)\)/g)].map(match => ({ record_id: match[1], action: "skip" }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    });
    process.env.STEAMHARNESS_MEMORY_MODEL_BASE_URL = (await listen(model)) + "/v1";
    process.env.STEAMHARNESS_MEMORY_MODEL_API_KEY = "isolated-model-key";
    process.env.STEAMHARNESS_MEMORY_MODEL = "isolated-protocol-fixture";
    const port = (service.address() as any).port;
    await close(service);
    await assert.rejects(provider.submitTurn({ ...turn, turnId: "temporary-outage" }), { status: 503 }, "a temporary outage remains retryable instead of acknowledging and dropping the turn");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM memory_jobs")).rows[0].n, 0);
    service = createMemoryHttpServer({ root, token: serviceToken });
    await new Promise<void>(resolve => service.listen(port, "127.0.0.1", resolve));
    assert.equal((await provider.capabilities()).automatic, true);
    assert.equal((await provider.get(manual.id)).content, manual.content, "SQLite survives a real service restart");
    const submitted = await provider.submitTurn(turn) as { accepted: boolean; jobId: string };
    const waitDone = async (id: string) => {
      const deadline = Date.now() + 15000;
      while (true) {
        const job = (await pool.query("SELECT status,error FROM memory_jobs WHERE id=$1", [id])).rows[0];
        if (job?.status === "done") return;
        assert.notEqual(job?.status, "failed", job?.error);
        assert.ok(Date.now() < deadline, "real HTTP extraction job completes");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    await waitDone(submitted.jobId);
    assert.equal(extractionCalls, 1);
    const repeat = await provider.submitTurn({ ...turn, turnId: "new-turn-same-facts" }) as { jobId: string };
    await waitDone(repeat.jobId);
    assert.equal(extractionCalls, 2);
    assert.equal(dedupCalls, 1, "conflict checking uses the real model HTTP protocol");
    assert.equal((await provider.list()).items.length, 3, "repeated facts produce no duplicate memories");
    const otherGrant = await memory.grant(identity, { scope: "project:q" });
    const other = createServerAgentMemoryProvider({ serverUrl: origin, getGrant: async () => otherGrant });
    const recalled = await other.recall("简洁中文 PostgreSQL");
    assert.deepEqual(recalled.map(item => item.content), ["用户要求跨项目用简洁中文回答。"]);
    assert.equal(recalled[0].scope, "global");
    assert.equal((await provider.recall("PostgreSQL"))[0].scope, "project:p");
    const runFreshSession = async (name: string) => {
      const runtime = await createAgentRuntime({
        provider: "memory-wire-check", model: "agent-wire-check", apiKind: "openai-completions",
        apiKey: "isolated-model-key", baseUrl: process.env.STEAMHARNESS_MEMORY_MODEL_BASE_URL,
        workdir: root, databasePath: path.join(root, `${name}.sqlite`),
        memory: { provider: other, readOnly: true },
      });
      try {
        let answer = "";
        for await (const event of runtime.run({ prompt: "简洁中文 英文", requestId: name, errCode: 0, errMessage: "" }))
          if (event.type === "text_delta") answer += event.delta;
        assert.equal(answer, "Verified final answer");
      } finally { await runtime.close(); }
    };
    await runFreshSession("before-forget");
    assert.ok(JSON.stringify(agentRequests.at(-1).messages).includes(recalled[0].content), "stored memory reaches an actual model HTTP request in a fresh session");
    assert.equal(agentRequests.at(-1).messages.filter((message: any) => ["system", "developer"].includes(message.role)).some((message: any) => JSON.stringify(message.content).includes("Current user instructions take precedence")), true);
    const item = recalled[0];
    const edited = await other.update({ id: item.id, version: item.version, content: "用户要求跨项目用简洁英文回答。", operationId: "edit-global" });
    assert.equal(edited.version, item.version + 1);
    await assert.rejects(other.update({ id: item.id, version: item.version, content: "stale", operationId: "stale-global" }), { status: 409 });
    await other.forget({ id: item.id, operationId: "forget-global" });
    assert.equal((await other.recall("简洁中文 英文")).length, 0);
    await runFreshSession("after-forget");
    assert.equal(agentRequests.length, 2);
    assert.equal(JSON.stringify(agentRequests.at(-1).messages).includes(item.content), false, "a new model request excludes forgotten memory");
    assert.equal((await provider.submitTurn(turn) as any).jobId, submitted.jobId);
    assert.equal(extractionCalls, 2, "replayed durable turn cannot recreate a forgotten preference");
    assert.equal((await other.list()).items.length, 0, "current-scope lists do not include another project's decisions");
    await pool.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1", [key.record.id]);
    await assert.rejects(other.recall("中文"), { status: 401 });
  } finally {
    if (web) await close(web);
    await memory.close();
    await close(service);
    if (model) await close(model);
    modelKeys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await accounts.close(); await database.close(); await pool.end();
    await rm(root, { recursive: true, force: true });
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
