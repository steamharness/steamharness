import { describe, expect, it, vi } from "vitest";
import { callStudioControlHost, readStudioControlHostBridgeConfig } from "../host-bridge";

const config = { url: "http://127.0.0.1:1234/studio-control", token: "test-token", permissionPolicy: "workspace" as const };

describe("Studio Control host bridge", () => {
  it("is unavailable outside Studio and rejects partial credentials", async () => {
    expect(readStudioControlHostBridgeConfig({})).toBeUndefined();
    expect(() => readStudioControlHostBridgeConfig({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: "test" })).toThrow("Incomplete");
    await expect(callStudioControlHost("studio.state.get", {}, undefined)).rejects.toThrow("only inside SteamHarness Studio");
  });
  it.each(["https://127.0.0.1:1/studio-control", "http://localhost:1/studio-control", "http://example.com:1/studio-control",
    "http://user:pass@127.0.0.1:1/studio-control", "http://127.0.0.1/studio-control", "http://127.0.0.1:1/other",
    "http://127.0.0.1:1/studio-control?x=1", "http://127.0.0.1:1/studio-control#x"])("rejects an untrusted endpoint %s", url => {
    expect(() => readStudioControlHostBridgeConfig({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: url, STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: "test" })).toThrow("authenticated loopback");
  });
  it("sends only the requested operation and propagates aborts", async () => {
    expect(readStudioControlHostBridgeConfig({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: config.url, STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: config.token })).toEqual(config);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, value: { opened: true } }));
    const controller = new AbortController();
    expect(await callStudioControlHost("studio.file.open", { filePath: "index.ts" }, config, fetcher, controller.signal)).toEqual({ opened: true });
    const options = fetcher.mock.calls[0]![1]!;
    expect(JSON.parse(options.body as string)).toEqual({ operation: "studio.file.open", input: { filePath: "index.ts" }, permissionPolicy: "workspace" });
    expect(options.headers).toMatchObject({ Authorization: "Bearer test-token" });
    controller.abort();
    expect(options.signal?.aborted).toBe(true);
  });
  it.each(["read-only", "workspace", "auto"])("forwards the trusted MCP child's %s policy outside model arguments", async permissionPolicy => {
    const selected = readStudioControlHostBridgeConfig({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: config.url,
      STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: config.token, STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY: permissionPolicy });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, value: {} }));
    await callStudioControlHost("studio.state.get", {}, selected, fetcher);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ operation: "studio.state.get", input: {}, permissionPolicy });
  });
  it("rejects an invalid injected permission policy", () => {
    expect(() => readStudioControlHostBridgeConfig({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: config.url,
      STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: config.token, STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY: "unknown" })).toThrow("permission policy");
  });
  it.each([null, [], { ok: false }, { ok: false, error: { code: "STUDIO_CONTROL_INVALID_REQUEST", message: "Invalid path" } }])("rejects unsuccessful host responses %j", async payload => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload, { status: 400 }));
    await expect(callStudioControlHost("studio.state.get", {}, config, fetcher)).rejects.toThrow();
  });
  it("rejects invalid JSON instead of treating it as a successful result", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("invalid JSON"));
    await expect(callStudioControlHost("studio.state.get", {}, config, fetcher)).rejects.toThrow("operation failed");
  });
});
