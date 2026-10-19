import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { WorkflowDeviceCodeSecretRecord } from "../../account-db";
import { configureWorkflowAuthContext, requireAdminPrincipal } from "../../auth";
import { getRequestT, localizeHttpErrorMessage } from "../../i18n";
import { fail, HttpError, ok, toHttpError } from "../../protocol";
import { createAdminAliasRouter, createAuthRouter, createMeAliasRouter } from "../auth";

test.afterEach(() => {
  configureWorkflowAuthContext({});
});

test("admin key login creates a workflow auth cookie visible to /api/auth/session", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-1";
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/admin-key/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: "admin-key-1" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    const loginBody = await login.json() as { errCode: number; data?: { authenticated?: boolean; principal?: { kind?: string } } };

    assert.equal(login.status, 200);
    assert.equal(loginBody.errCode, 0);
    assert.equal(loginBody.data?.authenticated, true);
    assert.equal(loginBody.data?.principal?.kind, "admin_key");
    assert.match(cookie, /steamharness_auth_session=/);

    const session = await fetchJson(server.url("/api/auth/session"), {
      headers: { Cookie: cookie },
    });
    assert.equal(session.errCode, 0);
    assert.equal(session.data?.authenticated, true);
    assert.equal(session.data?.principal?.kind, "admin_key");
  } finally {
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  }
});

test("admin key cookie can access protected management routes", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-2";
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/admin-key/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: "admin-key-2" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";

    const protectedResponse = await fetchJson(server.url("/api/protected"), {
      headers: { Cookie: cookie },
    });
    assert.equal(protectedResponse.errCode, 0);
    assert.equal(protectedResponse.data?.principal?.kind, "admin_key");
  } finally {
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  }
});

test("forged unsigned admin key cookie is rejected", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-forged-cookie";
  const server = await listen();

  try {
    const forgedCookie = "steamharness_auth_session=%7B%22kind%22%3A%22admin_key%22%7D";
    const protectedResponse = await fetch(server.url("/api/protected"), {
      headers: { Cookie: forgedCookie },
    });
    const payload = await protectedResponse.json() as { errCode: number };

    assert.equal(protectedResponse.status, 401);
    assert.equal(payload.errCode, 401);
  } finally {
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  }
});

test("signed admin key cookie stops working after cookie secret rotation", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-signed-cookie";
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/admin-key/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: "admin-key-signed-cookie" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-rotated-cookie";

    const protectedResponse = await fetch(server.url("/api/protected"), {
      headers: { Cookie: cookie },
    });
    const payload = await protectedResponse.json() as { errCode: number };

    assert.equal(protectedResponse.status, 401);
    assert.equal(payload.errCode, 401);
  } finally {
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  }
});

test("explicit cookie secret keeps admin key cookie valid across admin key rotation", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-explicit-secret";
  process.env.STEAMHARNESS_AUTH_COOKIE_SECRET = "stable-cookie-secret";
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/admin-key/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: "admin-key-explicit-secret" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-rotated-with-stable-cookie-secret";

    const protectedResponse = await fetchJson(server.url("/api/protected"), {
      headers: { Cookie: cookie },
    });
    assert.equal(protectedResponse.errCode, 0);
    assert.equal(protectedResponse.data?.principal?.kind, "admin_key");
  } finally {
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
    delete process.env.STEAMHARNESS_AUTH_COOKIE_SECRET;
  }
});

test("logout clears the auth cookie and protected routes reject the stale cookie", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-3";
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/admin-key/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: "admin-key-3" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";

    const logout = await fetch(server.url("/api/auth/logout"), {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const logoutPayload = await logout.json() as { errCode: number };
    assert.equal(logoutPayload.errCode, 0);
    const clearedCookie = (logout.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const protectedResponse = await fetch(server.url("/api/protected"), {
      headers: { Cookie: clearedCookie },
    });
    const payload = await protectedResponse.json() as { errCode: number };
    assert.equal(protectedResponse.status, 401);
    assert.equal(payload.errCode, 401);
  } finally {
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  }
});

test("admin alias routes forward to the auth admin handlers", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-4";
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/admin-key/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: "admin-key-4" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";

    const response = await fetchJson(server.url("/api/admin/permissions"), {
      headers: { Cookie: cookie },
    });
    assert.equal(response.errCode, 0);
    assert.ok(Array.isArray(response.data?.groups));
  } finally {
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  }
});

