import type { Request } from "express";
import {
  getRequestPrincipal,
  getProjectAuthContext,
  type AuthenticatedPrincipal,
} from "./auth";
import type {
  AuditEventInput,
  AuditEventListOptions,
  AuditEventPage,
} from "./account-db";

const REDACTED = "[redacted]";
const SECRET_KEY_PATTERN = /(token|secret|password|authorization|api[-_]?key|admin[-_]?key|cookie|session|refresh|access|credential|env|value)/i;

export interface AuditRouteEvent extends Omit<AuditEventInput, "requestIp" | "userAgent"> {}

export interface PermissionDeniedAuditEvent {
  eventType: string;
  permission: string;
  resourceType?: string;
  resourceId?: string;
  context?: Record<string, unknown>;
}

export async function recordAuditEventForRequest(
  req: Request,
  event: AuditRouteEvent,
): Promise<void> {
  const accountDb = getProjectAuthContext().accountDb;
  if (!accountDb) {
    return;
  }
  await accountDb.createAuditEvent({
    ...event,
    requestIp: readRequestIp(req),
    userAgent: req.get("user-agent") ?? undefined,
    context: redactAuditContext(event.context),
  });
}

export async function listAuditEvents(
  options: AuditEventListOptions,
): Promise<AuditEventPage> {
  const accountDb = getProjectAuthContext().accountDb;
  if (!accountDb) {
    throw new Error("Account storage is not configured.");
  }
  const page = await accountDb.listAuditEvents(options);
  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      context: redactAuditContext(item.context),
    })),
  };
}

export function createAuditActor(
  principal: AuthenticatedPrincipal | undefined,
): Pick<AuditRouteEvent, "principalKind" | "actorUserId" | "actorProfileId" | "actorDisplayName"> {
  if (!principal) {
    return { principalKind: "anonymous" };
  }
  if (principal.kind === "admin_key") {
    return { principalKind: principal.kind };
  }
  if ("profile" in principal) {
    return {
      principalKind: principal.kind,
      actorUserId: principal.userId,
      actorProfileId: principal.profile.userId,
      actorDisplayName: principal.profile.displayName,
    };
  }
  return { principalKind: "unknown" };
}

export function redactAuditContext(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactAuditValue(key, entry)]),
  );
}

export function readRequestIp(req: Request): string | undefined {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || undefined;
  }
  return req.ip || undefined;
}

export function recordPermissionDeniedForRequest(
  req: Request,
  event: PermissionDeniedAuditEvent,
): void {
  const principal = getRequestPrincipal(req);
  void recordAuditEventForRequest(req, {
    ...createAuditActor(principal),
    // 统一记录权限拒绝，避免把所有 403 误记成 audit.read.denied。
    eventType: event.eventType,
    outcome: "denied",
    resourceType: event.resourceType ?? "permission",
    resourceId: event.resourceId ?? event.permission,
    context: {
      permission: event.permission,
      ...(event.context ?? {}),
    },
  });
}

function redactAuditValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactAuditValue(key, entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redactAuditValue(nestedKey, nestedValue)]),
    );
  }
  if (typeof value === "string") {
    return shouldRedactKey(key) ? maskSensitiveString(value) : truncateString(value, 500);
  }
  return value;
}

function shouldRedactKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function maskSensitiveString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return REDACTED;
  }
  if (trimmed.length <= 8) {
    return REDACTED;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
