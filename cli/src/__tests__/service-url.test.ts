import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultServerUrl } from "../service-url";
import { parseArgs } from "../workspace";

afterEach(() => vi.unstubAllEnvs());

describe("default Server service", () => {
  it.each(["dev", "alpha", "main"])("uses %s when no saved Server is selected", channel => {
    const expected = channel === "dev" ? "http://localhost:7126"
      : `https://server${channel === "alpha" ? "-alpha" : ""}.steamharness.yuhe.space`;
    expect(defaultServerUrl({ STEAMHARNESS_SERVICE_CHANNEL: channel })).toBe(expected);
  });

  it("ignores unrelated project CI branches after the client has been built", () => {
    expect(defaultServerUrl({ CI_COMMIT_BRANCH: "main" })).toBe(defaultServerUrl({}));
  });

  it("falls back for an empty saved address and preserves an explicit target", () => {
    vi.stubEnv("STEAMHARNESS_SERVER_URL", undefined);
    vi.stubEnv("STEAMHARNESS_CLI_AUTH_DIR", "/not-present/service-links-auth.json");
    vi.stubEnv("STEAMHARNESS_SERVICE_CHANNEL", "alpha");
    expect(parseArgs(["health"]).options.server).toBe("https://server-alpha.steamharness.yuhe.space");
    expect(parseArgs(["health", "--server", "https://custom.example"]).options.server).toBe("https://custom.example");
    vi.stubEnv("STEAMHARNESS_SERVER_URL", "https://selected.example");
    expect(parseArgs(["health"]).options.server).toBe("https://selected.example");
  });
});
