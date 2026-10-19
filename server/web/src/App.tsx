
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Database, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { resolvePrincipalAvatarUrl } from "@steamharness/avatar-fallback";
import { toast } from "sonner";
import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n, persistLocale, readStoredLocale, resolveLocalePreference, translateDynamicKey, useTranslation, type LocalePreference } from "@steamharness/i18n/react";
import { apiClient } from "./api";
import { ADMIN_TAB_META, AppLayout, CONSOLE_NAV_ICONS } from "./components/AppLayout";
import { LoginPage } from "./components/LoginPage";
import { Badge } from "@/components/ui/badge";
import { AccountPage } from "./pages/AccountPage";
import { AccountInvitePage } from "./pages/AccountInvitePage";
import { ConfirmActionDialog } from "./components/ConfirmActionDialog";
import { AuditPage } from "./pages/AuditPage";
import { DetailPage, getDetailNavGroups, resolveDetailTab } from "./pages/DetailPage";
import { InviteAcceptPage } from "./pages/InviteAcceptPage";
import { ProjectSourceAccessRequestPage } from "./pages/ProjectSourceAccessRequestPage";
import { ProjectSourceSharePage } from "./pages/ProjectSourceSharePage";
import { DeviceApprovalPage } from "./pages/DeviceApprovalPage";
import type { KVFilters } from "./pages/ProjectKVPage";
import { ProjectListPage } from "./pages/ProjectListPage";
import { RolesPage } from "./pages/RolesPage";
import { UsersPage } from "./pages/UsersPage";
import { type AccountViewState, type AuditFilters, type AuditViewState, type AdminRolesState, type AdminUsersState, DEFAULT_AUDIT_FILTERS, DEFAULT_DETAIL, LOCALE_STORAGE_KEY, THEME_STORAGE_KEY, type AppRoute, type AsyncState, type DetailTab, type DetailState, type SettingsTab, type SessionState, type ThemeMode } from "./state";
import { isApiSuccess, type AdminUserSummary, type KVEntrySummary, type PermissionKey, type RoleRecord, type Summary, type UserInvitationResult } from "./types";
import { parseRoute, readRouteProjectId, replaceCurrentRouteIfNeeded, routeToPath } from "./utils/routes";
import { normalizeDateTimeFilter } from "./utils/date-filters";
import { consumeUnseenServerRelease } from "./lib/server-release-notes";
import { getWorkflowProjectDisplayName, getWorkflowProjectServerStorageAccess } from "./utils/project-presentation";

// keeps all server/web server-backed table pagination at 20 rows.
const RUN_PAGE_SIZE = 20;
const KV_PAGE_SIZE = 20;
const AUDIT_PAGE_SIZE = 20;

type PendingKnowledgeNavigation = {
  route: AppRoute;
  options: { replace?: boolean; skipKnowledgeGuard?: boolean };
  onConfirm?: () => void;
};

function leavesKnowledgeWorkspace(current: AppRoute, next: AppRoute): boolean {
  return current.page === "detail" &&
    current.tab === "knowledge" &&
    (next.page !== "detail" || next.id !== current.id || next.tab !== "knowledge");
}

const DEFAULT_KV_FILTERS: KVFilters = {
  query: "",
  scope: "all",
  valueType: "all",
  conversationId: "",
  runId: "",
};

function pushToast(tone: "success" | "error", message: string) {
  toast[tone](message);
}

function isUploadedVersionProject(project: Summary): boolean {
  return Array.isArray(project.versions);
}

export function App() {
  return (
    <ThemeProvider attribute={["class", "data-theme"]} defaultTheme="system" storageKey={THEME_STORAGE_KEY}>
      <TooltipProvider>
        <AppContent />
        <Toaster closeButton />
      </TooltipProvider>
    </ThemeProvider>
  );
}

