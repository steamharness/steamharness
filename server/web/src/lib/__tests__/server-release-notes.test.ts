import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowServerHealthData } from "../../types";
import {
  consumeUnseenServerRelease,
  LAST_SEEN_SERVER_RELEASE_VERSION_KEY,
} from "../server-release-notes";

const health: WorkflowServerHealthData = {
  status: "ok",
  versions: {
    serverVersion: "0.2.0",
    coreVersion: "0.1.1",
  },
  currentRelease: {
    summary: "新增项目 Core 版本兼容检查。",
    body: "### Added\n\n- 新增项目 Core 版本兼容检查。",
    docsUrl: "https://docs.steamharness.yuhe.space/guides/releases/server#server-v0-2-0",
  },
  deployment: {
    server: null,
    serverWeb: null,
  },
};

describe("server release notes", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("consumes a published Server summary once per version", () => {
    expect(consumeUnseenServerRelease(health)).toEqual({
      version: "0.2.0",
      title: "Server 已更新至 v0.2.0",
      summary: "新增项目 Core 版本兼容检查。",
      docsUrl: "https://docs.steamharness.yuhe.space/guides/releases/server#server-v0-2-0",
    });
    expect(window.localStorage.getItem(LAST_SEEN_SERVER_RELEASE_VERSION_KEY)).toBe("0.2.0");
    expect(consumeUnseenServerRelease(health)).toBeNull();
  });

  it("does not mark package-only health data without release notes as seen", () => {
    const withoutRelease = {
      ...health,
      currentRelease: null,
    } satisfies WorkflowServerHealthData;

    expect(consumeUnseenServerRelease(withoutRelease)).toBeNull();
    expect(window.localStorage.getItem(LAST_SEEN_SERVER_RELEASE_VERSION_KEY)).toBeNull();
  });
});
