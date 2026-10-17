// Shared run workspace visible-status copy.
// Label functions resolve through the shared i18n instance so strings follow
// the active language; components that render them must subscribe with
// useTranslation() so they re-render on language change. Never store a label
// string in a module-scope constant — resolve via t() inside render instead.
import { i18n } from "@steamharness/i18n";

const RUN_STATUS_KEYS = {
  success: "runStatus.success",
  failed: "runStatus.failed",
  timed_out: "runStatus.timedOut",
  aborted: "runStatus.aborted",
  running: "runStatus.running",
  waiting: "runStatus.waiting",
  waiting_for_input: "runStatus.waitingForInput",
  cleared: "runStatus.cleared",
  idle: "runStatus.idle",
  unknown: "runStatus.unknown",
} as const;

export function formatRunStatusLabel(status: string | undefined, fallback?: string): string {
  if (!status) return fallback ?? i18n.t(RUN_STATUS_KEYS.unknown);
  const key = RUN_STATUS_KEYS[status as keyof typeof RUN_STATUS_KEYS];
  return key ? i18n.t(key) : (status || fallback || i18n.t(RUN_STATUS_KEYS.unknown));
}

export function formatImagePreviewError(error: string | undefined): string {
  const trimmed = error?.trim();
  return trimmed ? trimmed : i18n.t("imagePreviewUnavailable");
}
