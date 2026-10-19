
import { Router } from "express";
import express from "express";
import { createHash } from "node:crypto";
import type { AccountRepository, UserProfileRecord } from "../account-db";
import { createApiKeyExpiresAt } from "../api-key-lifetime";
import { createAuditActor, recordAuditEventForRequest, readRequestIp } from "../audit";
import { clearAuthSessionCookie, getRequestPrincipal, getWorkflowAuthContext, hasConfiguredAdminKey, hasPermission, readRequestPrincipal, requireAuthenticatedPrincipal, writeAdminKeySessionCookie, writeAuthSessionCookie, type AuthenticatedPrincipal } from "../auth";
import { listWorkflowPermissionGroups, type PermissionKey } from "../permissions";
import { fail, HttpError, ok } from "../protocol";
import type { StorageDriver } from "../object-storage";
import { getRequestT, localizeServerMessage } from "../i18n";

interface AuthSessionResponse {
  authenticated: boolean;
  principal?: {
    kind: AuthenticatedPrincipal["kind"];
    userId?: string;
    displayName?: string;
    email?: string;
    // surface avatarUrl on the session so the header avatar loads on
    // every page instead of waiting for the settings-page profile fetch.
    avatarUrl?: string;
    permissions?: PermissionKey[];
    apiKeyId?: string;
    expiresAt?: string;
    roleNames?: string[];
  };
  // The non-web login flows (Desktop / CLI) also receive a long-lived
  // API key so they can keep using Authorization: Bearer headers instead of
  // the cookie. The shape mirrors the device flow's /device/token response
  // for consistency across login paths.
  accessToken?: string;
  apiKey?: {
    id: string;
    userId?: string;
    name?: string;
    prefix?: string;
    source?: string;
    scopes?: string[];
    createdAt?: string;
    expiresAt?: string;
  };
  user?: {
    userId: string;
    email: string;
    displayName: string;
  };
  expiresAt?: string;
}

const AUTH_RATE_LIMIT_WINDOW_MS = 1000 * 60;
const AUTH_RATE_LIMITS = {
  adminKeySession: { maxAttempts: 10, retryAfterSeconds: 60 },
  login: { maxAttempts: 10, retryAfterSeconds: 60 },
  deviceStart: { maxAttempts: 20, retryAfterSeconds: 60 },
  deviceToken: { maxAttempts: 60, retryAfterSeconds: 30 },
  deviceUserCode: { maxAttempts: 20, retryAfterSeconds: 60 },
  apiKeyCreate: { maxAttempts: 20, retryAfterSeconds: 60 },
  // Password login mints an API key on every successful login; it
  // shares the same `login` scope as the password itself, so we don't double
  // charge it against the user's normal api-key-create quota. The bucket is
  // sized to absorb normal re-login churn without becoming an unbounded key
  // farm.
  passwordLoginApiKey: { maxAttempts: 10, retryAfterSeconds: 60 },
} as const;

const authRateLimitState = new Map<string, { count: number; resetAt: number }>();

function jsonBody() {
  return express.json({ limit: "1mb" });
}

