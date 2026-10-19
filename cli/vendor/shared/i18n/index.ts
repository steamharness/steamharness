// @steamharness/i18n 核心入口。React 宿主请从 @steamharness/i18n/react 导入，
// 以便注册 react-i18next 插件；server / CLI 直接从这里导入（不引入 React）。
import { resources } from "./resources";
import { enResources } from "./resources/en";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
  type LocalePreference,
  type SupportedLocale,
} from "./types";
import { i18n } from "./instance";
import {
  normalizeLocale,
  persistLocale,
  readStoredLocale,
  resolveLocalePreference,
  resolveSystemLocale,
} from "./utils/locale";
import { setHtmlLang } from "./html-lang";

// 让 t("ns:key") / useTranslation 获得基于 en 资源形状的全量类型提示与 key 校验。
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof enResources;
  }
}

export { enResources } from "./resources/en";
export { zhResources } from "./resources/zh";
export { resources };

// 各命名空间的 key 联合类型，供配置项 / 常量数组标注 labelKey 等字段使用。
export type DesktopResourceKey = keyof (typeof enResources)["desktop"];
export type CommonResourceKey = keyof (typeof enResources)["common"];
export type ServerWebResourceKey = keyof (typeof enResources)["serverWeb"];
export type ServerResourceKey = keyof (typeof enResources)["server"];
export type CliResourceKey = keyof (typeof enResources)["cli"];
export type PermissionsResourceKey = keyof (typeof enResources)["permissions"];
export type SteamHarnessI18nNamespace = keyof typeof enResources;

/** A serializable translation reference that can cross CLI, IPC and HTTP boundaries. */
export interface SteamHarnessI18nDescriptor {
  namespace: SteamHarnessI18nNamespace;
  key: string;
  values?: Record<string, unknown>;
}

export interface SteamHarnessI18nTextDescriptors {
  title?: SteamHarnessI18nDescriptor;
  content?: SteamHarnessI18nDescriptor;
}
export {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
  type LocalePreference,
  type SupportedLocale,
} from "./types";
export { normalizeLocale, persistLocale, readStoredLocale, resolveLocalePreference, resolveSystemLocale } from "./utils/locale";
export { formatDate, formatDateTime, formatNumber, compareStrings, type FixedDateFormatOptions } from "./utils/format";
export { setHtmlLang } from "./html-lang";
export { i18n } from "./instance";

let initStarted = false;
let htmlLangHooked = false;
let systemLanguageHooked = false;
let activeStorageKey: string | undefined;
let activeSystemLanguages: readonly string[] | undefined;

/** 跟随系统模式下，操作系统/浏览器语言变化时实时切换界面语言（对应主题的 matchMedia 监听）。 */
function handleSystemLanguageChange(): void {
  if (!activeStorageKey || readStoredLocale(activeStorageKey) !== "system") return;
  i18n.changeLanguage(resolveSystemLocale(activeSystemLanguages));
}

/**
 * 初始化（或切换）i18n 语言，返回实际使用的语言。
 * - preference 为显式语言或 "system"；缺省时读取 storageKey 持久化的偏好，再缺省跟随系统。
 * - 首次调用完成 init，并注册 languageChanged → setHtmlLang 监听；之后调用仅切换语言。
 * - systemLanguages 可由桌面宿主传入操作系统的首选语言顺序；否则回退浏览器 Intl。
 * - 传入 storageKey 时额外注册 browser languagechange 监听；桌面宿主语言列表会在下次启动时刷新。
 */
export function initI18n(options?: {
  preference?: LocalePreference;
  storageKey?: string;
  systemLanguages?: readonly string[];
}): SupportedLocale {
  if (options?.systemLanguages !== undefined) {
    activeSystemLanguages = options.systemLanguages;
  }
  const preference =
    options?.preference ?? (options?.storageKey ? readStoredLocale(options.storageKey) : "system");
  const locale = resolveLocalePreference(preference, activeSystemLanguages);
  activeStorageKey = options?.storageKey;

  if (!initStarted) {
    i18n.init({
      lng: locale,
      fallbackLng: DEFAULT_LOCALE,
      defaultNS: "common",
      resources,
      initImmediate: false,
      interpolation: { escapeValue: false },
      returnEmptyString: false,
    });
    initStarted = true;
    if (typeof document !== "undefined" && !htmlLangHooked) {
      htmlLangHooked = true;
      i18n.on("languageChanged", setHtmlLang);
    }
  } else {
    i18n.changeLanguage(locale);
  }

  if (typeof window !== "undefined" && !systemLanguageHooked) {
    systemLanguageHooked = true;
    window.addEventListener("languagechange", handleSystemLanguageChange);
  }

  if (typeof document !== "undefined") {
    setHtmlLang(i18n.language);
  }
  return locale;
}

/** 当前解析后的语言（归一化到支持语言），供 HTTP 请求注入 X-Workflow-Locale 头。 */
export function getCurrentLocale(): SupportedLocale {
  return normalizeLocale(i18n.language);
}

