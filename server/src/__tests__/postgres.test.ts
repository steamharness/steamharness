import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { createPostgresClient, createPostgresPool, formatPostgresPoolError } from "../postgres";

test("pool limits apply to each runtime pool and preserve explicit limits", async () => {
  const env = { STEAMHARNESS_SERVER_DATABASE_POOL_MAX: "2" };
  const shared = createPostgresPool({ label: "shared" }, env);
  const explicit = createPostgresPool({ label: "explicit", max: 1 }, env);
  try {
    assert.equal(shared.options.max, 2);
    assert.equal(explicit.options.max, 1);
  } finally { await Promise.all([shared.end(), explicit.end()]); }
  for (const value of ["0", "-1", "1.5", "invalid"]) {
    assert.throws(() => createPostgresPool({ label: "invalid" }, { STEAMHARNESS_SERVER_DATABASE_POOL_MAX: value }), /positive integer/);
  }
});

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
    "[steamharness-server] test PostgreSQL idle client error; future queries will reconnect. terminated",
  );
});

test("checked-out clients survive a disconnect between queries and the pool replaces them", async t => {
  const endpoint = await postgresEndpoint(t);
  const warnings = captureWarnings(t);
  const pool = createPostgresPool({ ...endpoint.options, label: "test lock", max: 1 });
  t.after(() => pool.end());
  const client = await pool.connect();
  try {
    await client.query("select 1");
    const ended = new Promise<void>(resolve => client.once("end", resolve));
    endpoint.disconnect();
    await ended;
    await assert.rejects(client.query("select 1"), /not queryable/);
  } finally { client.release(); }

  assert.equal(pool.totalCount, 0);
  assert.equal((await pool.query("select 1")).command, "SELECT");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test lock PostgreSQL client connection error/);
  assert.match(warnings[0], /Connection terminated unexpectedly/);
});

test("disconnects during a checked-out query reject without retrying it", async t => {
  const endpoint = await postgresEndpoint(t);
  const warnings = captureWarnings(t);
  const pool = createPostgresPool({ ...endpoint.options, label: "test transaction", max: 1 });
  t.after(() => pool.end());
  const client = await pool.connect();
  try {
    endpoint.disconnectOnNextQuery();
    await assert.rejects(client.query("select 1"), /Connection terminated unexpectedly/);
    assert.equal(endpoint.queryCount, 1);
  } finally { client.release(); }

  assert.equal((await pool.query("select 1")).command, "SELECT");
  assert.equal(warnings.length, 1);
});

test("pool.query still rejects disconnected queries and replaces the failed client", async t => {
  const endpoint = await postgresEndpoint(t);
  const warnings = captureWarnings(t);
  const pool = createPostgresPool({ ...endpoint.options, label: "test query", max: 1 });
  t.after(() => pool.end());
  endpoint.disconnectOnNextQuery();
  await assert.rejects(pool.query("select 1"), /Connection terminated unexpectedly/);
  assert.equal(endpoint.queryCount, 1);
  assert.equal((await pool.query("select 1")).command, "SELECT");
  assert.equal(warnings.length, 1);
});

test("repeated checkouts retain one error listener and idle disconnects are reported once", async t => {
  const endpoint = await postgresEndpoint(t);
  const warnings = captureWarnings(t);
  const pool = createPostgresPool({ ...endpoint.options, label: "test idle", max: 1 });
  t.after(() => pool.end());
  for (let attempt = 0; attempt < 20; attempt++) {
    const client = await pool.connect();
    try { assert.equal(client.listenerCount("error"), 1); }
    finally { client.release(); }
    assert.equal(client.listenerCount("error"), 1);
  }

  const disconnected = new Promise<void>(resolve => pool.once("error", () => resolve()));
  endpoint.disconnect();
  await disconnected;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test idle PostgreSQL idle client error/);
  assert.equal((await pool.query("select 1")).command, "SELECT");
});

test("standalone clients consume asynchronous errors and continue rejecting queries", async t => {
  const endpoint = await postgresEndpoint(t);
  const warnings = captureWarnings(t);
  const client = createPostgresClient({ ...endpoint.options, label: "test migration" });
  t.after(() => client.end());
  await client.connect();
  await client.query("select 1");
  const ended = new Promise<void>(resolve => client.once("end", resolve));
  endpoint.disconnect();
  await ended;

  await assert.rejects(client.query("select 1"), /not queryable/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test migration PostgreSQL client connection error/);
});

function captureWarnings(t: TestContext): string[] {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  return warnings;
}

// A local PostgreSQL protocol endpoint exercises real pg sockets and error
// events without touching a developer's database or requiring Docker.
async function postgresEndpoint(t: TestContext) {
  const sockets = new Set<Socket>();
  let dropQuery = false, queryCount = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let startup = true, pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      while (pending.length >= (startup ? 4 : 5)) {
        const length = startup ? pending.readInt32BE(0) : pending.readInt32BE(1) + 1;
        if (pending.length < length) return;
        const type = startup ? "startup" : String.fromCharCode(pending[0]);
        pending = pending.subarray(length);
        if (startup) {
          startup = false;
          // AuthenticationOk, ReadyForQuery.
          socket.write(Buffer.from("5200000008000000005a0000000549", "hex"));
        } else if (type === "Q") {
          queryCount++;
          if (dropQuery) { dropQuery = false; socket.end(); return; }
          // CommandComplete (SELECT 1), ReadyForQuery.
          socket.write(Buffer.from("430000000d53454c4543542031005a0000000549", "hex"));
        } else if (type === "X") socket.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    options: { host: "127.0.0.1", port: (server.address() as AddressInfo).port, user: "test", database: "test", ssl: false, connectionTimeoutMillis: 2_000 },
    disconnect: () => { for (const socket of sockets) socket.end(); },
    disconnectOnNextQuery: () => { dropQuery = true; },
    get queryCount() { return queryCount; },
  };
}
