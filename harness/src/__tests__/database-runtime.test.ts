import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseResourceError, type NodeDatabaseDescriptor } from "../database/index";
import { createDatabaseConnector } from "../database/runtime";
import { createRemoteRelationalDatabaseHost, type RelationalDatabaseHost, type DatabaseConnectionLease } from "../database/host";

interface Model { findMany(): Promise<string[]>; create(input: { data: { name: string } }): Promise<string> }
interface Client { user: Model; transaction<T>(work: (tx: { user: Model }) => Promise<T>): Promise<T> }
function fixture(options: { pooled?: boolean; onQueued?: () => void; enforceExpiry?: boolean } = {}) {
  const rows: string[] = [], released: string[] = [];
  const expirations = new Map<string, number>();
  let activeTransactions = 0;
  const waiting: Array<() => void> = [];
  let opens = 0, checks = 0, disconnects = 0, revision = 1, accessRevision = 1, denied = false;
  let mode: "read" | "write" = "write";
  let ttl = 60_000;
  let read: (() => Promise<string[]>) | undefined;
  class Engine {
    user: Model = {
      async findMany() { return read ? read() : [...rows]; },
      async create({ data }) { if (data.name === "error") throw Object.assign(new Error("postgresql://SECRET/password"), { code: "P2002" }); rows.push(data.name); return data.name; },
    };
    async $connect() {}
    async $disconnect() { disconnects++; }
    async $transaction<T>(work: (engine: Engine) => Promise<T>, settings: { maxWait: number }) {
      if (options.pooled && activeTransactions >= 2) await new Promise<void>((resolve, reject) => {
        const ready = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(ready), 1);
          reject(Object.assign(new Error("Connection acquisition timed out."), { code: "P2028" }));
        }, settings.maxWait);
        waiting.push(ready);
        options.onQueued?.();
      });
      activeTransactions++;
      const before = [...rows];
      try { return await work(this); }
      catch (error) { rows.splice(0, rows.length, ...before); throw error; }
      finally { activeTransactions--; waiting.shift()?.(); }
    }
  }
  const descriptor: NodeDatabaseDescriptor<"main", Client> = {
    kind: "steamharness.database", version: 1, target: "node", provider: "postgresql", alias: "main", schemaHash: "a".repeat(64),
    metadata: { enums: [], models: [{ name: "User", delegate: "user", table: "User", fields: [], primaryKey: [], uniqueKeys: [] }] },
    loadEngine: async () => ({ PrismaClient: Engine }),
  };
  const host: RelationalDatabaseHost = {
    async open(input) {
      if (input.binding && input.binding.revision !== revision) throw new DatabaseResourceError("DATABASE_BINDING_CHANGED", "Changed.");
      opens++;
      expirations.set(String(opens), Date.now() + ttl);
      return { binding: { ...input, id: "binding", databaseId: "resource", mode, revision }, credential: {
        id: String(opens), databaseId: "resource", mode, revision: accessRevision, schemaHash: descriptor.schemaHash, expiresAt: new Date(Date.now() + ttl).toISOString(), connectionString: "postgresql://SECRET/password",
      } };
    },
    async authorize(input) {
      checks++;
      if (denied) throw new DatabaseResourceError("DATABASE_ACCESS_DENIED", "Revoked.");
      if (options.enforceExpiry && (expirations.get(input.credentialId) ?? 0) <= Date.now()) throw new DatabaseResourceError("DATABASE_CONNECTION_EXPIRED", "Expired.");
      if (input.binding?.revision !== revision) throw new DatabaseResourceError("DATABASE_BINDING_CHANGED", "Changed.");
    },
    async release(id) { released.push(id); },
  };
  return { rows, descriptor, host, released, stats: () => ({ opens, checks, disconnects }), rebind() { revision++; }, changeAccess() { accessRevision++; }, revoke() { denied = true; }, readOnly() { mode = "read"; }, blockRead(work: () => Promise<string[]>) { read = work; } };
}

