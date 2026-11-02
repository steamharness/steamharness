import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabase, defineDatabases, parseDatabaseDefinitions, DatabaseDefinitionError } from "../database/index";

test("database definitions retain independent aliases even when they share a schema", () => {
  const defined = defineDatabases({ main: { schema: "./database/main/steamharness.schema" }, audit: { schema: "./database/audit/steamharness.schema" }, archive: { schema: "./database/main/steamharness.schema" } });
  assert.deepEqual(Object.keys(defined.databases), ["main", "audit", "archive"]);
  assert.deepEqual(parseDatabaseDefinitions(defined), defined);
  assert.equal(defineDatabase({ schema: "steamharness.schema" }).databases.main.schema, "steamharness.schema");
  assert.ok(Object.isFrozen(defined));
  assert.ok(Object.isFrozen(defined.databases.main));
});

test("definitions reject host bindings, invalid aliases and non-portable schema paths", () => {
  for (const value of [{}, [], { default: { schema: "steamharness.schema" } }, { Main: { schema: "steamharness.schema" } }, { databases: { schema: "steamharness.schema" } },
    { main: { schema: "../steamharness.schema" } }, { main: { schema: "C:/steamharness.schema" } }, { main: { schema: "database\\steamharness.schema" } },
    { main: { schema: "/steamharness.schema" } }, { main: { schema: "schema.prisma" } },
    { main: { schema: "steamharness.schema", databaseId: "host-owned" } }, { main: { schema: "steamharness.schema", url: "unused" } }]) {
    assert.throws(() => defineDatabases(value as never), DatabaseDefinitionError);
  }
  assert.throws(() => parseDatabaseDefinitions({ main: { schema: "steamharness.schema" } }), DatabaseDefinitionError);
  assert.throws(() => parseDatabaseDefinitions({ ...defineDatabase({ schema: "steamharness.schema" }), url: "unused" }), DatabaseDefinitionError);
});
