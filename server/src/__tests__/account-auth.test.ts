import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import {
  hashPassword,
  verifyPassword,
  AuthService,
} from "../account-auth";

test("scrypt password hashes use random salts and verify without storing plaintext", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");

  assert.match(first, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/u);
  assert.notEqual(first, second);
  assert.equal(first.includes("correct horse"), false);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
  assert.equal(await verifyPassword("correct horse battery staple", "not-a-password-hash"), false);
  await assert.rejects(() => hashPassword("short"), /at least 8 characters/u);
});

test("resolvePrincipal slides active Desktop API keys forward by 90 days", async () => {
  const profile = createApiKeyProfile();
  let touchedExpiresAt: string | undefined;
  const service = createAuthService({
    async findApiKeyByToken() {
      return createApiKeyLookupRecord({ source: "desktop", user: profile });
    },
    async touchApiKey(_apiKeyId: string, input: { expiresAt?: string }) {
      touchedExpiresAt = input.expiresAt;
      return { expiresAt: input.expiresAt };
    },
  });
  const before = Date.now();

  const principal = await service.resolvePrincipal(createBearerRequest("wf_api_active_desktop"));
  const after = Date.now();

  assert.equal(principal?.kind, "api_key");
  assert.ok(touchedExpiresAt);
  assert.ok(Date.parse(touchedExpiresAt) >= before + 90 * 24 * 60 * 60 * 1000);
  assert.ok(Date.parse(touchedExpiresAt) <= after + 90 * 24 * 60 * 60 * 1000);
  assert.equal(principal?.kind === "api_key" ? principal.apiKey.expiresAt : undefined, touchedExpiresAt);
});

test("resolvePrincipal records CLI API key use without changing its expiration", async () => {
  const profile = createApiKeyProfile();
  const originalExpiresAt = "2026-08-21T00:00:00.000Z";
  let receivedExpiresAt: string | undefined = "not-called";
  const service = createAuthService({
    async findApiKeyByToken() {
      return createApiKeyLookupRecord({ source: "cli", expiresAt: originalExpiresAt, user: profile });
    },
    async touchApiKey(_apiKeyId: string, input: { expiresAt?: string }) {
      receivedExpiresAt = input.expiresAt;
      return { expiresAt: originalExpiresAt };
    },
  });

  const principal = await service.resolvePrincipal(createBearerRequest("wf_api_active_cli"));

  assert.equal(receivedExpiresAt, undefined);
  assert.equal(principal?.kind === "api_key" ? principal.apiKey.expiresAt : undefined, originalExpiresAt);
});

test("resolvePrincipal does not revive an expired or revoked API key", async () => {
  let touched = false;
  const service = createAuthService({
    async findApiKeyByToken() {
      return undefined;
    },
    async touchApiKey() {
      touched = true;
      return { expiresAt: "2099-01-01T00:00:00.000Z" };
    },
  });

  await assert.rejects(
    () => service.resolvePrincipal(createBearerRequest("wf_api_expired")),
    /Unauthorized/u,
  );
  assert.equal(touched, false);
});

function createAuthService(accountDb: object): AuthService {
  return new AuthService({
    pool: createInitOnlyPool(),
    accountDb: accountDb as never,
  });
}

function createInitOnlyPool(): pg.Pool {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
}

function createBearerRequest(token: string) {
  return {
    headers: { authorization: `Bearer ${token}` },
    header() {
      return undefined;
    },
    get() {
      return undefined;
    },
    ip: "127.0.0.1",
  } as never;
}

function createApiKeyProfile() {
  return {
    userId: "user-api-key",
    email: "user@example.com",
    displayName: "Workflow User",
    status: "active" as const,
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    roleIds: [] as string[],
    roleNames: [] as string[],
    permissions: ["projects.read_all"] as const,
  };
}

function createApiKeyLookupRecord(options: {
  source: string;
  expiresAt?: string;
  user: ReturnType<typeof createApiKeyProfile>;
}) {
  return {
    id: "api-key-1",
    userId: options.user.userId,
    name: "App login",
    prefix: "wf_api",
    source: options.source,
    scopes: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    expiresAt: options.expiresAt ?? "2026-07-23T00:00:00.000Z",
    secretHash: "hash",
    user: options.user,
  };
}
