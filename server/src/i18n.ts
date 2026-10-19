// Server-side i18n. The shared @steamharness/i18n core entry is used directly
// (never the /react entry) so no React runtime is pulled into the server.
import {
  initI18n,
  i18n,
  readSteamHarnessI18nDescriptor,
  type SupportedLocale,
} from "@steamharness/i18n";
import type { HttpError } from "./protocol";

// 服务端默认语言保持英文：服务端既有报错文案全部是英文，改成中文默认会让
// 不带语言头的 API 调用方（curl、脚本、第三方集成）的 errMessage 从英文变中文。
// 中英文界面客户端都会在请求头里带上 X-SteamHarness-Locale，按需得到本地化文案。
const SERVER_DEFAULT_LOCALE = "en";

/**
 * t() bound to a fixed locale and the "server" namespace.
 * The structural type accepts any key so messageKey-driven lookups (including
 * "server:..." prefixed keys) type-check without depending on i18next types in
 * the server package (i18next is a transitive dependency, not a direct one).
 */
export type ServerT = (
  key: string,
  options?: Record<string, unknown>,
) => string;

let serverI18nStarted = false;

const STABLE_ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "Unauthorized.": "server:unauthorized",
  "Permission denied.": "server:permissionDenied",
  "Admin key is invalid.": "server:adminKeyInvalid",
  "Invalid device code.": "server:invalidDeviceCode",
  "Account is disabled.": "server:accountDisabled",
  "A user account is required.": "server:userAccountRequired",
  "Account login is required to accept invitations.": "server:invitationLoginRequired",
  "Account login is required to use Kanban configurations.": "server:kanbanLoginRequired",
  "Login is required to use Kanban configurations.": "server:kanbanLoginRequired",
  "steamHarness.projectInfo must be an object.": "server:projectInfoObjectRequired",
  "steamHarness.projectInfo.dataStorage must be an object.": "server:projectInfoDataStorageObjectRequired",
  'steamHarness.projectInfo.dataStorage.mode must be "local", "server", or "both".': "server:projectInfoDataStorageModeInvalid",
  "steamHarness.projectInfo.dataStorage.mode must be declared as local, server, or both.": "server:projectInfoDataStorageModeRequired",
  "User not found.": "server:userNotFound",
  "Invitation not found.": "server:invitationNotFound",
  "Device code not found.": "server:deviceCodeNotFound",
  "API route not found.": "server:apiRouteNotFound",
  "STEAMHARNESS_SERVER_ADMIN_KEY is required.": "server:adminKeyRequired",
  "Too many requests.": "server:tooManyRequests",
  "Request body is too large.": "server:requestBodyTooLarge",
  "Kanban related project is unavailable.": "server:kanbanRelatedProjectUnavailable",
  "Related project does not exist.": "server:relatedProjectMissing",
  "Related project KV access is not granted for this key.": "server:relatedProjectKVAccessDenied",
  "Related project is unavailable or awaiting confirmation.": "server:relatedProjectUnavailable",
  "Related project grant is invalid.": "server:relatedProjectGrantInvalid",
  'status must be "approved" or "rejected".': "server:sourceAccessStatusInvalid",
  "limit must be an integer from 1 to 200.": "server:sourceAccessLimitInvalid",
  'source must be "desktop" or "cli".': "server:nonWebClientSourceType",
  "A project group root must be an existing Kanban project.": "server:projectGroupRootInvalid",
  "Project-group packages must use .tar.gz or .tgz format.": "server:projectGroupPackageFormat",
  "Uploaded project-group manifest does not match the deployment plan.": "server:projectGroupManifestMismatch",
  "The project-group root archive must contain a Kanban project.": "server:projectGroupRootArchiveType",
  "The previously published Kanban root has a different dependency lock.": "server:projectGroupPreviousLockMismatch",
  "Project groups can only download immutable published versions.": "server:projectGroupImmutableDownload",
  "Access request reason must contain 2 to 1000 characters.": "server:sourceAccessReasonLength",
  "Project source access request link is invalid or expired.": "server:sourceAccessLinkInvalid",
  "Project-group root is missing.": "server:projectGroupRootMissing",
  "Project-group dependency manifest no longer matches the root Kanban draft.": "server:projectGroupDraftChanged",
  "Project dependency delivery requires PostgreSQL storage.": "server:projectDependencyStorageUnavailable",
  "Project dependency lock is invalid.": "server:projectDependencyLockInvalid",
  "Published dependency lock does not match confirmed related projects.": "server:dependencyLockRelatedProjectsMismatch",
  "Failed to inspect tar.gz package.": "server:archiveInspectFailed",
  "Archive contains too many entries.": "server:archiveEntryLimit",
  "Archive expanded size exceeds the 512 MB limit.": "server:archiveExpandedSizeLimit",
  "A user account is required to create a project deployment.": "server:accountCreateDeploymentRequired",
  "A user account is required to view a project source access request.": "server:accountViewSourceRequestRequired",
  "A user account is required to request project source access.": "server:accountRequestSourceAccessRequired",
  "Bearer token is required.": "server:bearerTokenRequired",
});

