import type { AccessPage, ProjectGroup, ProjectRole } from "./types";
import type { ProjectConfigurationAction, ProjectConfigurationState, ProjectConfigurationExport, ProjectConfigurationFile } from "@steamharness/project-configuration";

import type { AuthSessionState, ApiResponse, AdminUserSummary, AccountInvitationLookupResult, ApiKeyCreateResult, ApiKeyRecord, AuditEventPage, AuditOutcome, DeviceCodeResult, KVEntryDetail, KVEntryPage, KVEntryScope, KVEntryValueType, KnowledgeDocument, KnowledgeDocumentPageRecord, KnowledgeDocumentLinesResult, KnowledgeDocumentSummaryRecord, KnowledgeSearchResultRecord, MeResult, ProjectInvitation, RelatedProjectListResult, ProjectAccessLinkInfo, ProjectAccessRequest, ProjectDependencyStatusResult, ProjectSourceAccessSummary, InvitationAcceptResult, InvitationLookupResult, InvitationRole, ProjectMember, UserInvitationResult, ServerHealthData, Summary, VersionSummary } from "./types";
import { getCurrentLocale, translateDynamicKey, translateSteamHarnessError, type CommonResourceKey } from "@steamharness/i18n";

import type { ProjectDataSummary, SourceShare } from "./types";

export class ServerApiClient {
  uploadProjectConfigurationFile(id: string, file: File, key: string, target = "draft"): Promise<ApiResponse<ProjectConfigurationFile[]>> {
    const mimeType = file.type || "application/octet-stream";
    const query = new URLSearchParams({fileName:file.name,mimeType,key,target});
    return this.request(`/api/projects/${encodeURIComponent(id)}/configurations/files?${query}`, {method:"POST",body:file,headers:{"Content-Type":mimeType}});
  }
  projectConfigurations(id: string, call: ProjectConfigurationAction, target = "draft"): Promise<ApiResponse<ProjectConfigurationState | ProjectConfigurationExport>> {
    return call.action === "get" ? this.request(`/api/projects/${encodeURIComponent(id)}/configurations?target=${encodeURIComponent(target)}`)
      : this.request(`/api/projects/${encodeURIComponent(id)}/configurations`, {method:"POST",body:JSON.stringify({target,call})});
  }

