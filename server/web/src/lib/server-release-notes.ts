import type { WorkflowServerHealthData } from "../types";
import { i18n } from "@steamharness/i18n";

export const LAST_SEEN_SERVER_RELEASE_VERSION_KEY =
  "steamharness:server-web:last-seen-server-version";

export interface ServerReleaseAnnouncement {
  version: string;
  title: string;
  summary: string;
  docsUrl: string;
}

type ReleaseVersionStorage = Pick<Storage, "getItem" | "setItem">;

export function consumeUnseenServerRelease(
  health: WorkflowServerHealthData,
  storage: ReleaseVersionStorage = window.localStorage,
): ServerReleaseAnnouncement | null {
  const version = health.versions.serverVersion?.trim();
  const summary = health.currentRelease?.summary.trim();
  if (!version || !summary || !health.currentRelease) {
    return null;
  }
  if (storage.getItem(LAST_SEEN_SERVER_RELEASE_VERSION_KEY) === version) {
    return null;
  }

  storage.setItem(LAST_SEEN_SERVER_RELEASE_VERSION_KEY, version);
  return {
    version,
    title: i18n.t("serverReleaseAnnouncement", { ns: "serverWeb", version }),
    summary,
    docsUrl: health.currentRelease.docsUrl,
  };
}