test("admin key login upgrades to admin_session when auth service is configured", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-auth-service";
  const authService = {
    async signInBootstrapAdmin() {
      return {
        accessToken: "access-token-auth-service",
        refreshToken: "refresh-token-auth-service",
        user: {
          userId: "admin-user-auth-service",
          email: "admin@steamharness.local",
          displayName: "SteamHarness Admin",
        },
      };
    },
    async resolvePrincipal(req: { headers: { cookie?: string } }) {
      if (!String(req.headers.cookie ?? "").includes("steamharness_auth_session=")) {
        return undefined;
      }
      return {
        kind: "admin_session" as const,
        tokenSource: "cookie" as const,
        userId: "admin-user-auth-service",
        profile: {
          userId: "admin-user-auth-service",
          email: "admin@steamharness.local",
          displayName: "SteamHarness Admin",
          status: "active" as const,
          createdAt: "2026-06-18T00:00:00.000Z",
          updatedAt: "2026-06-18T00:00:00.000Z",
          roleIds: ["builtin_admin"],
          roleNames: ["Admin"],
          permissions: ["system.admin"],
        },
        permissions: ["system.admin"],
        isSystemAdmin: true,
        accessToken: "access-token-auth-service",
        refreshToken: "refresh-token-auth-service",
      };
    },
    setAuthCookie(res: { append(name: string, value: string): void }) {
      res.append(
        "Set-Cookie",
        "steamharness_auth_session=signed-refresh-cookie; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
      );
    },
    clearAuthCookie() {},
  };
  const accountDb = {
    async getUserProfileOrThrow() {
      return {
        userId: "admin-user-auth-service",
        email: "admin@steamharness.local",
        displayName: "SteamHarness Admin",
        status: "active" as const,
        createdAt: "2026-06-18T00:00:00.000Z",
        updatedAt: "2026-06-18T00:00:00.000Z",
        roleIds: ["builtin_admin"],
        roleNames: ["Admin"],
        permissions: ["system.admin"],
      };
    },
    async createAuditEvent() {},
  };
  configureWorkflowAuthContext({ authService: authService as any, accountDb: accountDb as any });
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/admin-key/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: "admin-key-auth-service" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    const loginBody = await login.json() as { errCode: number; data?: { principal?: { kind?: string } } };
    assert.equal(login.status, 200);
    assert.equal(loginBody.errCode, 0);
    assert.equal(loginBody.data?.principal?.kind, "admin_session");
    assert.doesNotMatch(cookie, /refresh-token-auth-service/);

    const session = await fetchJson(server.url("/api/auth/session"), {
      headers: { Cookie: cookie },
    });
    assert.equal(session.errCode, 0);
    assert.equal(session.data?.authenticated, true);
    assert.equal(session.data?.principal?.kind, "admin_session");

    const response = await fetchJson(server.url("/api/admin/permissions"), {
      headers: { Cookie: cookie },
    });
    assert.equal(response.errCode, 0);
    assert.ok(Array.isArray(response.data?.groups));
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  }
});

test("valid admin key keeps its signed cookie when bootstrap account login is rejected", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-native-auth-rejected";
  const authService = {
    async signInBootstrapAdmin() {
      throw new HttpError(401, 401, "Email or password is invalid.");
    },
    setAdminKeyCookie(res: { append(name: string, value: string): void }) {
      res.append(
        "Set-Cookie",
        "steamharness_auth_session=signed-admin-key-cookie; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
      );
    },
    async resolvePrincipal(req: { headers: { cookie?: string } }) {
      if (!String(req.headers.cookie ?? "").includes("signed-admin-key-cookie")) return undefined;
      return {
        kind: "admin_key" as const,
        tokenSource: "cookie" as const,
        permissions: ["system.admin"],
        isSystemAdmin: true,
      };
    },
    async recordAudit() {},
  };
  configureWorkflowAuthContext({ authService: authService as any });
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/admin-key/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: "admin-key-native-auth-rejected" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    const loginBody = await login.json() as { errCode: number; data?: { principal?: { kind?: string } } };
    assert.equal(login.status, 200);
    assert.equal(loginBody.errCode, 0);
    assert.equal(loginBody.data?.principal?.kind, "admin_key");
    assert.match(cookie, /steamharness_auth_session=/u);

    const protectedResponse = await fetchJson(server.url("/api/protected"), {
      headers: { Cookie: cookie },
    });
    assert.equal(protectedResponse.errCode, 0);
    assert.equal(protectedResponse.data?.principal?.kind, "admin_key");
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  }
});

test("password login can bootstrap the env-configured admin account into an admin_session", async () => {
  process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
  process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-secret";
  const authService = {
    async signInBootstrapAdmin(payload: { email: string; password: string; displayName?: string }) {
      assert.equal(payload.email, "admin@example.com");
      assert.equal(payload.password, "bootstrap-secret");
      return {
        accessToken: "access-token-bootstrap-admin",
        refreshToken: "refresh-token-bootstrap-admin",
        user: {
          userId: "bootstrap-admin-user",
          email: "admin@example.com",
          displayName: "SteamHarness Admin",
        },
      };
    },
    async signInWithPassword() {
      throw new Error("signInWithPassword should not be called for bootstrap admin env login");
    },
    async resolvePrincipal(req: { headers: { cookie?: string } }) {
      if (!String(req.headers.cookie ?? "").includes("steamharness_auth_session=")) {
        return undefined;
      }
      return {
        kind: "admin_session" as const,
        tokenSource: "cookie" as const,
        userId: "bootstrap-admin-user",
        profile: {
          userId: "bootstrap-admin-user",
          email: "admin@example.com",
          displayName: "SteamHarness Admin",
          status: "active" as const,
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
          roleIds: ["builtin_admin"],
          roleNames: ["Admin"],
          permissions: ["system.admin"],
        },
        permissions: ["system.admin"],
        isSystemAdmin: true,
        accessToken: "access-token-bootstrap-admin",
        refreshToken: "refresh-token-bootstrap-admin",
      };
    },
    setAuthCookie(res: { append(name: string, value: string): void }) {
      res.append(
        "Set-Cookie",
        "steamharness_auth_session=signed-bootstrap-admin-cookie; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
      );
    },
    clearAuthCookie() {},
  };
  const accountDb = {
    async getUserProfileOrThrow() {
      return {
        userId: "bootstrap-admin-user",
        email: "admin@example.com",
        displayName: "SteamHarness Admin",
        status: "active" as const,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        roleIds: ["builtin_admin"],
        roleNames: ["Admin"],
        permissions: ["system.admin"],
      };
    },
    async createAuditEvent() {},
  };
  configureWorkflowAuthContext({ authService: authService as any, accountDb: accountDb as any });
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "bootstrap-secret" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    const loginBody = await login.json() as { errCode: number; data?: { principal?: { kind?: string } } };
    assert.equal(login.status, 200);
    assert.equal(loginBody.errCode, 0);
    assert.equal(loginBody.data?.principal?.kind, "admin_session");
    assert.match(cookie, /steamharness_auth_session=/);

    const session = await fetchJson(server.url("/api/auth/session"), {
      headers: { Cookie: cookie },
    });
    assert.equal(session.errCode, 0);
    assert.equal(session.data?.authenticated, true);
    assert.equal(session.data?.principal?.kind, "admin_session");
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
    delete process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD;
  }
});

