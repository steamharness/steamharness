import assert from "node:assert/strict";
import test from "node:test";
import { checkMigrationSql, destructiveMigration, hash, modelHash, modelSchema, validateMigrationHistory } from "../relational-databases/schema";

test("model migrations reject connection blocks, transaction control and history edits", () => {
  for (const source of ['datasource db { provider = "postgresql" }', 'generator client { provider = "x" }']) {
    assert.throws(() => modelSchema(source), { code: "DATABASE_SCHEMA_INVALID" });
  }
  assert.match(modelSchema('// datasource ignored {}\nmodel User {\n id String @id\n}'), /provider = "postgresql"/);
  checkMigrationSql(`/* outer /* nested */ */ CREATE TABLE "User" ("id" TEXT, "note" TEXT DEFAULT '; COMMIT');
    CREATE UNIQUE INDEX "User_id" ON "User"("id"); INSERT INTO "User" VALUES ('1', 'x');`);
  for (const sql of ['BEGIN; CREATE TABLE x(id int); COMMIT;', 'SET ROLE postgres;', 'CREATE EXTENSION dblink;',
    'COPY x FROM PROGRAM \'whoami\';', 'DO $$ BEGIN END $$;', 'DROP DATABASE x;', 'GRANT ALL ON x TO public;',
    'DELETE FROM "steamharness_migrations".history;', 'ALTER TABLE steamharness_migrations.history ADD COLUMN x int;',
    '/* unterminated', "INSERT INTO x VALUES ('unterminated)"]) {
    assert.throws(() => checkMigrationSql(sql), { code: "DATABASE_INVALID_REQUEST" }, sql);
  }
});

test("migration fingerprints bind SQL, models and an ordered immutable history", () => {
  const schema = "model User {\n id String @id\n}\n";
  const sql = 'CREATE TABLE "User" ("id" TEXT PRIMARY KEY);';
  const migration = { name: "20261102000000000_init", schema, schemaHash: modelHash(schema), sql, checksum: hash(sql) };
  validateMigrationHistory([migration]);
  assert.equal(modelHash(schema), modelHash(schema.replaceAll("\n", "\r\n")));
  for (const history of [[{ ...migration, sql: sql + "-- changed" }], [{ ...migration, schema: schema + "// changed" }],
    [migration, migration], [{ ...migration, name: "../init" }]]) {
    assert.throws(() => validateMigrationHistory(history), { code: "DATABASE_HISTORY_CONFLICT" });
  }
  assert.equal(destructiveMigration(sql), false);
  assert.equal(destructiveMigration('ALTER TABLE "User" DROP COLUMN "email";'), true);
  assert.equal(destructiveMigration('ALTER TABLE "User" ALTER COLUMN "id" SET NOT NULL;'), true);
  assert.equal(destructiveMigration('INSERT INTO "User" VALUES (\'drop table x\'); -- DROP'), false);
  assert.equal(destructiveMigration('ALTER TABLE "Entry" ADD CONSTRAINT "Entry_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;'), false);
  assert.equal(destructiveMigration('UPDATE "User" SET "id" = \'changed\''), true);
});
