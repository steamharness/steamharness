import assert from "node:assert/strict";
import test from "node:test";

import { buildEcsEnv } from "../write-ecs-env.mjs";

const env = {
  STEAMHARNESS_SERVER_ADMIN_KEY: "admin-key", STEAMHARNESS_DATABASE_URL: "postgresql://old-host/steamharness",
  STEAMHARNESS_POSTGRES_PASSWORD: "steamharness password", STEAMHARNESS_POSTGRES_USER: "steamharness", STEAMHARNESS_POSTGRES_DB: "steamharness",
  STEAMHARNESS_RELEASE_STORAGE_ROOT: "/old/root",
};

test("ECS compose env requires secrets and fixes the remote storage root", () => {
  const output = buildEcsEnv({ kind: "compose", env });
  assert.match(output, /STEAMHARNESS_RELEASE_STORAGE_ROOT=\/srv\/steamharness-release\n/u);
  assert.match(output, /STEAMHARNESS_POSTGRES_PASSWORD/iu);
});

test("ECS runtime env uses the private ECS PostgreSQL endpoint and channel isolation", () => {
  const output = buildEcsEnv({ kind: "alpha", env });
  assert.match(output, /STEAMHARNESS_DATABASE_URL=postgresql:\/\/steamharness:steamharness%20password@127\.0\.0\.1:7125\/steamharness\n/u);
  assert.match(output, /STEAMHARNESS_RELEASE_CHANNEL=alpha\n/u);
  assert.match(output, /STEAMHARNESS_SERVER_PORT=7140\n/u);
  assert.doesNotMatch(output, /STEAMHARNESS_SCHEDULE_POLLING_ENABLED/u);
});

test("ECS runtime env carries the object-storage root and no provider settings", () => {
  // The Server keeps objects on its own disk, so the runtime env must carry the
  // storage root but no provider credentials or endpoints for a backend it does
  // not implement.
  const output = buildEcsEnv({
    kind: "alpha",
    env: {
      ...env,
      STEAMHARNESS_LOCAL_STORAGE_ROOT: "/srv/steamharness-release/object-storage",
      STEAMHARNESS_OSS_ENDPOINT: "oss-cn-beijing-internal.aliyuncs.com",
      STEAMHARNESS_OSS_ACCESS_KEY_ID: "should-not-be-forwarded",
    },
  });
  assert.match(output, /STEAMHARNESS_LOCAL_STORAGE_ROOT=\/srv\/steamharness-release\/object-storage\n/u);
  assert.doesNotMatch(output, /STEAMHARNESS_OSS_/u);
  assert.doesNotMatch(output, /should-not-be-forwarded/u);
  assert.doesNotMatch(output, /STEAMHARNESS_STORAGE_PUBLIC_BASE_URL/u);
});
