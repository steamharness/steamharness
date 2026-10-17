import assert from "node:assert/strict";
import test from "node:test";
import {
  findUnsafeEnvironmentPaths,
  findUnsafeExampleAssignments,
  findUnsafeHistoricalExampleAssignments,
  isExampleEnvironmentFile,
} from "../check-secret-files.mjs";
import {
  findMissingProductionEnv,
  REQUIRED_PRODUCTION_ENV,
} from "../check-production-env.mjs";

test("secret file audit rejects current and historical env files", () => {
  assert.deepEqual(findUnsafeEnvironmentPaths({
    tracked: [".env.example"],
    untracked: ["docker/postgres/.env.local"],
    historical: [".env.production"],
  }), [".env.production", "docker/postgres/.env.local"]);
  assert.equal(isExampleEnvironmentFile("docker\\postgres\\.env.production.example"), true);
});

test("secret file audit scans deleted examples in reachable history", async () => {
  const findings = await findUnsafeHistoricalExampleAssignments([
    { objectId: "unsafe", filePath: "docker/postgres/.env.example" },
    { objectId: "ignored", filePath: "README.md" },
  ], async () => "JWT_SECRET=live-secret-value\n");
  assert.deepEqual(findings, [{
    filePath: "docker/postgres/.env.example",
    line: 1,
    name: "JWT_SECRET",
  }]);
});

test("secret examples accept placeholders and reject live-looking values", () => {
  assert.deepEqual(findUnsafeExampleAssignments([
    "WORKFLOW_DATABASE_URL=postgresql://user:replace-with-password@localhost/db",
    "JWT_SECRET=change_me_with_openssl_rand_hex_32",
    "WORKFLOW_SERVER_PORT=7130",
  ].join("\n")), []);
  assert.deepEqual(findUnsafeExampleAssignments("WORKFLOW_AUTH_COOKIE_SECRET=live-cookie-secret\n"), [
    { line: 1, name: "WORKFLOW_AUTH_COOKIE_SECRET" },
  ]);
});

test("production env validation reports names without exposing values", () => {
  const env = Object.fromEntries(REQUIRED_PRODUCTION_ENV.map((name) => [name, `${name}-value`]));
  delete env.WORKFLOW_DATABASE_URL;
  env.WORKFLOW_AUTH_COOKIE_SECRET = " ";
  assert.deepEqual(findMissingProductionEnv(env), [
    "WORKFLOW_AUTH_COOKIE_SECRET",
    "WORKFLOW_DATABASE_URL",
  ]);
});

test("production env validation requires credentials and nothing else", () => {
  const env = Object.fromEntries(REQUIRED_PRODUCTION_ENV.map((name) => [name, `${name}-value`]));
  assert.deepEqual(findMissingProductionEnv(env), []);

  // A missing value is reported by name, and object-storage provider settings
  // are not part of the required set at all.
  assert.deepEqual(findMissingProductionEnv({ ...env, WORKFLOW_DATABASE_URL: "  " }), ["WORKFLOW_DATABASE_URL"]);
  assert.deepEqual(findMissingProductionEnv(env), []);
  assert.ok(!REQUIRED_PRODUCTION_ENV.some((name) => name.startsWith("WORKFLOW_OSS_")));
});
