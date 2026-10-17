
import type { AuthSessionState, ApiResponse, WorkflowAdminUserSummary, WorkflowAccountInvitationLookupResult, WorkflowApiKeyCreateResult, WorkflowApiKeyRecord, WorkflowAuditEventPage, WorkflowAuditOutcome, WorkflowDeviceCodeResult, WorkflowKVEntryDetail, WorkflowKVEntryPage, WorkflowKVEntryScope, WorkflowKVEntryValueType, WorkflowKnowledgeDocument, WorkflowKnowledgeDocumentPage, WorkflowKnowledgeDocumentLinesResult, WorkflowKnowledgeDocumentSummary, WorkflowKnowledgeSearchResult, WorkflowMeResult, WorkflowPermissionGroup, WorkflowProjectInvitation, WorkflowRelatedProjectListResult, WorkflowProjectAccessLinkInfo, WorkflowProjectAccessRequest, WorkflowProjectDependencyStatusResult, WorkflowProjectSourceAccessSummary, WorkflowInvitationAcceptResult, WorkflowInvitationLookupResult, WorkflowInvitationRole, WorkflowProjectMember, WorkflowRoleRecord, WorkflowUserInvitationResult, WorkflowServerHealthData, WorkflowSummary, WorkflowVersionSummary } from "./types";
import { getCurrentLocale, translateDynamicKey, translateSteamHarnessError, type CommonResourceKey } from "@steamharness/i18n";

import type { WorkflowProjectDataSummary, WorkflowSourceShare } from "./types";

