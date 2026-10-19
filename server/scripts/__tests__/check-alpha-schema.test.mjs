import assert from "node:assert/strict";
import test from "node:test";
import { findDestructiveSchemaChanges } from "../check-alpha-schema.mjs";

test("alpha schema gate permits expand changes and rejects destructive DDL", () => {
  assert.deepEqual(findDestructiveSchemaChanges(`diff --git a/src/persistence.ts b/src/persistence.ts
+++ b/src/persistence.ts
+alter table workflows add column if not exists alpha_note text;
+create table if not exists alpha_events (id text primary key);`), []);
  assert.ok(findDestructiveSchemaChanges(`diff --git a/src/persistence.ts b/src/persistence.ts
+++ b/src/persistence.ts
+alter table workflows drop column legacy_value;`).length > 0);
  assert.ok(findDestructiveSchemaChanges(`diff --git a/src/account-db.ts b/src/account-db.ts
+++ b/src/account-db.ts
+alter table project_users alter column email set not null;`).length > 0);
  assert.ok(findDestructiveSchemaChanges(`diff --git a/src/account-db.ts b/src/account-db.ts
--- a/src/account-db.ts
+++ b/src/account-db.ts
 alter table project_users
+alter column email set not null;`).length > 0);
});
