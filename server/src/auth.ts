
import type { NextFunction, Request, Response } from "express";
import { type AccountRepository } from "./account-db";
import { createProjectAuthServiceFromEnv, encodeCookieSession, getConfiguredAdminKey, getRequestPrincipal, hasConfiguredAdminKey, hasPermission, parseCookieHeader, readCookieSession, type AuthenticatedPrincipal, type AuthService } from "./account-auth";
import type { PermissionKey } from "./permissions";
import { fail, HttpError } from "./protocol";
import { getRequestT, localizeHttpErrorMessage, localizeServerMessage } from "./i18n";
import type { ObjectStorage } from "./object-storage";

export const STEAMHARNESS_AUTH_COOKIE = "steamharness_auth_session";
export type { AuthenticatedPrincipal } from "./account-auth";

export interface AuthContext {
  authService?: AuthService;
  accountDb?: AccountRepository;
  dataDir?: string;
  /** Object storage used for avatars; absent when no backend is configured. */
  objectStorage?: ObjectStorage;
}

let authContext: AuthContext = {};

export function configureProjectAuthContext(context: AuthContext): void {
  authContext = context;
}

export function ensureProjectAuthService(accountDb?: AccountRepository): AuthService | undefined {
  if (authContext.authService) {
    return authContext.authService;
  }
  if (!accountDb) {
    return undefined;
  }
  const authService = createProjectAuthServiceFromEnv(accountDb);
  if (authService) {
    authContext = { ...authContext, authService, accountDb };
  }
  return authService;
}

export function requireAuthenticatedPrincipal() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = await readRequestPrincipal(req);
      if (!principal) {
        res.status(401).json(fail(401, localizeServerMessage("Unauthorized.", getRequestT(req))));
        return;
      }
      res.locals.principal = principal;
      next();
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401) {
        clearAuthSessionCookie(res);
        res.status(401).json(fail(401, localizeHttpErrorMessage(error, getRequestT(req))));
        return;
      }
      if (error instanceof HttpError) {
        res.status(error.statusCode).json(fail(error.errCode, localizeHttpErrorMessage(error, getRequestT(req)), error.data));
        return;
      }
      next(error);
    }
  };
}

export function requireAdminPrincipal() {
  return requirePermission("system.admin");
}

export function requirePermission(permission: PermissionKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = await readRequestPrincipal(req);
      if (!principal) {
        res.status(401).json(fail(401, localizeServerMessage("Unauthorized.", getRequestT(req))));
        return;
      }
      if (!hasPermission(principal, permission)) {
        res.locals.principal = principal;
        res.status(403).json(fail(403, localizeServerMessage("Permission denied.", getRequestT(req))));
        return;
      }
      res.locals.principal = principal;
      next();
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401) {
        clearAuthSessionCookie(res);
        res.status(401).json(fail(401, localizeHttpErrorMessage(error, getRequestT(req))));
        return;
      }
      if (error instanceof HttpError) {
        res.status(error.statusCode).json(fail(error.errCode, localizeHttpErrorMessage(error, getRequestT(req)), error.data));
        return;
      }
      next(error);
    }
  };
}

export async function readRequestPrincipal(req: Request): Promise<AuthenticatedPrincipal | undefined> {
  const existing = getRequestPrincipal(req);
  if (existing) {
    return existing;
  }
  const authService = authContext.authService;
  if (!authService) {
    const cookieValue = parseCookieHeader(req.headers.cookie)[STEAMHARNESS_AUTH_COOKIE];
    if (cookieValue) {
      const parsed = readCookieSession(cookieValue);
      if (parsed?.kind === "admin_key") {
        return {
          kind: "admin_key",
          tokenSource: "cookie",
          isSystemAdmin: true,
        };
      }
    }
    const bearer = readBearerToken(req.headers.authorization);
    if (bearer && hasConfiguredAdminKey() && bearer === getConfiguredAdminKey()) {
      return {
        kind: "admin_key",
        tokenSource: "bearer",
        isSystemAdmin: true,
      };
    }
    return undefined;
  }
  const principal = await authService.resolvePrincipal(req);
  if (principal) {
    req.res?.locals && (req.res.locals.principal = principal);
  }
  return principal;
}

export function setAuthSessionCookie(
  res: Response,
  session: {
    refreshToken: string;
  },
): void {
  writeAuthSessionCookie(res, {
    accessToken: "",
    refreshToken: session.refreshToken,
    user: { userId: "", email: "", displayName: "" },
  });
}

export function writeAuthSessionCookie(
  res: Response,
  authServiceSession: {
    accessToken: string;
    refreshToken: string;
    expiresAt?: string;
    user: {
      userId: string;
      email: string;
      displayName: string;
    };
  },
): void {
  const authService = authContext.authService;
  if (!authService) {
    throw new Error("Workflow auth service is not configured.");
  }
  authService.setAuthCookie(res, authServiceSession);
}

export function writeAdminKeySessionCookie(res: Response): void {
  const authService = authContext.authService;
  if (authService) {
    authService.setAdminKeyCookie(res);
    return;
  }
  const encoded = encodeCookieSession({ kind: "admin_key" });
  res.append("Set-Cookie", `${STEAMHARNESS_AUTH_COOKIE}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}

export function clearAuthSessionCookie(res: Response): void {
  authContext.authService?.clearAuthCookie(res);
  if (!authContext.authService) {
    res.append("Set-Cookie", `${STEAMHARNESS_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
}

export function getProjectAuthContext(): AuthContext {
  return authContext;
}

function readBearerToken(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return readBearerToken(value[0]);
  }
  if (!value) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim();
}

export { getConfiguredAdminKey, getRequestPrincipal, hasConfiguredAdminKey };
export { hasPermission };
