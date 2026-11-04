import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { AuthService } from "../../account-auth";
import { configureProjectAuthContext } from "../../auth";
import { fail, toHttpError } from "../../protocol";
import { createAuthRouter } from "../auth";

const token = "wf_api_studio_browser_test";
const returnTo = "/databases/00000000-0000-4000-8000-000000000001";

async function fixture(t: test.TestContext) {
  const secret = process.env.STEAMHARNESS_AUTH_COOKIE_SECRET;
  process.env.STEAMHARNESS_AUTH_COOKIE_SECRET = "browser-session-test-secret";
  const state = { revoked: false, disabled: false, touched: 0 };
  const accountDb = {
    async findApiKeyByToken(value: string) {
      if (value !== token || state.revoked) return undefined;
      return {
        id: "browser-session-key", userId: "studio-user", source: "desktop", scopes: ["workflow"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        user: { userId: "studio-user", email: "studio@example.test", displayName: "Studio User", isSystemAdmin: false, status: state.disabled ? "disabled" : "active" },
      };
    },
    async touchApiKey() { state.touched++; return { expiresAt: "2099-01-01T00:00:00.000Z" }; },
  };
  const authService = new AuthService({ accountDb: accountDb as never, pool: { async query() { return { rows: [] }; } } as never });
  configureProjectAuthContext({ authService, accountDb: accountDb as never });
  const app = express();
  app.use("/api/auth", createAuthRouter());
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const httpError = toHttpError(error);
    res.status(httpError.statusCode).json(fail(httpError.errCode, httpError.message));
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    configureProjectAuthContext({});
    if (secret === undefined) delete process.env.STEAMHARNESS_AUTH_COOKIE_SECRET;
    else process.env.STEAMHARNESS_AUTH_COOKIE_SECRET = secret;
  });
  const issue = (target = returnTo, headers: Record<string, string> = { Authorization: `Bearer ${token}` }) => fetch(`${base}/api/auth/browser-session`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ returnTo: target }),
  });
  const consume = (code: string) => fetch(`${base}/api/auth/browser-session?code=${encodeURIComponent(code)}`, { redirect: "manual" });
  return { state, issue, consume, session: (cookie: string) => fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } }) };
}

test("Studio browser handoff opens the requested database with the same account and key", async t => {
  const f = await fixture(t), issued = await f.issue();
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const body = await issued.json();
  assert.match(body.data.code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(body).includes(token), false);
  assert.equal(issued.headers.get("set-cookie"), null);
  const opened = await f.consume(body.data.code);
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get("location"), returnTo);
  assert.equal(opened.headers.get("referrer-policy"), "no-referrer");
  const cookie = opened.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  const session = await (await f.session(cookie)).json();
  assert.equal(session.data.authenticated, true);
  assert.equal(session.data.principal.kind, "api_key");
  assert.equal(session.data.principal.userId, "studio-user");
  assert.equal(session.data.principal.apiKeyId, "browser-session-key");
  assert.equal(session.data.principal.isSystemAdmin, false);
  assert.equal(JSON.stringify(session).includes(token), false);
  assert.equal((await f.consume(body.data.code)).status, 401, "A handoff can only be consumed once");
  f.state.revoked = true;
  assert.equal((await f.session(cookie)).status, 401, "Revoking the Studio key also revokes browser access");
});

test("handoff rejects missing credentials, external redirects and replay after expiration", async t => {
  const f = await fixture(t);
  assert.equal((await f.issue(returnTo, {})).status, 401);
  for (const target of ["https://attacker.test", "//attacker.test", "/\\attacker.test", "/a/..//attacker.test", "/databases\r\nLocation: bad"]) {
    assert.equal((await f.issue(target)).status, 400, target);
  }
  const { data } = await (await f.issue()).json();
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 61_000);
  const response = await f.consume(data.code);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("handoff revalidates revoked and disabled accounts before setting a browser cookie", async t => {
  const f = await fixture(t);
  const first = await (await f.issue()).json();
  f.state.revoked = true;
  const revoked = await f.consume(first.data.code);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.headers.get("set-cookie"), null);
  f.state.revoked = false;
  const second = await (await f.issue()).json();
  f.state.disabled = true;
  const disabled = await f.consume(second.data.code);
  assert.equal(disabled.status, 403);
  assert.equal(disabled.headers.get("set-cookie"), null);
});

test("browser key cookies cannot issue another handoff or forge a different key", async t => {
  const f = await fixture(t), { data } = await (await f.issue()).json();
  const cookie = (await f.consume(data.code)).headers.get("set-cookie")!;
  assert.equal((await f.issue(returnTo, { Cookie: cookie })).status, 403);
  assert.equal((await f.session(cookie.replace(token, "wf_api_forged"))).status, 401);
});