export function createAuthRouter(): Router {
  const router = Router();
  const json = jsonBody();
  const rawBody = express.raw({ type: "image/*", limit: 5 * 1024 * 1024 });

  router.get("/session", async (req, res, next) => {
    try {
      const principal = await readRequestPrincipal(req);
      if (!principal) {
        res.json(ok<AuthSessionResponse>({ authenticated: false }));
        return;
      }
      res.json(ok<AuthSessionResponse>({
        authenticated: true,
        principal: serializePrincipal(principal),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin-key/session", json, async (req, res) => {
    const authService = getWorkflowAuthContext().authService;
    const authAttempt = consumeAuthRateLimit({
      scope: "admin-key-session",
      key: readRequestIp(req) ?? "unknown",
      maxAttempts: AUTH_RATE_LIMITS.adminKeySession.maxAttempts,
      retryAfterSeconds: AUTH_RATE_LIMITS.adminKeySession.retryAfterSeconds,
    });
    if (!authAttempt.ok) {
      writeRateLimitResponse(res, authAttempt.retryAfterSeconds);
      return;
    }
    if (!hasConfiguredAdminKey()) {
      res.status(500).json(fail(
        500,
        localizeServerMessage("STEAMHARNESS_SERVER_ADMIN_KEY is required.", getRequestT(req)),
      ));
      return;
    }

    const adminKey = typeof req.body?.adminKey === "string" ? req.body.adminKey.trim() : "";
    if (adminKey === "" || adminKey !== process.env.STEAMHARNESS_SERVER_ADMIN_KEY?.trim()) {
      void recordAuthAudit(req, {
        principalKind: "admin_key",
        eventType: "auth.admin_key.login",
        outcome: "failed",
      });
      res.status(401).json(fail(401, localizeServerMessage("Admin key is invalid.", getRequestT(req))));
      return;
    }

    if (!authService) {
      writeAdminKeySessionCookie(res);
      void recordAuthAudit(req, {
        principalKind: "admin_key",
        eventType: "auth.admin_key.login",
        outcome: "success",
      });
      res.json(ok<AuthSessionResponse>({
        authenticated: true,
        principal: {
          kind: "admin_key",
          permissions: ["system.admin"],
        },
      }));
      return;
    }

    const bootstrapEmail = process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL?.trim() || "admin@steamharness.local";
    const bootstrapPassword = process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD?.trim() || process.env.STEAMHARNESS_SERVER_ADMIN_KEY?.trim() || "";
    const session = await authService.signInBootstrapAdmin({
      email: bootstrapEmail,
      password: bootstrapPassword,
      displayName: "SteamHarness Admin",
    }).catch(() => undefined);

    if (session) {
      writeAuthSessionCookie(res, session);
      const profile = await getWorkflowAuthContext().accountDb?.getUserProfileOrThrow(session.user.userId);
      void recordAuthAudit(req, {
        principalKind: "admin_session",
        actorUserId: session.user.userId,
        actorProfileId: session.user.userId,
        actorDisplayName: session.user.displayName,
        eventType: "auth.admin_key.login",
        outcome: "success",
      });
      res.json(ok<AuthSessionResponse>({
        authenticated: true,
        principal: {
          kind: "admin_session",
          userId: session.user.userId,
          displayName: session.user.displayName,
          email: session.user.email,
          permissions: profile?.permissions ?? ["system.admin"],
        },
      }));
      return;
    }

    writeAdminKeySessionCookie(res);
    void recordAuthAudit(req, {
      principalKind: "admin_key",
      eventType: "auth.admin_key.login",
      outcome: "success",
    });
    res.json(ok<AuthSessionResponse>({
      authenticated: true,
      principal: {
        kind: "admin_key",
        permissions: ["system.admin"],
      },
    }));
  });

  router.post("/login", json, async (req, res, next) => {
    try {
      const authAttempt = consumeAuthRateLimit({
        scope: "login",
        key: `${readRequestIp(req) ?? "unknown"}:${String(req.body?.email ?? "").trim().toLowerCase()}`,
        maxAttempts: AUTH_RATE_LIMITS.login.maxAttempts,
        retryAfterSeconds: AUTH_RATE_LIMITS.login.retryAfterSeconds,
      });
      if (!authAttempt.ok) {
        writeRateLimitResponse(res, authAttempt.retryAfterSeconds);
        return;
      }
      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const source = readNonWebClientSource(req.body?.source);
      if (!email || !password) {
        throw new HttpError(400, 400, "email and password are required.");
      }
      const bootstrapEmail = process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
      const bootstrapPassword = process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD?.trim();
      // 登录页只保留账号密码入口后，env 管理员也必须通过统一密码登录路径自举。
      const shouldBootstrapAdmin =
        !!bootstrapEmail &&
        !!bootstrapPassword &&
        email.trim().toLowerCase() === bootstrapEmail &&
        password === bootstrapPassword;
      const authService = getWorkflowAuthContext().authService;
      if (!authService) {
        if (shouldBootstrapAdmin && hasConfiguredAdminKey()) {
          writeAdminKeySessionCookie(res);
          void recordAuthAudit(req, {
            principalKind: "admin_key",
            actorDisplayName: email,
            eventType: "auth.password.login",
            outcome: "success",
            context: {
              email,
              via: "bootstrap_admin_no_auth_service",
            },
          }).catch(() => undefined);
          res.json(ok<AuthSessionResponse>({
            authenticated: true,
            principal: {
              kind: "admin_key",
              permissions: ["system.admin"],
            },
          }));
          return;
        }
        throw new HttpError(503, 503, "Account auth is not configured.");
      }
      let session: Awaited<ReturnType<typeof authService.signInWithPassword>>;
      try {
        session = shouldBootstrapAdmin
          ? await authService.signInBootstrapAdmin({
              email,
              password,
              displayName: "SteamHarness Admin",
            })
          : await authService.signInWithPassword({ email, password });
      } catch (authError) {
        if (shouldBootstrapAdmin && hasConfiguredAdminKey() && isAuthBackendUnavailable(authError)) {
          writeAdminKeySessionCookie(res);
          void recordAuthAudit(req, {
            principalKind: "admin_key",
            actorDisplayName: email,
            eventType: "auth.password.login",
            outcome: "success",
            context: {
              email,
              via: "bootstrap_admin_fallback",
              reason: authError instanceof Error ? authError.message : "unknown",
            },
          }).catch(() => undefined);
          res.json(ok<AuthSessionResponse>({
            authenticated: true,
            principal: {
              kind: "admin_key",
              permissions: ["system.admin"],
            },
          }));
          return;
        }
        // Record failed password attempts so brute-force scans and
        // repeated invalid logins show up in audit + eventType=auth.password.login
        // with outcome=failed. We re-throw so the outer error middleware
        // produces the usual 401 envelope for the client.
        await recordAuthAudit(req, {
          principalKind: shouldBootstrapAdmin ? "admin_session" : "user_session",
          actorUserId: undefined,
          actorProfileId: undefined,
          actorDisplayName: email,
          eventType: "auth.password.login",
          outcome: "failed",
          context: {
            email,
            reason: authError instanceof Error ? authError.message : "unknown",
            via: shouldBootstrapAdmin ? "bootstrap_admin" : "password",
          },
        }).catch(() => undefined);
        throw authError;
      }
      writeAuthSessionCookie(res, session);
      const accountDb = getWorkflowAuthContext().accountDb;
      const profile = await accountDb?.getUserProfileOrThrow(session.user.userId);
      const principalKind = profile?.permissions.includes("system.admin") ? "admin_session" : "user_session";
      await recordAuthAudit(req, {
        principalKind,
        actorUserId: session.user.userId,
        actorProfileId: session.user.userId,
        actorDisplayName: session.user.displayName,
        eventType: "auth.password.login",
        outcome: "success",
      });
      // Non-web clients (Desktop / CLI) need a Bearer-style API key
      // instead of the session cookie, so when the client opts in by
      // passing source === "desktop" (or "cli"), we also mint a long-lived
      // API key tied to this user and return the token alongside the
      // principal. The cookie is still set for parity with the web flow.
      const wantsApiKey = source !== undefined;
      let apiKeyRecord: { id: string; userId?: string; name?: string; prefix?: string; source?: string; scopes?: string[]; createdAt?: string; expiresAt?: string } | null = null;
      let apiKeyToken: string | null = null;
      if (wantsApiKey) {
        if (!accountDb) {
          throw new HttpError(503, 503, "Account storage is not configured.");
        }
        const rawClientName =
          typeof req.body?.clientName === "string" && req.body.clientName.trim() !== ""
            ? req.body.clientName.trim()
            : source === "desktop"
              ? "SteamHarness Desktop login"
              : "SteamHarness CLI login";
        // Rate-limit the implicit API-key mint against its own
        // bucket keyed by user+IP so a legitimate user can re-login across
        // sessions without burning their quota for manually creating keys
        // via /api/auth/api-keys.
        const apiKeyAttempt = consumeAuthRateLimit({
          scope: "password-login-api-key",
          key: `${session.user.userId}:${readRequestIp(req) ?? "unknown"}`,
          maxAttempts: AUTH_RATE_LIMITS.passwordLoginApiKey.maxAttempts,
          retryAfterSeconds: AUTH_RATE_LIMITS.passwordLoginApiKey.retryAfterSeconds,
        });
        if (!apiKeyAttempt.ok) {
          writeRateLimitResponse(res, apiKeyAttempt.retryAfterSeconds);
          return;
        }
        const created = await accountDb.createApiKey({
          userId: session.user.userId,
          name: rawClientName.slice(0, 80),
          source,
          scopes: [],
          createdByUserId: session.user.userId,
          expiresAt: createApiKeyExpiresAt(source),
        });
        apiKeyToken = created.token;
        apiKeyRecord = {
          id: created.record.id,
          userId: created.record.userId,
          name: created.record.name,
          prefix: created.record.prefix,
          source: created.record.source,
          scopes: created.record.scopes,
          createdAt: created.record.createdAt,
          ...(created.record.expiresAt ? { expiresAt: created.record.expiresAt } : {}),
        };
        await recordAuthAudit(req, {
          principalKind,
          actorUserId: session.user.userId,
          actorProfileId: session.user.userId,
          actorDisplayName: session.user.displayName,
          eventType: "auth.api_key.create",
          outcome: "success",
          resourceType: "api_key",
          resourceId: created.record.id,
          context: { via: "password_login", source },
        });
      }
      const responseBody: AuthSessionResponse = {
        authenticated: true,
        principal: {
          kind: principalKind,
          userId: session.user.userId,
          displayName: session.user.displayName,
          email: session.user.email,
          permissions: profile?.permissions,
        },
      };
      if (apiKeyRecord && apiKeyToken) {
        responseBody.accessToken = apiKeyToken;
        responseBody.apiKey = apiKeyRecord;
        responseBody.user = {
          userId: session.user.userId,
          email: session.user.email,
          displayName: session.user.displayName,
        };
        if (apiKeyRecord.expiresAt) {
          responseBody.expiresAt = apiKeyRecord.expiresAt;
        }
      }
      res.json(ok(responseBody));
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      const principal = await readRequestPrincipal(req).catch(() => undefined);
      if (principal && "refreshToken" in principal && principal.refreshToken) {
        await getWorkflowAuthContext().authService?.revokeSession(principal.refreshToken);
      }
      clearAuthSessionCookie(res);
      await recordAuthAudit(req, {
        principalKind: principal?.kind ?? "unknown",
        actorUserId: principal && "userId" in principal ? principal.userId : undefined,
        actorProfileId: principal && "profile" in principal ? principal.profile.userId : undefined,
        actorDisplayName: principal && "profile" in principal ? principal.profile.displayName : undefined,
        eventType: "auth.logout",
        outcome: "success",
      });
      res.json(ok({ loggedOut: true }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin-key/health", (_req, res) => {
    res.json(ok({ configured: hasConfiguredAdminKey() }));
  });

  router.get("/invitations/:token", async (req, res, next) => {
    try {
      const authService = getWorkflowAuthContext().authService;
      if (!authService) throw new HttpError(503, 503, "Account auth is not configured.");
      res.json(ok({ invitation: await authService.getInvitation(req.params.token) }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/invitations/:token/accept", json, async (req, res, next) => {
    try {
      const authService = getWorkflowAuthContext().authService;
      if (!authService) throw new HttpError(503, 503, "Account auth is not configured.");
      const session = await authService.acceptInvitation({
        token: req.params.token,
        password: requireString(req.body?.password, "password"),
        displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined,
      });
      writeAuthSessionCookie(res, session);
      await recordAuthAudit(req, {
        principalKind: "user_session",
        actorUserId: session.user.userId,
        actorProfileId: session.user.userId,
        actorDisplayName: session.user.displayName,
        eventType: "auth.user.invitation.accept",
        outcome: "success",
        resourceType: "user",
        resourceId: session.user.userId,
      });
      res.json(ok<AuthSessionResponse>({
        authenticated: true,
        principal: {
          kind: "user_session",
          userId: session.user.userId,
          displayName: session.user.displayName,
          email: session.user.email,
        },
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/device/start", json, async (req, res, next) => {
    try {
      const authAttempt = consumeAuthRateLimit({
        scope: "device-start",
        key: readRequestIp(req) ?? "unknown",
        maxAttempts: AUTH_RATE_LIMITS.deviceStart.maxAttempts,
        retryAfterSeconds: AUTH_RATE_LIMITS.deviceStart.retryAfterSeconds,
      });
      if (!authAttempt.ok) {
        writeRateLimitResponse(res, authAttempt.retryAfterSeconds);
        return;
      }
      const authService = getWorkflowAuthContext().authService;
      if (!authService) {
        throw new HttpError(503, 503, "Account auth is not configured.");
      }
      const clientName = typeof req.body?.clientName === "string" ? req.body.clientName.trim() : "SteamHarness CLI";
      const source = readNonWebClientSource(req.body?.source, "cli");
      const started = await authService.createDeviceCode({
        clientName,
        source,
        requestedScopes: Array.isArray(req.body?.requestedScopes)
          ? req.body.requestedScopes.filter((item: unknown): item is string => typeof item === "string")
          : [],
        requestedByIp: readRequestIp(req),
        userAgent: req.get("user-agent") ?? undefined,
      });
      await recordAuthAudit(req, {
        principalKind: "anonymous",
        eventType: "auth.device.start",
        outcome: "success",
        resourceType: "device_code",
        resourceId: started.record.id,
        context: {
          source,
          clientName,
        },
      });
      res.json(ok({
        deviceCode: started.deviceCode,
        userCode: started.record.userCode,
        verificationUri: `${readRequestOrigin(req)}/login/device`,
        verificationUriComplete: `${readRequestOrigin(req)}/login/device?user_code=${encodeURIComponent(started.record.userCode)}`,
        expiresAt: started.record.expiresAt,
        intervalSeconds: started.record.intervalSeconds,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/device/token", json, async (req, res, next) => {
    try {
      const deviceCode = typeof req.body?.deviceCode === "string" ? req.body.deviceCode.trim() : "";
      const authAttempt = consumeAuthRateLimit({
        scope: "device-token",
        key: `${readRequestIp(req) ?? "unknown"}:${deviceCode || "missing"}`,
        maxAttempts: AUTH_RATE_LIMITS.deviceToken.maxAttempts,
        retryAfterSeconds: AUTH_RATE_LIMITS.deviceToken.retryAfterSeconds,
      });
      if (!authAttempt.ok) {
        writeRateLimitResponse(res, authAttempt.retryAfterSeconds, {
          errCode: 429,
          errMessage: "slow_down",
          data: { retryAfterSeconds: authAttempt.retryAfterSeconds },
        });
        return;
      }
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!accountDb) {
        throw new HttpError(503, 503, "Account storage is not configured.");
      }
      if (!deviceCode) {
        throw new HttpError(400, 400, "deviceCode is required.");
      }
      const record = await accountDb.getDeviceCodeBySecret(deviceCode);
      if (!record) {
        await recordAuthAudit(req, {
          principalKind: "anonymous",
          eventType: "auth.device.token",
          outcome: "failed",
          resourceType: "device_code",
        });
        throw new HttpError(401, 401, "Invalid device code.");
      }
      if (new Date(record.expiresAt).getTime() <= Date.now() && record.state !== "consumed") {
        const expired = await accountDb.updateDeviceCodeState(record.id, { state: "expired" });
        await recordAuthAudit(req, {
          principalKind: "anonymous",
          eventType: "auth.device.token",
          outcome: "failed",
          resourceType: "device_code",
          resourceId: record.id,
          context: { state: "expired" },
        });
        res.status(409).json(fail(409, "expired_token", expired));
        return;
      }
      if (record.state === "pending") {
        res.status(428).json(fail(428, "authorization_pending", { intervalSeconds: record.intervalSeconds }));
        return;
      }
      if (record.state === "denied") {
        await recordAuthAudit(req, {
          principalKind: "anonymous",
          eventType: "auth.device.token",
          outcome: "denied",
          resourceType: "device_code",
          resourceId: record.id,
          context: { state: "denied" },
        });
        res.status(403).json(fail(403, "access_denied"));
        return;
      }
      if (record.state === "consumed") {
        await recordAuthAudit(req, {
          principalKind: "anonymous",
          eventType: "auth.device.token",
          outcome: "failed",
          resourceType: "device_code",
          resourceId: record.id,
          context: { state: "consumed" },
        });
        res.status(409).json(fail(409, "expired_token"));
        return;
      }
      if (record.state !== "approved" || !record.result?.user) {
        throw new HttpError(409, 409, "Device code is not approved.");
      }
      const consumed = await accountDb.consumeApprovedDeviceCodeWithApiKey(record.id, {
        userId: record.result.user.userId,
        name: `${record.clientName} login`,
        source: record.source,
        createdByUserId: record.approvedByUserId,
        expiresAt: record.result.expiresAt ?? createApiKeyExpiresAt(record.source),
        consumedAt: new Date().toISOString(),
        result: record.result,
      });
      if (!consumed) {
        await recordAuthAudit(req, {
          principalKind: "anonymous",
          eventType: "auth.device.token",
          outcome: "failed",
          resourceType: "device_code",
          resourceId: record.id,
          context: { state: "already_consumed" },
        });
        res.status(409).json(fail(409, "expired_token"));
        return;
      }
      const consumedRecord = consumed.deviceCode;
      await recordAuthAudit(req, {
        principalKind: "api_key",
        actorUserId: consumedRecord.result!.user!.userId,
        actorProfileId: consumedRecord.result!.user!.userId,
        actorDisplayName: consumedRecord.result!.user!.displayName,
        eventType: "auth.device.token",
        outcome: "success",
        resourceType: "api_key",
        resourceId: consumed.apiKey.record.id,
        context: {
          deviceCodeId: consumedRecord.id,
          source: consumedRecord.source,
        },
      });
      res.json(ok({
        accessToken: consumed.apiKey.token,
        apiKey: consumed.apiKey.record,
        user: consumedRecord.result!.user,
        expiresAt: consumed.apiKey.record.expiresAt,
      }));
    } catch (error) {
      next(error);
    }
  });


  router.use(requireAuthenticatedPrincipal());

  router.get("/me", async (req, res) => {
    const principal = getRequestPrincipal(req);
    if (!principal || !("profile" in principal)) {
      res.json(ok({ principal: serializePrincipal(principal), profile: null }));
      return;
    }
    res.json(ok({
      principal: serializePrincipal(principal),
      profile: principal.profile,
    }));
  });

  router.patch("/me", json, async (req, res, next) => {
    try {
      const principal = getRequestPrincipal(req);
      const accountDb = getWorkflowAuthContext().accountDb;
      const authService = getWorkflowAuthContext().authService;
      if (!principal || !("profile" in principal) || !accountDb) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      const displayName = typeof req.body?.displayName === "string" ? req.body.displayName : undefined;
      const avatarUrl = typeof req.body?.avatarUrl === "string"
        ? req.body.avatarUrl
        : req.body?.avatarUrl === null
          ? null
          : undefined;
      const email = typeof req.body?.email === "string" ? req.body.email : undefined;
      const temporaryPassword = typeof req.body?.temporaryPassword === "string" ? req.body.temporaryPassword : undefined;
      if (email || temporaryPassword) {
        if (!authService) {
          throw new HttpError(503, 503, "Account auth is not configured.");
        }
        await authService.updateAuthUser({
          userId: principal.userId,
          email,
          password: temporaryPassword,
          displayName,
        });
      }
      const profile = await accountDb.updateUserProfile(principal.userId, { displayName, avatarUrl });
      await recordAuthAudit(req, {
        principalKind: principal.kind,
        actorUserId: principal.userId,
        actorProfileId: principal.profile.userId,
        actorDisplayName: principal.profile.displayName,
        eventType: "auth.profile.update",
        outcome: "success",
        resourceType: "user_profile",
        resourceId: principal.userId,
      });
      res.json(ok({ profile }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/me/avatar", rawBody, async (req, res, next) => {
    try {
      const principal = getRequestPrincipal(req);
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!principal || !("profile" in principal) || !accountDb) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body as ArrayBuffer);
      if (buffer.length === 0) {
        throw new HttpError(400, 400, "Avatar file body is empty.");
      }
      const userId = principal.userId;
      const mimeType = req.headers["content-type"]?.split(";")[0]?.trim() ?? "image/png";
      const ext = mimeTypeToExt(mimeType);
      const hash = createHash("sha256").update(buffer).digest("hex");
      const { url: avatarUrl, backend } = await uploadAvatar(userId, hash, ext, mimeType, buffer);

      const profile = await accountDb.updateUserProfile(userId, { displayName: undefined, avatarUrl });
      await recordAuthAudit(req, {
        principalKind: principal.kind,
        actorUserId: userId,
        actorProfileId: principal.profile.userId,
        actorDisplayName: principal.profile.displayName,
        eventType: "auth.profile.avatar.upload",
        outcome: "success",
        resourceType: "user_profile",
        resourceId: userId,
        context: { avatarUrl, mimeType, size: buffer.length, backend },
      });
      res.json(ok({ profile, avatarUrl }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api-keys", async (req, res, next) => {
    try {
      const principal = getRequestPrincipal(req);
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!principal || !accountDb) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      if (principal.kind === "api_key") {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const list = hasPermission(principal, "api_keys.manage_all")
        ? await accountDb.listApiKeys()
        : "userId" in principal
          ? await accountDb.listApiKeys({ userId: principal.userId })
          : [];
      res.json(ok({ items: list }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api-keys", json, async (req, res, next) => {
    try {
      const principal = getRequestPrincipal(req);
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!principal || !accountDb || !("userId" in principal)) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      if (principal.kind === "api_key") {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const authAttempt = consumeAuthRateLimit({
        scope: "api-key-create",
        key: `${principal.userId}:${readRequestIp(req) ?? "unknown"}`,
        maxAttempts: AUTH_RATE_LIMITS.apiKeyCreate.maxAttempts,
        retryAfterSeconds: AUTH_RATE_LIMITS.apiKeyCreate.retryAfterSeconds,
      });
      if (!authAttempt.ok) {
        writeRateLimitResponse(res, authAttempt.retryAfterSeconds);
        return;
      }
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        throw new HttpError(400, 400, "name is required.");
      }
      const expiresAt = typeof req.body?.expiresAt === "string" ? req.body.expiresAt : undefined;
      const created = await accountDb.createApiKey({
        userId: principal.userId,
        name,
        source: typeof req.body?.source === "string" ? req.body.source : "manual",
        scopes: Array.isArray(req.body?.scopes)
          ? req.body.scopes.filter((item: unknown): item is string => typeof item === "string")
          : [],
        createdByUserId: principal.userId,
        expiresAt,
      });
      await recordAuthAudit(req, {
        principalKind: principal.kind,
        actorUserId: principal.userId,
        actorProfileId: principal.profile.userId,
        actorDisplayName: principal.profile.displayName,
        eventType: "auth.api_key.create",
        outcome: "success",
        resourceType: "api_key",
        resourceId: created.record.id,
      });
      res.status(201).json(ok({
        apiKey: created.record,
        token: created.token,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api-keys/:id", async (req, res, next) => {
    try {
      const principal = getRequestPrincipal(req);
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!principal || !accountDb) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      if (principal.kind === "api_key" || principal.kind === "admin_key") {
        throw new HttpError(403, 403, "Permission denied.");
      }
      const apiKey = await accountDb.getApiKeyOrThrow(req.params.id);
      if (!hasPermission(principal, "api_keys.manage_all") && (!("userId" in principal) || principal.userId !== apiKey.userId)) {
        throw new HttpError(403, 403, "Permission denied.");
      }
      await accountDb.revokeApiKey(apiKey.id);
      await recordAuthAudit(req, {
        principalKind: principal.kind,
        actorUserId: "userId" in principal ? principal.userId : undefined,
        actorProfileId: "profile" in principal ? principal.profile.userId : undefined,
        actorDisplayName: "profile" in principal ? principal.profile.displayName : undefined,
        eventType: "auth.api_key.revoke",
        outcome: "success",
        resourceType: "api_key",
        resourceId: apiKey.id,
      });
      res.json(ok({ revoked: true, id: apiKey.id }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/device/approve", json, async (req, res, next) => {
    try {
      const principal = getRequestPrincipal(req);
      const accountDb = getWorkflowAuthContext().accountDb;
      if (
        !principal ||
        !accountDb ||
        !("userId" in principal) ||
        (principal.kind !== "user_session" && principal.kind !== "admin_session")
      ) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      const userCode = typeof req.body?.userCode === "string" ? req.body.userCode.trim().toUpperCase() : "";
      const authAttempt = consumeAuthRateLimit({
        scope: "device-user-code",
        key: `${principal.userId}:${readRequestIp(req) ?? "unknown"}`,
        maxAttempts: AUTH_RATE_LIMITS.deviceUserCode.maxAttempts,
        retryAfterSeconds: AUTH_RATE_LIMITS.deviceUserCode.retryAfterSeconds,
      });
      if (!authAttempt.ok) {
        writeRateLimitResponse(res, authAttempt.retryAfterSeconds);
        return;
      }
      if (!userCode) {
        throw new HttpError(400, 400, "userCode is required.");
      }
      const record = await accountDb.getDeviceCodeByUserCode(userCode);
      if (!record) {
        throw new HttpError(404, 404, "Device code not found.");
      }
      if (record.state !== "pending") {
        throw new HttpError(409, 409, "Device code is not pending.");
      }
      const updated = await accountDb.updateDeviceCodeState(record.id, {
        state: "approved",
        approvedAt: new Date().toISOString(),
        approvedByUserId: principal.userId,
        result: {
          user: {
            userId: principal.userId,
            email: principal.profile.email,
            displayName: principal.profile.displayName,
          },
          expiresAt: createApiKeyExpiresAt(record.source),
        },
      });
      await recordAuthAudit(req, {
        principalKind: principal.kind,
        actorUserId: principal.userId,
        actorProfileId: principal.profile.userId,
        actorDisplayName: principal.profile.displayName,
        eventType: "auth.device.approve",
        outcome: "success",
        resourceType: "device_code",
        resourceId: record.id,
      });
      res.json(ok({ deviceCode: updated }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/device/deny", json, async (req, res, next) => {
    try {
      const principal = getRequestPrincipal(req);
      const accountDb = getWorkflowAuthContext().accountDb;
      if (
        !principal ||
        !accountDb ||
        !("userId" in principal) ||
        (principal.kind !== "user_session" && principal.kind !== "admin_session")
      ) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      const userCode = typeof req.body?.userCode === "string" ? req.body.userCode.trim().toUpperCase() : "";
      const authAttempt = consumeAuthRateLimit({
        scope: "device-user-code",
        key: `${principal.userId}:${readRequestIp(req) ?? "unknown"}`,
        maxAttempts: AUTH_RATE_LIMITS.deviceUserCode.maxAttempts,
        retryAfterSeconds: AUTH_RATE_LIMITS.deviceUserCode.retryAfterSeconds,
      });
      if (!authAttempt.ok) {
        writeRateLimitResponse(res, authAttempt.retryAfterSeconds);
        return;
      }
      if (!userCode) {
        throw new HttpError(400, 400, "userCode is required.");
      }
      const record = await accountDb.getDeviceCodeByUserCode(userCode);
      if (!record) {
        throw new HttpError(404, 404, "Device code not found.");
      }
      const updated = await accountDb.updateDeviceCodeState(record.id, {
        state: "denied",
        deniedAt: new Date().toISOString(),
      });
      await recordAuthAudit(req, {
        principalKind: principal.kind,
        actorUserId: principal.userId,
        actorProfileId: principal.profile.userId,
        actorDisplayName: principal.profile.displayName,
        eventType: "auth.device.deny",
        outcome: "success",
        resourceType: "device_code",
        resourceId: record.id,
      });
      res.json(ok({ deviceCode: updated }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/permissions", requirePermissionRoute("roles.read"), async (_req, res) => {
    res.json(ok({ groups: listWorkflowPermissionGroups() }));
  });

  router.get("/admin/roles", requirePermissionRoute("roles.read"), async (_req, res, next) => {
    try {
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!accountDb) {
        throw new HttpError(503, 503, "Account storage is not configured.");
      }
      const roles = await accountDb.listRoles();
      res.json(ok({ items: roles }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/roles", requirePermissionRoute("roles.manage"), json, async (req, res, next) => {
    try {
      const accountDb = getWorkflowAuthContext().accountDb;
      const principal = getRequestPrincipal(req);
      if (!accountDb || !principal || !("userId" in principal)) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      const role = await accountDb.createRole({
        name: requireString(req.body?.name, "name"),
        description: typeof req.body?.description === "string" ? req.body.description : undefined,
        permissions: readPermissionArray(req.body?.permissions),
        createdByUserId: principal.userId,
      });
      await recordAuthAudit(req, {
        ...createAuditActor(principal),
        eventType: "auth.role.create",
        outcome: "success",
        resourceType: "role",
        resourceId: role.id,
        context: {
          name: role.name,
          permissions: role.permissions,
        },
      });
      res.status(201).json(ok({ role }));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/roles/:roleId", requirePermissionRoute("roles.manage"), json, async (req, res, next) => {
    try {
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!accountDb) {
        throw new HttpError(503, 503, "Account storage is not configured.");
      }
      const role = await accountDb.updateRole(req.params.roleId, {
        name: typeof req.body?.name === "string" ? req.body.name : undefined,
        description: typeof req.body?.description === "string" ? req.body.description : undefined,
        permissions: req.body?.permissions === undefined ? undefined : readPermissionArray(req.body.permissions),
      });
      const principal = getRequestPrincipal(req);
      await recordAuthAudit(req, {
        ...createAuditActor(principal),
        eventType: "auth.role.update",
        outcome: "success",
        resourceType: "role",
        resourceId: role.id,
        context: {
          name: role.name,
          permissions: role.permissions,
        },
      });
      res.json(ok({ role }));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/admin/roles/:roleId", requirePermissionRoute("roles.manage"), async (req, res, next) => {
    try {
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!accountDb) {
        throw new HttpError(503, 503, "Account storage is not configured.");
      }
      const role = await accountDb.getRole(req.params.roleId);
      await accountDb.deleteRole(req.params.roleId);
      await recordAuthAudit(req, {
        ...createAuditActor(getRequestPrincipal(req)),
        eventType: "auth.role.delete",
        outcome: "success",
        resourceType: "role",
        resourceId: req.params.roleId,
        context: role ? { name: role.name } : undefined,
      });
      res.json(ok({ deleted: true }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/users", requirePermissionRoute("users.read"), async (req, res, next) => {
    try {
      const authService = getWorkflowAuthContext().authService;
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!authService || !accountDb) {
        throw new HttpError(503, 503, "Account auth is not configured.");
      }
      const search = typeof req.query?.search === "string" ? req.query.search.trim().toLowerCase() : "";
      const statusFilter = typeof req.query?.status === "string" ? req.query.status.trim() : "";

      const page = Math.max(1, Number(req.query?.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query?.pageSize) || 20));

      const users = await authService.listUsers();

      let items = users.map(({ user, profile }) => ({
        userId: user.userId,
        email: user.email || profile?.email || "",
        displayName: profile?.displayName ?? readProfileDisplayName(profile, user.email),
        status: profile?.status ?? "invited",
        lastSignInAt: user.lastSignInAt ?? profile?.lastLoginAt,
        createdAt: user.createdAt,
        roles: profile?.roleNames ?? [],
        permissions: profile?.permissions ?? [],
        avatarUrl: profile?.avatarUrl,
      }));

      if (statusFilter) {
        items = items.filter((u) => u.status === statusFilter);
      }
      if (search) {
        items = items.filter((u) =>
          u.email.toLowerCase().includes(search) ||
          u.displayName.toLowerCase().includes(search) ||
          u.roles.some((r) => r.toLowerCase().includes(search)),
        );
      }

      const total = items.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const start = (page - 1) * pageSize;
      res.json(ok({ items: items.slice(start, start + pageSize), total, page, pageSize, totalPages }));
    } catch (error) {
      next(error);
    }
  });



  router.get("/admin/users/invitation-link/:userId", requirePermissionRoute("users.manage"), async (req, res, next) => {
    try {
      const authService = getWorkflowAuthContext().authService;
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!authService || !accountDb) {
        throw new HttpError(503, 503, "Account auth is not configured.");
      }
      const profile = await accountDb.getUserProfile(req.params.userId);
      if (!profile) {
        throw new HttpError(404, 404, "User not found.");
      }
      const { invitationLink } = await authService.generateInviteLink(profile.email);
      res.json(ok({ invitationLink }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/users/invitations", requirePermissionRoute("users.manage"), json, async (req, res, next) => {
    try {
      const authService = getWorkflowAuthContext().authService;
      const principal = getRequestPrincipal(req);
      if (!authService || !principal || !("userId" in principal)) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      const invitation = await authService.inviteUser({
        email: requireString(req.body?.email, "email"),
        displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined,
        password: typeof req.body?.temporaryPassword === "string" ? req.body.temporaryPassword : undefined,
        redirectTo: typeof req.body?.redirectTo === "string" ? req.body.redirectTo : undefined,
        createdByUserId: principal.userId,
      });
      await recordAuthAudit(req, {
        ...createAuditActor(principal),
        eventType: "auth.user.invite",
        outcome: "success",
        resourceType: "user",
        resourceId: invitation.profile.userId,
        context: {
          email: invitation.profile.email,
          invitationLinkReturned: typeof invitation.invitationLink === "string" && invitation.invitationLink.trim() !== "",
          temporaryPasswordReturned: typeof invitation.temporaryPassword === "string" && invitation.temporaryPassword.trim() !== "",
        },
      });
      res.status(201).json(ok(invitation));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/users/:userId", requirePermissionRoute("users.manage"), json, async (req, res, next) => {
    try {
      const authService = getWorkflowAuthContext().authService;
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!authService || !accountDb) {
        throw new HttpError(503, 503, "Account auth is not configured.");
      }
      const displayName = typeof req.body?.displayName === "string" ? req.body.displayName : undefined;
      const disabled = req.body?.disabled === true ? true : req.body?.disabled === false ? false : undefined;
      const avatarUrl =
        req.body?.avatarUrl === null
          ? null
          : typeof req.body?.avatarUrl === "string"
            ? req.body.avatarUrl
            : undefined;
      await authService.updateAuthUser({
        userId: req.params.userId,
        email: typeof req.body?.email === "string" ? req.body.email : undefined,
        password: typeof req.body?.temporaryPassword === "string" ? req.body.temporaryPassword : undefined,
        displayName,
        disabled,
      });
      const profile = await accountDb.updateUserProfile(req.params.userId, {
        displayName,
        avatarUrl,
        status: disabled === undefined ? undefined : disabled ? "disabled" : "active",
      });
      await recordAuthAudit(req, {
        ...createAuditActor(getRequestPrincipal(req)),
        eventType: "auth.user.update",
        outcome: "success",
        resourceType: "user",
        resourceId: req.params.userId,
        context: {
          email: typeof req.body?.email === "string" ? req.body.email : undefined,
          displayName,
          disabled,
          avatarUrl: avatarUrl ?? undefined,
          temporaryPasswordProvided: typeof req.body?.temporaryPassword === "string" && req.body.temporaryPassword !== "",
          nextStatus: profile.status,
        },
      });
      res.json(ok({ profile }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/users/:userId/avatar", requirePermissionRoute("users.manage"), rawBody, async (req, res, next) => {
    try {
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!accountDb) {
        throw new HttpError(503, 503, "Account storage is not configured.");
      }
      const userId = req.params.userId;
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body as ArrayBuffer);
      if (buffer.length === 0) {
        throw new HttpError(400, 400, "Avatar file body is empty.");
      }
      const mimeType = req.headers["content-type"]?.split(";")[0]?.trim() ?? "image/png";
      const ext = mimeTypeToExt(mimeType);
      const hash = createHash("sha256").update(buffer).digest("hex");
      const { url: avatarUrl, backend } = await uploadAvatar(userId, hash, ext, mimeType, buffer);

      const profile = await accountDb.updateUserProfile(userId, { displayName: undefined, avatarUrl });
      await recordAuthAudit(req, {
        ...createAuditActor(getRequestPrincipal(req)),
        eventType: "auth.user.avatar.upload",
        outcome: "success",
        resourceType: "user",
        resourceId: userId,
        context: { avatarUrl, mimeType, size: buffer.length, backend },
      });
      res.json(ok({ profile, avatarUrl }));
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/users/:userId/roles", requirePermissionRoute("users.manage"), json, async (req, res, next) => {
    try {
      const accountDb = getWorkflowAuthContext().accountDb;
      if (!accountDb) {
        throw new HttpError(503, 503, "Account storage is not configured.");
      }
      const roleIds = Array.isArray(req.body?.roleIds)
        ? req.body.roleIds.filter((item: unknown): item is string => typeof item === "string")
        : [];
      const profile = await accountDb.setUserRoles(req.params.userId, roleIds);
      await recordAuthAudit(req, {
        ...createAuditActor(getRequestPrincipal(req)),
        eventType: "auth.user.roles.update",
        outcome: "success",
        resourceType: "user",
        resourceId: req.params.userId,
        context: {
          roleIds,
          roleNames: profile.roleNames,
        },
      });
      res.json(ok({ profile }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function consumeAuthRateLimit(options: {
  scope: string;
  key: string;
  maxAttempts: number;
  retryAfterSeconds: number;
}): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const bucketKey = `${options.scope}:${options.key}`;
  const existing = authRateLimitState.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    authRateLimitState.set(bucketKey, {
      count: 1,
      resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS,
    });
    return { ok: true };
  }
  if (existing.count >= options.maxAttempts) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  existing.count += 1;
  authRateLimitState.set(bucketKey, existing);
  return { ok: true };
}

function writeRateLimitResponse(
  res: express.Response,
  retryAfterSeconds: number,
  payload?: { errCode: number; errMessage: string; data?: unknown },
) {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json(
    payload
      ? fail(payload.errCode, payload.errMessage, payload.data)
      : fail(
        429,
        localizeServerMessage("Too many requests.", getRequestT(res.req)),
        { retryAfterSeconds },
      ),
  );
}

async function recordAuthAudit(
  req: express.Request,
  event: {
    principalKind: string;
    actorUserId?: string;
    actorProfileId?: string;
    actorDisplayName?: string;
    eventType: string;
    resourceType?: string;
    resourceId?: string;
    outcome: "success" | "failed" | "denied";
    context?: Record<string, unknown>;
  },
): Promise<void> {
  const authService = getWorkflowAuthContext().authService;
  const accountDb = getWorkflowAuthContext().accountDb;
  if (!authService && !accountDb) {
    return;
  }
  if (!accountDb && authService) {
    await authService.recordAudit({
      actorUserId: event.actorUserId,
      actorProfileId: event.actorProfileId,
      actorDisplayName: event.actorDisplayName,
      principalKind: event.principalKind,
      eventType: event.eventType,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome: event.outcome,
      requestIp: readRequestIp(req),
      userAgent: req.get("user-agent") ?? undefined,
      context: event.context,
    });
    return;
  }
  await recordAuditEventForRequest(req, event);
}

export function createAdminAliasRouter(): Router {
  const router = Router();
  const authRouter = createAuthRouter();
  router.use((req, _res, next) => {
    req.url = `/admin${req.url === "/" ? "" : req.url}`;
    next();
  });
  router.use(authRouter);
  return router;
}

export function createMeAliasRouter(): Router {
  const router = Router();
  const authRouter = createAuthRouter();
  router.use((req, _res, next) => {
    req.url = `/me${req.url === "/" ? "" : req.url}`;
    next();
  });
  router.use(authRouter);
  return router;
}

function serializePrincipal(principal: AuthenticatedPrincipal | undefined): AuthSessionResponse["principal"] | undefined {
  if (!principal) {
    return undefined;
  }
  if (principal.kind === "admin_key") {
    return {
      kind: principal.kind,
      permissions: principal.permissions,
    };
  }
  if (principal.kind === "api_key") {
    return {
      kind: principal.kind,
      userId: principal.userId,
      displayName: principal.profile.displayName,
      email: principal.profile.email,
      avatarUrl: principal.profile.avatarUrl,
      permissions: principal.permissions,
      apiKeyId: principal.apiKey.id,
      expiresAt: principal.apiKey.expiresAt,
      roleNames: principal.profile.roleNames,
    };
  }
  return {
    kind: principal.kind,
    userId: principal.userId,
    displayName: principal.profile.displayName,
    email: principal.profile.email,
    avatarUrl: principal.profile.avatarUrl,
    permissions: principal.permissions,
    roleNames: principal.profile.roleNames,
  };
}


function requirePermissionRoute(permission: PermissionKey) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const principal = getRequestPrincipal(req);
      if (!principal) {
        throw new HttpError(401, 401, "Unauthorized.");
      }
      if (!hasPermission(principal, permission)) {
        throw new HttpError(403, 403, "Permission denied.");
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, 400, `${fieldName} is required.`);
  }
  return value.trim();
}

function readPermissionArray(value: unknown): PermissionKey[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 400, "permissions must be an array.");
  }
  return value.filter((item): item is PermissionKey => typeof item === "string") as PermissionKey[];
}

function readRequestOrigin(req: express.Request): string {
  const origin = req.get("origin");
  if (origin && /^https?:\/\//i.test(origin)) {
    return origin.replace(/\/+$/, "");
  }
  const host = req.get("host") ?? "localhost";
  const protocol = req.protocol || "http";
  return `${protocol}://${host}`;
}

type NonWebClientSource = "desktop" | "cli";

function readNonWebClientSource(value: unknown, fallback: NonWebClientSource): NonWebClientSource;
function readNonWebClientSource(value: unknown, fallback?: undefined): NonWebClientSource | undefined;
function readNonWebClientSource(
  value: unknown,
  fallback?: NonWebClientSource,
): NonWebClientSource | undefined {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, 400, 'source must be "desktop" or "cli".');
  }
  const source = value.trim().toLowerCase();
  if (source === "desktop" || source === "cli") {
    return source;
  }
  throw new HttpError(400, 400, `Invalid non-web client source "${source}".`);
}

function readProfileDisplayName(profile: UserProfileRecord | undefined, email: string | undefined): string {
  return profile?.displayName || email || "未命名用户";
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
  };
  return map[mimeType.toLowerCase()] ?? ".png";
}

async function uploadAvatar(
  userId: string,
  hash: string,
  ext: string,
  mimeType: string,
  buffer: Buffer,
): Promise<{ url: string; backend: StorageDriver }> {
  const objectStorage = getWorkflowAuthContext().objectStorage;
  if (!objectStorage) throw new HttpError(503, 503, "Workflow object storage is not configured.");
  return {
    url: await objectStorage.uploadBuffer(`avatars/${userId}/${hash}${ext}`, buffer, mimeType),
    backend: objectStorage.driver,
  };
}

function isAuthBackendUnavailable(error: unknown): boolean {
  return !(error instanceof HttpError) || error.statusCode >= 500;
}
