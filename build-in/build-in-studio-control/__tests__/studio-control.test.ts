import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  globalThis.steamharness = {
    defineProject: (value: unknown) => value,
    defineExecutor: (value: unknown) => value,
    defineEntrypoint: (value: unknown) => value,
    createOutputPayload: (input: { items?: unknown[] }) => ({ errCode: 0, errMessage: "", items: input.items ?? [] }),
    HarnessError: class extends Error {
      type: string;
      constructor(input: { type: string; message: string }) { super(input.message); this.type = input.type; }
    },
  } as never;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Studio Control workflow", () => {
  it("passes the runtime's static validation and exposes only supported entrypoints", async () => {
    const { inspectLocalProjectStructure } = await import("steamharness");
    expect(() => inspectLocalProjectStructure({ projectDir: path.resolve(import.meta.dirname, "..") })).not.toThrow();
    const { executor } = await import("../index");
    expect(executor.entrypoints?.map(entry => entry.id)).toEqual([
      "get_configurations", "manage_configurations", "open_configurations", "studio_state", "get_related_projects", "open_file", "get_diagnostics", "set_theme", "open_terminal", "show_view",
    ]);
  });

  it.each([
    ["get_configurations", {input:JSON.stringify({storage:"local",projectDir:"/workspace"})}, "studio.configurations.get", {storage:"local",projectDir:"/workspace"}],
    ["manage_configurations", {input:JSON.stringify({storage:"server",projectId:"project",target:"latest",call:{action:"create",revision:0}})}, "studio.configurations.manage", {storage:"server",projectId:"project",target:"latest",call:{action:"create",revision:0}}],
    ["open_configurations", {input:JSON.stringify({storage:"local",projectDir:"/workspace"})}, "studio.configurations.open", {storage:"local",projectDir:"/workspace"}],
    ["studio_state", {}, "studio.state.get", {}],
    ["get_related_projects", {}, "studio.relatedProjects.get", {}],
    ["get_related_projects", { projectDir: "" }, "studio.relatedProjects.get", {}],
    ["get_related_projects", { projectDir: " projects/notes " }, "studio.relatedProjects.get", { projectDir: "projects/notes" }],
    ["open_file", { filePath: " index.ts ", line: "2", column: "3" }, "studio.file.open", { filePath: "index.ts", line: 2, column: 3 }],
    ["get_diagnostics", { filePath: "index.ts" }, "studio.diagnostics.get", { filePath: "index.ts" }],
    ["set_theme", { theme: "Default Dark Modern" }, "studio.theme.set", { theme: "Default Dark Modern" }],
    ["open_terminal", { cwd: "src" }, "studio.terminal.open", { cwd: "src" }],
    ["show_view", { view: "explorer" }, "studio.view.show", { view: "explorer" }],
    ["get_diagnostics", {}, "studio.diagnostics.get", {}],
    ["get_diagnostics", { filePath: "" }, "studio.diagnostics.get", {}],
    ["open_terminal", {}, "studio.terminal.open", {}],
    ["open_terminal", { cwd: "" }, "studio.terminal.open", {}],
  ])("maps %s parameters to a narrow host operation", async (id, params, operation, input) => {
    const { executor } = await import("../index");
    const entry = executor.entrypoints?.find(entry => entry.id === id)!;
    expect(entry.createInput!({ paramValues: params, args: [] } as never)).toEqual({ errCode: 0, errMessage: "", operation, input });
  });

  it.each([{}, { filePath: [] }, { filePath: "" }, { filePath: "a.ts", line: "0" },
    { filePath: "a.ts", line: "1.5" }, { filePath: "a.ts", column: ["2"] }])("rejects invalid file parameters %j", async params => {
    const { executor } = await import("../index");
    const entry = executor.entrypoints?.find(entry => entry.id === "open_file")!;
    expect(() => entry.createInput!({ paramValues: params } as never)).toThrow();
  });

  it.each([{ projectDir: " " }, { projectDir: [] }])("rejects an invalid explicit project directory %j", async params => {
    const { executor } = await import("../index");
    const entry = executor.entrypoints?.find(entry => entry.id === "get_related_projects")!;
    expect(() => entry.createInput!({ paramValues: params } as never)).toThrow();
  });

  it.each([["get_diagnostics", { filePath: [] }], ["get_diagnostics", { filePath: " " }],
    ["open_terminal", { cwd: [] }], ["open_terminal", { cwd: " " }]])("rejects an invalid optional path for %s", async (id, params) => {
    const { executor } = await import("../index");
    const entry = executor.entrypoints?.find(entry => entry.id === id)!;
    expect(() => entry.createInput!({ paramValues: params } as never)).toThrow();
  });

  it("forwards cancellation and returns the host result as Workflow output", async () => {
    vi.stubEnv("STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL", "http://127.0.0.1:1234/studio-control");
    vi.stubEnv("STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN", "test-token");
    const fetcher = vi.fn(async () => Response.json({ ok: true, value: { theme: "Dark" } }));
    vi.stubGlobal("fetch", fetcher);
    const { studioControlProject } = await import("../index");
    const controller = new AbortController();
    const result = await studioControlProject.run!({ errCode: 0, errMessage: "", operation: "studio.state.get", input: {} }, { abortSignal: controller.signal } as never);
    expect(result).toMatchObject({ errCode: 0, errMessage: "", value: { theme: "Dark" }, items: [{ contentType: "json" }] });
    controller.abort();
    expect(fetcher.mock.calls[0]).toBeDefined();
  });

  it.each([["STUDIO_CONTROL_INVALID_REQUEST", "input_validation"], ["HOST_STOPPED", "execution"]])("classifies host failure %s", async (code, type) => {
    vi.stubEnv("STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL", "http://127.0.0.1:1234/studio-control");
    vi.stubEnv("STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal("fetch", async () => Response.json({ ok: false, error: { code, message: "Host failure" } }, { status: 400 }));
    const { studioControlProject } = await import("../index");
    await expect(studioControlProject.run!({ operation: "studio.state.get", input: {} } as never, {} as never))
      .rejects.toMatchObject({ message: "Host failure", type });
  });

  it("handles non-Error transport failures", async () => {
    vi.stubEnv("STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL", "http://127.0.0.1:1234/studio-control");
    vi.stubEnv("STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN", "test-token");
    vi.stubGlobal("fetch", async () => { throw "offline"; });
    const { studioControlProject } = await import("../index");
    await expect(studioControlProject.run!({ operation: "studio.state.get", input: {} } as never, {} as never)).rejects.toThrow("offline");
  });
});
