// 当前支持的语言与偏好类型。新增语言时：在 SUPPORTED_LOCALES 追加，
// 补齐 resources/<lang>.ts 资源，并同步 normalizeLocale 的映射规则。
export type SupportedLocale = "zh-CN" | "en";

// LocalePreference 表示“跟随系统或显式指定语言”的偏好；持久化与语言切换 UI 使用它。
export type LocalePreference = "system" | SupportedLocale;

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ["zh-CN", "en"] as const;

export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