test("bootstrap password login falls back to admin key session when auth service is unavailable", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-bootstrap-fallback";
  process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
  process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-secret";
  const createdAuditEvents: Array<{ eventType: string; outcome: string; context?: Record<string, unknown> }> = [];
  const authService = {
    async signInBootstrapAdmin() {
      throw new Error("PostgreSQL authentication query timed out after 5000ms.");
    },
    async signInWithPassword() {
      throw new Error("signInWithPassword should not be called for bootstrap admin env login");
    },
    async resolvePrincipal(req: { headers: { cookie?: string } }) {
      if (!String(req.headers.cookie ?? "").includes("steamharness_auth_session=")) {
        return undefined;
      }
      return {
        kind: "admin_key" as const,
        tokenSource: "cookie" as const,
        permissions: ["system.admin"],
        isSystemAdmin: true,
      };
    },
    setAdminKeyCookie(res: { append(name: string, value: string): void }) {
      res.append(
        "Set-Cookie",
        "steamharness_auth_session=signed-admin-key-fallback-cookie; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
      );
    },
    clearAuthCookie() {},
  };
  const accountDb = {
    async createAuditEvent(event: { eventType: string; outcome: string; context?: Record<string, unknown> }) {
      createdAuditEvents.push(event);
    },
  };
  configureWorkflowAuthContext({ authService: authService as any, accountDb: accountDb as any });
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "bootstrap-secret" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    const loginBody = await login.json() as { errCode: number; data?: { principal?: { kind?: string } } };
    assert.equal(login.status, 200);
    assert.equal(loginBody.errCode, 0);
    assert.equal(loginBody.data?.principal?.kind, "admin_key");
    assert.match(cookie, /steamharness_auth_session=/);
    assert.equal(createdAuditEvents.at(-1)?.context?.via, "bootstrap_admin_fallback");

    const protectedResponse = await fetchJson(server.url("/api/protected"), {
      headers: { Cookie: cookie },
    });
    assert.equal(protectedResponse.errCode, 0);
    assert.equal(protectedResponse.data?.principal?.kind, "admin_key");
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
    delete process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD;
  }
});

test("bootstrap password login does not bypass a rejected native account", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-bootstrap-rejected";
  process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
  process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-secret";
  const authService = {
    async signInBootstrapAdmin() {
      throw new HttpError(401, 401, "Email or password is invalid.");
    },
  };
  configureWorkflowAuthContext({ authService: authService as any });
  const server = await listen();

  try {
    const response = await fetch(server.url("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "bootstrap-secret" }),
    });
    const payload = await response.json() as { errCode: number; errMessage: string };
    assert.equal(response.status, 401);
    assert.equal(payload.errCode, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
    delete process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD;
  }
});

test("bootstrap password login falls back to admin key session when auth service is not configured", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-bootstrap-no-auth";
  process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
  process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-secret";
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "bootstrap-secret" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    const loginBody = await login.json() as { errCode: number; data?: { principal?: { kind?: string } } };
    assert.equal(login.status, 200);
    assert.equal(loginBody.errCode, 0);
    assert.equal(loginBody.data?.principal?.kind, "admin_key");
    assert.match(cookie, /steamharness_auth_session=/);

    const protectedResponse = await fetchJson(server.url("/api/protected"), {
      headers: { Cookie: cookie },
    });
    assert.equal(protectedResponse.errCode, 0);
    assert.equal(protectedResponse.data?.principal?.kind, "admin_key");
  } finally {
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
    delete process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD;
  }
});

