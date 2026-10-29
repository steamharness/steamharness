export interface MemoryRecord {
  id: string;
  scope: string;
  content: string;
  origin: "manual" | "automatic";
  version: number;
  updatedAt: string;
  sources: { id: string; role: string; content: string }[];
}
export interface MemoryClient {
  call(action: string, input?: Record<string, unknown>): Promise<any>;
}
const en = {
  title: "Memory",
  global: "Personal global",
  current: "Current project",
  all: "All scopes",
  project: "Project",
  directory: "Directory",
  automatic: "Automatic",
  manual: "Manual",
  allOrigins: "All sources",
  search: "Search memories",
  refresh: "Refresh",
  new: "Remember",
  save: "Save",
  edit: "Edit",
  autoUnavailable:
    "Automatic extraction is off or its model is not configured.",
  forget: "Forget",
  clear: "Clear scope",
  cancel: "Cancel",
  back: "Back to list",
  next: "Next page",
  previous: "Previous page",
  empty: "No memories yet",
  emptyNote: "Durable preferences and project decisions will appear here.",
  select: "Select a memory to read its full content.",
  loading: "Loading memories…",
  error: "Memory is unavailable. Retry or check the service configuration.",
  unconfigured:
    "Account memory is not configured on this server. Ask your administrator to configure the memory service.",
  unauthorized: "Verify your account authorization to access memory.",
  authorize: "Verify account authorization",
  unsupported: "This server does not support account memory yet. Ask your administrator to update it.",
  disabled: "Account memory is turned off.",
  readonly: "Read-only memory",
  content: "Memory content",
  scope: "Scope",
  source: "Source",
  updated: "Updated",
  version: "Version",
  sources: "Source excerpts",
  enabled: "Account memory",
  enabledNote: "Let the assistant recall your preferences and project decisions across conversations.",
  autoSave: "Automatically save durable memories",
  autoSaveNote: "Extract long-term preferences and project context after conversations. You can edit or forget them at any time.",
  privacy:
    "Private to your account. Deleting a conversation does not forget its memories.",
  locked: "Permission locked",
  lockedNote:
    "Only the number of records is visible until project access is restored.",
  pending: "Pending extraction",
  failed: "Extraction failed",
  retry: "Retry extraction",
  confirmForget: "Forget this memory?",
  confirmClear: "Clear all memories in this scope?",
  consequence:
    "This removes saved memory and prevents older pending turns from recreating it. Conversation messages remain available.",
  confirm: "Confirm",
  conflict:
    "This memory changed. Refresh and review the current version before saving.",
  count: "records",
  copied: "Copied",
  copy: "Copy text",
  detail: "Memory details",
  status: "Service status",
};
const zh: Record<keyof typeof en, string> = {
  title: "记忆",
  global: "个人全局",
  current: "当前项目",
  all: "全部范围",
  project: "项目",
  directory: "目录",
  automatic: "自动提炼",
  manual: "手动保存",
  allOrigins: "全部来源",
  search: "搜索记忆",
  refresh: "刷新",
  new: "记住",
  save: "保存",
  edit: "编辑",
  autoUnavailable: "自动提炼已关闭或尚未配置提炼模型。",
  forget: "遗忘",
  clear: "清空范围",
  cancel: "取消",
  back: "返回列表",
  next: "下一页",
  previous: "上一页",
  empty: "暂无记忆",
  emptyNote: "长期偏好和项目决策会显示在这里。",
  select: "选择一条记忆，查看完整内容。",
  loading: "正在加载记忆…",
  error: "记忆暂时不可用，请重试或检查服务配置。",
  unconfigured: "当前服务器尚未配置账号记忆服务，请联系管理员完成配置。",
  unauthorized: "验证当前账号的访问授权后，即可查看和管理记忆。",
  authorize: "验证账号授权",
  unsupported: "当前服务器尚不支持账号记忆，请联系管理员升级服务。",
  disabled: "账号记忆已关闭。",
  readonly: "只读记忆",
  content: "记忆内容",
  scope: "范围",
  source: "来源",
  updated: "更新时间",
  version: "版本",
  sources: "来源片段",
  enabled: "账号记忆",
  enabledNote: "允许助手跨对话召回你的长期偏好和项目约定。",
  autoSave: "自动保存长期记忆",
  autoSaveNote: "对话后自动提炼长期偏好和项目背景，你可以随时编辑或遗忘。",
  privacy: "仅当前账号可见。删除对话不会遗忘长期记忆。",
  locked: "权限已锁定",
  lockedNote: "恢复项目权限前，仅显示记录数量。",
  pending: "待提炼",
  failed: "提炼失败",
  retry: "重新提炼",
  confirmForget: "遗忘这条记忆？",
  confirmClear: "清空此范围的全部记忆？",
  consequence:
    "这会移除已保存的记忆，并阻止较早的待处理回合重新生成它。对话消息仍会保留。",
  confirm: "确认",
  conflict: "记忆已发生变化，请刷新并查看最新版本后再编辑。",
  count: "条记录",
  copied: "已复制",
  copy: "复制文本",
  detail: "记忆详情",
  status: "服务状态",
};
export type MemoryTextKey = keyof typeof en;
export function memoryText(locale: string, key: MemoryTextKey): string {
  return /^zh/i.test(locale) ? zh[key] : en[key];
}
export const memoryEndpoint: Record<string, { path: string; method: string }> =
  {
    capabilities: { path: "/memory/capabilities", method: "GET" },
    list: { path: "/memories", method: "GET" },
    get: { path: "/memories/:id", method: "GET" },
    remember: { path: "/memories", method: "POST" },
    update: { path: "/memories/:id", method: "PATCH" },
    forget: { path: "/memories/:id", method: "DELETE" },
    preferences: { path: "/memory/preferences", method: "GET" },
    setPreferences: { path: "/memory/preferences", method: "PATCH" },
    jobs: { path: "/memory/jobs", method: "GET" },
    retry: { path: "/memory/jobs/:id/retry", method: "POST" },
    clear: { path: "/memory/clear", method: "POST" },
    scopes: { path: "/memory/scopes", method: "GET" },
  };
/** Browser cookie session client. A scoped host bridge can implement the same interface. */
export function createMemoryClient(
  options: {
    fetch?: typeof fetch;
    baseUrl?: string;
    headers?: () => Record<string, string>;
  } = {},
): MemoryClient {
  return {
    async call(action, input = {}) {
      const endpoint = Object.hasOwn(memoryEndpoint, action) ? memoryEndpoint[action] : undefined;
      if (!endpoint) throw new Error("Unknown memory operation.");
      const url = new URL(
        (options.baseUrl ??
          (globalThis as { location?: { origin: string } }).location?.origin ??
          "") +
          "/api/me" +
          endpoint.path.replace(
            ":id",
            encodeURIComponent(String(input.id ?? "")),
          ),
      );
      if (endpoint.method === "GET")
        for (const [k, v] of Object.entries(input))
          if (v !== undefined) url.searchParams.set(k, String(v));
      const response = await (options.fetch ?? fetch)(url, {
        method: endpoint.method,
        headers: { "Content-Type": "application/json", ...options.headers?.() },
        ...(endpoint.method === "GET" ? {} : { body: JSON.stringify(input) }),
        credentials: "same-origin",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      let b: any;
      try { b = await response.json(); }
      catch { throw Object.assign(new Error("Invalid memory service response."), { status: response.status }); }
      if (!response.ok || b?.errCode !== 0)
        throw Object.assign(
          new Error(b?.errMessage ?? "Memory request failed."),
          { status: response.status },
        );
      return b.data;
    },
  };
}
