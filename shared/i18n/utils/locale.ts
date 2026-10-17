// 语言偏好解析、系统语言探测与 localStorage 持久化。
// 持久化函数对 window 做了守卫，可安全用于 Node（server / CLI）环境。
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type LocalePreference,
  type SupportedLocale,
} from "../types";

function resolveSupportedLocale(input: string | null | undefined): SupportedLocale | undefined {
  const value = (input ?? "").toLowerCase().replace("_", "-");
  if (value.startsWith("zh")) return "zh-CN";
  if (value.startsWith("en")) return "en";
  return undefined;
}

/** 把任意 locale 输入归一化到最近的支持语言；未识别语言回退默认（zh-CN）。 */
export function normalizeLocale(input: string | null | undefined): SupportedLocale {
  return resolveSupportedLocale(input) ?? DEFAULT_LOCALE;
}

/** 优先使用宿主提供的系统首选语言；浏览器宿主没有该信息时回退 Intl。 */
export function resolveSystemLocale(systemLanguages?: readonly string[]): SupportedLocale {
  if (systemLanguages !== undefined && systemLanguages.length > 0) {
    for (const systemLanguage of systemLanguages) {
      const locale = resolveSupportedLocale(systemLanguage);
      if (locale !== undefined) return locale;
    }
    return DEFAULT_LOCALE;
  }

  try {
    if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
      return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale);
    }
  } catch {
    // Intl 不可用时回退默认。
  }
  return DEFAULT_LOCALE;
}

/** 读取持久化的语言偏好；无值或非法时返回 "system"。 */
export function readStoredLocale(storageKey: string): LocalePreference {
  try {
    if (typeof window === "undefined") return "system";
    const value = window.localStorage.getItem(storageKey);
    if (value === "system" || isSupportedLocale(value)) return value;
    return "system";
  } catch {
    return "system";
  }
}

/** 持久化语言偏好；localStorage 不可用（锁定 webview 等）时静默忽略。 */
export function persistLocale(storageKey: string, preference: LocalePreference): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, preference);
  } catch {
    // localStorage 不可用时保持内存中的设置。
  }
}

/** 把偏好解析为实际使用的语言。 */
export function resolveLocalePreference(
  preference: LocalePreference,
  systemLanguages?: readonly string[],
): SupportedLocale {
  return preference === "system" ? resolveSystemLocale(systemLanguages) : preference;
}
