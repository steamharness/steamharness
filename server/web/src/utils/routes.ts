import type { AdminTab, AppRoute, DetailTab, SettingsTab } from "../state";

export function projectSourceSharePath(id: string, version: string): string {
  return `/share/projects/${encodeURIComponent(id)}/${encodeURIComponent(version)}`;
}

export function projectSourceArchivePath(id: string, version: string): string {
  return `/api/projects/${encodeURIComponent(id)}/source-archive?target=${encodeURIComponent(version)}`;
}

// /detail 的设置与成员现在使用稳定子路由，避免只靠概览页内局部状态切换。
const DETAIL_TABS = new Set<DetailTab>(["configurations","project", "settings", "members", "invitations", "dependencies", "knowledge", "versions", "kv"]);
const ADMIN_TABS = new Set<AdminTab>(["users", "audit"]);
const SETTINGS_TABS = new Set<SettingsTab>(["profile", "appearance", "api-keys"]);

export function parseRoute(pathname: string): AppRoute {
  let segments: string[];
  try { segments = pathname.split("/").filter(Boolean).map(decodeURIComponent); }
  catch { return { page: "projects" }; }
  const search = new URLSearchParams(window.location.search);

  if (segments.length === 4 && segments[0] === "share" && segments[1] === "projects" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segments[2]) && /^\d+\.\d+\.\d+$/.test(segments[3])) {
    return { page: "source-share", id: segments[2], version: segments[3] };
  }

  if (segments.length === 0 || segments[0] === "projects") {
    return { page: "projects" };
  }

  if (segments[0] === "account") {
    if (segments[1] === "invite" && segments[2]) {
      return { page: "account-invite", token: segments[2] };
    }
    return { page: "settings", tab: "profile" };
  }

  if (segments[0] === "settings") {
    const tab = SETTINGS_TABS.has(segments[1] as SettingsTab) ? (segments[1] as SettingsTab) : "profile";
    return { page: "settings", tab };
  }

  if (segments[0] === "audit") {
    return { page: "admin", tab: "audit" };
  }

  // keep the login mockup mapped to a stable route instead of normalizing it to projects.
  if (segments[0] === "login") {
    if (segments[1] === "device") {
      const userCode = search.get("user_code")?.trim() || undefined;
      return { page: "device", ...(userCode ? { userCode } : {}) };
    }
    // Only the two values this app knows how to return to, so a hand-written
    // `?next=` cannot send anyone anywhere else.
    return { page: "login" };
  }

  if (segments[0] === "users") {
    return { page: "admin", tab: "users" };
  }

  if (segments[0] === "groups") return {page:"groups",id:segments[1]};

  if (segments[0] === "admin") {
    const tab = ADMIN_TABS.has(segments[1] as AdminTab) ? (segments[1] as AdminTab) : "users";
    return { page: "admin", tab };
  }

  if (segments[0] === "detail" && segments[1]) {
    const tab = DETAIL_TABS.has(segments[2] as DetailTab) ? (segments[2] as DetailTab) : "project";
    return { page: "detail", id: segments[1], tab };
  }


  if (segments[0] === "invite" && segments[1]) {
    return { page: "invite", token: segments[1] };
  }

  if (segments[0] === "access-requests" && segments[1]) {
    return { page: "access-request", token: segments[1] };
  }

  return { page: "projects" };
}

export function routeToPath(route: AppRoute): string {
  if (route.page === "login") return "/login";
  if (route.page === "device") {
    const query = route.userCode ? `?user_code=${encodeURIComponent(route.userCode)}` : "";
    return `/login/device${query}`;
  }
  if (route.page === "groups") return `/groups${route.id?`/${encodeURIComponent(route.id)}`:""}`;
  if (route.page === "settings") return `/settings/${route.tab}`;
  if (route.page === "admin") return `/admin/${route.tab}`;
  if (route.page === "detail") {
    return `/detail/${encodeURIComponent(route.id)}/${route.tab}`;
  }
  if (route.page === "invite") return `/invite/${encodeURIComponent(route.token)}`;
  if (route.page === "account-invite") return `/account/invite/${encodeURIComponent(route.token)}`;
  if (route.page === "access-request") return `/access-requests/${encodeURIComponent(route.token)}`;
  if (route.page === "source-share") return projectSourceSharePath(route.id, route.version);
  return "/projects";
}

export function readRouteProjectId(route: AppRoute): string {
  return route.page === "detail" ? route.id : "";
}

export function replaceCurrentRouteIfNeeded(): void {
  const parsed = parseRoute(window.location.pathname);
  const normalizedPath = routeToPath(parsed);
  if (`${window.location.pathname}${window.location.search}` !== normalizedPath) {
    window.history.replaceState(null, "", normalizedPath);
  }
}
