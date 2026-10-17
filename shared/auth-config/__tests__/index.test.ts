import { describe, expect, it } from "vitest";
import {
  isWorkflowAuthExpiringSoon,
  normalizeWorkflowAuthConfig,
  resolveWorkflowCliAuthFilePath,
  resolveWorkflowDesktopConfigFilePath,
} from "@workflow-code/auth-config";

describe("auth-config package", () => {
  it("normalizes legacy auth fields", () => {
    expect(
      normalizeWorkflowAuthConfig({
        remoteUrl: " https://example.com ",
        token: " secret ",
        source: "device_flow",
      }),
    ).toEqual({
      serverUrl: "https://example.com",
      apiKey: "secret",
      source: "device_flow",
    });
  });

  it("keeps password login as a first-class App auth source", () => {
    expect(
      normalizeWorkflowAuthConfig({
        serverUrl: "https://example.com",
        apiKey: "secret",
        source: "password",
      }),
    ).toEqual({
      serverUrl: "https://example.com",
      apiKey: "secret",
      source: "password",
    });
  });

  it("resolves the CLI auth file path from the configured auth dir", () => {
    expect(
      resolveWorkflowCliAuthFilePath({
        WORKFLOW_CLI_AUTH_DIR: "/tmp/workflow-auth",
      }),
    ).toBe("/tmp/workflow-auth/workflow-auth.json");
  });

  it("resolves the Desktop config file without an App compatibility path", () => {
    expect(resolveWorkflowDesktopConfigFilePath({
      WORKFLOW_DESKTOP_CONFIG_DIR: "C:\\workflow\\desktop",
      platform: "win32",
    })).toBe("C:/workflow/desktop/workflow-desktop.json");
  });

  it("ignores the former App config variable", () => {
    const legacyOnlyEnv = {
      WORKFLOW_APP_CONFIG_DIR: "C:\\workflow\\legacy-app",
      APPDATA: "C:\\Users\\workflow\\AppData\\Roaming",
      platform: "win32",
    };

    expect(resolveWorkflowDesktopConfigFilePath(legacyOnlyEnv)).toBe(
      "C:/Users/workflow/AppData/Roaming/workflow-code/workflow-desktop.json",
    );
  });

  it("detects expiration within the threshold window", () => {
    expect(
      isWorkflowAuthExpiringSoon("2026-06-28T00:00:00.000Z", {
        now: Date.parse("2026-06-26T00:00:00.000Z"),
      }),
    ).toBe(true);
    expect(
      isWorkflowAuthExpiringSoon("2026-07-05T00:00:00.000Z", {
        now: Date.parse("2026-06-26T00:00:00.000Z"),
      }),
    ).toBe(false);
  });
});
