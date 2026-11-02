import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { RuntimeStorageError, type AgentStorageWrite, type RuntimeStorageOperation, type RuntimeStorageCredentials } from "steamharness/runtime-storage";
import { RuntimeStorageRepository } from "../runtime-storage/repository";

const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL;
const enabled = { skip: !databaseUrl };
const token = () => randomBytes(32).toString("base64url");
const workspaceInput = () => ({ kind: "local" as const, projectId: randomUUID(), entryId: "agent", localKey: randomUUID() });

async function fixture(t: TestContext) {
  const schema = `runtime_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const repository = new RuntimeStorageRepository(databaseUrl!, { schema });
  t.after(async () => { await repository.close(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); });
  await repository.init();
  return { repository, admin, schema };
}

test("runtime migrations serialize startup and reject edited applied migrations", enabled, async t => {
  const { repository, admin, schema } = await fixture(t);
  await Promise.all([repository.init(), repository.init()]);
  assert.equal((await admin.query(`select count(*) from ${schema}.schema_migrations`)).rows[0].count, "1");
  await admin.query(`update ${schema}.schema_migrations set checksum='changed'`);
  await assert.rejects(repository.init(), /checksum/);
  assert.equal((await admin.query(`select count(*) from ${schema}.workspaces`)).rows[0].count, "0");
});

test("runtime workspaces isolate accounts, entries and local folders without project databases", enabled, async t => {
  const { repository } = await fixture(t);
  const input = workspaceInput();
  const a = await repository.registerWorkspace("alice", input);
  assert.equal((await repository.registerWorkspace("alice", input)).id, a.id);
  const b = await repository.registerWorkspace("bob", input);
  const folder = await repository.registerWorkspace("alice", { ...input, localKey: "different-folder" });
  const entry = await repository.registerWorkspace("alice", { ...input, entryId: "another" });
  assert.equal(new Set([a.id, b.id, folder.id, entry.id]).size, 4);
  await assert.rejects(repository.getWorkspace("bob", a.id), isCode("RUNTIME_STORAGE_NOT_FOUND"));
});

test("ID allocation and commits survive response loss, reconnect and competing owners", enabled, async t => {
  const { repository, admin, schema } = await fixture(t);
  const space = await repository.registerWorkspace("alice", workspaceInput());
  const ownerToken = token();
  const lease = await repository.openSession("alice", space.id, "thread", ownerToken);
  const credentials = { ownerToken, fence: lease.fence };
  assert.equal((await repository.openSession("alice", space.id, "thread", ownerToken)).fence, lease.fence);
  await assert.rejects(repository.openSession("alice", space.id, "thread", token()), isCode("RUNTIME_STORAGE_OWNER_CONFLICT"));
  const operation: RuntimeStorageOperation = { kind: "mintId", requestId: randomUUID() };
  const id = await repository.operation("alice", lease.sessionId, credentials, operation);
  assert.equal(id, 2);
  assert.equal(await repository.operation("alice", lease.sessionId, credentials, operation), id);
  await assert.rejects(repository.operation("alice", lease.sessionId, credentials, { kind: "commit", requestId: operation.requestId, writes: [] }), isCode("RUNTIME_STORAGE_IDEMPOTENCY_CONFLICT"));
  const writes = [{ type: "conversation", value: { id: 1 } }, { type: "entry", value: { id, conversationId: 1, kind: "message", data: { text: "committed once" } } }] as AgentStorageWrite[];
  const commit: RuntimeStorageOperation = { kind: "commit", requestId: randomUUID(), writes };
  const seq = await repository.operation("alice", lease.sessionId, credentials, commit);
  assert.equal(await repository.operation("alice", lease.sessionId, credentials, commit), seq);
  assert.equal((await admin.query(`select count(*) from ${schema}.agent_entries`)).rows[0].count, "1");
  assert.notEqual((await admin.query(`select owner_token_hash from ${schema}.agent_sessions`)).rows[0].owner_token_hash, ownerToken);
  await repository.operation("alice", lease.sessionId, credentials, { kind: "release" });
  const reopened = new RuntimeStorageRepository(databaseUrl!, { schema });
  try {
    await reopened.init();
    const nextToken = token(), next = await reopened.openSession("alice", space.id, "thread", nextToken);
    assert.equal(next.sessionId, lease.sessionId); assert.ok(next.fence > lease.fence);
    const access = { ownerToken: nextToken, fence: next.fence };
    assert.equal(await reopened.operation("alice", next.sessionId, access, { kind: "mintId", requestId: randomUUID() }), 3);
    const entries = await reopened.operation("alice", next.sessionId, access, { kind: "entries", query: { conversationId: 1 as never }, limit: 10 }) as { items: unknown[] };
    assert.equal(entries.items.length, 1);
  } finally { await reopened.close(); }
});

test("expired owner leases can be reclaimed and every stale fence is rejected", enabled, async t => {
  const { repository, admin, schema } = await fixture(t);
  const space = await repository.registerWorkspace("alice", workspaceInput());
  const firstToken = token(), first = await repository.openSession("alice", space.id, "thread", firstToken);
  await admin.query(`update ${schema}.agent_sessions set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1`, [first.sessionId]);
  const secondToken = token(), second = await repository.openSession("alice", space.id, "thread", secondToken);
  assert.ok(second.fence > first.fence);
  for (const credentials of [{ ownerToken: firstToken, fence: first.fence }, { ownerToken: firstToken, fence: second.fence }, { ownerToken: secondToken, fence: first.fence }]) {
    await assert.rejects(repository.operation("alice", first.sessionId, credentials, { kind: "mintId", requestId: randomUUID() }), isCode("RUNTIME_STORAGE_LEASE_LOST"));
  }
  await assert.rejects(repository.operation("bob", second.sessionId, { ownerToken: secondToken, fence: second.fence }, { kind: "mintId", requestId: randomUUID() }), isCode("RUNTIME_STORAGE_NOT_FOUND"));
  const renewed = await repository.operation("alice", second.sessionId, { ownerToken: secondToken, fence: second.fence }, { kind: "renew" }) as { expiresAt: string };
  assert.ok(Date.parse(renewed.expiresAt) >= Date.parse(second.expiresAt));
});

test("concurrent acquisition selects one owner and duplicate reservations select one ID", enabled, async t => {
  const { repository } = await fixture(t);
  const space = await repository.registerWorkspace("alice", workspaceInput());
  const tokens = [token(), token()];
  const attempts = await Promise.allSettled(tokens.map(value => repository.openSession("alice", space.id, "race", value)));
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
  const index = attempts.findIndex(value => value.status === "fulfilled");
  const result = attempts[index]; assert.equal(result.status, "fulfilled");
  const lease = result.value;
  const credentials: RuntimeStorageCredentials = { ownerToken: tokens[index], fence: lease.fence };
  const operation: RuntimeStorageOperation = { kind: "mintId", requestId: randomUUID() };
  const ids = await Promise.all(Array.from({ length: 8 }, () => repository.operation("alice", lease.sessionId, credentials, operation)));
  assert.deepEqual(ids, Array(8).fill(2));
  assert.equal(await repository.operation("alice", lease.sessionId, credentials, { kind: "mintId", requestId: randomUUID() }), 3);
});

function isCode(code: RuntimeStorageError["code"]): (error: unknown) => boolean {
  return error => error instanceof RuntimeStorageError && error.code === code;
}
