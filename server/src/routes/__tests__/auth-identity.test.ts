import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { configureProjectAuthContext } from "../../auth";
import { fail, toHttpError } from "../../protocol";
import { createAuthRouter } from "../auth";

test("account changes use the browser session without secondary identity proof", async () => {
  const profile = { userId: "browser-user", displayName: "Browser user" };
  let principal: { kind: string; tokenSource: string; userId: string; profile: typeof profile } | undefined = {
    kind: "user_session", tokenSource: "cookie", userId: "browser-user", profile,
  };
  const changes: unknown[][] = [];
  configureProjectAuthContext({ authService: {
    async resolvePrincipal() { return principal; },
    clearAuthCookie(res: express.Response) { res.append("Set-Cookie", "session=; Max-Age=0"); },
    accounts: {
      async security() { return { username: "user", email: null, emailVerifiedAt: null, hasPassword: true }; },
      async setUsername(...args: unknown[]) { changes.push(["username", ...args]); },
      async setPassword(...args: unknown[]) { changes.push(["password", ...args]); },
      async updateEmail(...args: unknown[]) { changes.push(["email", ...args]); },
    },
  } as any });
  const app = express();
  app.use("/api/auth", createAuthRouter());
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const httpError = toHttpError(error);
    res.status(httpError.statusCode).json(fail(httpError.errCode, httpError.message));
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/auth/me/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: "browser-session", ...headers }, body: JSON.stringify(body),
  });
  try {
    const username = await post("username", { username: "new-user" });
    assert.equal(username.status, 200, await username.text());
    assert.equal(username.headers.get("set-cookie"), null);
    const password = await post("password", { password: "new-password" });
    assert.equal(password.status, 200);
    assert.match(password.headers.get("set-cookie") ?? "", /Max-Age=0/);
    const binding = await post("email", { action: "bind", challengeId: "target", code: "123456" });
    assert.equal(binding.status, 200);
    assert.match(binding.headers.get("set-cookie") ?? "", /Max-Age=0/);
    const unbinding = await post("email", { action: "unbind" });
    assert.equal(unbinding.status, 200);
    assert.deepEqual(changes, [
      ["username", "browser-user", "new-user"],
      ["password", "browser-user", "new-password"],
      ["email", "browser-user", { action: "bind", challengeId: "target", code: "123456" }],
      ["email", "browser-user", { action: "unbind", challengeId: "", code: "" }],
    ]);

    assert.equal((await post("username", { username: "cross-site" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    for (const rejected of [
      undefined,
      { kind: "api_key", tokenSource: "cookie", userId: "browser-user", profile },
      { kind: "user_session", tokenSource: "bearer", userId: "browser-user", profile },
    ]) {
      principal = rejected;
      assert.equal((await post("password", { password: "blocked-password" })).status, 401);
    }
    assert.equal(changes.length, 4);
  } finally {
    configureProjectAuthContext({});
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
