// 语言感知的日期/数字格式化与字符串排序。默认使用当前 i18n 语言，
// 也允许显式传入 locale（测试与个别场景需要确定性输出时使用）。
import { i18n } from "../instance";
import { normalizeLocale } from "./locale";

function resolveLocale(locale?: string): string {
  return locale ? normalizeLocale(locale) : normalizeLocale(i18n.language);
}

function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export interface FixedDateFormatOptions {
  timeZone?: string;
}

type FixedDatePart = "year" | "month" | "day" | "hour" | "minute" | "second";

function readFixedDateParts(
  value: Date | number | string,
  options: FixedDateFormatOptions,
  includeTime: boolean,
): Partial<Record<FixedDatePart, string>> {
  const date = toDate(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Invalid time value");
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime
      ? {
          hour: "2-digit" as const,
          minute: "2-digit" as const,
          second: "2-digit" as const,
          hourCycle: "h23" as const,
        }
      : {}),
    timeZone: options.timeZone,
  }).formatToParts(date);

  return parts.reduce<Partial<Record<FixedDatePart, string>>>((result, part) => {
    if (part.type === "year" || part.type === "month" || part.type === "day"
      || part.type === "hour" || part.type === "minute" || part.type === "second") {
      result[part.type] = part.value;
    }
    return result;
  }, {});
}

function joinFixedDate(parts: Partial<Record<FixedDatePart, string>>): string {
  if (!parts.year || !parts.month || !parts.day) {
    throw new RangeError("Invalid time value");
  }
  return `${parts.year.padStart(4, "0")}-${parts.month.padStart(2, "0")}-${parts.day.padStart(2, "0")}`;
}

/** 用户可见的完整时间固定为 YYYY-MM-DD HH:mm:ss，语言参数仅保留兼容性。 */
export function formatDateTime(
  value: Date | number | string,
  options: FixedDateFormatOptions = {},
  _locale?: string,
): string {
  const parts = readFixedDateParts(value, options, true);
  if (!parts.hour || !parts.minute || !parts.second) {
    throw new RangeError("Invalid time value");
  }
  return `${joinFixedDate(parts)} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** 用户可见的纯日期固定为 YYYY-MM-DD，语言参数仅保留兼容性。 */
export function formatDate(
  value: Date | number | string,
  options: FixedDateFormatOptions = {},
  _locale?: string,
): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new RangeError("Invalid time value");
    }
    return value;
  }
  return joinFixedDate(readFixedDateParts(value, options, false));
}

/** 语言感知的数字格式化，替换散落的 Intl.NumberFormat("zh-CN") 调用。 */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale?: string,
): string {
  return new Intl.NumberFormat(resolveLocale(locale), options).format(value);
}

/** 语言感知的字符串排序比较，替换散落的 localeCompare(b, "zh-CN")。 */
export function compareStrings(a: string, b: string, locale?: string): number {
  return a.localeCompare(b, resolveLocale(locale));
}
