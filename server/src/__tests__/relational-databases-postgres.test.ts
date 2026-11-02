import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { DatabaseMigration } from "steamharness/database";
import { RelationalDatabaseRepository } from "../relational-databases/repository";
import { databaseNames } from "../relational-databases/cluster";
import { hash, modelHash } from "../relational-databases/schema";

const databaseUrl = process.env.STEAMHARNESS_TEST_RELATIONAL_DATABASE_URL;
const userSchema = 'model User {\n id String @id\n email String @unique\n}\n';
const logSchema = 'enum EventKind {\n LOGIN\n LOGOUT\n}\nmodel User {\n id Int @id @default(autoincrement())\n event EventKind @default(LOGIN)\n entries Entry[]\n}\nmodel Entry {\n id Int @id @default(autoincrement())\n userId Int\n user User @relation(fields: [userId], references: [id])\n label String\n @@unique([userId, label])\n}\n';
const migration = (schema: string, sql: string, name = "20261102000000000_init"): DatabaseMigration =>
  ({ name, schema, sql, schemaHash: modelHash(schema), checksum: hash(sql) });

test("independent PostgreSQL resources support provisioning, account grants and durable migrations", { skip: !databaseUrl, timeout: 180_000 }, async t => {
  const catalog = `relational_test_${randomUUID().replaceAll("-", "")}`;
  let repository = new RelationalDatabaseRepository(databaseUrl!, { adminConnectionString: databaseUrl!, schema: catalog });
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const identities: string[] = [];
  t.after(async () => {
    await repository.close();
    for (const id of identities) {
      const names = databaseNames(id);
      const roles = await admin.query("select rolname from pg_roles where rolname like 'shc_%'");
      for (const row of roles.rows) {
        await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where usename=$1", [row.rolname]);
        await admin.query(`drop role if exists "${row.rolname}"`);
      }
      await admin.query(`drop database if exists "${names.database}" with (force)`);
      for (const role of [names.owner, names.write, names.read]) await admin.query(`drop role if exists "${role}"`);
    }
    await admin.query(`drop schema if exists "${catalog}" cascade`); await admin.end();
  });
  await repository.init();
  const create = async (owner: string, name: string) => {
    const resource = await repository.create(owner, { name, requestId: randomUUID() });
    identities.push(resource.id); assert.equal(resource.status, "ready", resource.failureCode ?? undefined); return resource;
  };
  let a: Awaited<ReturnType<typeof create>>, b: Awaited<ReturnType<typeof create>>;
  let first: DatabaseMigration;

  await t.test("records failures and retries the same request without duplicating a physical resource", async () => {
    const original = repository.cluster.database.bind(repository.cluster);
    repository.cluster.database = async () => { throw new Error("simulated database provisioning interruption"); };
    const input = { name: "retry", requestId: randomUUID() };
    const failed = await repository.create("owner", input); identities.push(failed.id);
    repository.cluster.database = original;
    assert.equal(failed.status, "failed"); assert.equal(failed.stage, "database");
    assert.equal(failed.failureCode, "DATABASE_PROVISION_FAILED");
    assert.equal((await repository.retry("owner", failed.id)).status, "ready");
    assert.equal((await repository.create("owner", input)).id, failed.id);
    await assert.rejects(repository.create("owner", { ...input, name: "different" }), { code: "DATABASE_HISTORY_CONFLICT" });
    a = await create("owner", "Project A"); b = await create("owner-b", "Project B");
    assert.notEqual(a.id, b.id);
    await assert.rejects(repository.get("stranger", a.id), { code: "DATABASE_NOT_FOUND" });
  });
  await t.test("migrates different User models into different databases and verifies schema history", async () => {
    const plan = await repository.plan("owner", a.id, { schema: userSchema, migrations: [] });
    assert.ok(plan.sql?.includes('"User"')); assert.equal(plan.destructive, false);
    first = migration(userSchema, plan.sql!);
    const input = { migrations: [first], schemaHash: first.schemaHash };
    const history = await repository.deploy("owner", a.id, input);
    assert.equal(history.length, 1); assert.deepEqual(await repository.deploy("owner", a.id, input), history);
    assert.equal((await repository.plan("owner", a.id, { schema: userSchema, migrations: [first] })).sql, null);
    const planB = await repository.plan("owner-b", b.id, { schema: logSchema, migrations: [] });
    assert.equal(planB.destructive, false, "foreign key clauses do not make table creation destructive");
    const initialB = migration(logSchema, planB.sql!);
    await repository.deploy("owner-b", b.id, { migrations: [initialB], schemaHash: initialB.schemaHash });
    const reducedEnum = logSchema.replace(" LOGOUT\n", "");
    const enumPlan = await repository.plan("owner-b", b.id, { schema: reducedEnum, migrations: [initialB] });
    const enumMigration = migration(reducedEnum, enumPlan.sql!, "20261102000000001_enum");
    assert.equal(enumPlan.destructive, true);
    await repository.deploy("owner-b", b.id, { migrations: [initialB, enumMigration], schemaHash: enumMigration.schemaHash, acceptDataLoss: true });
    for (const [id, expected] of [[a.id, ["id", "email"]], [b.id, ["id", "event"]]] as const) {
      await repository.cluster.withAdminDatabase(databaseNames(id).database, async client => {
        const fields = await client.query("select column_name from information_schema.columns where table_schema='public' and table_name='User' order by ordinal_position");
        assert.deepEqual(fields.rows.map(row => row.column_name), expected);
      });
    }
    const edited = migration(userSchema, first.sql + "\n-- edited history");
    await assert.rejects(repository.deploy("owner", a.id, { migrations: [edited], schemaHash: edited.schemaHash }), { code: "DATABASE_HISTORY_CONFLICT" });
    await assert.rejects(repository.plan("owner", a.id, { schema: userSchema, migrations: [] }), { code: "DATABASE_HISTORY_CONFLICT" });
  });
  await t.test("read/write grants enforce SQL isolation and terminate existing connections when revoked", async () => {
    await repository.grant("owner", a.id, "reader", "read");
    const credential = await repository.issueCredentials("reader", a.id, { expectedSchemaHash: first.schemaHash });
    assert.equal(credential.mode, "read");
    const reader = new pg.Client({ connectionString: credential.connectionString }); reader.on("error", () => undefined);
    await reader.connect();
    try {
      assert.equal((await reader.query('SELECT * FROM "User"')).rowCount, 0);
      await assert.rejects(reader.query('INSERT INTO "User" VALUES(\'x\',\'x@example.test\')'), { code: "42501" });
      await assert.rejects(reader.query('CREATE TABLE "Intrusion"(id INT)'), { code: "42501" });
      await assert.rejects(reader.query('SELECT * FROM steamharness_migrations.history'), { code: "42501" });
      const destination = new URL(credential.connectionString); destination.pathname = `/${databaseNames(b.id).database}`;
      const cross = new pg.Client({ connectionString: destination.toString() });
      try { await assert.rejects(cross.connect(), { code: "42501" }); } finally { await cross.end(); }
      await assert.rejects(repository.issueCredentials("reader", a.id, { mode: "write" }), { code: "DATABASE_ACCESS_DENIED" });
      await assert.rejects(repository.plan("reader", a.id, { schema: userSchema, migrations: [first] }), { code: "DATABASE_ACCESS_DENIED" });
      await repository.revoke("owner", a.id, "reader");
      await assert.rejects(reader.query('SELECT * FROM "User"'));
      await assert.rejects(repository.issueCredentials("reader", a.id), { code: "DATABASE_NOT_FOUND" });
    } finally { await reader.end(); }
    await repository.grant("owner", a.id, "writer", "write");
    const writable = await repository.issueCredentials("writer", a.id);
    const writer = new pg.Client({ connectionString: writable.connectionString }); writer.on("error", () => undefined);
    await writer.connect();
    try {
      await writer.query('INSERT INTO "User" VALUES(\'one\',\'one@example.test\')');
      await repository.grant("owner", a.id, "writer", "read");
      await assert.rejects(writer.query('SELECT * FROM "User"'));
    } finally { await writer.end(); }
    await assert.rejects(repository.issueCredentials("owner", a.id, { expectedSchemaHash: "0".repeat(64) }), { code: "DATABASE_SCHEMA_MISMATCH" });
  });
  await t.test("management locks span connections and unsafe PUBLIC access prevents credential issuance", async () => {
    const client = await admin.connect(), key = `steamharness:database:"${catalog}":${a.id}`;
    try {
      await client.query("select pg_advisory_lock(hashtextextended($1,0))", [key]);
      await assert.rejects(repository.issueCredentials("owner", a.id), { code: "DATABASE_BUSY" });
    } finally { await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]); client.release(); }
    const unmanaged = `unmanaged_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${unmanaged}" template template0`);
    try {
      await assert.rejects(repository.issueCredentials("owner", a.id), { code: "DATABASE_UNSAFE_CLUSTER" });
      assert.equal((await admin.query(`select count(*)::int as count from "${catalog}".credentials where user_id='owner'`)).rows[0].count, 0);
    } finally { await admin.query(`drop database "${unmanaged}"`); }
  });
  await t.test("validates intermediate migration snapshots before changing the business database", async () => {
    const c = await create("owner", "Invalid history");
    const planB = await repository.plan("owner", c.id, { schema: logSchema, migrations: [] });
    const invalidFirst = migration(userSchema, planB.sql!);
    const misleadingLast = migration(logSchema, "", "20261102000000001_followup");
    await assert.rejects(repository.deploy("owner", c.id, { migrations: [invalidFirst, misleadingLast], schemaHash: misleadingLast.schemaHash }), { code: "DATABASE_SCHEMA_DRIFT" });
    assert.equal((await repository.get("owner", c.id)).schemaHash, null);
    assert.equal((await repository.history("owner", c.id)).length, 0);
  });
  await t.test("detects live drift, rolls back failed DDL, and resumes the same migration", async () => {
    const database = databaseNames(a.id).database;
    await repository.cluster.withAdminDatabase(database, client => client.query('ALTER TABLE "User" ADD COLUMN intrusion TEXT'));
    await assert.rejects(repository.plan("owner", a.id, { schema: userSchema, migrations: [first] }), { code: "DATABASE_SCHEMA_DRIFT" });
    await repository.cluster.withAdminDatabase(database, client => client.query('ALTER TABLE "User" DROP COLUMN intrusion'));
    const nextSchema = userSchema.replace(" email String @unique", " email String @unique\n required String");
    const plan = await repository.plan("owner", a.id, { schema: nextSchema, migrations: [first] });
    const next = migration(nextSchema, plan.sql!, "20261102000000001_required");
    const input = { migrations: [first, next], schemaHash: next.schemaHash };
    await assert.rejects(repository.deploy("owner", a.id, input), { code: "DATABASE_MIGRATION_FAILED" });
    assert.equal((await repository.get("owner", a.id)).migrationStatus, "failed");
    assert.equal((await repository.history("owner", a.id)).length, 1);
    await assert.rejects(repository.issueCredentials("owner", a.id), { code: "DATABASE_BUSY" });
    await repository.cluster.withAdminDatabase(database, async client => {
      assert.equal((await client.query('SELECT email FROM "User"')).rows[0].email, "one@example.test");
      await client.query('DELETE FROM "User"');
    });
    assert.equal((await repository.deploy("owner", a.id, input)).length, 2);
    assert.equal((await repository.get("owner", a.id)).migrationStatus, "idle");
    // Planning can stop before any deploy status is recorded. Its shadow must
    // be cleaned on restart even though the resource is still idle.
    const abandoned = databaseNames(b.id);
    await admin.query(`create role "${abandoned.shadowOwner}" nologin`);
    await admin.query(`create database "${abandoned.shadow}" owner "${abandoned.shadowOwner}" template template0`);
    // Simulate a crash after the business commit and before catalog acknowledgement.
    await admin.query(`update "${catalog}".resources set migration_status='running' where id=$1`, [a.id]);
    await repository.close();
    repository = new RelationalDatabaseRepository(databaseUrl!, { adminConnectionString: databaseUrl!, schema: catalog });
    await repository.init();
    assert.equal((await repository.get("owner", a.id)).migrationStatus, "failed");
    assert.equal((await repository.deploy("owner", a.id, input)).length, 2);
    assert.equal((await repository.get("owner", a.id)).migrationStatus, "idle");
    const reduced = 'model User {\n id String @id\n required String\n}\n';
    const destructive = await repository.plan("owner", a.id, { schema: reduced, migrations: [first, next] });
    assert.equal(destructive.destructive, true);
    const drop = migration(reduced, destructive.sql!, "20261102000000002_drop");
    const dropInput = { migrations: [first, next, drop], schemaHash: drop.schemaHash };
    await assert.rejects(repository.deploy("owner", a.id, dropInput), { code: "DATABASE_DESTRUCTIVE_MIGRATION" });
    assert.equal((await repository.deploy("owner", a.id, { ...dropInput, acceptDataLoss: true })).length, 3);
    assert.equal((await admin.query("select count(*)::int as count from pg_database where datname like 'shshadow_%'")).rows[0].count, 0);
  });
});