test("model facades hide engine APIs, protect failed transactions and expire retained transaction handles", async () => {
  const f = fixture(), connector = createDatabaseConnector({ projectId: "project", entryId: "entry", host: f.host });
  try {
    const db = await connector.connect(f.descriptor);
    assert.deepEqual(Object.keys(db).sort(), ["transaction", "user"]);
    for (const key of ["$connect", "$disconnect", "$queryRaw", "$executeRaw", "$extends", "$transaction", "then"]) assert.equal(Reflect.get(db, key), undefined);
    assert.equal(Reflect.get(db.user, "$queryRaw"), undefined);
    assert.equal(Object.isFrozen(db), true); assert.equal(Object.isFrozen(db.user), true);
    await db.user.create({ data: { name: "first" } });
    assert.deepEqual(await db.user.findMany(), ["first"]);
    let retained: { user: Model } | undefined;
    await assert.rejects(db.transaction(async tx => { retained = tx; await tx.user.create({ data: { name: "rollback" } }); throw new Error("cancel"); }), /cancel/);
    assert.deepEqual(await db.user.findMany(), ["first"]);
    await assert.rejects(retained!.user.findMany(), { code: "DATABASE_CLOSED" });
    assert.equal(await db.transaction(async tx => tx.user.create({ data: { name: "commit" } })), "commit");
    await assert.rejects(db.transaction(async tx => { await tx.user.create({ data: { name: "rollback-too" } }); try { await tx.user.create({ data: { name: "error" } }); } catch {} }), { code: "DATABASE_QUERY_FAILED", queryCode: "P2002" });
    assert.deepEqual(f.rows, ["first", "commit"]);
    await assert.rejects(db.user.create({ data: { name: "error" } }), error => {
      assert.equal(JSON.stringify(error).includes("SECRET"), false); assert.doesNotMatch(String(error), /SECRET|Prisma|postgresql/); return true;
    });
    assert.ok(f.stats().checks >= 10);
  } finally { await connector.close(); }
  assert.deepEqual(f.released, ["1"]); assert.equal(f.stats().disconnects, 1);
});

test("concurrent transactions wait for busy connections without replaying callbacks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void, queued!: () => void, waiting = 0, callbacks = 0;
  const occupied = new Promise<void>(resolve => { release = resolve; });
  const allQueued = new Promise<void>(resolve => { queued = resolve; });
  const f = fixture({ pooled: true, onQueued: () => { if (++waiting === 6) queued(); } });
  const connector = createDatabaseConnector({ projectId: "project", entryId: "entry", host: f.host });
  try {
    const db = await connector.connect(f.descriptor);
    const completed = Promise.allSettled(Array.from({ length: 8 }, (_, index) => db.transaction(async tx => {
      callbacks++;
      await occupied;
      return tx.user.create({ data: { name: String(index) } });
    })));
    await allQueued;
    t.mock.timers.tick(12_000);
    release();
    const results = await completed;
    assert.equal(results.filter(result => result.status === "fulfilled").length, 8);
    assert.equal(callbacks, 8);
    assert.deepEqual([...f.rows].sort(), ["0", "1", "2", "3", "4", "5", "6", "7"]);
  } finally { release(); await connector.close(); }
});

test("bindings are pinned, reconnect is explicit, read grants and revocation stop model access", async () => {
  const f = fixture(), connector = createDatabaseConnector({ projectId: "project", entryId: "entry", host: f.host });
  try {
    const old = await connector.connect(f.descriptor);
    f.rebind();
    await assert.rejects(old.user.create({ data: { name: "stale" } }), { code: "DATABASE_BINDING_CHANGED" });
    f.readOnly();
    const read = await connector.connect(f.descriptor);
    assert.deepEqual(await read.user.findMany(), []);
    await assert.rejects(read.user.create({ data: { name: "read-only" } }), { code: "DATABASE_ACCESS_DENIED" });
    f.revoke(); await assert.rejects(read.user.findMany(), { code: "DATABASE_ACCESS_DENIED" });
    assert.deepEqual(f.rows, []);
  } finally { await connector.close(); }
});

test("expired leases renew the same binding and release old connections without replaying queries", async t => {
  const f = fixture(), initial = Date.now(); let now = initial;
  t.mock.method(Date, "now", () => now);
  const connector = createDatabaseConnector({ projectId: "project", entryId: "entry", host: f.host });
  try {
    const db = await connector.connect(f.descriptor);
    await db.user.create({ data: { name: "once" } });
    now += 60_000;
    assert.deepEqual(await db.user.findMany(), ["once"]);
    assert.equal(f.stats().opens, 2);
    now += 60_000; f.rebind();
    await assert.rejects(db.user.create({ data: { name: "wrong-resource" } }), { code: "DATABASE_BINDING_CHANGED" });
    assert.deepEqual(f.rows, ["once"]);
  } finally { await connector.close(); }
  assert.equal(f.stats().disconnects, 2); assert.deepEqual([...f.released].sort(), ["1", "2"]);
});

test("near-expiry leases renew before a transaction so authorization can finish without replay", async t => {
  let now = Date.now(), callbacks = 0;
  t.mock.method(Date, "now", () => now);
  const f = fixture({ enforceExpiry: true });
  const connector = createDatabaseConnector({ projectId: "project", entryId: "entry", host: f.host });
  try {
    const db = await connector.connect(f.descriptor);
    now += 55_000;
    await db.transaction(async tx => {
      callbacks++;
      await tx.user.create({ data: { name: "once" } });
      now += 10_000;
    });
    assert.equal(callbacks, 1);
    assert.equal(f.stats().opens, 2);
    assert.deepEqual(f.rows, ["once"]);
  } finally { await connector.close(); }
  assert.deepEqual([...f.released].sort(), ["1", "2"]);
});

