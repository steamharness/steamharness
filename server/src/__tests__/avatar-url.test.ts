import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAvatarUrl } from "../account-db";

const USER_ID = "3f2a1b4c-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

function withSilencedWarnings<T>(run: () => T): T {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    return run();
  } finally {
    console.warn = original;
  }
}

test("avatar URLs accept data URLs and the configured storage origin", () => {
  const env = { STEAMHARNESS_API_PUBLIC_BASE_URL: "https://api.example.com" };

  assert.equal(normalizeAvatarUrl(undefined, env), null);
  assert.equal(normalizeAvatarUrl("", env), null);
  assert.equal(
    normalizeAvatarUrl("data:image/png;base64,AAAA", env),
    "data:image/png;base64,AAAA",
  );
  assert.equal(
    normalizeAvatarUrl(
      `https://cdn.example.com/storage/avatars/${USER_ID}/${HASH}.webp`,
      { STEAMHARNESS_STORAGE_PUBLIC_BASE_URL: "https://cdn.example.com" },
    ),
    `https://cdn.example.com/storage/avatars/${USER_ID}/${HASH}.webp`,
  );
});

test("avatar URLs reject foreign origins and unexpected paths", () => {
  const env = { STEAMHARNESS_API_PUBLIC_BASE_URL: "https://api.example.com" };

  for (const rejected of [
    `https://evil.example.com/storage/avatars/${USER_ID}/${HASH}.png`,
    `https://api.example.com/avatars/${USER_ID}/${HASH}.png`,
    `https://api.example.com/storage/avatars/${USER_ID}/${HASH}.svg`,
    `https://api.example.com/storage/avatars/${USER_ID}/${"a".repeat(63)}.png`,
    `https://api.example.com/storage/workflows/${USER_ID}/${HASH}.png`,
    "not a url",
  ]) {
    assert.throws(() => normalizeAvatarUrl(rejected, env), /Workflow storage avatar URL/u, rejected);
  }
});

test("local object storage accepts the Server's own avatar origin", () => {
  // Without a public base URL, development mints loopback URLs.
  const localDevEnv = { STEAMHARNESS_STORAGE_DRIVER: "local", STEAMHARNESS_SERVER_DEV: "1" };
  assert.equal(
    withSilencedWarnings(() => normalizeAvatarUrl(
      `http://127.0.0.1:7126/storage/avatars/${USER_ID}/${HASH}.webp`,
      localDevEnv,
    )),
    `http://127.0.0.1:7126/storage/avatars/${USER_ID}/${HASH}.webp`,
  );

  // A configured API origin replaces the loopback fallback.
  const localConfiguredEnv = {
    STEAMHARNESS_STORAGE_DRIVER: "local",
    STEAMHARNESS_API_PUBLIC_BASE_URL: "https://api.example.com",
  };
  assert.equal(
    normalizeAvatarUrl(
      `https://api.example.com/storage/avatars/${USER_ID}/${HASH}.png`,
      localConfiguredEnv,
    ),
    `https://api.example.com/storage/avatars/${USER_ID}/${HASH}.png`,
  );
  // A foreign CDN origin is not the Server's own, so it must be rejected.
  assert.throws(
    () => normalizeAvatarUrl(
      `https://wfstorage.yuhe.space/storage/avatars/${USER_ID}/${HASH}.png`,
      localConfiguredEnv,
    ),
    /Workflow storage avatar URL/u,
  );
});
