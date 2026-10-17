import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_API_KEY_TTL_MS,
  DEFAULT_API_KEY_TTL_MS,
  createApiKeyExpiresAt,
  createSlidingApiKeyExpiresAt,
  resolveApiKeyTtlMs,
} from "../api-key-lifetime";
import { AccountRepository } from "../account-db";

test("Desktop API keys use a 90-day sliding lifetime while other keys remain 30 days", () => {
  const now = Date.parse("2026-07-22T00:00:00.000Z");

  assert.equal(resolveApiKeyTtlMs("desktop"), DESKTOP_API_KEY_TTL_MS);
  assert.equal(resolveApiKeyTtlMs("DESKTOP"), DESKTOP_API_KEY_TTL_MS);
  assert.equal(resolveApiKeyTtlMs("app"), DEFAULT_API_KEY_TTL_MS);
  assert.equal(resolveApiKeyTtlMs("cli"), DEFAULT_API_KEY_TTL_MS);
  assert.equal(createApiKeyExpiresAt("desktop", now), "2026-10-20T00:00:00.000Z");
  assert.equal(createApiKeyExpiresAt("cli", now), "2026-08-21T00:00:00.000Z");
  assert.equal(createSlidingApiKeyExpiresAt("desktop", now), "2026-10-20T00:00:00.000Z");
  assert.equal(createSlidingApiKeyExpiresAt("app", now), undefined);
  assert.equal(createSlidingApiKeyExpiresAt("manual", now), undefined);
});

test("AccountRepository extends only active API keys and keeps a later expiration", async () => {
  const repository = new AccountRepository("postgresql://example.invalid/postgres");
  const pool = Reflect.get(repository, "pool") as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ expires_at: Date | null }> }>;
  };
  const renewedExpiresAt = "2026-10-20T00:00:00.000Z";
  let query: { sql: string; params?: unknown[] } | undefined;
  pool.query = async (sql: string, params?: unknown[]) => {
    query = { sql, params };
    return { rows: [{ expires_at: new Date("2027-01-01T00:00:00.000Z") }] };
  };

  const touched = await repository.touchApiKey("api-key-1", {
    ip: "127.0.0.1",
    userAgent: "Workflow Desktop",
    expiresAt: renewedExpiresAt,
  });

  assert.deepEqual(query?.params, ["api-key-1", "127.0.0.1", "Workflow Desktop", renewedExpiresAt]);
  assert.match(query?.sql ?? "", /greatest\(expires_at, \$4::timestamptz\)/);
  assert.match(query?.sql ?? "", /revoked_at is null/);
  assert.match(query?.sql ?? "", /expires_at is null or expires_at > now\(\)/);
  assert.equal(touched?.expiresAt, "2027-01-01T00:00:00.000Z");
});