test("missing hosts, browser targets, unsafe metadata and closed connectors fail before loading engines", async () => {
  const f = fixture(), without = createDatabaseConnector({ projectId: "p", entryId: "e" });
  await assert.rejects(without.connect(f.descriptor), { code: "DATABASE_UNBOUND" }); await without.close();
  const connector = createDatabaseConnector({ projectId: "p", entryId: "e", host: f.host });
  await assert.rejects(connector.connect({ ...f.descriptor, target: "browser" as const }), { code: "DATABASE_TARGET_UNSUPPORTED" });
  await assert.rejects(connector.connect({ ...f.descriptor, metadata: { enums: [], models: [{ ...f.descriptor.metadata.models[0], delegate: "$queryRaw" }] } }), { code: "DATABASE_INVALID_REQUEST" });
  assert.equal(f.stats().opens, 0);
  await connector.close(); await assert.rejects(connector.connect(f.descriptor), { code: "DATABASE_CLOSED" });
});

test("renewal cannot revive a client after its account authorization generation changes", async t => {
  const f = fixture(); let now = Date.now(); t.mock.method(Date, "now", () => now);
  const connector = createDatabaseConnector({ projectId: "project", entryId: "entry", host: f.host });
  try {
    const db = await connector.connect(f.descriptor);
    f.changeAccess(); now += 60_000;
    await assert.rejects(db.user.create({ data: { name: "revived" } }), { code: "DATABASE_CONNECTION_EXPIRED" });
    assert.deepEqual(f.rows, []);
    const fresh = await connector.connect(f.descriptor);
    await fresh.user.create({ data: { name: "explicit" } });
    assert.deepEqual(f.rows, ["explicit"]);
  } finally { await connector.close(); }
  assert.equal(f.released.length, 3);
});

test("closing or cancelling during connection acquisition releases the credential", async () => {
  const f = fixture(); let release!: (lease: DatabaseConnectionLease) => void;
  const lease = await f.host.open({ projectId: "p", entryId: "e", alias: "main", schemaHash: f.descriptor.schemaHash });
  f.host.open = () => new Promise(resolve => { release = resolve; });
  const connector = createDatabaseConnector({ projectId: "p", entryId: "e", host: f.host });
  const connecting = connector.connect(f.descriptor);
  const rejection = assert.rejects(connecting, { code: "DATABASE_CLOSED" });
  const closing = connector.close(); release(lease);
  await rejection; await closing; assert.deepEqual(f.released, ["1"]);
});

test("cancellation revokes the SQL identity before waiting for an in-flight query", async () => {
  const f = fixture(), controller = new AbortController();
  let started!: () => void, rejectQuery!: (reason: Error) => void;
  const queryStarted = new Promise<void>(resolve => { started = resolve; });
  f.blockRead(() => { started(); return new Promise((_resolve, reject) => { rejectQuery = reject; }); });
  const originalRelease = f.host.release;
  f.host.release = async id => { rejectQuery(new Error("SQL terminated")); await originalRelease(id); };
  const connector = createDatabaseConnector({ projectId: "p", entryId: "e", host: f.host, signal: controller.signal });
  const db = await connector.connect(f.descriptor);
  const query = db.user.findMany(), rejection = assert.rejects(query, { code: "DATABASE_QUERY_FAILED" });
  await queryStarted; controller.abort(); await rejection; await connector.close();
  assert.deepEqual(f.released, ["1"]); assert.equal(f.stats().disconnects, 1);
});

test("native HTTP transport has a deadline, refuses redirects and sanitizes network errors", async t => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ errCode: 409, data: { code: "DATABASE_BINDING_CHANGED" }, errMessage: "Changed." }), { status: 409 });
  });
  const host = createRemoteRelationalDatabaseHost({ serverUrl: "http://localhost:18126", token: "private-account-key" });
  const input = { projectId: "p", entryId: "e", alias: "main", schemaHash: "a".repeat(64) };
  await assert.rejects(host.open(input), { code: "DATABASE_BINDING_CHANGED" });
  assert.equal(requests[0].init.redirect, "error"); assert.ok(requests[0].init.signal);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("postgresql://SECRET/password private-account-key"); });
  await assert.rejects(host.open(input), error => { assert.doesNotMatch(String(error), /SECRET|private-account-key/); return true; });
});