test("admin users list merges compatible auth user summaries with workflow profiles", async () => {
  const authService = {
    async listUsers() {
      return [
        {
          user: {
            userId: "user-admin",
            email: "admin@example.com",
            displayName: "Auth Admin",
            createdAt: "2026-06-20T00:00:00.000Z",
            lastSignInAt: "2026-06-22T00:00:00.000Z",
          },
          profile: {
            userId: "user-admin",
            email: "admin@example.com",
            displayName: "Profile Admin",
            avatarUrl: "https://wfstorage.example.com/storage/avatars/user-admin/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png",
            status: "active" as const,
            createdAt: "2026-06-20T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            lastLoginAt: "2026-06-21T00:00:00.000Z",
            roleIds: ["builtin_admin"],
            roleNames: ["Admin"],
            permissions: ["system.admin"],
          },
        },
        {
          user: {
            userId: "user-viewer",
            email: "viewer@example.com",
            displayName: "Viewer User",
            createdAt: "2026-06-19T00:00:00.000Z",
          },
          profile: undefined,
        },
      ];
    },
    async resolvePrincipal() {
      return {
        kind: "admin_session" as const,
        tokenSource: "cookie" as const,
        userId: "user-admin",
        profile: {
          userId: "user-admin",
          email: "admin@example.com",
          displayName: "Profile Admin",
          status: "active" as const,
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-21T00:00:00.000Z",
          roleIds: ["builtin_admin"],
          roleNames: ["Admin"],
          permissions: ["system.admin"],
        },
        permissions: ["system.admin"],
        isSystemAdmin: true,
        accessToken: "access-token-admin",
        refreshToken: "refresh-token-admin",
      };
    },
    setAuthCookie() {},
    clearAuthCookie() {},
  };
  const accountDb = {
    async createAuditEvent() {},
  };
  configureWorkflowAuthContext({ authService: authService as any, accountDb: accountDb as any });
  const server = await listen();

  try {
    const response = await fetchJson(server.url("/api/admin/users?search=admin&pageSize=1"), {
      headers: { Cookie: "steamharness_auth_session=signed-admin-cookie" },
    });

    assert.equal(response.errCode, 0);
    assert.equal(response.data?.total, 1);
    assert.equal(response.data?.pageSize, 1);
    assert.equal(response.data?.items?.[0]?.userId, "user-admin");
    assert.equal(response.data?.items?.[0]?.displayName, "Profile Admin");
    assert.deepEqual(response.data?.items?.[0]?.roles, ["Admin"]);
    assert.equal(response.data?.items?.[0]?.lastSignInAt, "2026-06-22T00:00:00.000Z");
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("password login records a failed audit event when signInWithPassword rejects the credentials", async () => {
  // Failed login attempts must be auditable so operators can spot
  // brute-force scans against the same email. We only need to confirm the
  // audit fires; the test's listen() doesn't wire a JSON error handler so
  // the response itself comes back through Express's default error path.
  const authService = {
    async signInWithPassword(payload: { email: string; password: string }) {
      assert.equal(payload.email, "user@example.com");
      assert.equal(payload.password, "wrong-password");
      throw new Error("Invalid login credentials");
    },
    setAuthCookie() {},
    clearAuthCookie() {},
  };
  const auditEvents: Array<{ eventType: string; outcome: string; context?: Record<string, unknown> }> = [];
  const accountDb = {
    async createAuditEvent(event: { eventType: string; outcome: string; context?: Record<string, unknown> }) {
      auditEvents.push({ eventType: event.eventType, outcome: event.outcome, context: event.context });
    },
  };
  configureWorkflowAuthContext({ authService: authService as any, accountDb: accountDb as any });
  const server = await listen();

  try {
    const response = await fetch(server.url("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "wrong-password" }),
    });
    assert.ok(response.status >= 400, `expected an error response, got ${response.status}`);
    const failed = auditEvents.find(
      (event) => event.eventType === "auth.password.login" && event.outcome === "failed",
    );
    assert.ok(failed, "expected a failed password-login audit event");
    assert.equal(failed.context?.email, "user@example.com");
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("password login mints an API key when called with source=desktop for non-web clients", async () => {
  // Desktop needs a Bearer-style API key after password login so it
  // can keep using Authorization headers instead of switching to cookie auth.
  const authService = {
    async signInWithPassword(payload: { email: string; password: string }) {
      assert.equal(payload.email, "user@example.com");
      assert.equal(payload.password, "super-secret");
      return {
        accessToken: "session-token",
        refreshToken: "session-refresh",
        user: {
          userId: "user-1",
          email: "user@example.com",
          displayName: "Workflow User",
        },
      };
    },
    setAuthCookie() {},
    clearAuthCookie() {},
  };
  const createdKeys: Array<{ userId: string; name: string; source: string; expiresAt: string }> = [];
  const accountDb = {
    async getUserProfileOrThrow() {
      return {
        userId: "user-1",
        email: "user@example.com",
        displayName: "Workflow User",
        status: "active" as const,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        roleIds: [],
        roleNames: [],
        permissions: [],
      };
    },
    async createApiKey(input: { userId: string; name: string; source: string; expiresAt: string }) {
      createdKeys.push({
        userId: input.userId,
        name: input.name,
        source: input.source,
        expiresAt: input.expiresAt,
      });
      return {
        token: `wf_api_${input.userId}_${createdKeys.length}`,
        record: {
          id: `api-key-${createdKeys.length}`,
          userId: input.userId,
          name: input.name,
          prefix: "wf_api",
          source: input.source,
          scopes: [],
          createdAt: "2026-06-22T00:00:00.000Z",
          expiresAt: input.expiresAt,
        },
      };
    },
    async createAuditEvent() {},
  };
  configureWorkflowAuthContext({ authService: authService as any, accountDb: accountDb as any });
  const server = await listen();

  try {
    const response = await fetchJson(server.url("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "user@example.com",
        password: "super-secret",
        source: "desktop",
        clientName: "SteamHarness Desktop login",
      }),
    });
    assert.equal(response.errCode, 0);
    assert.equal(response.data?.authenticated, true);
    assert.equal(response.data?.accessToken, "wf_api_user-1_1");
    assert.equal(response.data?.apiKey?.id, "api-key-1");
    assert.equal(response.data?.user?.email, "user@example.com");
    assert.ok(typeof response.data?.expiresAt === "string");
    assert.equal(createdKeys.length, 1);
    assert.equal(createdKeys[0]?.source, "desktop");
    assert.equal(createdKeys[0]?.name, "SteamHarness Desktop login");
    const desktopKeyTtlMs = Date.parse(createdKeys[0]!.expiresAt) - Date.now();
    assert.ok(desktopKeyTtlMs >= 89 * 24 * 60 * 60 * 1000);
    assert.ok(desktopKeyTtlMs <= 91 * 24 * 60 * 60 * 1000);

    const legacyResponse = await fetch(server.url("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "user@example.com",
        password: "super-secret",
        source: "app",
      }),
    });
    const legacyPayload = await legacyResponse.json() as { errCode: number; errMessage: string };
    assert.equal(legacyResponse.status, 400);
    assert.equal(legacyPayload.errCode, 400);
    assert.match(legacyPayload.errMessage, /Invalid non-web client source "app"/);
    assert.equal(createdKeys.length, 1);

    // Web flow should keep its existing shape and NOT mint an extra API key.
    const webResponse = await fetchJson(server.url("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "user@example.com",
        password: "super-secret",
      }),
    });
    assert.equal(webResponse.errCode, 0);
    assert.equal(webResponse.data?.authenticated, true);
    assert.equal(webResponse.data?.accessToken, undefined);
    assert.equal(webResponse.data?.apiKey, undefined);
    assert.equal(createdKeys.length, 1);
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("me exposes the refreshed expiration for a Desktop API key principal", async () => {
  const refreshedExpiresAt = "2026-10-20T00:00:00.000Z";
  const profile = {
    userId: "user-desktop-key",
    email: "desktop@example.com",
    displayName: "Desktop User",
    status: "active" as const,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    roleIds: [],
    roleNames: [],
    permissions: [],
  };
  const authService = {
    async resolvePrincipal() {
      return {
        kind: "api_key" as const,
        tokenSource: "bearer" as const,
        userId: profile.userId,
        profile,
        permissions: [],
        isSystemAdmin: false,
        apiKey: {
          id: "api-key-desktop",
          userId: profile.userId,
          name: "SteamHarness Desktop login",
          prefix: "wf_api",
          source: "desktop",
          scopes: [],
          createdAt: "2026-07-22T00:00:00.000Z",
          expiresAt: refreshedExpiresAt,
          secretHash: "hash",
          user: profile,
        },
      };
    },
  };
  configureWorkflowAuthContext({ authService: authService as any });
  const server = await listen();

  try {
    const response = await fetchJson(server.url("/api/auth/me"), {
      headers: { Authorization: "Bearer wf_api_desktop" },
    });

    assert.equal(response.errCode, 0);
    assert.equal(response.data?.principal?.kind, "api_key");
    assert.equal(response.data?.principal?.apiKeyId, "api-key-desktop");
    assert.equal(response.data?.principal?.expiresAt, refreshedExpiresAt);
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("me patch updates display name and avatar url for authenticated sessions", async () => {
  let updatedPatch: { displayName?: string; avatarUrl?: string | null } | undefined;
  const authService = {
    async resolvePrincipal(req: { headers: { cookie?: string } }) {
      if (!String(req.headers.cookie ?? "").includes("steamharness_auth_session=")) {
        return undefined;
      }
      return {
        kind: "user_session" as const,
        tokenSource: "cookie" as const,
        userId: "user-profile-1",
        profile: {
          userId: "user-profile-1",
          email: "user@example.com",
          displayName: "Old Name",
          avatarUrl: undefined,
          status: "active" as const,
          createdAt: "2026-06-21T00:00:00.000Z",
          updatedAt: "2026-06-21T00:00:00.000Z",
          roleIds: ["builtin_viewer"],
          roleNames: ["Viewer"],
          permissions: ["api_keys.manage_self"],
        },
        permissions: ["api_keys.manage_self"],
        isSystemAdmin: false,
        accessToken: "access-token-profile",
        refreshToken: "refresh-token-profile",
      };
    },
    setAuthCookie(res: { append(name: string, value: string): void }) {
      res.append(
        "Set-Cookie",
        "steamharness_auth_session=signed-profile-cookie; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
      );
    },
    clearAuthCookie() {},
  };
  const accountDb = {
    async updateUserProfile(_userId: string, patch: { displayName?: string; avatarUrl?: string | null }) {
      updatedPatch = patch;
      return {
        userId: "user-profile-1",
        email: "user@example.com",
        displayName: patch.displayName ?? "Old Name",
        avatarUrl: patch.avatarUrl ?? undefined,
        status: "active" as const,
        createdAt: "2026-06-21T00:00:00.000Z",
        updatedAt: "2026-06-21T00:00:00.000Z",
        roleIds: ["builtin_viewer"],
        roleNames: ["Viewer"],
        permissions: ["api_keys.manage_self"],
      };
    },
    async createAuditEvent() {},
  };
  configureWorkflowAuthContext({ authService: authService as any, accountDb: accountDb as any });
  const server = await listen();

  try {
    const response = await fetch(server.url("/api/auth/me"), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: "steamharness_auth_session=signed-profile-cookie",
      },
      body: JSON.stringify({
        displayName: "New Name",
        avatarUrl: "data:image/png;base64,abc",
      }),
    });
    const payload = await response.json() as {
      errCode: number;
      data?: { profile?: { displayName?: string; avatarUrl?: string } };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.errCode, 0);
    assert.deepEqual(updatedPatch, {
      displayName: "New Name",
      avatarUrl: "data:image/png;base64,abc",
    });
    assert.equal(payload.data?.profile?.displayName, "New Name");
    assert.equal(payload.data?.profile?.avatarUrl, "data:image/png;base64,abc");
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("me alias routes forward to the auth me handlers", async () => {
  process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "admin-key-5";
  const server = await listen();

  try {
    const login = await fetch(server.url("/api/auth/admin-key/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: "admin-key-5" }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";

    const response = await fetchJson(server.url("/api/me"), {
      headers: { Cookie: cookie },
    });
    assert.equal(response.errCode, 0);
    assert.equal(response.data?.principal?.kind, "admin_key");
  } finally {
    await server.close();
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
  }
});

test("device start rejects the removed App source without creating a device code", async () => {
  let createDeviceCodeCalls = 0;
  const authService = {
    async createDeviceCode() {
      createDeviceCodeCalls += 1;
      throw new Error("createDeviceCode must not run for a removed source");
    },
  };
  configureWorkflowAuthContext({ authService: authService as any });
  const server = await listen();

  try {
    const response = await fetch(server.url("/api/auth/device/start"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workflow-Locale": "zh-CN",
      },
      body: JSON.stringify({
        clientName: "Legacy App",
        source: "app",
      }),
    });
    const payload = await response.json() as { errCode: number; errMessage: string };

    assert.equal(response.status, 400);
    assert.equal(payload.errCode, 400);
    assert.equal(payload.errMessage, "非 Web 客户端来源“app”无效。");
    assert.equal(createDeviceCodeCalls, 0);
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("device token returns expired_token when a pending device code is already expired", async () => {
  const accountDb = createAccountDbStub();
  const authService = createAuthServiceStub();
  configureWorkflowAuthContext({ accountDb: accountDb as any, authService: authService as any });
  const server = await listen();

  const expiredRecord = createDeviceCodeRecord({
    id: "device-expired",
    state: "pending",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  accountDb.deviceCodeBySecret.set("expired-secret", expiredRecord);

  try {
    const response = await fetch(server.url("/api/auth/device/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: "expired-secret" }),
    });
    const payload = await response.json() as { errCode: number; errMessage: string; data?: { state?: string } };

    assert.equal(response.status, 409);
    assert.equal(payload.errCode, 409);
    assert.equal(payload.errMessage, "expired_token");
    assert.equal(payload.data?.state, "expired");
    assert.equal(accountDb.updatedDeviceStates.at(-1)?.state, "expired");
    assert.equal(accountDb.createdAuditEvents.at(-1)?.eventType, "auth.device.token");
    assert.equal(accountDb.createdAuditEvents.at(-1)?.outcome, "failed");
    assert.equal(authService.auditEvents.length, 0);
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("device token returns slow_down with retry-after after repeated polls for the same code", async () => {
  const accountDb = createAccountDbStub();
  configureWorkflowAuthContext({ accountDb: accountDb as any, authService: createAuthServiceStub() as any });
  const server = await listen();

  const pendingRecord = createDeviceCodeRecord({
    id: "device-pending",
    state: "pending",
    expiresAt: "2999-01-01T00:00:00.000Z",
    intervalSeconds: 5,
  });
  accountDb.deviceCodeBySecret.set("pending-secret", pendingRecord);

  try {
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response = await fetch(server.url("/api/auth/device/token"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({ deviceCode: "pending-secret" }),
      });
      if (attempt < 60) {
        const payload = await response.json() as { errCode: number; errMessage: string };
        assert.equal(response.status, 428);
        assert.equal(payload.errMessage, "authorization_pending");
        continue;
      }
      const payload = await response.json() as { errCode: number; errMessage: string; data?: { retryAfterSeconds?: number } };
      assert.equal(response.status, 429);
      assert.equal(payload.errCode, 429);
      assert.equal(payload.errMessage, "slow_down");
      assert.equal(
        Number(response.headers.get("retry-after") ?? "0"),
        payload.data?.retryAfterSeconds,
      );
      assert.ok((payload.data?.retryAfterSeconds ?? 0) > 0);
    }
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("device token consumes approved code before creating an API key", async () => {
  const accountDb = createAccountDbStub();
  configureWorkflowAuthContext({ accountDb: accountDb as any, authService: createAuthServiceStub() as any });
  const server = await listen();
  const approvedRecord = createDeviceCodeRecord({
    id: "device-approved",
    state: "approved",
    expiresAt: "2999-01-01T00:00:00.000Z",
    result: {
      user: {
        userId: "user-device",
        email: "device@example.com",
        displayName: "Device User",
      },
      expiresAt: "2999-01-02T00:00:00.000Z",
    },
  });
  accountDb.deviceCodeBySecret.set("approved-secret", approvedRecord);

  try {
    const response = await fetch(server.url("/api/auth/device/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: "approved-secret" }),
    });
    const payload = await response.json() as { errCode: number; data?: { accessToken?: string; apiKey?: { id?: string } } };

    assert.equal(response.status, 200);
    assert.equal(payload.errCode, 0);
    assert.equal(payload.data?.accessToken, "wf_api_created");
    assert.equal(accountDb.consumedDeviceCodeIds.at(-1), "device-approved");
    assert.equal(accountDb.createdApiKeys.length, 1);
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("device token rejects approved code when another request already consumed it", async () => {
  const accountDb = createAccountDbStub();
  accountDb.consumeApprovedDeviceCodeWithApiKeyResult = undefined;
  configureWorkflowAuthContext({ accountDb: accountDb as any, authService: createAuthServiceStub() as any });
  const server = await listen();
  accountDb.deviceCodeBySecret.set("approved-secret", createDeviceCodeRecord({
    id: "device-approved",
    state: "approved",
    result: {
      user: {
        userId: "user-device",
        email: "device@example.com",
        displayName: "Device User",
      },
    },
  }));

  try {
    const response = await fetch(server.url("/api/auth/device/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: "approved-secret" }),
    });
    const payload = await response.json() as { errCode: number; errMessage: string };

    assert.equal(response.status, 409);
    assert.equal(payload.errMessage, "expired_token");
    assert.equal(accountDb.createdApiKeys.length, 0);
    assert.equal(accountDb.createdAuditEvents.at(-1)?.context?.state, "already_consumed");
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("account invitation routes expose metadata and establish a session after password setup", async () => {
  const authService = {
    async getInvitation(token: string) {
      assert.equal(token, "wf_invite_public-token");
      return {
        email: "invited@example.com",
        displayName: "Invited User",
        expiresAt: "2026-09-01T00:00:00.000Z",
      };
    },
    async acceptInvitation(input: { token: string; password: string; displayName?: string }) {
      assert.deepEqual(input, {
        token: "wf_invite_public-token",
        password: "initial-password",
        displayName: "Activated User",
      });
      return {
        accessToken: "wf_access_invited",
        refreshToken: "wf_refresh_invited",
        expiresAt: "2026-09-01T01:00:00.000Z",
        user: {
          userId: "invited-user",
          email: "invited@example.com",
          displayName: "Activated User",
        },
      };
    },
    setAuthCookie(res: { append(name: string, value: string): void }) {
      res.append("Set-Cookie", "steamharness_auth_session=signed-invited-cookie; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
    },
  };
  const accountDb = { async createAuditEvent() {} };
  configureWorkflowAuthContext({ authService: authService as any, accountDb: accountDb as any });
  const server = await listen();

  try {
    const lookup = await fetchJson(server.url("/api/auth/invitations/wf_invite_public-token"));
    assert.equal(lookup.errCode, 0);
    assert.equal(lookup.data?.invitation?.email, "invited@example.com");

    const accept = await fetch(server.url("/api/auth/invitations/wf_invite_public-token/accept"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "initial-password", displayName: "Activated User" }),
    });
    const payload = await accept.json() as { errCode: number; data?: { authenticated?: boolean } };
    assert.equal(accept.status, 200);
    assert.equal(payload.errCode, 0);
    assert.equal(payload.data?.authenticated, true);
    assert.match(accept.headers.get("set-cookie") ?? "", /steamharness_auth_session=/u);
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

test("logout revokes a PostgreSQL refresh session before clearing its cookie", async () => {
  let revokedRefreshToken: string | undefined;
  const profile = {
    userId: "logout-user",
    email: "logout@example.com",
    displayName: "Logout User",
    status: "active" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    roleIds: ["builtin_viewer"],
    roleNames: ["Viewer"],
    permissions: [] as const,
  };
  const authService = {
    async resolvePrincipal() {
      return {
        kind: "user_session" as const,
        tokenSource: "cookie" as const,
        userId: profile.userId,
        profile,
        permissions: [],
        isSystemAdmin: false,
        accessToken: "wf_access_logout",
        refreshToken: "wf_refresh_logout",
      };
    },
    async revokeSession(refreshToken: string) {
      revokedRefreshToken = refreshToken;
    },
    clearAuthCookie(res: { append(name: string, value: string): void }) {
      res.append("Set-Cookie", "steamharness_auth_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    },
  };
  const accountDb = { async createAuditEvent() {} };
  configureWorkflowAuthContext({ authService: authService as any, accountDb: accountDb as any });
  const server = await listen();

  try {
    const response = await fetch(server.url("/api/auth/logout"), {
      method: "POST",
      headers: { Cookie: "steamharness_auth_session=signed-refresh-cookie" },
    });
    assert.equal(response.status, 200);
    assert.equal(revokedRefreshToken, "wf_refresh_logout");
    assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  } finally {
    configureWorkflowAuthContext({});
    await server.close();
  }
});

async function listen(): Promise<{
  close: () => Promise<void>;
  url: (path: string) => string;
}> {
  const app = express();
  app.use("/api/auth", createAuthRouter());
  app.use("/api/me", createMeAliasRouter());
  app.use("/api/admin", createAdminAliasRouter());
  app.use("/api", requireAdminPrincipal());
  app.get("/api/protected", (req, res) => {
    const principal = req.res?.locals?.principal;
    res.json(ok({ principal }));
  });
  // Mirror the production global error handler so failed-login
  // tests get a clean JSON envelope instead of an HTML stack trace.
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const httpError = toHttpError(err);
    res.status(httpError.statusCode).json(fail(
      httpError.errCode,
      localizeHttpErrorMessage(httpError, getRequestT(req)),
      httpError.data,
    ));
  });
  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
  };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ errCode: number; data?: any }> {
  const response = await fetch(url, init);
  return await response.json() as { errCode: number; data?: any };
}

interface DeviceCodeStateUpdate {
  state: string;
  approvedAt?: string | null;
  approvedByUserId?: string | null;
  deniedAt?: string | null;
  consumedAt?: string | null;
  result?: Record<string, unknown>;
}

function createAccountDbStub(): {
  deviceCodeBySecret: Map<string, WorkflowDeviceCodeSecretRecord>;
  updatedDeviceStates: DeviceCodeStateUpdate[];
  consumedDeviceCodeIds: string[];
  consumeApprovedDeviceCodeWithApiKeyResult?: {
    deviceCode: WorkflowDeviceCodeSecretRecord;
    apiKey: { token: string; record: { id: string; expiresAt?: string } };
  } | null;
  createdApiKeys: Array<Record<string, unknown>>;
  createdAuditEvents: Array<{ eventType: string; outcome: string; context?: Record<string, unknown> }>;
  getDeviceCodeBySecret(deviceCode: string): Promise<WorkflowDeviceCodeSecretRecord | undefined>;
  updateDeviceCodeState(_deviceCodeId: string, input: DeviceCodeStateUpdate): Promise<WorkflowDeviceCodeSecretRecord>;
  consumeApprovedDeviceCodeWithApiKey(deviceCodeId: string, input: {
    consumedAt: string;
    result?: Record<string, unknown>;
    expiresAt?: string;
  } & Record<string, unknown>): Promise<{
    deviceCode: WorkflowDeviceCodeSecretRecord;
    apiKey: { token: string; record: { id: string; expiresAt?: string } };
  } | undefined>;
  createApiKey(input: Record<string, unknown>): Promise<{ token: string; record: { id: string; expiresAt?: string } }>;
  createAuditEvent(event: { eventType: string; outcome: string; context?: Record<string, unknown> }): Promise<void>;
} {
  const deviceCodeBySecret = new Map<string, WorkflowDeviceCodeSecretRecord>();
  return {
    deviceCodeBySecret,
    updatedDeviceStates: [] as DeviceCodeStateUpdate[],
    consumedDeviceCodeIds: [] as string[],
    consumeApprovedDeviceCodeWithApiKeyResult: null as {
      deviceCode: WorkflowDeviceCodeSecretRecord;
      apiKey: { token: string; record: { id: string; expiresAt?: string } };
    } | null | undefined,
    createdApiKeys: [] as Array<Record<string, unknown>>,
    createdAuditEvents: [] as Array<{ eventType: string; outcome: string; context?: Record<string, unknown> }>,
    async getDeviceCodeBySecret(deviceCode: string) {
      return deviceCodeBySecret.get(deviceCode);
    },
    async updateDeviceCodeState(_deviceCodeId: string, input: DeviceCodeStateUpdate) {
      this.updatedDeviceStates.push(input);
      const nextRecord = createDeviceCodeRecord({
        ...deviceCodeBySecret.values().next().value,
        state: input.state as ReturnType<typeof createDeviceCodeRecord>["state"],
        approvedAt: input.approvedAt ?? undefined,
        approvedByUserId: input.approvedByUserId ?? undefined,
        deniedAt: input.deniedAt ?? undefined,
        consumedAt: input.consumedAt ?? undefined,
        result: input.result as ReturnType<typeof createDeviceCodeRecord>["result"],
      });
      return nextRecord;
    },
    async consumeApprovedDeviceCodeWithApiKey(deviceCodeId: string, input: {
      consumedAt: string;
      result?: Record<string, unknown>;
      expiresAt?: string;
    } & Record<string, unknown>) {
      this.consumedDeviceCodeIds.push(deviceCodeId);
      if (this.consumeApprovedDeviceCodeWithApiKeyResult === undefined) {
        return undefined;
      }
      const baseRecord = [...deviceCodeBySecret.values()].find((record) => record.id === deviceCodeId) ?? deviceCodeBySecret.values().next().value;
      const consumed = this.consumeApprovedDeviceCodeWithApiKeyResult?.deviceCode ?? createDeviceCodeRecord({
        ...baseRecord,
        state: "consumed",
        consumedAt: input.consumedAt,
        result: {
          ...input.result as ReturnType<typeof createDeviceCodeRecord>["result"],
          apiKeyId: "api-key-created",
        },
      });
      this.createdApiKeys.push(input);
      return {
        deviceCode: consumed,
        apiKey: this.consumeApprovedDeviceCodeWithApiKeyResult?.apiKey ?? {
          token: "wf_api_created",
          record: {
            id: "api-key-created",
            expiresAt: typeof input.expiresAt === "string" ? input.expiresAt : undefined,
          },
        },
      };
    },
    async createApiKey(input: Record<string, unknown>) {
      this.createdApiKeys.push(input);
      return {
        token: "wf_api_created",
        record: {
          id: "api-key-created",
          expiresAt: typeof input.expiresAt === "string" ? input.expiresAt : undefined,
        },
      };
    },
    async createAuditEvent(event: { eventType: string; outcome: string; context?: Record<string, unknown> }) {
      this.createdAuditEvents.push(event);
    },
  };
}

function createAuthServiceStub(): {
  auditEvents: Array<{ eventType: string; outcome: string }>;
  recordAudit(event: { eventType: string; outcome: string }): Promise<void>;
} {
  return {
    auditEvents: [] as Array<{ eventType: string; outcome: string }>,
    async recordAudit(event: { eventType: string; outcome: string }) {
      this.auditEvents.push(event);
    },
  };
}

function createDeviceCodeRecord(overrides: Partial<{
  id: string;
  deviceCodeHash: string;
  userCode: string;
  clientName: string;
  source: string;
  requestedScopes: string[];
  state: "pending" | "approved" | "denied" | "expired" | "consumed";
  requestedByIp: string;
  userAgent: string;
  expiresAt: string;
  intervalSeconds: number;
  approvedAt: string;
  approvedByUserId: string;
  deniedAt: string;
  consumedAt: string;
  result: {
    apiKeyId?: string;
    user?: {
      userId: string;
      email: string;
      displayName: string;
    };
    expiresAt?: string;
  };
}> = {}): WorkflowDeviceCodeSecretRecord {
  return {
    id: overrides.id ?? "device-1",
    deviceCodeHash: overrides.deviceCodeHash ?? "device-code-hash",
    userCode: overrides.userCode ?? "ABCD-EFGH",
    clientName: overrides.clientName ?? "SteamHarness CLI",
    source: overrides.source ?? "cli",
    requestedScopes: overrides.requestedScopes ?? [],
    state: overrides.state ?? "pending",
    requestedByIp: overrides.requestedByIp,
    userAgent: overrides.userAgent,
    expiresAt: overrides.expiresAt ?? "2999-01-01T00:00:00.000Z",
    intervalSeconds: overrides.intervalSeconds ?? 5,
    approvedAt: overrides.approvedAt,
    approvedByUserId: overrides.approvedByUserId,
    deniedAt: overrides.deniedAt,
    consumedAt: overrides.consumedAt,
    result: overrides.result,
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
  };
}
