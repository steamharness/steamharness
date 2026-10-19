import assert from "node:assert/strict";
import test from "node:test";
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStorage } from "../local-storage";
import {
  normalizeStorageBaseUrl,
  resolveLocalStoragePublicBaseUrl,
  resolveLocalStorageRootFromEnv,
  resolveStorageAvatarBaseUrlOrigin,
  resolveWorkflowStorageDriver,
} from "../storage-driver";
import { createWorkflowObjectStorageFromEnv } from "../storage";

const DATA_ROOT = path.join(os.tmpdir(), "workflow-storage-driver-data");

function withSilencedWarnings<T>(run: () => T): T {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    return run();
  } finally {
    console.warn = original;
  }
}

test("storage driver defaults to local and rejects unknown values", () => {
  assert.equal(resolveWorkflowStorageDriver({}), "local");
  assert.equal(resolveWorkflowStorageDriver({ STEAMHARNESS_STORAGE_DRIVER: "" }), "local");
  // Case and surrounding whitespace are tolerated.
  assert.equal(resolveWorkflowStorageDriver({ STEAMHARNESS_STORAGE_DRIVER: "local" }), "local");
  assert.equal(resolveWorkflowStorageDriver({ STEAMHARNESS_STORAGE_DRIVER: " LOCAL " }), "local");
  assert.equal(resolveWorkflowStorageDriver({ STEAMHARNESS_STORAGE_DRIVER: "Local" }), "local");

  // A backend this build does not implement must fail closed rather than
  // silently storing objects somewhere the environment did not name.
  assert.throws(() => resolveWorkflowStorageDriver({ STEAMHARNESS_STORAGE_DRIVER: "oss" }), /must be "local"/u);
  assert.throws(() => resolveWorkflowStorageDriver({ STEAMHARNESS_STORAGE_DRIVER: "s3" }), /must be "local"/u);
  assert.throws(() => resolveWorkflowStorageDriver({ STEAMHARNESS_STORAGE_DRIVER: "false" }), /must be "local"/u);
});

test("object storage selection always wires the local driver", async () => {
  const root = path.join(DATA_ROOT, "selection");

  // A checkout with no storage configuration at all still gets a usable backend.
  const defaulted = withSilencedWarnings(() => createWorkflowObjectStorageFromEnv({
    dataRoot: root,
    env: { STEAMHARNESS_SERVER_DEV: "1" },
  }));
  assert.ok(defaulted instanceof LocalStorage);

  const local = withSilencedWarnings(() => createWorkflowObjectStorageFromEnv({
    dataRoot: root,
    env: { STEAMHARNESS_STORAGE_DRIVER: "local", STEAMHARNESS_SERVER_DEV: "1" },
  }));
  assert.ok(local instanceof LocalStorage);
  assert.equal(local.driver, "local");
  assert.equal(local.publicBaseUrl, "http://127.0.0.1:7126/");
  // The factory creates the root eagerly so an unusable path fails at startup.
  assert.equal((await stat(local.root)).isDirectory(), true);

  await rm(root, { recursive: true, force: true });
});

test("local storage root defaults under the data root and rejects relative overrides", () => {
  assert.equal(
    resolveLocalStorageRootFromEnv({ env: {}, dataRoot: DATA_ROOT }),
    path.join(DATA_ROOT, "object-storage"),
  );
  assert.equal(
    resolveLocalStorageRootFromEnv({
      env: { STEAMHARNESS_LOCAL_STORAGE_ROOT: path.join(DATA_ROOT, "custom") },
      dataRoot: DATA_ROOT,
    }),
    path.join(DATA_ROOT, "custom"),
  );
  assert.throws(
    () => resolveLocalStorageRootFromEnv({
      env: { STEAMHARNESS_LOCAL_STORAGE_ROOT: "relative/objects" },
      dataRoot: DATA_ROOT,
    }),
    /must be an absolute path/u,
  );
});

test("local public base URL prefers the API origin and falls back only in development", () => {
  assert.equal(
    resolveLocalStoragePublicBaseUrl({ STEAMHARNESS_API_PUBLIC_BASE_URL: "https://api.example.com" }),
    "https://api.example.com/",
  );
  assert.equal(
    resolveLocalStoragePublicBaseUrl({ STEAMHARNESS_PUBLIC_BASE_URL: "http://localhost:8080" }),
    "http://localhost:8080/",
  );
  // Precedence: the API origin wins over the storage-specific one.
  assert.equal(
    resolveLocalStoragePublicBaseUrl({
      STEAMHARNESS_API_PUBLIC_BASE_URL: "https://api.example.com",
      STEAMHARNESS_STORAGE_PUBLIC_BASE_URL: "https://cdn.example.com",
    }),
    "https://api.example.com/",
  );
  assert.throws(
    () => resolveLocalStoragePublicBaseUrl({ STEAMHARNESS_API_PUBLIC_BASE_URL: "https://api.example.com/sub" }),
    /HTTP\(S\) root URL/u,
  );

  // Development falls back to loopback so a dev server is usable out of the box.
  assert.equal(
    withSilencedWarnings(() => resolveLocalStoragePublicBaseUrl({ STEAMHARNESS_SERVER_DEV: "1" })),
    "http://127.0.0.1:7126/",
  );
  assert.equal(
    withSilencedWarnings(() => resolveLocalStoragePublicBaseUrl({
      STEAMHARNESS_SERVER_DEV: "1",
      STEAMHARNESS_SERVER_PORT: "7200",
    })),
    "http://127.0.0.1:7200/",
  );

  // Production must not hand users an unreachable URL.
  assert.throws(() => resolveLocalStoragePublicBaseUrl({}), /STEAMHARNESS_API_PUBLIC_BASE_URL is required/u);
});

test("avatar origin follows the configured public base URL", () => {
  assert.equal(
    resolveStorageAvatarBaseUrlOrigin({ STEAMHARNESS_STORAGE_PUBLIC_BASE_URL: "https://cdn.example.com" }),
    "https://cdn.example.com",
  );
  assert.equal(
    withSilencedWarnings(() => resolveStorageAvatarBaseUrlOrigin({
      STEAMHARNESS_STORAGE_DRIVER: "local",
      STEAMHARNESS_SERVER_DEV: "1",
    })),
    "http://127.0.0.1:7126",
  );
  assert.equal(
    resolveStorageAvatarBaseUrlOrigin({
      STEAMHARNESS_STORAGE_DRIVER: "local",
      STEAMHARNESS_API_PUBLIC_BASE_URL: "https://api.example.com",
    }),
    "https://api.example.com",
  );
});

test("storage base URL validation accepts a loopback origin and rejects anything else", () => {
  assert.equal(
    normalizeStorageBaseUrl("https://cdn.example.com", { envName: "TEST_URL" }),
    "https://cdn.example.com/",
  );
  assert.equal(
    normalizeStorageBaseUrl("http://127.0.0.1:7126", { envName: "TEST_URL" }),
    "http://127.0.0.1:7126/",
  );
  for (const rejected of [
    "https://cdn.example.com/nested",
    "https://user:pass@cdn.example.com",
    "https://cdn.example.com?query=1",
    "https://cdn.example.com#hash",
  ]) {
    assert.throws(
      () => normalizeStorageBaseUrl(rejected, { envName: "TEST_URL" }),
      /TEST_URL must be an HTTP\(S\) root URL/u,
    );
  }
});