  getSourceShare(id: string, version: string, signal?: AbortSignal): Promise<ApiResponse<SourceShare>> {
    return this.request(`/api/projects/${encodeURIComponent(id)}/source-share?target=${encodeURIComponent(version)}`, { signal });
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      "X-SteamHarness-Locale": getCurrentLocale(),
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

  async fetchProjectFile(
    fileId: string,
    options?: { download?: boolean; signal?: AbortSignal },
  ): Promise<Blob> {
    const query = options?.download ? "?download=1" : "";
    try {
      const res = await fetch(`/api/projects/files/${encodeURIComponent(fileId)}${query}`, {
        credentials: "include",
        headers: { "X-SteamHarness-Locale": getCurrentLocale() },
        signal: options?.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        const payload = parseApiResponse(text);
        const message = payload && payload.errCode !== 0
          ? translateSteamHarnessError(payload.data, payload.errMessage || tCommon("projectFileReadFailed"))
          : text.trim() !== ""
            ? tCommon("serverNonJsonErrorResponse", { body: trim(text.trim()) })
            : tCommon("projectFileReadFailed");
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

  health(): Promise<ApiResponse<ServerHealthData>> {
    return this.request<ServerHealthData>("/health");
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

  lookupAccountInvitation(token: string): Promise<ApiResponse<AccountInvitationLookupResult>> {
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
    apiKey: ApiKeyRecord;
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

  approveDevice(userCode: string): Promise<ApiResponse<{ deviceCode: DeviceCodeResult }>> {
    return this.request("/api/auth/device/approve", {
      method: "POST",
      body: JSON.stringify({ userCode }),
    });
  }

  denyDevice(userCode: string): Promise<ApiResponse<{ deviceCode: DeviceCodeResult }>> {
    return this.request("/api/auth/device/deny", {
      method: "POST",
      body: JSON.stringify({ userCode }),
    });
  }

  getMe(): Promise<ApiResponse<MeResult>> {
    return this.request("/api/auth/me");
  }

  updateMe(payload: {
    displayName?: string;
    avatarUrl?: string | null;
  }): Promise<ApiResponse<{ profile: MeResult["profile"] }>> {
    return this.request("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  listApiKeys(): Promise<ApiResponse<{ items: ApiKeyRecord[] }>> {
    return this.request("/api/auth/api-keys");
  }

  createApiKey(payload: {
    name: string;
    expiresAt?: string;
    source?: string;
    scopes?: string[];
  }): Promise<ApiResponse<ApiKeyCreateResult>> {
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

  listAdminUsers(params?: {
    search?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }): Promise<ApiResponse<{ items: AdminUserSummary[]; total: number; page: number; pageSize: number; totalPages: number }>> {
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
    outcome?: AuditOutcome | "all";
  } = {}): Promise<ApiResponse<AuditEventPage>> {
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
  }): Promise<ApiResponse<UserInvitationResult>> {
    return this.request("/api/auth/admin/users/invitations", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async uploadAdminAvatar(
    userId: string,
    file: File,
  ): Promise<ApiResponse<{ profile: MeResult["profile"]; avatarUrl: string }>> {
    return this.request<{ profile: MeResult["profile"]; avatarUrl: string }>(
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
  }): Promise<ApiResponse<{ profile: MeResult["profile"] }>> {
    return this.request(`/api/auth/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  updateSystemAdministrator(userId: string, isSystemAdmin: boolean): Promise<ApiResponse<{ profile: MeResult["profile"] }>> {
    return this.request(`/api/auth/admin/users/${encodeURIComponent(userId)}/administrator`, {
      method: "PUT",
      body: JSON.stringify({ isSystemAdmin }),
    });
  }

  listProjects(params: {page?:number;pageSize?:number;q?:string;groupId?:string|null;status?:string}={}): Promise<ApiResponse<AccessPage<Summary>>> {
    return this.request(`/api/projects?${resourceQuery(params)}`);
  }
  createProject(input:Record<string,unknown>):Promise<ApiResponse<{projectId:string}>> {return this.request("/api/projects",{method:"POST",body:JSON.stringify(input)});}
  deleteProject(id:string):Promise<ApiResponse<unknown>> {return this.request(`/api/projects/${encodeURIComponent(id)}`,{method:"DELETE"});}
  getProject(id:string):Promise<ApiResponse<Summary>> {return this.request(`/api/projects/${encodeURIComponent(id)}`);}
  listGroups(params:{page?:number;pageSize?:number;q?:string;parentId?:string|null;minRole?:string}={}):Promise<ApiResponse<AccessPage<ProjectGroup>>> {return this.request(`/api/groups?${resourceQuery(params)}`);}
  getGroup(id:string):Promise<ApiResponse<ProjectGroup>> {return this.request(`/api/groups/${encodeURIComponent(id)}`);}
  saveGroup(id:string|undefined,input:{name?:string;description?:string;parentId?:string|null}):Promise<ApiResponse<ProjectGroup>> {return this.request(`/api/groups${id?`/${encodeURIComponent(id)}`:""}`,{method:id?"PATCH":"POST",body:JSON.stringify(input)});}
  deleteGroup(id:string):Promise<ApiResponse<{deleted:boolean}>> {return this.request(`/api/groups/${encodeURIComponent(id)}`,{method:"DELETE"});}
  transferProject(id:string,groupId:string|null):Promise<ApiResponse<unknown>> {return this.request(`/api/projects/${encodeURIComponent(id)}/group`,{method:"PUT",body:JSON.stringify({groupId})});}
  resourceMembers(type:"project"|"group",id:string,page:number):Promise<ApiResponse<AccessPage<ProjectMember>>> {return this.request(`/api/${type}s/${encodeURIComponent(id)}/members?page=${page}`);}
  setResourceMember(type:"project"|"group",id:string,userId:string,role?:ProjectRole):Promise<ApiResponse<unknown>> {return this.request(`/api/${type}s/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,{method:role?"PUT":"DELETE",...(role?{body:JSON.stringify({role})}:{})});}
  resourceInvitations(type:"project"|"group",id:string):Promise<ApiResponse<ProjectInvitation[]>> {return this.request(`/api/${type}s/${encodeURIComponent(id)}/invitations`);}
  inviteResourceMember(type:"project"|"group",id:string,role:ProjectRole):Promise<ApiResponse<{invitation:ProjectInvitation;token:string}>> {return this.request(`/api/${type}s/${encodeURIComponent(id)}/invitations`,{method:"POST",body:JSON.stringify({role})});}
  revokeResourceInvitation(type:"project"|"group",id:string,invitationId:string):Promise<ApiResponse<unknown>> {return this.request(`/api/${type}s/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}`,{method:"DELETE"});}


  listVersions(projectName: string): Promise<ApiResponse<VersionSummary>> {
    return this.request<VersionSummary>(
      `/api/projects/${encodeURIComponent(projectName)}/versions`,
    );
  }

  getProjectDependencies(
    projectName: string,
    target = "latest",
  ): Promise<ApiResponse<ProjectDependencyStatusResult>> {
    return this.request<ProjectDependencyStatusResult>(
      `/api/projects/${encodeURIComponent(projectName)}/dependencies?target=${encodeURIComponent(target)}`,
    );
  }

  listRelatedProjects(projectId: string): Promise<ApiResponse<RelatedProjectListResult>> {
    return this.request<RelatedProjectListResult>(
      `/api/projects/${encodeURIComponent(projectId)}/related-projects`,
    );
  }

  setRelatedProject(
    projectId: string,
    alias: string,
    input: {
      targetProjectId: string;
      targetAlias: string;
      grantToRelatedProject: import("@steamharness/project-info").RelatedProjectKVGrant;
      targetGrantToRelatedProject: import("@steamharness/project-info").RelatedProjectKVGrant;
    },
  ): Promise<ApiResponse<RelatedProjectListResult>> {
    return this.request<RelatedProjectListResult>(
      `/api/projects/${encodeURIComponent(projectId)}/related-projects/${encodeURIComponent(alias)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  }

  removeRelatedProject(
    projectId: string,
    alias: string,
  ): Promise<ApiResponse<{ removed: boolean; relatedProjects: RelatedProjectListResult["relatedProjects"] }>> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/related-projects/${encodeURIComponent(alias)}`,
      { method: "DELETE" },
    );
  }

  listSourceAccessRequests(
    projectName: string,
  ): Promise<ApiResponse<ProjectSourceAccessSummary>> {
    return this.request<ProjectSourceAccessSummary>(
      `/api/projects/${encodeURIComponent(projectName)}/access-requests`,
    );
  }

  resolveSourceAccessRequest(
    projectName: string,
    requestId: string,
    status: "approved" | "rejected",
  ): Promise<ApiResponse<ProjectAccessRequest>> {
    return this.request<ProjectAccessRequest>(
      `/api/projects/${encodeURIComponent(projectName)}/access-requests/${encodeURIComponent(requestId)}`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
  }


  getProjectSourceAccessLink(
    token: string,
  ): Promise<ApiResponse<ProjectAccessLinkInfo>> {
    return this.request<ProjectAccessLinkInfo>(
      `/api/project-access/${encodeURIComponent(token)}`,
    );
  }

  createProjectSourceAccessRequest(
    token: string,
    reason: string,
  ): Promise<ApiResponse<ProjectAccessRequest>> {
    return this.request<ProjectAccessRequest>(
      `/api/project-access/${encodeURIComponent(token)}/requests`,
      { method: "POST", body: JSON.stringify({ reason }) },
    );
  }

  listProjectMembers(projectName: string): Promise<ApiResponse<AccessPage<ProjectMember>>> {
    return this.request(`/api/projects/${encodeURIComponent(projectName)}/members`);
  }

  setProjectMember(
    projectName: string,
    userId: string,
    payload: { role: ProjectRole },
  ): Promise<ApiResponse<ProjectMember>> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectName)}/members/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      },
    );
  }

  removeProjectMember(
    projectName: string,
    userId: string,
  ): Promise<ApiResponse<{ removed: boolean }>> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectName)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  createProjectInvitation(
    projectName: string,
    payload: { role: InvitationRole },
  ): Promise<ApiResponse<{ invitation: ProjectInvitation; token: string }>> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectName)}/invitations`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  }

  listProjectInvitations(
    projectName: string,
  ): Promise<ApiResponse<ProjectInvitation[]>> {
    return this.request(`/api/projects/${encodeURIComponent(projectName)}/invitations`);
  }

  revokeProjectInvitation(
    projectName: string,
    invitationId: string,
  ): Promise<ApiResponse<{ revoked: boolean }>> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectName)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
  }

  lookupInvitation(token: string): Promise<ApiResponse<InvitationLookupResult>> {
    return this.request(`/api/invitations/${encodeURIComponent(token)}`);
  }

  acceptInvitation(token: string): Promise<ApiResponse<InvitationAcceptResult>> {
    return this.request(`/api/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
    });
  }

  updateProjectVisibility(
    projectName: string,
    payload: { visibility: "private" | "public" },
  ): Promise<ApiResponse<Summary>> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectName)}/visibility`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  }

  getProjectDataSummary(projectId: string): Promise<ApiResponse<ProjectDataSummary>> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/data-summary`);
  }

  listProjectKVEntries(
    projectId: string,
    options: {
      pageSize?: number;
      cursor?: string;
      scope?: "project" | "conversation" | "all";
      query?: string;
      valueType?: KVEntryValueType | "all";
      conversationId?: string;
      runId?: string;
    } = {},
  ): Promise<ApiResponse<KVEntryPage>> {
    const query = new URLSearchParams();
    query.set("pageSize", String(options.pageSize ?? 20));
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.scope && options.scope !== "all") query.set("scope", options.scope);
    if (options.query) query.set("q", options.query);
    if (options.valueType && options.valueType !== "all") query.set("valueType", options.valueType);
    if (options.conversationId) query.set("conversationId", options.conversationId);
    if (options.runId) query.set("runId", options.runId);

    return this.request<KVEntryPage>(
      `/api/projects/${encodeURIComponent(projectId)}/kv?${query.toString()}`,
    );
  }

  getProjectKVEntry(
    projectId: string,
    options: {
      scope: KVEntryScope;
      key: string;
      conversationId?: string;
    },
  ): Promise<ApiResponse<KVEntryDetail>> {
    const query = new URLSearchParams();
    query.set("scope", options.scope);
    query.set("key", options.key);
    if (options.conversationId) query.set("conversationId", options.conversationId);

    return this.request<KVEntryDetail>(
      `/api/projects/${encodeURIComponent(projectId)}/kv/entry?${query.toString()}`,
    );
  }

  deleteProjectKVEntry(
    projectId: string,
    options: {
      scope: KVEntryScope;
      key: string;
      conversationId?: string;
    },
  ): Promise<ApiResponse<{ scope: KVEntryScope; key: string; conversationId?: string }>> {
    const query = new URLSearchParams();
    query.set("scope", options.scope);
    query.set("key", options.key);
    if (options.conversationId) query.set("conversationId", options.conversationId);

    return this.request<{ scope: KVEntryScope; key: string; conversationId?: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/kv/entry?${query.toString()}`,
      { method: "DELETE" },
    );
  }

  listKnowledgeDocuments(
    projectName: string,
    options: { pageSize?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ApiResponse<KnowledgeDocumentPageRecord>> {
    const query = new URLSearchParams();
    if (options.pageSize !== undefined) query.set("pageSize", String(options.pageSize));
    if (options.cursor) query.set("cursor", options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<KnowledgeDocumentPageRecord>(
      `/api/projects/${encodeURIComponent(projectName)}/knowledge-documents${suffix}`,
      { signal: options.signal },
    );
  }

  getKnowledgeDocument(
    projectName: string,
    documentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApiResponse<KnowledgeDocument>> {
    return this.request<KnowledgeDocument>(
      `/api/projects/${encodeURIComponent(projectName)}/knowledge-documents/${encodeURIComponent(documentId)}`,
      { signal: options.signal },
    );
  }

  createKnowledgeDocument(
    projectName: string,
    payload: { id?: string; title: string; markdown: string },
    options: { response?: "document" | "summary"; signal?: AbortSignal } = {},
  ): Promise<ApiResponse<KnowledgeDocument | KnowledgeDocumentSummaryRecord>> {
    const query = new URLSearchParams();
    if (options.response) query.set("response", options.response);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<KnowledgeDocument | KnowledgeDocumentSummaryRecord>(
      `/api/projects/${encodeURIComponent(projectName)}/knowledge-documents${suffix}`,
      {
        method: "POST",
        body: JSON.stringify(payload),
        signal: options.signal,
      },
    );
  }

  editKnowledgeDocument(
    projectName: string,
    documentId: string,
    payload: { title?: string; markdown?: string },
    options: { response?: "document" | "summary"; signal?: AbortSignal } = {},
  ): Promise<ApiResponse<KnowledgeDocument | KnowledgeDocumentSummaryRecord>> {
    const query = new URLSearchParams();
    if (options.response) query.set("response", options.response);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<KnowledgeDocument | KnowledgeDocumentSummaryRecord>(
      `/api/projects/${encodeURIComponent(projectName)}/knowledge-documents/${encodeURIComponent(documentId)}${suffix}`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
        signal: options.signal,
      },
    );
  }

  deleteKnowledgeDocument(
    projectName: string,
    documentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApiResponse<{ id: string; deleted: boolean }>> {
    return this.request<{ id: string; deleted: boolean }>(
      `/api/projects/${encodeURIComponent(projectName)}/knowledge-documents/${encodeURIComponent(documentId)}`,
      { method: "DELETE", signal: options.signal },
    );
  }

  searchKnowledgeDocuments(
    projectName: string,
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
  ): Promise<ApiResponse<KnowledgeSearchResultRecord>> {
    const query = new URLSearchParams();
    query.set("q", options.query);
    if (options.documentId) query.set("documentId", options.documentId);
    if (options.beforeLines !== undefined) query.set("beforeLines", String(options.beforeLines));
    if (options.afterLines !== undefined) query.set("afterLines", String(options.afterLines));
    if (options.maxMatches !== undefined) query.set("maxMatches", String(options.maxMatches));
    if (options.pageSize !== undefined) query.set("pageSize", String(options.pageSize));
    if (options.cursor) query.set("cursor", options.cursor);
    return this.request<KnowledgeSearchResultRecord>(
      `/api/projects/${encodeURIComponent(projectName)}/knowledge-documents/search?${query.toString()}`,
      { signal: options.signal },
    );
  }

  readKnowledgeDocumentLines(
    projectName: string,
    documentId: string,
    options: { startLine: number; endLine: number; signal?: AbortSignal },
  ): Promise<ApiResponse<KnowledgeDocumentLinesResult>> {
    const query = new URLSearchParams();
    query.set("startLine", String(options.startLine));
    query.set("endLine", String(options.endLine));
    return this.request<KnowledgeDocumentLinesResult>(
      `/api/projects/${encodeURIComponent(projectName)}/knowledge-documents/${encodeURIComponent(documentId)}/lines?${query.toString()}`,
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

function resourceQuery(params:Record<string,unknown>):string {const query=new URLSearchParams();for(const [key,value] of Object.entries(params))if(value!==undefined)query.set(key,value===null?"":String(value));return query.toString();}
