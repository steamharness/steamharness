import { i18n } from "@steamharness/i18n";

export function formatImagePreviewError(error: string | undefined): string {
  const trimmed = error?.trim();
  return trimmed ? trimmed : i18n.t("imagePreviewUnavailable");
}