function AppContent() {
  const { t } = useTranslation("serverWeb");
  const { theme: themePreference, setTheme } = useTheme();
  const theme: ThemeMode = themePreference === "light" || themePreference === "dark" ? themePreference : "system";
  const [session, setSession] = useState<SessionState>({ status: "checking" });
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [deviceUserCode, setDeviceUserCode] = useState(() => route.page === "device" ? route.userCode ?? "" : "");
  const [deviceStatusMessage, setDeviceStatusMessage] = useState<string | null>(null);
  const [projects, setProjects] = useState<Summary[]>([]);
  const [accountView, setAccountView] = useState<AccountViewState>({ me: null, apiKeys: null });
  const [auditView, setAuditView] = useState<AuditViewState>({ page: null, selectedEventId: null });
  const [adminUsers, setAdminUsers] = useState<AdminUsersState>({
    items: null,
    total: 0,
    page: 1,
    pageSize: 20,
    totalPages: 0,
    search: "",
    status: "",
  });
  const [adminRoles, setAdminRoles] = useState<AdminRolesState>({ items: null, groups: null });
  const [createdApiKeyToken, setCreatedApiKeyToken] = useState<string | null>(null);
  const [latestInvitation, setLatestInvitation] = useState<UserInvitationResult | null>(null);
  const [selectedId, setSelectedId] = useState(() => readRouteProjectId(parseRoute(window.location.pathname)));
  const [kvFilters, setKVFilters] = useState<KVFilters>(DEFAULT_KV_FILTERS);
  const [knowledgeRefreshToken, setKnowledgeRefreshToken] = useState(0);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [detailContentBusy, setDetailContentBusy] = useState(false);
  const [pendingKnowledgeNavigation, setPendingKnowledgeNavigation] = useState<PendingKnowledgeNavigation | null>(null);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  const [detail, setDetail] = useState<DetailState>(DEFAULT_DETAIL);
  const [localePreference, setLocalePreference] = useState<LocalePreference>(() => readStoredLocale(LOCALE_STORAGE_KEY));
  const [busy, setBusy] = useState<AsyncState>({});
  const projectDetailRequestRef = useRef(0);
  const projectKVRequestRef = useRef(0);
  const detailWorkflowIdRef = useRef<string | null>(null);
  const projectKVCursorHistoryRef = useRef<Array<string | undefined>>([undefined]);
  const auditCursorHistoryRef = useRef<Array<string | undefined>>([undefined]);
  const auditRequestRef = useRef(0);
  const validateSessionRequestRef = useRef(0);
  const [projectKVPageIndex, setProjectKVPageIndex] = useState(0);
  const [auditPageIndex, setAuditPageIndex] = useState(0);
  const page = route.page;
  const requestedDetailTab = route.page === "detail" ? route.tab : undefined;
  const selectedIdRef = useRef(selectedId);
  const routeRef = useRef(route);
  const knowledgeDraftDirtyRef = useRef(false);
  selectedIdRef.current = selectedId;
  routeRef.current = route;

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedId),
    [projects, selectedId],
  );
  const activeDetailTab = requestedDetailTab && selectedProject
    ? resolveDetailTab(selectedProject, requestedDetailTab)
    : requestedDetailTab;
  const selectedProjectDisplayName = selectedProject
    ? getWorkflowProjectDisplayName(selectedProject, i18n.language)
    : undefined;
  const selectedProjectServerStorageAllowed = selectedProject
    ? getWorkflowProjectServerStorageAccess(selectedProject).allowed
    : false;
  const principalPermissions = useMemo(
    () => new Set<PermissionKey>((session.status === "ready" ? (session.principal.permissions ?? []) : []) as PermissionKey[]),
    [session],
  );
  const isSystemAdmin =
    session.status === "ready" &&
    (
      session.principal.kind === "admin_key" ||
      session.principal.kind === "admin_session" ||
      principalPermissions.has("system.admin")
    );
  const hasAssignedGlobalRole =
    session.status === "ready" &&
    (session.principal.roleNames?.length ?? 0) > 0;
  const canViewProjects =
    isSystemAdmin ||
    // ordinary project users need the project workspace entry; the
    // backend still filters unreadable private projects from the list.
    principalPermissions.has("projects.read_all") ||
    principalPermissions.has("projects.read_public");
  const canViewAudit = isSystemAdmin || principalPermissions.has("audit.read");
  const canViewUsers = isSystemAdmin || principalPermissions.has("users.read");
  const canViewRoles = isSystemAdmin || principalPermissions.has("roles.read");
  const canManageRoles = isSystemAdmin || principalPermissions.has("roles.manage");
  const detailBelongsToSelectedProject = page !== "detail" || !selectedProject || detailWorkflowIdRef.current === selectedProject.id;
  const renderedDetail = detailBelongsToSelectedProject ? detail : DEFAULT_DETAIL;
  const renderedBusy = detailBelongsToSelectedProject ? busy : { ...busy, project: busy.project ?? t("busyLoadProjectDetail") };

  useEffect(() => {
    replaceCurrentRouteIfNeeded();
    function handlePopState() {
      const nextRoute = parseRoute(window.location.pathname);
      if (knowledgeDraftDirtyRef.current && leavesKnowledgeWorkspace(routeRef.current, nextRoute)) {
        window.history.pushState(null, "", routeToPath(routeRef.current));
        // The browser already moved to `nextRoute` before popstate. Restore
        // the current page for the decision, then replace that temporary
        // history entry after confirmation so Back never returns to a draft
        // the user explicitly discarded.
        setPendingKnowledgeNavigation({ route: nextRoute, options: { replace: true } });
        return;
      }
      setRoute(nextRoute);
      setSelectedId(readRouteProjectId(nextRoute));
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!knowledgeDraftDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    if (route.page === "device") {
      setDeviceUserCode(route.userCode ?? "");
    }
  }, [route]);

  useEffect(() => {
    if (session.status === "anonymous" && route.page !== "login") {
      if (route.page !== "device" && route.page !== "invite" && route.page !== "account-invite" && route.page !== "access-request" && route.page !== "source-share") {
        navigateTo({ page: "login" }, { replace: true });
      }
    }
    if (session.status === "ready" && route.page === "login") {
      if (canViewProjects) {
        navigateTo({ page: "projects" }, { replace: true });
      } else {
        navigateTo({ page: "settings", tab: "profile" }, { replace: true });
      }
    }
    if (session.status === "ready" && route.page === "projects" && !canViewProjects) {
      // Users without project access still fall back to account center.
      navigateTo({ page: "settings", tab: "profile" }, { replace: true });
    }
    if (session.status === "ready" && route.page === "admin") {
      if (route.tab === "audit" && !canViewAudit) {
        navigateTo({ page: "settings", tab: "profile" }, { replace: true });
      }
      if (route.tab === "users" && !canViewUsers) {
        navigateTo({ page: "settings", tab: "profile" }, { replace: true });
      }
      if (route.tab === "roles" && !canViewRoles) {
        navigateTo({ page: "settings", tab: "profile" }, { replace: true });
      }
    }
    if (session.status === "ready" && route.page === "device" && !deviceUserCode.trim()) {
      navigateTo({ page: "settings", tab: "profile" }, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status, route.page, route.page === "admin" ? route.tab : "", canViewProjects, canViewAudit, canViewUsers, canViewRoles, isSystemAdmin, deviceUserCode]);

  useEffect(() => {
    void validateSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (session.status !== "ready") return;
    void loadProjects({ keepSelection: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status]);

  useEffect(() => {
    if (route.page !== "detail" || !selectedProject || !activeDetailTab || route.tab === activeDetailTab) return;
    navigateTo(
      { page: "detail", id: selectedProject.id, tab: activeDetailTab },
      { replace: true, skipKnowledgeGuard: true },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDetailTab, route, selectedProject?.id]);

  useEffect(() => {
    if (session.status !== "ready") return;
    if (route.page === "settings") {
      void loadAccountView();
      return;
    }
    if (route.page === "admin" && route.tab === "users" && canViewUsers) {
      void loadAdminUsers();
      void ensureAdminRolesLoaded();
      return;
    }
    if (route.page === "admin" && route.tab === "roles" && canViewRoles) {
      void loadAdminRoles();
      return;
    }
    if (route.page === "admin" && route.tab === "audit" && canViewAudit) {
      void loadAuditEvents({ reset: true });
      return;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status, route.page, route.page === "admin" || route.page === "settings" ? route.tab : "", canViewAudit, canViewUsers, canViewRoles]);

  useEffect(() => {
    if (session.status !== "ready" || page !== "detail" || !selectedProject) return;
    void loadProjectDetail(selectedProject.id);
    return () => { projectDetailRequestRef.current += 1; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status, page, selectedProject?.id, selectedProject?.canManage, activeDetailTab, selectedProjectServerStorageAllowed]);

  useEffect(() => {
    if (session.status !== "ready" || !selectedProject || !selectedProjectServerStorageAllowed || page !== "detail" || route.page !== "detail" || route.tab !== "kv") return;
    void loadProjectKV(selectedProject.id, { reset: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status, selectedProject?.id, selectedProjectServerStorageAllowed, page, route, kvFilters]);

  useEffect(() => {
    if (session.status !== "ready" || page !== "admin" || route.page !== "admin" || route.tab !== "audit") return;
    void loadAuditEvents({ reset: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status, page, route, auditFilters]);

  // stage one replaces localStorage admin tokens with server-backed session checks.
  async function validateSession() {
    const requestId = ++validateSessionRequestRef.current;
    setBusy({ global: t("busyConnectingServer") });
    const health = await apiClient.health();
    if (requestId !== validateSessionRequestRef.current) {
      return;
    }
    if (!isApiSuccess(health)) {
      setBusy({});
      setSession({ status: "anonymous", message: t("appConnectServerFailed") });
      return;
    }
    const releaseAnnouncement = consumeUnseenServerRelease(health.data);
    if (releaseAnnouncement) {
      toast(releaseAnnouncement.title, {
        description: releaseAnnouncement.summary,
        action: releaseAnnouncement.docsUrl
          ? {
              label: t("appReleaseNotesViewFull"),
              onClick: () => window.open(
                releaseAnnouncement.docsUrl,
                "_blank",
                "noopener,noreferrer",
              ),
            }
          : undefined,
      });
    }
    const sessionState = await apiClient.getSession();
    if (requestId !== validateSessionRequestRef.current) {
      return;
    }
    setBusy({});
    if (!isApiSuccess(sessionState)) {
      // 登录页首屏的匿名会话探测允许返回 401，不应直接渲染成登录失败提示。
      if (sessionState.errCode === 401) {
        setSession({ status: "anonymous" });
        return;
      }
      setSession({ status: "anonymous", message: sessionState.errMessage });
      return;
    }
    if (!sessionState.data.authenticated || !sessionState.data.principal) {
      setSession({ status: "anonymous" });
      return;
    }

    const workflows = await apiClient.listWorkflows();
    if (requestId !== validateSessionRequestRef.current) {
      return;
    }
    if (!isApiSuccess(workflows)) {
      if (workflows.errCode === 401) {
        setSession({ status: "anonymous", message: t("appSessionExpiredRelogin") });
        return;
      }
      setSession({ status: "anonymous", message: workflows.errMessage });
      return;
    }
    // Directly opening account-system routes can race multiple
    // bootstrap validations; only the latest request may reset account/admin
    // view state or older responses will blank pages after they already loaded.
    setSession({ status: "ready", principal: sessionState.data.principal });
    setAccountView({ me: null, apiKeys: null });
    setAdminUsers({ items: null, total: 0, page: 1, pageSize: 20, totalPages: 0, search: "", status: "" });
    setAdminRoles({ items: null, groups: null });
    const uploadedProjects = workflows.data.filter(isUploadedVersionProject);
    setProjects(uploadedProjects);
    setSelectedId((current) => {
      const routeProjectId = readRouteProjectId(route);
      if (routeProjectId && uploadedProjects.some((p) => p.id === routeProjectId)) return routeProjectId;
      return current;
    });
  }

  async function loadAccountView() {
    setBusy((state) => ({ ...state, account: t("busyLoadAccount"), apiKeys: state.apiKeys ?? t("busyApiKeys") }));
    const [meResult, apiKeyResult] = await Promise.all([
      apiClient.getMe(),
      apiClient.listApiKeys(),
    ]);
    setBusy((state) => ({ ...state, account: undefined, apiKeys: undefined }));
    if (!isApiSuccess(meResult)) {
      pushToast("error", meResult.errMessage);
      return;
    }
    if (!isApiSuccess(apiKeyResult)) {
      pushToast("error", apiKeyResult.errMessage);
      return;
    }
    setAccountView((current) => ({
      ...current,
      me: meResult.data,
      apiKeys: apiKeyResult.data.items,
    }));
  }

  async function ensureAdminRolesLoaded() {
    if (adminRoles.items && adminRoles.groups) {
      return;
    }
    await loadAdminRoles();
  }

  async function loadAdminUsers(params?: { search?: string; status?: string; page?: number; pageSize?: number }) {
    const search = params?.search ?? adminUsers.search;
    const status = params?.status ?? adminUsers.status;
    setBusy((state) => ({ ...state, users: t("busyLoadUsers") }));
    const res = await apiClient.listAdminUsers({
      ...params,
      search: search || undefined,
      status: status || undefined,
    });
    setBusy((state) => ({ ...state, users: undefined }));
    if (!isApiSuccess(res)) {
      pushToast("error", res.errMessage);
      return;
    }
    setAdminUsers({
      items: res.data.items,
      total: res.data.total,
      page: res.data.page,
      pageSize: res.data.pageSize,
      totalPages: res.data.totalPages,
      search,
      status,
    });
  }

  async function loadAdminRoles() {
    setBusy((state) => ({ ...state, roles: t("busyLoadRoles") }));
    const [rolesResult, permissionsResult] = await Promise.all([
      apiClient.listAdminRoles(),
      apiClient.listAdminPermissions(),
    ]);
    setBusy((state) => ({ ...state, roles: undefined }));
    if (!isApiSuccess(rolesResult)) {
      pushToast("error", rolesResult.errMessage);
      return;
    }
    if (!isApiSuccess(permissionsResult)) {
      pushToast("error", permissionsResult.errMessage);
      return;
    }
    setAdminRoles({
      items: rolesResult.data.items,
      groups: permissionsResult.data.groups,
    });
  }

  async function loadProjects(options: { keepSelection?: boolean } = {}) {
    setBusy((s) => ({ ...s, global: t("busyGlobalRefreshProjects") }));
    const res = await apiClient.listWorkflows();
    setBusy((s) => ({ ...s, global: undefined }));
    if (!isApiSuccess(res)) { pushToast("error", res.errMessage); return; }
    const uploadedProjects = res.data.filter(isUploadedVersionProject);
    setProjects(uploadedProjects);
    setSelectedId((current) => {
      const routeProjectId = readRouteProjectId(route);
      if (routeProjectId && uploadedProjects.some((p) => p.id === routeProjectId)) return routeProjectId;
      if (options.keepSelection && uploadedProjects.some((p) => p.id === current)) return current;
      return current;
    });
  }
  async function loadProjectDetail(workflowName: string) {
    const requestId = ++projectDetailRequestRef.current;
    const switching = detailWorkflowIdRef.current !== workflowName;
    detailWorkflowIdRef.current = workflowName;
    if (switching) { projectKVRequestRef.current += 1; setDetail(DEFAULT_DETAIL); projectKVCursorHistoryRef.current = [undefined]; setProjectKVPageIndex(0); }
    setBusy(state => ({...state, project: t("busyLoadProjectDetail")}));
    const [versions, members, invitations, dataSummary] = await Promise.all([
      apiClient.listVersions(workflowName), apiClient.listProjectMembers(workflowName),
      activeDetailTab === "invitations" && selectedProject?.canManage ? apiClient.listProjectInvitations(workflowName) : undefined,
      activeDetailTab === "project" && selectedProjectServerStorageAllowed ? apiClient.getProjectDataSummary(workflowName) : undefined,
    ]);
    if (requestId !== projectDetailRequestRef.current || selectedIdRef.current !== workflowName) return;
    setBusy(state => ({...state, project: undefined}));
    for (const result of [versions, members, invitations, dataSummary]) if (result && !isApiSuccess(result)) pushToast("error", result.errMessage);
    setDetail(state => ({...state, versions: isApiSuccess(versions) ? versions.data : null,
      members: isApiSuccess(members) ? members.data : null,
      invitations: invitations ? isApiSuccess(invitations) ? invitations.data : null : state.invitations,
      dataSummary: dataSummary ? isApiSuccess(dataSummary) ? dataSummary.data : null : state.dataSummary,
      loadErrors: {
        versions: !isApiSuccess(versions) ? versions.errMessage : undefined,
        members: !isApiSuccess(members) ? members.errMessage : undefined,
        invitations: invitations && !isApiSuccess(invitations) ? invitations.errMessage : undefined,
        dataSummary: dataSummary && !isApiSuccess(dataSummary) ? dataSummary.errMessage : undefined,
      }}));
  }

  async function updateProjectVisibility(visibility: "private" | "public") {
    if (!selectedProject) return;
    setBusy((s) => ({ ...s, project: t("busyProjectVisibility") }));
    const res = await apiClient.updateProjectVisibility(selectedProject.id, { visibility });
    setBusy((s) => ({ ...s, project: undefined }));
    if (!isApiSuccess(res)) {
      pushToast("error", res.errMessage);
      return;
    }
    setProjects((items) => items.map((project) => project.id === selectedProject.id ? { ...project, visibility: res.data.visibility } : project));
    setDetail((state) => ({ ...state, members: state.members, }));
    pushToast("success", visibility === "public" ? t("toastProjectVisibilityPublic") : t("toastProjectVisibilityPrivate"));
    void loadProjectDetail(selectedProject.id);
  }

  async function setProjectMember(userId: string, role: "owner" | "manager" | "writer" | "viewer") {
    if (!selectedProject) return;
    setBusy((s) => ({ ...s, project: t("busySetProjectMember") }));
    const res = await apiClient.setProjectMember(selectedProject.id, userId, { role });
    setBusy((s) => ({ ...s, project: undefined }));
    if (!isApiSuccess(res)) {
      pushToast("error", res.errMessage);
      return;
    }
    pushToast("success", t("toastMemberUpdated", { userId, role }));
    void loadProjectDetail(selectedProject.id);
  }

  async function removeProjectMember(userId: string) {
    if (!selectedProject) return;
    setBusy((s) => ({ ...s, project: t("busyRemoveProjectMember") }));
    const res = await apiClient.removeProjectMember(selectedProject.id, userId);
    setBusy((s) => ({ ...s, project: undefined }));
    if (!isApiSuccess(res)) {
      pushToast("error", res.errMessage);
      return;
    }
    pushToast("success", res.data.removed ? t("toastMemberRemoved", { userId }) : t("toastMemberUnchanged", { userId }));
    void loadProjectDetail(selectedProject.id);
  }

  async function createProjectInvitation(role: "manager" | "writer" | "viewer"): Promise<{
    invitation: import("./types").ProjectInvitation;
    token: string;
    shareUrl: string;
  } | null> {
    if (!selectedProject) return null;
    setBusy((s) => ({ ...s, invitation: t("busyGenerateInvitation") }));
    const res = await apiClient.createProjectInvitation(selectedProject.id, { role });
    setBusy((s) => ({ ...s, invitation: undefined }));
    if (!isApiSuccess(res)) {
      pushToast("error", res.errMessage);
      return null;
    }
    const shareUrl = `${window.location.origin}/invite/${encodeURIComponent(res.data.token)}`;
    pushToast("success", t("toastInvitationGenerated"));
    void loadProjectDetail(selectedProject.id);
    return { ...res.data, shareUrl };
  }

  async function revokeProjectInvitation(invitationId: string) {
    if (!selectedProject) return;
    setBusy((s) => ({ ...s, revokeInvitationId: invitationId }));
    const res = await apiClient.revokeProjectInvitation(selectedProject.id, invitationId);
    setBusy((s) => ({ ...s, revokeInvitationId: undefined }));
    if (!isApiSuccess(res)) {
      pushToast("error", res.errMessage);
      return;
    }
    pushToast("success", t("toastInvitationRevoked"));
    void loadProjectDetail(selectedProject.id);
  }

  async function loadProjectKV(workflowName: string, options: { reset?: boolean; cursor?: string; pageIndex?: number } = {}) {
    const project = projects.find((item) => item.id === workflowName);
    if (project && !getWorkflowProjectServerStorageAccess(project).allowed) return;
    const cursor = options.reset ? undefined : options.cursor;
    const pageIndex = options.reset ? 0 : options.pageIndex ?? 0;
    if (!options.reset && busy.kv) return;
    const requestId = ++projectKVRequestRef.current;
    setBusy((s) => ({ ...s, kv: options.reset ? t("busyKvLoad") : t("busyKvPage") }));
    if (options.reset) { projectKVCursorHistoryRef.current = [undefined]; setProjectKVPageIndex(0); setDetail((s) => ({ ...s, kv: null })); }
    const res = await apiClient.listProjectKVEntries(workflowName, { pageSize: KV_PAGE_SIZE, cursor, scope: kvFilters.scope, query: kvFilters.query, valueType: kvFilters.valueType, conversationId: kvFilters.conversationId, runId: kvFilters.runId });
    if (requestId !== projectKVRequestRef.current || selectedIdRef.current !== workflowName) return;
    setBusy((s) => ({ ...s, kv: undefined }));
    if (!isApiSuccess(res)) { pushToast("error", res.errMessage); return; }
    setDetail((s) => ({ ...s, kv: res.data }));
    setProjectKVPageIndex(pageIndex);
  }

  async function loadAuditEvents(options: { reset?: boolean; cursor?: string; pageIndex?: number } = {}) {
    const cursor = options.reset ? undefined : options.cursor;
    const pageIndex = options.reset ? 0 : options.pageIndex ?? 0;
    if (!options.reset && busy.audit) return;
    // 审计页筛选和翻页共享同一请求闸门，避免旧响应覆盖当前页。
    const requestId = ++auditRequestRef.current;
    setBusy((s) => ({ ...s, audit: options.reset ? t("busyLoadAudit") : t("busyUpdateAuditPage") }));
    if (options.reset) {
      auditCursorHistoryRef.current = [undefined];
      setAuditPageIndex(0);
      setAuditView({ page: null, selectedEventId: null });
    }
    const res = await apiClient.listAuditEvents({
      pageSize: AUDIT_PAGE_SIZE,
      cursor,
      from: normalizeDateTimeFilter(auditFilters.from),
      to: normalizeDateTimeFilter(auditFilters.to, "end"),
      actorUserId: auditFilters.actorUserId || undefined,
      principalKind: auditFilters.principalKind || undefined,
      eventType: auditFilters.eventType || undefined,
      resourceType: auditFilters.resourceType || undefined,
      resourceId: auditFilters.resourceId || undefined,
      outcome: auditFilters.outcome,
    });
    if (requestId !== auditRequestRef.current) return;
    setBusy((s) => ({ ...s, audit: undefined }));
    if (!isApiSuccess(res)) {
      pushToast("error", res.errMessage);
      return;
    }
    setAuditView((current) => ({
      page: res.data,
      selectedEventId:
        current.selectedEventId && res.data.items.some((item) => item.id === current.selectedEventId)
          ? current.selectedEventId
          : null,
    }));
    setAuditPageIndex(pageIndex);
  }

  async function changeProjectKVPage(workflowName: string, direction: "next" | "previous") {
    if (busy.kv) return;
    if (direction === "previous") {
      const nextIndex = Math.max(0, projectKVPageIndex - 1);
      if (nextIndex === projectKVPageIndex) return;
      await loadProjectKV(workflowName, { cursor: projectKVCursorHistoryRef.current[nextIndex], pageIndex: nextIndex });
      return;
    }
    const nextCursor = detail.kv?.nextCursor;
    if (!detail.kv?.hasMore || !nextCursor) return;
    const nextIndex = projectKVPageIndex + 1;
    projectKVCursorHistoryRef.current[nextIndex] = nextCursor;
    await loadProjectKV(workflowName, { cursor: nextCursor, pageIndex: nextIndex });
  }

  async function changeAuditPage(direction: "next" | "previous") {
    if (busy.audit) return;
    if (direction === "previous") {
      const nextIndex = Math.max(0, auditPageIndex - 1);
      if (nextIndex === auditPageIndex) return;
      await loadAuditEvents({ cursor: auditCursorHistoryRef.current[nextIndex], pageIndex: nextIndex });
      return;
    }
    const nextCursor = auditView.page?.nextCursor;
    if (!auditView.page?.hasMore || !nextCursor) return;
    const nextIndex = auditPageIndex + 1;
    auditCursorHistoryRef.current[nextIndex] = nextCursor;
    await loadAuditEvents({ cursor: nextCursor, pageIndex: nextIndex });
  }

  async function loadProjectKVEntry(workflowName: string, entry: KVEntrySummary) {
    if (entry.scope !== "project" && entry.scope !== "conversation") {
      return {
        errCode: 400,
        errMessage: t("projectKvDetailScopeError"),
      };
    }
    return apiClient.getProjectKVEntry(workflowName, {
      scope: entry.scope,
      key: entry.key,
      conversationId: entry.scope === "conversation" ? entry.conversationId ?? entry.lastConversationId : undefined,
    });
  }

  async function deleteProjectKVEntry(workflowName: string, entry: KVEntrySummary) {
    if (entry.scope !== "project" && entry.scope !== "conversation") {
      return {
        errCode: 400,
        errMessage: t("projectKvDetailScopeError"),
      };
    }
    // The conversation scope is part of the entry's identity, and the row can
    // carry it on lastConversationId, so resolve it exactly like the detail load.
    return apiClient.deleteProjectKVEntry(workflowName, {
      scope: entry.scope,
      key: entry.key,
      conversationId: entry.scope === "conversation" ? entry.conversationId ?? entry.lastConversationId : undefined,
    });
  }

  async function handlePasswordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = emailInput.trim();
    const password = passwordInput;
    if (!email || !password) {
      setSession({ status: "anonymous", message: t("loginPasswordRequired") });
      return;
    }
    setBusy((state) => ({ ...state, global: t("busyPasswordLogin") }));
    const result = await apiClient.loginWithPassword({ email, password });
    setBusy((state) => ({ ...state, global: undefined }));
    if (!isApiSuccess(result) || !result.data.authenticated) {
      setSession({ status: "anonymous", message: result.errMessage || t("loginPasswordInvalid") });
      return;
    }
    setPasswordInput("");
    await validateSession();
  }

  async function approveDeviceLogin() {
    const userCode = deviceUserCode.trim().toUpperCase();
    if (!userCode) {
      setDeviceStatusMessage(t("deviceUserCodeEmpty"));
      return;
    }
    setBusy((state) => ({ ...state, device: t("busyApprovingDevice") }));
    setDeviceStatusMessage(null);
    const result = await apiClient.approveDevice(userCode);
    setBusy((state) => ({ ...state, device: undefined }));
    if (!isApiSuccess(result)) {
      setDeviceStatusMessage(result.errMessage);
      return;
    }
    setDeviceStatusMessage(t("deviceStatusApproved"));
    pushToast("success", t("toastDeviceApproved"));
  }

  async function denyDeviceLogin() {
    const userCode = deviceUserCode.trim().toUpperCase();
    if (!userCode) {
      setDeviceStatusMessage(t("deviceUserCodeEmpty"));
      return;
    }
    setBusy((state) => ({ ...state, device: t("busyDenyingDevice") }));
    setDeviceStatusMessage(null);
    const result = await apiClient.denyDevice(userCode);
    setBusy((state) => ({ ...state, device: undefined }));
    if (!isApiSuccess(result)) {
      setDeviceStatusMessage(result.errMessage);
      return;
    }
    setDeviceStatusMessage(t("deviceStatusDenied"));
    pushToast("success", t("toastDeviceDenied"));
  }

  async function saveAccountProfile(payload: { displayName: string; avatarUrl: string | null }) {
    setBusy((state) => ({ ...state, saveProfile: t("busySaveAccountProfile") }));
    const result = await apiClient.updateMe(payload);
    setBusy((state) => ({ ...state, saveProfile: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    pushToast("success", t("accountSaveProfileToast"));
    setAccountView((current) => current.me ? { ...current, me: { ...current.me, profile: result.data.profile } } : current);
    setSession((current) => current.status === "ready"
      ? {
          ...current,
          principal: {
            ...current.principal,
            displayName: result.data.profile?.displayName ?? current.principal.displayName,
          },
        }
      : current);
    await loadAccountView();
  }

  async function createAccountApiKey(payload: { name: string; expiresAt?: string }) {
    setBusy((state) => ({ ...state, createKeyBusy: t("busyCreateApiKey") }));
    const result = await apiClient.createApiKey({
      name: payload.name,
      expiresAt: payload.expiresAt,
      source: "web-account",
    });
    setBusy((state) => ({ ...state, createKeyBusy: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    setCreatedApiKeyToken(result.data.token);
    pushToast("success", t("toastApiKeyCreated"));
    await loadAccountView();
  }

  async function revokeAccountApiKey(id: string) {
    setBusy((state) => ({ ...state, revokeKeyId: id }));
    const result = await apiClient.revokeApiKey(id);
    setBusy((state) => ({ ...state, revokeKeyId: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    pushToast("success", t("toastApiKeyRevoked"));
    await loadAccountView();
  }

  async function inviteUser(payload: { email: string; displayName?: string }) {
    setBusy((state) => ({ ...state, inviteUser: t("busyInviteUser") }));
    const result = await apiClient.inviteAdminUser(payload);
    setBusy((state) => ({ ...state, inviteUser: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    setLatestInvitation(result.data);
    pushToast("success", t("toastInviteSent"));
    await loadAdminUsers();
  }

  async function updateUser(
    user: AdminUserSummary,
    patch: { email?: string; displayName?: string; disabled?: boolean; avatarUrl?: string | null },
  ) {
    setBusy((state) => ({ ...state, updateBusyUserId: user.userId }));
    const result = await apiClient.updateAdminUser(user.userId, patch);
    setBusy((state) => ({ ...state, updateBusyUserId: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    const changed: string[] = [];
    if (patch.email !== undefined) changed.push(t("usersChangeEmail"));
    if (patch.displayName !== undefined) changed.push(t("usersChangeDisplayName"));
    if (patch.avatarUrl !== undefined) changed.push(t("usersChangeAvatar"));
    if (patch.disabled !== undefined) changed.push(patch.disabled ? t("usersChangeDisabled") : t("usersChangeEnabled"));
    pushToast("success", t("toastUserUpdated", { displayName: user.displayName, changed: changed.join("、") }));
    await loadAdminUsers();
  }

  async function fetchInviteLink(userId: string) {
    setBusy((state) => ({ ...state, updateBusyUserId: userId }));
    const result = await apiClient.fetchInvitationLink(userId);
    setBusy((state) => ({ ...state, updateBusyUserId: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return null;
    }
    return result.data.invitationLink;
  }

  async function updateUserRoles(user: AdminUserSummary, roleIds: string[]) {
    setBusy((state) => ({ ...state, updateBusyUserId: user.userId }));
    const result = await apiClient.updateAdminUserRoles(user.userId, roleIds);
    setBusy((state) => ({ ...state, updateBusyUserId: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    pushToast("success", t("toastUserRolesUpdated", { displayName: user.displayName }));
    await loadAdminUsers();
  }

  async function updateUserAvatar(user: AdminUserSummary, file: File) {
    setBusy((state) => ({ ...state, updateBusyUserId: user.userId }));
    const result = await apiClient.uploadAdminAvatar(user.userId, file);
    setBusy((state) => ({ ...state, updateBusyUserId: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    pushToast("success", t("toastUserAvatarUpdated", { displayName: user.displayName }));
    await loadAdminUsers();
  }

  async function createRole(payload: { name: string; description?: string; permissions: string[] }) {
    setBusy((state) => ({ ...state, saveRole: t("busyCreateRole") }));
    const result = await apiClient.createAdminRole(payload);
    setBusy((state) => ({ ...state, saveRole: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    pushToast("success", t("toastRoleCreated", { name: result.data.role.name }));
    await loadAdminRoles();
  }

  async function updateRole(role: RoleRecord, payload: { name?: string; description?: string; permissions?: string[] }) {
    setBusy((state) => ({ ...state, saveRole: t("busySaveRole") }));
    const result = await apiClient.updateAdminRole(role.id, payload);
    setBusy((state) => ({ ...state, saveRole: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    pushToast("success", t("toastRoleUpdated", { name: result.data.role.name }));
    await loadAdminRoles();
  }

  async function deleteRole(role: RoleRecord) {
    setBusy((state) => ({ ...state, deleteRoleId: role.id }));
    const result = await apiClient.deleteAdminRole(role.id);
    setBusy((state) => ({ ...state, deleteRoleId: undefined }));
    if (!isApiSuccess(result)) {
      pushToast("error", result.errMessage);
      return;
    }
    pushToast("success", t("toastRoleDeleted", { name: role.name }));
    await loadAdminRoles();
  }

  async function completeLogout() {
    await apiClient.logout();
    setSession({ status: "anonymous" });
    setProjects([]);
    setAccountView({ me: null, apiKeys: null });
    setAdminUsers({ items: null, total: 0, page: 1, pageSize: 20, totalPages: 0, search: "", status: "" });
    setAdminRoles({ items: null, groups: null });
    setSelectedId("");
    navigateTo({ page: "login" }, { replace: true, skipKnowledgeGuard: true });
    detailWorkflowIdRef.current = null;
    setDetail(DEFAULT_DETAIL);
  }

  async function logout() {
    if (knowledgeDraftDirtyRef.current && leavesKnowledgeWorkspace(routeRef.current, { page: "login" })) {
      setPendingKnowledgeNavigation({
        route: { page: "login" },
        options: { replace: true, skipKnowledgeGuard: true },
        onConfirm: () => { void completeLogout(); },
      });
      return;
    }
    await completeLogout();
  }

  function setThemeMode(nextTheme: ThemeMode) {
    setTheme(nextTheme);
  }

  function handleLocalePreferenceChange(preference: LocalePreference) {
    persistLocale(LOCALE_STORAGE_KEY, preference);
    setLocalePreference(preference);
    void i18n.changeLanguage(resolveLocalePreference(preference));
  }

  function navigateTo(nextRoute: AppRoute, options: { replace?: boolean; skipKnowledgeGuard?: boolean } = {}) {
    if (session.status === "ready") {
      if (nextRoute.page === "projects" && !canViewProjects) {
        nextRoute = { page: "settings", tab: "profile" };
      }
      if (nextRoute.page === "admin" && nextRoute.tab === "audit" && !canViewAudit) {
          nextRoute = { page: "settings", tab: "profile" };
      }
      if (nextRoute.page === "admin" && nextRoute.tab === "users" && !canViewUsers) {
          nextRoute = { page: "settings", tab: "profile" };
      }
      if (nextRoute.page === "admin" && nextRoute.tab === "roles" && !canViewRoles) {
          nextRoute = { page: "settings", tab: "profile" };
      }
    }
    if (!options.skipKnowledgeGuard && knowledgeDraftDirtyRef.current && leavesKnowledgeWorkspace(routeRef.current, nextRoute)) {
      setPendingKnowledgeNavigation({ route: nextRoute, options });
      return;
    }
    const path = routeToPath(nextRoute);
    setRoute(nextRoute);
    setSelectedId(readRouteProjectId(nextRoute));
    if (`${window.location.pathname}${window.location.search}` !== path) {
      const method = options.replace ? "replaceState" : "pushState";
      window.history[method](null, "", path);
    }
  }

  function openProject(project: Summary, tab: DetailTab = "project") {
    navigateTo({ page: "detail", id: project.id, tab });
  }

  function navigateDetail(tab: DetailTab) {
    if (!selectedProject) return;
    navigateTo({ page: "detail", id: selectedProject.id, tab });
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (session.status === "checking") {
    return (
      <div className="flex h-screen items-center justify-center gap-2 bg-background text-foreground">
        <Loader2 className="size-5 animate-spin text-primary" />
        <span className="text-sm">{t("appCheckingSession")}</span>
      </div>
    );
  }

  if (route.page === "device") {
    return (
      <DeviceApprovalPage
        userCode={deviceUserCode}
        statusMessage={deviceStatusMessage ?? (session.status === "anonymous" ? session.message : undefined) ?? undefined}
        busy={busy.device}
        disabled={false}
        onUserCodeChange={setDeviceUserCode}
        onApprove={() => void approveDeviceLogin()}
        onDeny={() => void denyDeviceLogin()}
      />
    );
  }

  if (route.page === "account-invite") {
    return (
      <AccountInvitePage
        token={route.token}
        onContinue={() => window.location.replace("/projects")}
      />
    );
  }

  if (session.status === "anonymous") {
    return (
      <LoginPage
        emailInput={emailInput}
        passwordInput={passwordInput}
        message={session.message}
        loading={busy.global}
        onEmailInputChange={setEmailInput}
        onPasswordInputChange={setPasswordInput}
        onPasswordSubmit={handlePasswordLogin}
      />
    );
  }

  if (route.page === "source-share") {
    return <ProjectSourceSharePage key={`${route.id}/${route.version}`} id={route.id} version={route.version} onNavigateProjects={() => navigateTo({ page: "projects" })} />;
  }

  if (route.page === "invite") {
    return (
      <InviteAcceptPage
        token={route.token}
        onNavigateProjects={() => navigateTo({ page: "projects" })}
        onNavigateProject={(projectId) => navigateTo({ page: "detail", id: projectId, tab: "project" })}
        onNavigateLogin={() => navigateTo({ page: "login" }, { replace: true })}
      />
    );
  }

  if (route.page === "access-request") {
    return (
      <ProjectSourceAccessRequestPage
        token={route.token}
        onNavigateProjects={() => navigateTo({ page: "projects" })}
      />
    );
  }

  const settingsTab: SettingsTab = route.page === "settings" ? route.tab : "profile";
  const principalLabel = session.principal.displayName ?? session.principal.email ?? session.principal.kind;
  const principalEmail = accountView.me?.profile?.email ?? session.principal.email;
  // prefer the session-provided avatar (always available, including
  // on the workbench home page) and fall back to the settings-page profile
  // fetch so a freshly uploaded avatar shows up without a full re-login.
  const principalAvatarUrl =
    resolvePrincipalAvatarUrl({
      avatarUrl: session.principal.avatarUrl,
      profile: accountView.me?.profile,
    }) ?? undefined;
  const settingsNavItems = [
    {
      id: "settings-profile",
      label: t("accountProfileTitle"),
      icon: CONSOLE_NAV_ICONS.settings,
      active: page === "settings" && settingsTab === "profile",
      onClick: () => navigateTo({ page: "settings", tab: "profile" }),
    },
    {
      id: "settings-appearance",
      label: t("accountAppearanceTitle"),
      icon: Settings2,
      active: page === "settings" && settingsTab === "appearance",
      onClick: () => navigateTo({ page: "settings", tab: "appearance" }),
    },
    {
      id: "settings-api-keys",
      label: t("accountApiKey"),
      icon: Database,
      active: page === "settings" && settingsTab === "api-keys",
      onClick: () => navigateTo({ page: "settings", tab: "api-keys" }),
    },
  ];
  const adminTab = route.page === "admin" ? route.tab : canViewUsers ? "users" : canViewRoles ? "roles" : "audit";
  const adminNavItems = [
    canViewUsers ? {
      id: "admin-users",
      label: translateDynamicKey(ADMIN_TAB_META.users.labelKey, "serverWeb"),
      icon: ADMIN_TAB_META.users.icon,
      active: page === "admin" && adminTab === "users",
      onClick: () => navigateTo({ page: "admin", tab: "users" }),
    } : null,
    canViewRoles ? {
      id: "admin-roles",
      label: translateDynamicKey(ADMIN_TAB_META.roles.labelKey, "serverWeb"),
      icon: ADMIN_TAB_META.roles.icon,
      active: page === "admin" && adminTab === "roles",
      onClick: () => navigateTo({ page: "admin", tab: "roles" }),
    } : null,
    canViewAudit ? {
      id: "admin-audit",
      label: translateDynamicKey(ADMIN_TAB_META.audit.labelKey, "serverWeb"),
      icon: ADMIN_TAB_META.audit.icon,
      active: page === "admin" && adminTab === "audit",
      onClick: () => navigateTo({ page: "admin", tab: "audit" }),
    } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  const consoleNavItems = [
    canViewProjects ? {
      id: "projects",
      label: t("navProjects"),
      icon: CONSOLE_NAV_ICONS.projects,
      active: page === "projects",
      onClick: () => navigateTo({ page: "projects" }),
    } : null,
    {
      id: "settings",
      label: t("navSettings"),
      icon: CONSOLE_NAV_ICONS.settings,
      onClick: () => navigateTo({ page: "settings", tab: "profile" }),
    },
    adminNavItems.length > 0 ? {
      id: "admin",
      label: t("navAdminCenter"),
      icon: CONSOLE_NAV_ICONS.admin,
      onClick: () => navigateTo({ page: "admin", tab: adminTab }),
    } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  const workbenchPrincipalActions = [
    {
      label: t("navSettings"),
      icon: CONSOLE_NAV_ICONS.settings,
      onSelect: () => navigateTo({ page: "settings", tab: "profile" }),
    },
    ...(adminNavItems.length > 0
      ? [{
        label: t("navEnterAdminCenter"),
        icon: CONSOLE_NAV_ICONS.admin,
        onSelect: () => navigateTo({ page: "admin", tab: adminTab }),
      }]
      : []),
  ];
  const detailNavGroups = getDetailNavGroups(selectedProject).map(group => ({
    id: group.id,
    label: translateDynamicKey(group.label, "serverWeb"),
    items: group.items.map(item => ({
      id: `detail-${item.tab}`,
      label: translateDynamicKey(item.label, "serverWeb"),
      icon: item.icon,
      active: activeDetailTab === item.tab,
      onClick: () => navigateDetail(item.tab),
    })),
  }));
  const detailNavItems = detailNavGroups.flatMap(group => group.items);

  const settingsBusy = {
    profile: busy.account || busy.saveProfile,
    appearance: busy.account,
    "api-keys": busy.account || busy.apiKeys || busy.createKeyBusy || busy.revokeKeyId,
  };
  const adminBusy = {
    users: busy.users || busy.inviteUser || busy.updateBusyUserId,
    roles: busy.roles || busy.saveRole || busy.deleteRoleId,
    audit: busy.audit,
  };
  const refreshBusy = Boolean(busy.global || (
    page === "detail" ? renderedBusy.project || (activeDetailTab === "kv" && busy.kv)
      || (activeDetailTab === "invitations" && (busy.invitation || busy.revokeInvitationId))
      || ((activeDetailTab === "knowledge" || activeDetailTab === "dependencies") && detailContentBusy)
      : page === "settings" ? settingsBusy[settingsTab]
      : page === "admin" ? adminBusy[adminTab]
      : false
  ));

  async function refreshCurrentPage() {
    if (page === "projects") return loadProjects({ keepSelection: true });
    if (page === "settings") {
      await loadAccountView();
      return;
    }
    if (page === "admin") {
      switch (adminTab) {
        case "users": return loadAdminUsers({ page: adminUsers.page, pageSize: adminUsers.pageSize });
        case "roles": return loadAdminRoles();
        case "audit": return loadAuditEvents({ reset: true });
      }
    }
    if (page === "detail") {
      if (!selectedProject) return loadProjects({ keepSelection: true });
      if (activeDetailTab === "knowledge") setKnowledgeRefreshToken(current => current + 1);
      if (activeDetailTab === "dependencies") setDetailRefreshToken(current => current + 1);
      await Promise.all([
        loadProjects({ keepSelection: true }),
        loadProjectDetail(selectedProject.id),
        activeDetailTab === "kv" && selectedProjectServerStorageAllowed
          ? loadProjectKV(selectedProject.id, { reset: true }) : undefined,
      ]);
    }
  }

  const refreshActions = [{
    label: t("commonRefresh"),
    icon: RefreshCw,
    onClick: () => void refreshCurrentPage(),
    variant: "outline" as const,
    disabled: refreshBusy,
    loading: refreshBusy,
  }];

  if (page === "projects") {
    return (
      <AppLayout
        principalLabel={principalLabel}
        principalEmail={principalEmail}
        principalAvatarUrl={principalAvatarUrl}
        principalMenuActions={workbenchPrincipalActions}
        currentLabel={t("navProjects")}
        secondaryActions={refreshActions}
        navItems={consoleNavItems}
        onBrandClick={() => navigateTo({ page: "projects" })}
        onLogout={logout}
      >
        <ProjectListPage
          projects={projects}
          selectedId={selectedProject?.id ?? ""}
          loading={busy.global}
          onRefresh={() => void loadProjects({ keepSelection: true })}
          onOpenDetail={(project) => openProject(project)}
        />
      </AppLayout>
    );
  }

  const navigationLabel = page === "settings"
    ? t("navSettings")
    : page === "admin"
      ? t("navAdminCenter")
      : selectedProjectDisplayName ?? t("appBreadcrumbProjectDetail");

  return (
    <>
    <AppLayout
      principalLabel={principalLabel}
      principalEmail={principalEmail}
      principalAvatarUrl={principalAvatarUrl}
      principalMenuActions={workbenchPrincipalActions}
      currentLabel={navigationLabel}
      navigationLabel={navigationLabel}
      breadcrumbs={
        page === "detail"
          ? [
            { label: t("navProjects"), onClick: canViewProjects ? () => navigateTo({ page: "projects" }) : undefined },
            { label: selectedProjectDisplayName ?? t("appBreadcrumbProjectDetail"), onClick: () => navigateDetail("project") },
            { label: detailNavItems.find(item => item.active)?.label ?? t("detailNavOverview") },
          ]
          : page === "admin"
            ? [{ label: t("navAdminCenter") }, { label: translateDynamicKey(ADMIN_TAB_META[adminTab].labelKey, "serverWeb") }]
            : page === "settings"
              ? [{ label: t("navSettings") }, { label: settingsNavItems.find(item => item.active)?.label ?? t("accountProfileTitle") }]
              : []
      }
      headerExtras={
        page === "detail" && selectedProject ? (
          <Badge variant="outline" className="max-w-40 truncate">
            {selectedProject.latest ? t("appHeaderVersionBadge", { version: selectedProject.latest }) : t("appHeaderNoVersion")}
          </Badge>
        ) : null
      }
      secondaryActions={refreshActions}
      navItems={page === "detail" ? detailNavItems : page === "admin" ? adminNavItems : settingsNavItems}
      navGroups={page === "detail" ? detailNavGroups : undefined}
      onBrandClick={() => navigateTo({ page: "projects" })}
      onLogout={logout}
    >
      {page === "settings" ? (
        <AccountPage
          tab={settingsTab}
          me={accountView.me}
          apiKeys={accountView.apiKeys}
          busy={busy.account}
          apiKeysBusy={busy.apiKeys}
          saveBusy={busy.saveProfile}
          createKeyBusy={busy.createKeyBusy}
          revokeKeyId={busy.revokeKeyId}
          createdToken={createdApiKeyToken}
          theme={theme}
          localePreference={localePreference}
          onRefresh={() => void loadAccountView()}
          onSaveProfile={(payload) => void saveAccountProfile(payload)}
          onThemeChange={setThemeMode}
          onLocalePreferenceChange={handleLocalePreferenceChange}
          onCreateApiKey={(payload) => void createAccountApiKey(payload)}
          onRevokeApiKey={(id) => void revokeAccountApiKey(id)}
        />
      ) : page === "admin" && adminTab === "users" ? (
        <UsersPage
          users={adminUsers.items}
          roles={adminRoles.items ?? []}
          loading={busy.users}
          inviteBusy={busy.inviteUser}
          updateBusyUserId={busy.updateBusyUserId}
          invitationResult={latestInvitation}
          total={adminUsers.total}
          page={adminUsers.page}
          pageSize={adminUsers.pageSize}
          totalPages={adminUsers.totalPages}
          initialSearch={adminUsers.search}
          initialStatus={adminUsers.status}
          onSearch={(query, status) => void loadAdminUsers({ search: query, status, page: 1, pageSize: adminUsers.pageSize })}
          onPageChange={(page) => void loadAdminUsers({ page, pageSize: adminUsers.pageSize })}
          onRefresh={() => void loadAdminUsers({ page: adminUsers.page, pageSize: adminUsers.pageSize })}
          onInvite={(payload) => void inviteUser(payload)}
          onUpdateUser={(user, patch) => void updateUser(user, patch)}
          onUpdateRoles={(user, roleIds) => void updateUserRoles(user, roleIds)}
          onUpdateAvatar={(user, file) => void updateUserAvatar(user, file)}
          onFetchInviteLink={(userId) => fetchInviteLink(userId)}
        />
      ) : page === "admin" && adminTab === "roles" ? (
        <RolesPage
          roles={adminRoles.items}
          groups={adminRoles.groups}
          loading={busy.roles}
          saveBusy={busy.saveRole}
          deleteRoleId={busy.deleteRoleId}
          onRefresh={() => void loadAdminRoles()}
          onCreateRole={(payload) => void createRole(payload)}
          onUpdateRole={(role, payload) => void updateRole(role, payload)}
          onDeleteRole={(role) => void deleteRole(role)}
        />
      ) : page === "admin" && adminTab === "audit" ? (
        <AuditPage
          auditPage={auditView.page}
          filters={auditFilters}
          loading={busy.audit}
          pageIndex={auditPageIndex}
          pageSize={AUDIT_PAGE_SIZE}
          selectedEventId={auditView.selectedEventId}
          onFiltersChange={setAuditFilters}
          onRefresh={() => void loadAuditEvents({ reset: true })}
          onPageChange={(direction) => void changeAuditPage(direction)}
          onOpenDetail={(eventId) => setAuditView((current) => ({ ...current, selectedEventId: eventId }))}
        />
      ) : !selectedProject ? (
        <div className="flex h-full flex-col items-center justify-center gap-1">
          <span className="text-sm text-muted-foreground">{t("appNoProject")}</span>
        </div>
      ) : (
        <DetailPage
          project={selectedProject}
          detail={renderedDetail}
          activeTab={activeDetailTab ?? "project"}
          busy={renderedBusy}
          onUpdateVisibility={(visibility) => void updateProjectVisibility(visibility)}
          onSetProjectMember={(userId, role) => void setProjectMember(userId, role)}
          onRemoveProjectMember={(userId) => void removeProjectMember(userId)}
          onCreateProjectInvitation={async (role) => await createProjectInvitation(role)}
          onRevokeProjectInvitation={(invitationId) => void revokeProjectInvitation(invitationId)}
          kvPageIndex={projectKVPageIndex}
          kvPageSize={KV_PAGE_SIZE}
          kvFilters={kvFilters}
          onKVFiltersChange={setKVFilters}
          onKVPageChange={(direction) => void changeProjectKVPage(selectedProject.id, direction)}
          onLoadKVEntry={(entry) => loadProjectKVEntry(selectedProject.id, entry)}
          onDeleteKVEntry={(entry) => deleteProjectKVEntry(selectedProject.id, entry)}
          knowledgeRefreshToken={knowledgeRefreshToken}
          refreshToken={detailRefreshToken}
          onContentBusyChange={setDetailContentBusy}
          onKnowledgeDirtyChange={(dirty) => { knowledgeDraftDirtyRef.current = dirty; }}
          onNavigateTab={navigateDetail}
          onNavigateProjectTab={(projectId, tab) => navigateTo({ page: "detail", id: projectId, tab })}
          sidebarCollapsed={false}
          onRefresh={() => void refreshCurrentPage()}
        />
      )}
      </AppLayout>
      <ConfirmActionDialog
        action={pendingKnowledgeNavigation ? {
          title: t("appKnowledgeGuardTitle"),
          description: t("appKnowledgeGuardDescription"),
          confirmLabel: t("appKnowledgeGuardConfirm"),
          cancelLabel: t("appKnowledgeGuardCancel"),
          tone: "warning",
          onConfirm: () => {
            const pending = pendingKnowledgeNavigation;
            setPendingKnowledgeNavigation(null);
            knowledgeDraftDirtyRef.current = false;
            if (pending?.onConfirm) {
              pending.onConfirm();
              return;
            }
            if (pending) navigateTo(pending.route, { ...pending.options, skipKnowledgeGuard: true });
          },
        } : null}
        onOpenChange={(open) => {
          if (!open) setPendingKnowledgeNavigation(null);
        }}
      />
    </>
  );
}
