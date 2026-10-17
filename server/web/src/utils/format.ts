import { formatDate as formatFixedDate, formatDateTime, i18n } from "@steamharness/i18n";

export function formatDate(value?: string): string {
  if (!value) return i18n.t("formatTimeUnknown", { ns: "serverWeb" });
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
}

export function formatDateOnly(value?: string): string {
  if (!value) return i18n.t("formatDateGroupUnknown", { ns: "serverWeb" });
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatFixedDate(value);
}

export function formatDateGroup(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return i18n.t("formatDateGroupUnknown", { ns: "serverWeb" });
  return formatFixedDate(value);
}

export function formatDuration(value: number): string {
  if (!Number.isFinite(value)) return i18n.t("formatDurationUnknown", { ns: "serverWeb" });
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}