const DYNAMIC_ERROR_MESSAGE_RULES: ReadonlyArray<{
  key: string;
  pattern: RegExp;
}> = [
  { key: "server:invalidNonWebClientSource", pattern: /^Invalid non-web client source "(?<source>[^"]*)"\.$/ },
  { key: "server:includedProjectMissing", pattern: /^Included project "(?<projectId>[^"]+)" does not exist on this Server\.$/ },
  { key: "server:includedDependencyType", pattern: /^Included dependency "(?<projectId>[^"]+)" must be a Workflow project\.$/ },
  { key: "server:deploymentMissing", pattern: /^Deployment "(?<deploymentId>[^"]+)" does not exist\.$/ },
  { key: "server:deploymentInvalidStatus", pattern: /^Deployment "(?<deploymentId>[^"]+)" cannot be prepared from status "(?<status>[^"]+)"\.$/ },
  { key: "server:deploymentBusy", pattern: /^Deployment "(?<deploymentId>[^"]+)" is already being prepared or published\.$/ },
  { key: "server:projectGroupManifestFileInvalid", pattern: /^Invalid project-group\.json: (?<details>[\s\S]+)$/ },
  { key: "server:projectGroupForbiddenFile", pattern: /^Project group contains forbidden file "(?<path>[^"]+)"\.$/ },
  { key: "server:includedProjectHostData", pattern: /^Included project "(?<projectId>[^"]+)" contains forbidden host data "(?<path>[^"]+)"\.$/ },
  { key: "server:includedDependencyArchiveType", pattern: /^Included dependency "(?<projectId>[^"]+)" must contain a Workflow project\.$/ },
  { key: "server:deploymentPrepareRequired", pattern: /^Deployment "(?<deploymentId>[^"]+)" must be prepared before publishing\.$/ },
  { key: "server:deploymentProjectsIncomplete", pattern: /^Deployment "(?<deploymentId>[^"]+)" has not finished preparing every project\.$/ },
  { key: "server:deploymentReservationIncomplete", pattern: /^Deployment "(?<deploymentId>[^"]+)" could not reserve every project version\.$/ },
  { key: "server:workflowVersionSourceUnavailable", pattern: /^Workflow "(?<projectId>[^"]+)" version "(?<version>[^"]+)" does not retain downloadable source\.$/ },
  { key: "server:projectGroupHostData", pattern: /^Project "(?<projectId>[^"]+)" version "(?<version>[^"]+)" contains host data that cannot be included in a project-group download\.$/ },
  { key: "server:workflowMissing", pattern: /^Workflow "(?<projectId>[^"]+)" does not exist\.$/ },
  { key: "server:pendingSourceAccessMissing", pattern: /^Pending access request "(?<requestId>[^"]+)" does not exist\.$/ },
  { key: "server:reservedVersionChanged", pattern: /^Reserved version for project "(?<projectId>[^"]+)" changed\.$/ },
  { key: "server:projectNotKanban", pattern: /^Project "(?<projectName>[^"]+)" is not a Kanban project\.$/ },
  { key: "server:workflowReservationUnavailable", pattern: /^Workflow "(?<projectId>[^"]+)" version reservation is unavailable\.$/ },
  { key: "server:workflowReservationChanged", pattern: /^Workflow "(?<projectId>[^"]+)" version reservation changed\.$/ },
  { key: "server:workflowDraftChanged", pattern: /^Workflow "(?<projectId>[^"]+)" draft changed after deployment preparation\.$/ },
  { key: "server:dependencyLockRelatedProjectMismatch", pattern: /^Published dependency lock "(?<alias>[^"]+)" does not match a confirmed related project\.$/ },
  { key: "server:versionDependencyLockInvalid", pattern: /^Workflow "(?<projectId>[^"]+)" version "(?<version>[^"]+)" has an invalid dependency lock\.$/ },
  { key: "server:archiveEntrySizeInvalid", pattern: /^Archive entry "(?<path>[^"]+)" has an invalid size\.$/ },
  { key: "server:archiveUnsupportedType", pattern: /^Archive entry "(?<path>[^"]+)" uses unsupported type "(?<type>[^"]+)"\. Only regular files and directories are allowed\.$/ },
  { key: "server:workflowOwnedByAnotherAccount", pattern: /^Workflow "(?<projectId>[^"]+)" already exists and is owned by another account\.$/ },
];

