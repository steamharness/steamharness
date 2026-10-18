import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  composeArgs,
  createDockerRecoveryServices,
  resolveDockerSocketLocation,
  validateRecoveryEnvironment,
} from "../recover-services.mjs";
import { parseStableReleaseMetadata, resolveStableRecoveryPaths } from "../recover-stable.mjs";

test("Docker recovery preserves the established Compose project names", () => {
  const services = createDockerRecoveryServices("/srv/server");
  assert.deepEqual(services.map((service) => service.projectName), [
    "steamharness-postgres",
  ]);
  assert.deepEqual(composeArgs(services[0], "up", "--detach").slice(-2), ["up", "--detach"]);
});

test("Docker recovery uses the daemon socket unless explicitly configured", () => {
  assert.equal(resolveDockerSocketLocation({}), "/var/run/docker.sock");
  assert.equal(resolveDockerSocketLocation({
    DOCKER_HOST: "unix:///Users/runner/.docker/run/docker.sock",
  }), "/var/run/docker.sock");

  const configuredSocket = resolveDockerSocketLocation({
    DOCKER_SOCKET_LOCATION: " /custom/docker.sock ",
  });
  assert.equal(configuredSocket, "/custom/docker.sock");
});

test("Docker recovery validates the persistent release root without a local download service", () => {
  const env = validateRecoveryEnvironment({
    STEAMHARNESS_SERVER_ADMIN_KEY: "x",
    STEAMHARNESS_AUTH_COOKIE_SECRET: "x",
    STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
    STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD: "x",
    STEAMHARNESS_DATABASE_URL: "postgres://example",
    STEAMHARNESS_POSTGRES_PASSWORD: "x",
    STEAMHARNESS_LOCAL_STORAGE_ROOT: "/srv/workflow-release/object-storage",
    STEAMHARNESS_API_PUBLIC_BASE_URL: "https://api.steamharness.example.com",
    STEAMHARNESS_RELEASE_STORAGE_ROOT: "/srv/workflow-release",
  });
  assert.equal(env.STEAMHARNESS_RELEASE_STORAGE_ROOT, "/srv/workflow-release");
  assert.equal(env.STEAMHARNESS_DOWNLOAD_ROOT, undefined);
});

test("stable recovery accepts only recorded stable Server releases", () => {
  assert.deepEqual(parseStableReleaseMetadata({
    unit: "server",
    channel: "stable",
    tag: "server/v0.1.4",
    version: "0.1.4",
  }), { tag: "server/v0.1.4", version: "0.1.4" });
  assert.throws(() => parseStableReleaseMetadata({ unit: "server", channel: "stable", tag: "server/v0.1.4", version: "0.1.5" }));
  assert.deepEqual(parseStableReleaseMetadata({
    unit: "server",
    channel: "stable",
    tag: "server/v0.1.4",
    version: "0.1.4",
    deploymentId: "server-0.1.4__web-0.1.4__abcdef123456",
  }), {
    tag: "server/v0.1.4",
    version: "0.1.4",
    deploymentId: "server-0.1.4__web-0.1.4__abcdef123456",
  });
  assert.throws(() => parseStableReleaseMetadata({
    unit: "server",
    channel: "stable",
    tag: "server/v0.1.4",
    version: "0.1.4",
    deploymentId: "../outside",
  }), /invalid deployment id/u);
  assert.equal(resolveStableRecoveryPaths("/srv/workflow-release").currentLink, "/srv/workflow-release/deployments/server/stable/current");
});
