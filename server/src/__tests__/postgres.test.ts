import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPool, formatPostgresPoolError } from "../postgres";

test("createPostgresPool consumes idle client errors", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const pool = createPostgresPool({
    connectionString: "postgresql://example.invalid/postgres",
    label: "test storage",
  });

  try {
    assert.equal(pool.listenerCount("error"), 1);

    const error = Object.assign(new Error("{:shutdown, :db_termination}"), {
      code: "XX000",
      severity: "FATAL",
    });

    assert.equal(pool.emit("error", error), true);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /test storage PostgreSQL idle client error/);
    assert.match(String(warnings[0]?.[0]), /future queries will reconnect/);
    assert.match(String(warnings[0]?.[0]), /code=XX000/);
  } finally {
    console.warn = originalWarn;
    await pool.end();
  }
});

test("formatPostgresPoolError includes non-Error values", () => {
  assert.equal(
    formatPostgresPoolError("test", "terminated"),
    "[workflow-server] test PostgreSQL idle client error; future queries will reconnect. terminated",
  );
});
