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
import { DatabaseRepository } from "../persistence";
import { AccountMemory } from "../memory";
import { createMemoryRouter } from "../routes/memory";
import { HttpError } from "../protocol";
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
    try {
      await accounts.init();
      await database.init();
      await memory.init();
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
      if (web) await close(web);
      await memory.close();
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
