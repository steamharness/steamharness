import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { publicServiceUrls, resolveServiceChannel, serviceChannelFromServerUrl } from "../index";
import { checkoutServiceChannel } from "../node.mjs";

describe("service channels", () => {
  it.each(["dev", "alpha", "main"] as const)("keeps %s builds on their own services", channel => {
    expect(resolveServiceChannel({ branch: channel, mode: "production" })).toBe(channel);
    const urls = publicServiceUrls(channel);
    expect(serviceChannelFromServerUrl(urls.server)).toBe(channel);
    expect(urls.docs).toBe(channel === "dev" ? "http://localhost:7135"
      : `https://docs${channel === "alpha" ? "-alpha" : ""}.steamharness.yuhe.space`);
  });

  it("honors explicit channels and modes ahead of the checkout", () => {
    expect(checkoutServiceChannel({ env: { STEAMHARNESS_SERVICE_CHANNEL: "alpha", CI_COMMIT_BRANCH: "main" } })).toBe("alpha");
    expect(checkoutServiceChannel({ env: { CI_COMMIT_BRANCH: "main" }, mode: "dev" })).toBe("dev");
    expect(checkoutServiceChannel({ env: { STEAMHARNESS_RELEASE_CHANNEL: "stable" } })).toBe("main");
    expect(checkoutServiceChannel({ env: { GITHUB_REF: "refs/heads/alpha" } })).toBe("alpha");
    expect(checkoutServiceChannel({ env: { CI_COMMIT_BRANCH: "codex/example" } })).toBe("dev");
    expect(() => checkoutServiceChannel({ env: { STEAMHARNESS_SERVICE_CHANNEL: "alhpa" } })).toThrow(/channel/u);
  });

  it("reads the actual source checkout, including worktree Git metadata", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "steamharness-service-channel-"));
    try {
      execFileSync("git", ["init", "--initial-branch=alpha", root], { stdio: "ignore" });
      expect(checkoutServiceChannel({ root, env: {}, mode: "production" })).toBe("alpha");
      expect(checkoutServiceChannel({ root, env: {}, mode: "main" })).toBe("main");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("recognizes loopback and existing alpha entrances without matching lookalike domains", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(serviceChannelFromServerUrl(`http://${host}:7126`)).toBe("dev");
    expect(serviceChannelFromServerUrl("https://alpha.steamharness.yuhe.space")).toBe("alpha");
    expect(serviceChannelFromServerUrl("https://server-alpha.steamharness.yuhe.space.example")).toBeUndefined();
    expect(serviceChannelFromServerUrl("https://user:secret@server-alpha.steamharness.yuhe.space")).toBeUndefined();
  });
});
