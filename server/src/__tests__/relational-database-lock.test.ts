import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { advisoryLock } from "../relational-databases/lock";

function fixture(options: { contended?: boolean; timeout?: boolean; unlockError?: Error } = {}) {
  let held = false, timeout = "11s";
  const queries: string[] = [], releases: (Error | undefined)[] = [];
  const pool = { connect: async () => ({
    query: async (sql: string, values?: string[]) => {
      queries.push(sql);
      if (sql.includes("pg_try_advisory_lock")) { held = !options.contended; return { rows: [{ locked: held }] }; }
      if (sql.includes("current_setting")) return { rows: [{ timeout }] };
      if (sql.includes("set_config")) { timeout = values?.[0] ?? "5s"; return { rows: [] }; }
      if (sql.includes("pg_advisory_unlock")) { if (options.unlockError) throw options.unlockError; held = false; return { rows: [] }; }
      if (sql.includes("pg_advisory_lock")) {
        assert.equal(timeout, "5s");
        if (options.timeout) throw Object.assign(new Error("Timed out"), { code: "55P03" });
        held = true; return { rows: [] };
      }
      throw new Error("Unexpected lock query");
    },
    release: (error?: Error) => { releases.push(error); },
  }) } as unknown as pg.Pool;
  return { pool, queries, releases, held: () => held, timeout: () => timeout };
}

for (const shared of [false, true]) test(`uncontended ${shared ? "shared" : "exclusive"} lock uses two round trips and releases on failure`, async () => {
  const f = fixture(), failure = new Error("Work failed");
  await assert.rejects(advisoryLock(f.pool, "scope", "Busy", async () => {
    assert.equal(f.held(), true); assert.equal(f.timeout(), "11s"); throw failure;
  }, true, shared), failure);
  assert.equal(f.held(), false); assert.equal(f.queries.length, 2);
  assert.ok(f.queries.every(sql => shared === sql.includes("_shared")));
  assert.deepEqual(f.releases, [undefined]);
});

test("contention retains the bounded wait and restores the pool connection timeout", async () => {
  const f = fixture({ contended: true });
  assert.equal(await advisoryLock(f.pool, "scope", "Busy", async () => { assert.equal(f.held(), true); return "done"; }, true), "done");
  assert.equal(f.held(), false); assert.equal(f.timeout(), "11s"); assert.deepEqual(f.releases, [undefined]);
});

test("timed-out and nonwaiting contenders cannot run work or unlock another owner's lock", async () => {
  for (const wait of [false, true]) {
    const f = fixture({ contended: true, timeout: true });
    await assert.rejects(advisoryLock(f.pool, "scope", "Busy", async () => assert.fail("Must not execute"), wait), { code: "DATABASE_BUSY" });
    assert.equal(f.timeout(), "11s"); assert.equal(f.queries.some(sql => sql.includes("pg_advisory_unlock")), false);
    assert.deepEqual(f.releases, [undefined]);
  }
});

test("failed lock cleanup discards the connection", async () => {
  const failure = new Error("Connection lost"), f = fixture({ unlockError: failure });
  await assert.rejects(advisoryLock(f.pool, "scope", "Busy", async () => 1, true), failure);
  assert.deepEqual(f.releases, [failure]);
});
