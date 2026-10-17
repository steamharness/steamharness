import assert from "node:assert/strict";
import test from "node:test";

import { buildEcsEnv } from "../write-ecs-env.mjs";

const env = {
  WORKFLOW_SERVER_ADMIN_KEY: "admin-key", WORKFLOW_DATABASE_URL: "postgresql://old-host/workflow",
  WORKFLOW_POSTGRES_PASSWORD: "workflow password", WORKFLOW_POSTGRES_USER: "workflow", WORKFLOW_POSTGRES_DB: "workflow",
  WORKFLOW_RELEASE_STORAGE_ROOT: "/old/root",
};

test("ECS compose env requires secrets and fixes the remote storage root", () => {
  const output = buildEcsEnv({ kind: "compose", env });
  assert.match(output, /WORKFLOW_RELEASE_STORAGE_ROOT=\/srv\/workflow-release\n/u);
  assert.match(output, /WORKFLOW_POSTGRES_PASSWORD/iu);
});

test("ECS runtime env uses the private ECS PostgreSQL endpoint and channel isolation", () => {
  const output = buildEcsEnv({ kind: "alpha", env });
  assert.match(output, /WORKFLOW_DATABASE_URL=postgresql:\/\/workflow:workflow%20password@127\.0\.0\.1:7125\/workflow\n/u);
  assert.match(output, /WORKFLOW_RELEASE_CHANNEL=alpha\n/u);
  assert.match(output, /WORKFLOW_SERVER_PORT=7140\n/u);
  assert.doesNotMatch(output, /WORKFLOW_SCHEDULE_POLLING_ENABLED/u);
});

test("ECS runtime env carries the object-storage root and no provider settings", () => {
  // The Server keeps objects on its own disk, so the runtime env must carry the
  // storage root but no provider credentials or endpoints for a backend it does
  // not implement.
  const output = buildEcsEnv({
    kind: "alpha",
    env: {
      ...env,
      WORKFLOW_LOCAL_STORAGE_ROOT: "/srv/workflow-release/object-storage",
      WORKFLOW_OSS_ENDPOINT: "oss-cn-beijing-internal.aliyuncs.com",
      WORKFLOW_OSS_ACCESS_KEY_ID: "should-not-be-forwarded",
    },
  });
  assert.match(output, /WORKFLOW_LOCAL_STORAGE_ROOT=\/srv\/workflow-release\/object-storage\n/u);
  assert.doesNotMatch(output, /WORKFLOW_OSS_/u);
  assert.doesNotMatch(output, /should-not-be-forwarded/u);
  assert.doesNotMatch(output, /WORKFLOW_STORAGE_PUBLIC_BASE_URL/u);
});