/**
 * Initialize the server default locale (en) exactly once at startup.
 * Requests are never switched via the global instance — request-scoped
 * localization uses getRequestT() so concurrent requests stay isolated.
 */
export function ensureServerI18n(): void {
  if (!serverI18nStarted) {
    initI18n({ preference: SERVER_DEFAULT_LOCALE });
    serverI18nStarted = true;
  }
}

/**
 * 解析请求语言。只信任显式 X-SteamHarness-Locale 头（第一方客户端注入），
 * WebSocket 升级无法设置自定义头时回退 ?locale= 查询参数；都不带时回退
 * 服务端默认（en）。accept-language 被刻意忽略，避免 errMessage 随调用方
 * 系统/浏览器语言漂移而破坏现有英文断言的调用方。
 */
export function resolveRequestLocale(req: {
  headers: { [k: string]: string | string[] | undefined };
  url?: string;
}): SupportedLocale {
  const localeHeader = req.headers["x-steamharness-locale"];
  let raw = typeof localeHeader === "string"
    ? localeHeader
    : Array.isArray(localeHeader)
      ? localeHeader[0]
      : undefined;
  if (!raw && req.url) {
    try {
      raw = new URL(req.url, "http://steamharness.local").searchParams.get("locale") ?? undefined;
    } catch {
      // Malformed url must not break request localization.
    }
  }
  // 明确支持的 zh/en 才本地化；未支持语言统一回退服务端默认（en），而不是 app 默认 zh-CN。
  const lower = (raw ?? "").toLowerCase().replace("_", "-");
  return lower.startsWith("zh") ? "zh-CN" : lower.startsWith("en") ? "en" : SERVER_DEFAULT_LOCALE;
}

/**
 * Build a request-scoped t() bound to the caller's locale.
 */
export function getRequestT(req: {
  headers: { [k: string]: string | string[] | undefined };
  url?: string;
}): ServerT {
  // Startup initialization is the contract, but keep first-use lazy so any
  // entry point (tests, workers, scripts) is safe without ordering surprises.
  ensureServerI18n();
  return i18n.getFixedT(resolveRequestLocale(req), "server") as unknown as ServerT;
}

/**
 * Resolve the message an HttpError should surface, preferring the translated
 * messageKey when present and falling back to the literal message.
 */
export function localizeHttpErrorMessage(
  httpError: HttpError,
  t: ServerT,
): string {
  const descriptor = readSteamHarnessI18nDescriptor(httpError.data);
  if (descriptor !== undefined) {
    return t(`${descriptor.namespace}:${descriptor.key}`, descriptor.values);
  }
  if (httpError.messageKey) {
    return t(httpError.messageKey, httpError.params);
  }
  return localizeServerMessage(httpError.message, t, httpError.params);
}

/** Localize stable server-owned literals while preserving dynamic provider and business details. */
export function localizeServerMessage(
  message: string,
  t: ServerT,
  params?: Record<string, unknown>,
): string {
  const messageKey = STABLE_ERROR_MESSAGE_KEYS[message];
  if (messageKey) return t(messageKey, params);

  for (const rule of DYNAMIC_ERROR_MESSAGE_RULES) {
    const match = rule.pattern.exec(message);
    if (match !== null) {
      return t(rule.key, {
        ...params,
        ...(match.groups ?? {}),
      });
    }
  }
  return message;
}
