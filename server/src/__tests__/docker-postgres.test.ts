import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("PostgreSQL Compose uses PostgreSQL 15 and exposes only the loopback port", async () => {
  const compose = await readFile(
    path.resolve(import.meta.dirname, "../../docker/postgres/docker-compose.yml"),
    "utf8",
  );

  assert.match(compose, /image: postgres:15-alpine/u);
  assert.match(compose, /"127\.0\.0\.1:7125:5432"/u);
  assert.match(compose, /pg_isready/u);
  assert.doesNotMatch(compose, /0\.0\.0\.0:7125/u);
});

test("production PostgreSQL data is bound under the release storage root", async () => {
  const compose = await readFile(
    path.resolve(import.meta.dirname, "../../docker/postgres/docker-compose.release.yml"),
    "utf8",
  );

  assert.match(compose, /WORKFLOW_RELEASE_STORAGE_ROOT[^\n]*\/postgres-data/u);
  assert.match(compose, /target: \/var\/lib\/postgresql\/data/u);
});