/** 翻译运行期动态 key（数据驱动的状态/操作/元数据 key）。
 * key 为 string 时直接调用 i18n.t(key, { ns }) 会触发 react-i18next 类型重载在
 * TS 编译器下的崩溃（Debug Failure: No error for last overload signature），
 * 因此统一走这个宽松签名的包装；key 是静态字面量时请继续直接用 t()。 */
export function translateDynamicKey(
  key: string,
  ns: keyof typeof enResources = "common",
  options?: Record<string, unknown>,
): string {
  return (i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, {
    ns,
    ...options,
  });
}

/** 动态 key 翻译带回退：key 缺失时 i18next 返回 key 本身，此时回退到 fallback（如服务端下发的原始文案）。 */
export function translateDynamicKeyWithFallback(
  key: string,
  ns: keyof typeof enResources,
  fallback: string,
  options?: Record<string, unknown>,
): string {
  const value = translateDynamicKey(key, ns, options);
  return value === key ? fallback : value;
}

/** Read a single descriptor from an error, serialized HarnessError, or API failure payload. */
export function readSteamHarnessI18nDescriptor(value: unknown): SteamHarnessI18nDescriptor | undefined {
  const visited = new Set<object>();

  const visit = (candidate: unknown): SteamHarnessI18nDescriptor | undefined => {
    if (!isRecord(candidate) || visited.has(candidate)) return undefined;
    visited.add(candidate);

    if (isSteamHarnessI18nDescriptor(candidate)) return candidate;

    const direct = candidate["steamHarnessI18n"];
    if (isSteamHarnessI18nDescriptor(direct)) return direct;

    return visit(candidate["metadata"]) ??
      visit(candidate["workflowError"]) ??
      visit(candidate["error"]) ??
      visit(candidate["data"]) ??
      visit(candidate["cause"]);
  };

  return visit(value);
}

/** Read title/content descriptors stored on OutputItem metadata. */
export function readSteamHarnessI18nTextDescriptors(
  value: unknown,
): SteamHarnessI18nTextDescriptors | undefined {
  if (!isRecord(value)) return undefined;
  const container = isRecord(value["steamHarnessI18n"])
    ? value["steamHarnessI18n"]
    : isRecord(value["metadata"]) && isRecord(value["metadata"]["steamHarnessI18n"])
      ? value["metadata"]["steamHarnessI18n"]
      : undefined;
  if (!container) return undefined;

  const title = isSteamHarnessI18nDescriptor(container["title"])
    ? container["title"]
    : undefined;
  const content = isSteamHarnessI18nDescriptor(container["content"])
    ? container["content"]
    : undefined;
  return title || content ? { title, content } : undefined;
}

export function translateSteamHarnessI18nDescriptor(
  descriptor: SteamHarnessI18nDescriptor | undefined,
  fallback: string,
): string {
  return descriptor === undefined
    ? fallback
    : translateDynamicKeyWithFallback(
        descriptor.key,
        descriptor.namespace,
        fallback,
        descriptor.values,
      );
}

/** Translate an error at render time so a live language change updates its message. */
export function translateSteamHarnessError(value: unknown, fallback = "Unexpected workflow error."): string {
  return translateSteamHarnessI18nDescriptor(
    readSteamHarnessI18nDescriptor(value),
    readErrorMessage(value) ?? fallback,
  );
}

export class SteamHarnessLocalizedError extends Error {
  readonly steamHarnessI18n?: SteamHarnessI18nDescriptor;

  constructor(message: string, descriptor?: SteamHarnessI18nDescriptor) {
    super(message);
    this.name = "SteamHarnessLocalizedError";
    this.steamHarnessI18n = descriptor;
  }
}

export function createSteamHarnessLocalizedError(message: string, data?: unknown): SteamHarnessLocalizedError {
  return new SteamHarnessLocalizedError(message, readSteamHarnessI18nDescriptor(data));
}

function isSteamHarnessI18nDescriptor(value: unknown): value is SteamHarnessI18nDescriptor {
  return isRecord(value) &&
    typeof value["namespace"] === "string" &&
    Object.hasOwn(enResources, value["namespace"]) &&
    typeof value["key"] === "string" &&
    value["key"].trim() !== "" &&
    (value["values"] === undefined || isRecord(value["values"]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorMessage(value: unknown): string | undefined {
  const visited = new Set<object>();

  const visit = (candidate: unknown): string | undefined => {
    if (typeof candidate === "string") return candidate.trim() || undefined;
    if (!isRecord(candidate) || visited.has(candidate)) return undefined;
    visited.add(candidate);

    const message = candidate["message"];
    if (typeof message === "string" && message.trim() !== "") return message.trim();
    const errMessage = candidate["errMessage"];
    if (typeof errMessage === "string" && errMessage.trim() !== "") return errMessage.trim();
    return visit(candidate["workflowError"]) ??
      visit(candidate["error"]) ??
      visit(candidate["data"]) ??
      visit(candidate["cause"]);
  };

  return visit(value);
}