export class ServerApiClient {
  getSourceShare(id: string, version: string, signal?: AbortSignal): Promise<ApiResponse<WorkflowSourceShare>> {
    return this.request(`/api/workflows/${encodeURIComponent(id)}/source-share?target=${encodeURIComponent(version)}`, { signal });
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      "X-Workflow-Locale": getCurrentLocale(),
      ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}),
    };

    try {
      const res = await fetch(path, {
        ...init,
        credentials: "include",
        headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      });
      const text = await res.text();
      const trimmed = text.trim();

      if (trimmed === "") {
        const message = tCommon("serverEmptyResponse");
        return {
          errCode: res.ok ? -1 : res.status,
          errMessage: res.ok
            ? message
            : formatHttpError(res, message),
        };
      }

      try {
        const payload = JSON.parse(trimmed) as unknown;
        if (isApiResponse(payload)) {
          return payload as ApiResponse<T>;
        }
        return {
          errCode: res.ok ? -1 : res.status,
          errMessage: formatResponseError(res, tCommon("serverUnexpectedJsonResponse")),
          data: payload,
        };
      } catch {
        return {
          errCode: res.ok ? -1 : res.status,
          errMessage: formatResponseError(
            res,
            tCommon(res.ok ? "serverNonJsonResponse" : "serverNonJsonErrorResponse", {
              body: trim(trimmed),
            }),
          ),
        };
      }
    } catch (error) {
      return {
        errCode: -1,
        errMessage: tCommon(isAbortError(error) ? "requestCancelled" : "networkError"),
      };
    }
  }

  async fetchWorkflowFile(
    fileId: string,
    options?: { download?: boolean; signal?: AbortSignal },
  ): Promise<Blob> {
    const query = options?.download ? "?download=1" : "";
    try {
      const res = await fetch(`/api/workflows/files/${encodeURIComponent(fileId)}${query}`, {
        credentials: "include",
        headers: { "X-Workflow-Locale": getCurrentLocale() },
        signal: options?.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        const payload = parseApiResponse(text);
        const message = payload && payload.errCode !== 0
          ? translateSteamHarnessError(payload.data, payload.errMessage || tCommon("workflowFileReadFailed"))
          : text.trim() !== ""
            ? tCommon("serverNonJsonErrorResponse", { body: trim(text.trim()) })
            : tCommon("workflowFileReadFailed");
        throw new Error(formatHttpError(res, message));
      }
      return res.blob();
    } catch (error) {
      if (error instanceof Error && !isAbortError(error) && error.message.startsWith("HTTP ")) {
        throw error;
      }
      throw new Error(tCommon(isAbortError(error) ? "requestCancelled" : "networkError"));
    }
  }

  health(): Promise<ApiResponse<WorkflowServerHealthData>> {
    return this.request<WorkflowServerHealthData>("/health");
  }

  getSession(): Promise<ApiResponse<AuthSessionState>> {
    return this.request<AuthSessionState>("/api/auth/session");
  }

  loginWithAdminKey(adminKey: string): Promise<ApiResponse<AuthSessionState>> {
    return this.request<AuthSessionState>("/api/auth/admin-key/session", {
      method: "POST",
      body: JSON.stringify({ adminKey }),
    });
  }

  loginWithPassword(payload: {
    email: string;
    password: string;
  }): Promise<ApiResponse<AuthSessionState>> {
    return this.request<AuthSessionState>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  lookupAccountInvitation(token: string): Promise<ApiResponse<WorkflowAccountInvitationLookupResult>> {
    return this.request(`/api/auth/invitations/${encodeURIComponent(token)}`);
  }

  acceptAccountInvitation(
    token: string,
    payload: { password: string; displayName?: string },
  ): Promise<ApiResponse<AuthSessionState>> {
    return this.request(`/api/auth/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  logout(): Promise<ApiResponse<{ loggedOut: boolean }>> {
    return this.request<{ loggedOut: boolean }>("/api/auth/logout", {
      method: "POST",
    });
  }

  startDeviceFlow(payload: {
    clientName: string;
    source: string;
    requestedScopes?: string[];
  }): Promise<ApiResponse<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresAt: string;
    intervalSeconds: number;
  }>> {
    return this.request("/api/auth/device/start", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  pollDeviceToken(deviceCode: string): Promise<ApiResponse<{
    accessToken: string;
    apiKey: WorkflowApiKeyRecord;
    user: {
      userId: string;
      email: string;
      displayName: string;
    };
    expiresAt?: string;
  }>> {
    return this.request("/api/auth/device/token", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
    });
  }

  approveDevice(userCode: string): Promise<ApiResponse<{ deviceCode: WorkflowDeviceCodeResult }>> {
    return this.request("/api/auth/device/approve", {
      method: "POST",
      body: JSON.stringify({ userCode }),
    });
  }

  denyDevice(userCode: string): Promise<ApiResponse<{ deviceCode: WorkflowDeviceCodeResult }>> {
    return this.request("/api/auth/device/deny", {
      method: "POST",
      body: JSON.stringify({ userCode }),
    });
  }

  getMe(): Promise<ApiResponse<WorkflowMeResult>> {
    return this.request("/api/auth/me");
  }

  updateMe(payload: {
    displayName?: string;
    avatarUrl?: string | null;
  }): Promise<ApiResponse<{ profile: WorkflowMeResult["profile"] }>> {
    return this.request("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  listApiKeys(): Promise<ApiResponse<{ items: WorkflowApiKeyRecord[] }>> {
    return this.request("/api/auth/api-keys");
  }

  createApiKey(payload: {
    name: string;
    expiresAt?: string;
    source?: string;
    scopes?: string[];
  }): Promise<ApiResponse<WorkflowApiKeyCreateResult>> {
    return this.request("/api/auth/api-keys", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  revokeApiKey(id: string): Promise<ApiResponse<{ revoked: boolean; id: string }>> {
    return this.request(`/api/auth/api-keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  listAdminPermissions(): Promise<ApiResponse<{ groups: WorkflowPermissionGroup[] }>> {
    return this.request("/api/auth/admin/permissions");
  }

  listAdminRoles(): Promise<ApiResponse<{ items: WorkflowRoleRecord[] }>> {
    return this.request("/api/auth/admin/roles");
  }

  createAdminRole(payload: {
    name: string;
    description?: string;
    permissions: string[];
  }): Promise<ApiResponse<{ role: WorkflowRoleRecord }>> {
    return this.request("/api/auth/admin/roles", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  updateAdminRole(roleId: string, payload: {
    name?: string;
    description?: string;
    permissions?: string[];
  }): Promise<ApiResponse<{ role: WorkflowRoleRecord }>> {
    return this.request(`/api/auth/admin/roles/${encodeURIComponent(roleId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  deleteAdminRole(roleId: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return this.request(`/api/auth/admin/roles/${encodeURIComponent(roleId)}`, {
      method: "DELETE",
    });
  }

  listAdminUsers(params?: {
    search?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }): Promise<ApiResponse<{ items: WorkflowAdminUserSummary[]; total: number; page: number; pageSize: number; totalPages: number }>> {
    const query = new URLSearchParams();
    if (params?.search) query.set("search", params.search);
    if (params?.status) query.set("status", params.status);
    if (params?.page) query.set("page", String(params.page));
    if (params?.pageSize) query.set("pageSize", String(params.pageSize));
    const qs = query.toString();
    return this.request(`/api/auth/admin/users${qs ? `?${qs}` : ""}`);
  }

  listAuditEvents(options: {
    pageSize?: number;
    cursor?: string;
    from?: string;
    to?: string;
    actorUserId?: string;
    principalKind?: string;
    eventType?: string;
    resourceType?: string;
    resourceId?: string;
    outcome?: WorkflowAuditOutcome | "all";
  } = {}): Promise<ApiResponse<WorkflowAuditEventPage>> {
    const params = new URLSearchParams();
    if (options.pageSize) params.set("pageSize", String(options.pageSize));
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);
    if (options.actorUserId) params.set("userId", options.actorUserId);
    if (options.principalKind) params.set("principalKind", options.principalKind);
    if (options.eventType) params.set("eventType", options.eventType);
    if (options.resourceType) params.set("resourceType", options.resourceType);
    if (options.resourceId) params.set("resourceId", options.resourceId);
    if (options.outcome && options.outcome !== "all") params.set("outcome", options.outcome);
    const query = params.toString();
    return this.request(`/api/audit-events${query ? `?${query}` : ""}`);
  }

  fetchInvitationLink(userId: string): Promise<ApiResponse<{ invitationLink: string }>> {
    return this.request<{ invitationLink: string }>(`/api/auth/admin/users/invitation-link/${encodeURIComponent(userId)}`);
  }

  inviteAdminUser(payload: {
    email: string;
    displayName?: string;
    temporaryPassword?: string;
    redirectTo?: string;
  }): Promise<ApiResponse<WorkflowUserInvitationResult>> {
    return this.request("/api/auth/admin/users/invitations", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async uploadAdminAvatar(
    userId: string,
    file: File,
  ): Promise<ApiResponse<{ profile: WorkflowMeResult["profile"]; avatarUrl: string }>> {
    return this.request<{ profile: WorkflowMeResult["profile"]; avatarUrl: string }>(
      `/api/auth/admin/users/${encodeURIComponent(userId)}/avatar`,
      { method: "POST", body: file },
    );
  }

  updateAdminUser(userId: string, payload: {
    email?: string;
    displayName?: string;
    temporaryPassword?: string;
    disabled?: boolean;
    avatarUrl?: string | null;
  }): Promise<ApiResponse<{ profile: WorkflowMeResult["profile"] }>> {
    return this.request(`/api/auth/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  updateAdminUserRoles(userId: string, roleIds: string[]): Promise<ApiResponse<{ profile: WorkflowMeResult["profile"] }>> {
    return this.request(`/api/auth/admin/users/${encodeURIComponent(userId)}/roles`, {
      method: "PUT",
      body: JSON.stringify({ roleIds }),
    });
  }

  listWorkflows(): Promise<ApiResponse<WorkflowSummary[]>> {
    return this.request<WorkflowSummary[]>("/api/workflows");
  }

  listVersions(workflowName: string): Promise<ApiResponse<WorkflowVersionSummary>> {
    return this.request<WorkflowVersionSummary>(
      `/api/workflows/${encodeURIComponent(workflowName)}/versions`,
    );
  }

  getProjectDependencies(
    workflowName: string,
    target = "latest",
  ): Promise<ApiResponse<WorkflowProjectDependencyStatusResult>> {
    return this.request<WorkflowProjectDependencyStatusResult>(
      `/api/workflows/${encodeURIComponent(workflowName)}/dependencies?target=${encodeURIComponent(target)}`,
    );
  }

  listRelatedProjects(projectId: string): Promise<ApiResponse<WorkflowRelatedProjectListResult>> {
    return this.request<WorkflowRelatedProjectListResult>(
      `/api/workflows/${encodeURIComponent(projectId)}/related-projects`,
    );
  }

  setRelatedProject(
    projectId: string,
    alias: string,
    input: {
      targetProjectId: string;
      targetAlias: string;
      grantToRelatedProject: import("@steamharness/project-info").WorkflowRelatedProjectKVGrant;
      targetGrantToRelatedProject: import("@steamharness/project-info").WorkflowRelatedProjectKVGrant;
    },
  ): Promise<ApiResponse<WorkflowRelatedProjectListResult>> {
    return this.request<WorkflowRelatedProjectListResult>(
      `/api/workflows/${encodeURIComponent(projectId)}/related-projects/${encodeURIComponent(alias)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  }

  removeRelatedProject(
    projectId: string,
    alias: string,
  ): Promise<ApiResponse<{ removed: boolean; relatedProjects: WorkflowRelatedProjectListResult["relatedProjects"] }>> {
    return this.request(
      `/api/workflows/${encodeURIComponent(projectId)}/related-projects/${encodeURIComponent(alias)}`,
      { method: "DELETE" },
    );
  }

  listSourceAccessRequests(
    workflowName: string,
  ): Promise<ApiResponse<WorkflowProjectSourceAccessSummary>> {
    return this.request<WorkflowProjectSourceAccessSummary>(
      `/api/workflows/${encodeURIComponent(workflowName)}/source-access-requests`,
    );
  }

  resolveSourceAccessRequest(
    workflowName: string,
    requestId: string,
    status: "approved" | "rejected",
  ): Promise<ApiResponse<WorkflowProjectAccessRequest>> {
    return this.request<WorkflowProjectAccessRequest>(
      `/api/workflows/${encodeURIComponent(workflowName)}/source-access-requests/${encodeURIComponent(requestId)}`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
  }

  revokeSourceCapability(
    workflowName: string,
    userId: string,
  ): Promise<ApiResponse<{ revoked: boolean }>> {
    return this.request<{ revoked: boolean }>(
      `/api/workflows/${encodeURIComponent(workflowName)}/source-capabilities/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  getProjectSourceAccessLink(
    token: string,
  ): Promise<ApiResponse<WorkflowProjectAccessLinkInfo>> {
    return this.request<WorkflowProjectAccessLinkInfo>(
      `/api/project-source-access/${encodeURIComponent(token)}`,
    );
  }

  createProjectSourceAccessRequest(
    token: string,
    reason: string,
  ): Promise<ApiResponse<WorkflowProjectAccessRequest>> {
    return this.request<WorkflowProjectAccessRequest>(
      `/api/project-source-access/${encodeURIComponent(token)}/requests`,
      { method: "POST", body: JSON.stringify({ reason }) },
    );
  }

  listProjectMembers(workflowName: string): Promise<ApiResponse<WorkflowProjectMember[]>> {
    return this.request(`/api/workflows/${encodeURIComponent(workflowName)}/members`);
  }

  setProjectMember(
    workflowName: string,
    userId: string,
    payload: { role: "owner" | "manager" | "writer" | "viewer" },
  ): Promise<ApiResponse<WorkflowProjectMember>> {
    return this.request(
      `/api/workflows/${encodeURIComponent(workflowName)}/members/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      },
    );
  }

  removeProjectMember(
    workflowName: string,
    userId: string,
  ): Promise<ApiResponse<{ removed: boolean }>> {
    return this.request(
      `/api/workflows/${encodeURIComponent(workflowName)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  createProjectInvitation(
    workflowName: string,
    payload: { role: WorkflowInvitationRole },
  ): Promise<ApiResponse<{ invitation: WorkflowProjectInvitation; token: string }>> {
    return this.request(
      `/api/workflows/${encodeURIComponent(workflowName)}/invitations`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  }

  listProjectInvitations(
    workflowName: string,
  ): Promise<ApiResponse<WorkflowProjectInvitation[]>> {
    return this.request(`/api/workflows/${encodeURIComponent(workflowName)}/invitations`);
  }

  revokeProjectInvitation(
    workflowName: string,
    invitationId: string,
  ): Promise<ApiResponse<{ revoked: boolean }>> {
    return this.request(
      `/api/workflows/${encodeURIComponent(workflowName)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
  }

  lookupInvitation(token: string): Promise<ApiResponse<WorkflowInvitationLookupResult>> {
    return this.request(`/api/invitations/${encodeURIComponent(token)}`);
  }

  acceptInvitation(token: string): Promise<ApiResponse<WorkflowInvitationAcceptResult>> {
    return this.request(`/api/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
    });
  }

  updateProjectVisibility(
    workflowName: string,
    payload: { visibility: "private" | "public" },
  ): Promise<ApiResponse<WorkflowSummary>> {
    return this.request(
      `/api/workflows/${encodeURIComponent(workflowName)}/visibility`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  }

  getProjectDataSummary(projectId: string): Promise<ApiResponse<WorkflowProjectDataSummary>> {
    return this.request(`/api/workflows/${encodeURIComponent(projectId)}/data-summary`);
  }

  listProjectKVEntries(
    projectId: string,
    options: {
      pageSize?: number;
      cursor?: string;
      scope?: "project" | "conversation" | "all";
      query?: string;
      valueType?: WorkflowKVEntryValueType | "all";
      conversationId?: string;
      runId?: string;
    } = {},
  ): Promise<ApiResponse<WorkflowKVEntryPage>> {
    const query = new URLSearchParams();
    query.set("pageSize", String(options.pageSize ?? 20));
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.scope && options.scope !== "all") query.set("scope", options.scope);
    if (options.query) query.set("q", options.query);
    if (options.valueType && options.valueType !== "all") query.set("valueType", options.valueType);
    if (options.conversationId) query.set("conversationId", options.conversationId);
    if (options.runId) query.set("runId", options.runId);

    return this.request<WorkflowKVEntryPage>(
      `/api/workflows/${encodeURIComponent(projectId)}/kv?${query.toString()}`,
    );
  }

  getProjectKVEntry(
    projectId: string,
    options: {
      scope: WorkflowKVEntryScope;
      key: string;
      conversationId?: string;
    },
  ): Promise<ApiResponse<WorkflowKVEntryDetail>> {
    const query = new URLSearchParams();
    query.set("scope", options.scope);
    query.set("key", options.key);
    if (options.conversationId) query.set("conversationId", options.conversationId);

    return this.request<WorkflowKVEntryDetail>(
      `/api/workflows/${encodeURIComponent(projectId)}/kv/entry?${query.toString()}`,
    );
  }

  deleteProjectKVEntry(
    projectId: string,
    options: {
      scope: WorkflowKVEntryScope;
      key: string;
      conversationId?: string;
    },
  ): Promise<ApiResponse<{ scope: WorkflowKVEntryScope; key: string; conversationId?: string }>> {
    const query = new URLSearchParams();
    query.set("scope", options.scope);
    query.set("key", options.key);
    if (options.conversationId) query.set("conversationId", options.conversationId);

    return this.request<{ scope: WorkflowKVEntryScope; key: string; conversationId?: string }>(
      `/api/workflows/${encodeURIComponent(projectId)}/kv/entry?${query.toString()}`,
      { method: "DELETE" },
    );
  }

  listKnowledgeDocuments(
    workflowName: string,
    options: { pageSize?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ApiResponse<WorkflowKnowledgeDocumentPage>> {
    const query = new URLSearchParams();
    if (options.pageSize !== undefined) query.set("pageSize", String(options.pageSize));
    if (options.cursor) query.set("cursor", options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<WorkflowKnowledgeDocumentPage>(
      `/api/workflows/${encodeURIComponent(workflowName)}/knowledge-documents${suffix}`,
      { signal: options.signal },
    );
  }

  getKnowledgeDocument(
    workflowName: string,
    documentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApiResponse<WorkflowKnowledgeDocument>> {
    return this.request<WorkflowKnowledgeDocument>(
      `/api/workflows/${encodeURIComponent(workflowName)}/knowledge-documents/${encodeURIComponent(documentId)}`,
      { signal: options.signal },
    );
  }

  createKnowledgeDocument(
    workflowName: string,
    payload: { id?: string; title: string; markdown: string },
    options: { response?: "document" | "summary"; signal?: AbortSignal } = {},
  ): Promise<ApiResponse<WorkflowKnowledgeDocument | WorkflowKnowledgeDocumentSummary>> {
    const query = new URLSearchParams();
    if (options.response) query.set("response", options.response);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<WorkflowKnowledgeDocument | WorkflowKnowledgeDocumentSummary>(
      `/api/workflows/${encodeURIComponent(workflowName)}/knowledge-documents${suffix}`,
      {
        method: "POST",
        body: JSON.stringify(payload),
        signal: options.signal,
      },
    );
  }

  editKnowledgeDocument(
    workflowName: string,
    documentId: string,
    payload: { title?: string; markdown?: string },
    options: { response?: "document" | "summary"; signal?: AbortSignal } = {},
  ): Promise<ApiResponse<WorkflowKnowledgeDocument | WorkflowKnowledgeDocumentSummary>> {
    const query = new URLSearchParams();
    if (options.response) query.set("response", options.response);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<WorkflowKnowledgeDocument | WorkflowKnowledgeDocumentSummary>(
      `/api/workflows/${encodeURIComponent(workflowName)}/knowledge-documents/${encodeURIComponent(documentId)}${suffix}`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
        signal: options.signal,
      },
    );
  }

  deleteKnowledgeDocument(
    workflowName: string,
    documentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApiResponse<{ id: string; deleted: boolean }>> {
    return this.request<{ id: string; deleted: boolean }>(
      `/api/workflows/${encodeURIComponent(workflowName)}/knowledge-documents/${encodeURIComponent(documentId)}`,
      { method: "DELETE", signal: options.signal },
    );
  }

  searchKnowledgeDocuments(
    workflowName: string,
    options: {
      query: string;
      documentId?: string;
      beforeLines?: number;
      afterLines?: number;
      maxMatches?: number;
      pageSize?: number;
      cursor?: string;
      signal?: AbortSignal;
    },
  ): Promise<ApiResponse<WorkflowKnowledgeSearchResult>> {
    const query = new URLSearchParams();
    query.set("q", options.query);
    if (options.documentId) query.set("documentId", options.documentId);
    if (options.beforeLines !== undefined) query.set("beforeLines", String(options.beforeLines));
    if (options.afterLines !== undefined) query.set("afterLines", String(options.afterLines));
    if (options.maxMatches !== undefined) query.set("maxMatches", String(options.maxMatches));
    if (options.pageSize !== undefined) query.set("pageSize", String(options.pageSize));
    if (options.cursor) query.set("cursor", options.cursor);
    return this.request<WorkflowKnowledgeSearchResult>(
      `/api/workflows/${encodeURIComponent(workflowName)}/knowledge-documents/search?${query.toString()}`,
      { signal: options.signal },
    );
  }

  readKnowledgeDocumentLines(
    workflowName: string,
    documentId: string,
    options: { startLine: number; endLine: number; signal?: AbortSignal },
  ): Promise<ApiResponse<WorkflowKnowledgeDocumentLinesResult>> {
    const query = new URLSearchParams();
    query.set("startLine", String(options.startLine));
    query.set("endLine", String(options.endLine));
    return this.request<WorkflowKnowledgeDocumentLinesResult>(
      `/api/workflows/${encodeURIComponent(workflowName)}/knowledge-documents/${encodeURIComponent(documentId)}/lines?${query.toString()}`,
      { signal: options.signal },
    );
  }

}

function isApiResponse(value: unknown): value is ApiResponse<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "errCode" in value &&
    typeof (value as { errCode: unknown }).errCode === "number" &&
    "errMessage" in value &&
    typeof (value as { errMessage: unknown }).errMessage === "string"
  );
}

function formatHttpError(response: Response, message: string): string {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return `HTTP ${response.status}${statusText}: ${message}`;
}

function formatResponseError(response: Response, message: string): string {
  return response.ok ? message : formatHttpError(response, message);
}

function tCommon(key: CommonResourceKey, values?: Record<string, unknown>): string {
  return translateDynamicKey(key, "common", values);
}

function parseApiResponse(value: string): ApiResponse<unknown> | undefined {
  try {
    const payload = JSON.parse(value) as unknown;
    return isApiResponse(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function isAbortError(value: unknown): boolean {
  return typeof value === "object" && value !== null && "name" in value && value.name === "AbortError";
}

function trim(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}...` : value;
}

export const apiClient = new ServerApiClient();
