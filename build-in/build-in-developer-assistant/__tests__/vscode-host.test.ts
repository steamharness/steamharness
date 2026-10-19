import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInput, AgentProjectOptions, AgentToolSet, McpServerConnection, NodeContext, ExecutorContext } from "steamharness";
import { installWorkflowRuntimeGlobal } from "steamharness/runtime-api";
import { createAgentRuntime } from "steamharness";
import { createDeveloperAssistantSystemPrompt } from "../assistant-prompt";

const temporary: string[] = [];
afterEach(async () => {
  installWorkflowRuntimeGlobal();
  vi.resetModules();
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function loadHost(environment: Record<string, string> = {}, connection?: McpServerConnection) {
  vi.resetModules();
  const runtime = installWorkflowRuntimeGlobal();
  let options: AgentProjectOptions = {};
  const connect = vi.fn(runtime.connectMcpServer);
  if (connection) connect.mockResolvedValue(connection);
  const getEnv = vi.fn((name: string) => environment[name]);
  const approve = vi.fn(async () => ({ approved: true }));
  globalThis.workflow = {
    ...runtime,
    getEnv,
    connectMcpServer: connect,
    createToolApprovalGate: () => ({ ...runtime.createToolApprovalGate(), approve }),
    createAgentConversationWorkflow: (value: AgentProjectOptions = {}) => {
      options = value;
      return runtime.createAgentConversationWorkflow(value);
    },
  };
  const module = await import("../index");
  return { module, options, connect, approve, getEnv };
}

describe("VS Code assistant host", () => {
  const definition = {
    id: "workflow-studio", command: [process.execPath, "/apps/cli/index.js", "mcp", "/apps/studio-control"],
    inheritEnvironment: ["STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL", "STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN"],
  };

  it("offers Studio MCP tools with approvals, disabled-tool filtering and run-scoped cleanup", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "opened" }], isError: false }));
    const close = vi.fn(async () => {});
    const connection = { id: "workflow-studio", tools: [
      { name: "studio_state", inputSchema: { type: "object", properties: {} } },
      { name: "open_file", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
      { name: "get_related_projects", inputSchema: { type: "object", properties: { projectDir: { type: "string" } } } },
      { name: "legacy_desktop_tool", inputSchema: { type: "object" } },
    ], callTool, close };
    const host = await loadHost({ STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER: JSON.stringify(definition),
      STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: "http://127.0.0.1:1/studio-control", STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: "test-capability" }, connection);
    const context = { toolPermissions: { getTool: (name: string) => ({ enabled: name !== "workflow-studio_studio_state" }) } } as unknown as NodeContext;
    const deferred = await host.options.createTools!(context) as AgentToolSet;
    expect(host.connect).not.toHaveBeenCalled();
    expect(deferred.catalogs?.[0]?.allowedTools).not.toContain("workflow-studio_studio_state");
    const set = await deferred.catalogs![0]!.open();
    expect(set.tools.map(tool => tool.name)).toContain("workflow-studio_open_file");
    expect(set.tools.map(tool => tool.name)).not.toContain("workflow-studio_studio_state");
    expect(set.tools.map(tool => tool.name)).not.toContain("workflow-studio_legacy_desktop_tool");
    const tool = set.tools.find(tool => tool.name === "workflow-studio_open_file")!;
    await tool.execute("call", { filePath: "index.ts" });
    expect(host.approve).toHaveBeenCalledWith({ name: "workflow-studio_open_file", arguments: { filePath: "index.ts" } }, context);
    expect(callTool).toHaveBeenCalledWith("open_file", { filePath: "index.ts" }, undefined);
    const related = set.tools.find(tool => tool.name === "workflow-studio_get_related_projects")!;
    await related.execute("related", { projectDir: "projects/notes" });
    expect(host.approve).toHaveBeenCalledWith({ name: "workflow-studio_get_related_projects", arguments: { projectDir: "projects/notes" } }, context);
    expect(callTool).toHaveBeenCalledWith("get_related_projects", { projectDir: "projects/notes" }, undefined);
    expect(host.connect).toHaveBeenCalledWith({ ...definition, environment: { STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY: "auto" } },
      expect.objectContaining({ env: expect.objectContaining({ STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: "test-capability" }) }));
    await set.close!(); expect(close).toHaveBeenCalledOnce();
  });

  it("removes injected capability credentials from coding-tool shell environments", async () => {
    vi.stubEnv("STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER", JSON.stringify(definition));
    vi.stubEnv("STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL", "http://127.0.0.1:1/studio-control");
    vi.stubEnv("STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN", "test-capability");
    const host = await loadHost(Object.fromEntries(definition.inheritEnvironment.map(key => [key, process.env[key]!])));
    expect(process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN).toBeUndefined();
    expect(process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL).toBeUndefined();
    expect(process.env.STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER).toBeUndefined();
    expect(host.connect).not.toHaveBeenCalled();
  });

  it("rejects legacy server identities and inline capability secrets before connecting", async () => {
    for (const invalid of [{ ...definition, id: "workflow-desktop" }, { ...definition, environment: { STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: "secret" } }]) {
      const host = await loadHost({ STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER: JSON.stringify(invalid) });
      await expect(host.options.createTools!({} as NodeContext)).rejects.toThrow();
      expect(host.connect).not.toHaveBeenCalled();
    }
  });

  it("closes the connection if the server publishes an unusable tool schema", async () => {
    const close = vi.fn(async () => {});
    const host = await loadHost({ STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER: JSON.stringify(definition) }, {
      id: "workflow-studio", tools: [{ name: "studio_state", inputSchema: null }], close,
      callTool: async () => ({ content: [], isError: false }),
    });
    const set = await host.options.createTools!({} as NodeContext) as AgentToolSet;
    expect(host.connect).not.toHaveBeenCalled();
    await expect(set.catalogs![0]!.open()).rejects.toThrow("schema");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([undefined, "vscode"])("offers skills without a Desktop MCP process for host %s", async (value) => {
    const host = await loadHost({
      ...(value === undefined ? {} : { STEAMHARNESS_DEVELOPER_ASSISTANT_HOST: value }),
      STEAMHARNESS_DESKTOP_CONTROL_MCP_SERVER: "invalid legacy control configuration",
      STEAMHARNESS_DESKTOP_CONTROL_PROXY_URL: "http://127.0.0.1:1",
      STEAMHARNESS_DESKTOP_CONTROL_PROXY_TOKEN: "legacy-test-token",
    });
    const tools = await host.options.createTools!({} as NodeContext) as AgentToolSet;
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "workflow-memory_global_memory", "workflow-ui_present_card", "skill",
    ]);
    expect(host.connect).not.toHaveBeenCalled();
    expect(host.getEnv.mock.calls.every(([name]) => !name.startsWith("STEAMHARNESS_DESKTOP_CONTROL"))).toBe(true);
    expect(tools.close).toBeUndefined();
    const skill = tools.tools.find((tool) => tool.name === "skill")!;
    const result = await skill.execute("list", { action: "list" });
    expect(JSON.stringify(result)).toContain("workflow-generator");
    expect(host.approve).toHaveBeenCalledWith({ name: "skill", arguments: { action: "list" } }, expect.anything());
    const disabled = await host.options.createTools!({
      toolPermissions: { getTool: (name: string) => ({ enabled: name !== "skill" }) },
    } as unknown as NodeContext) as AgentToolSet;
    expect(disabled.tools.some((tool) => tool.name === "skill")).toBe(false);
  });

  it("binds input and its prompt only to the independent scope supplied by the host", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "assistant-vscode-"));
    temporary.push(root);
    const primaryTarget = { kind: "folder", folderId: "current-folder" };
    const manifest = { schemaVersion: 2, primaryTarget, warnings: [], roots: [
      { target: primaryTarget, name: "Current <project>", rootPath: root, role: "primary", depth: 0 },
      { target: { kind: "folder", folderId: "linked-folder" }, name: "Linked", rootPath: path.join(root, "linked"), role: "linked", depth: 1 },
    ] };
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const host = await loadHost({ STEAMHARNESS_DEVELOPER_ASSISTANT_HOST: "vscode",
      STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR: root,
      STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST: manifestPath,
    });
    const executor = host.module.executor as unknown as { createInput(context: ExecutorContext): Promise<AgentInput> };
    const input = await executor.createInput({ args: ["--message", "Read my project"],
      paramValues: { provider: "system", model: "model", plan: "true", permissionPolicy: "workspace" },
    } as unknown as ExecutorContext);
    expect(input).toMatchObject({ errCode: 0, errMessage: "", prompt: "Read my project", workdir: root,
      allowedDirectories: [root, path.join(root, "linked")], agent: "plan", permissionPolicy: "workspace" });
    expect(input.systemPrompt).toContain("Studio VS Code");
    expect(input.systemPrompt).toContain("Core coding tools");
    expect(input.systemPrompt).toContain("call the skill tool with action=list");
    expect(input.systemPrompt).toContain("run independently from any project opened in the editor");
    expect(input.systemPrompt).toContain("Do not infer additional roots from folders opened in VS Code");
    expect(input.systemPrompt).toContain("Use get_related_projects");
    expect(input.systemPrompt).toContain("Import status does not replace the permission policy");
    expect(input.systemPrompt).not.toContain("Workspace-specific recovery policy");
    expect(input.systemPrompt).not.toContain("call create_cloud_app");
    expect(input.systemPrompt).toContain("Current \\u003cproject\\u003e");
    expect(createDeveloperAssistantSystemPrompt(manifest as Parameters<typeof createDeveloperAssistantSystemPrompt>[0]))
      .toContain("Studio VS Code");
  });

  it.each(["conversation", "openai"])("defaults %s input to Auto approve and preserves explicit policies", async kind => {
    const root = await mkdtemp(path.join(tmpdir(), "assistant-permission-"));
    temporary.push(root);
    const target = { kind: "folder", folderId: "primary" };
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, primaryTarget: target, warnings: [],
      roots: [{ target, name: "Primary", rootPath: root, role: "primary", depth: 0 }],
    }));
    const host = await loadHost({ STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR: root, STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST: manifestPath });
    const executor = host.module.executor as unknown as {
      createInput(context: ExecutorContext): Promise<AgentInput>;
      createContext(context: ExecutorContext): Partial<NodeContext>;
    };
    const hostInput = kind === "openai" ? {
      kind: "openai.responses", requestId: "req_test", responseId: "resp_test",
      projectId: "a3aca697-b086-459b-84e4-d357ad2d9fb2", model: "provider/model",
      messages: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read my project" }] }],
      settings: {},
    } : undefined;
    for (const permissionPolicy of [undefined, "read-only", "workspace", "auto"]) {
      const context = { args: ["--message", "Read my project"],
        paramValues: permissionPolicy === undefined ? {} : { permissionPolicy }, hostInput,
      } as unknown as ExecutorContext;
      const input = await executor.createInput(context);
      expect(input.permissionPolicy).toBe(permissionPolicy ?? "auto");
      expect(executor.createContext(context).metadata?.studioControlPermissionPolicy).toBe(permissionPolicy ?? "auto");
      if (input.permissionPolicy === "auto") {
        expect(input.systemPrompt).toContain("including absolute paths outside the workspace");
        expect(input.systemPrompt).not.toContain("Never access files outside those roots");
      } else expect(input.systemPrompt).toContain("Never access files outside those roots");
    }
  });

  it.each(["read-only", "workspace", "auto"])("passes the run's %s policy to MCP without accepting a configured override", async permissionPolicy => {
    const connection = { id: "workflow-studio", tools: [], close: async () => {}, callTool: async () => ({ content: [], isError: false }) };
    const host = await loadHost({ STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER: JSON.stringify({ ...definition,
      environment: { STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY: "auto" },
    }) }, connection);
    const deferred = await host.options.createTools!({ metadata: { studioControlPermissionPolicy: permissionPolicy } } as unknown as NodeContext) as AgentToolSet;
    expect(host.connect).not.toHaveBeenCalled();
    const tools = await deferred.catalogs![0]!.open();
    expect(host.connect).toHaveBeenCalledWith(expect.objectContaining({ environment: { STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY: permissionPolicy } }), expect.anything());
    await tools.close!();
  });

  it.each(["auto", "workspace"])("enforces %s file access through Core coding tools for the assistant's actual input", async permissionPolicy => {
    const base = await mkdtemp(path.join(tmpdir(), "assistant-files-")); temporary.push(base);
    const root = path.join(base, "primary"), outside = path.join(base, "outside");
    await mkdir(root); await mkdir(outside);
    const existing = path.join(outside, "existing.txt"), created = path.join(outside, "created.txt");
    await writeFile(existing, "before");
    const target = { kind: "folder", folderId: "primary" }, manifestPath = path.join(base, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, primaryTarget: target, warnings: [],
      roots: [{ target, name: "Primary", rootPath: root, role: "primary", depth: 0 }],
    }));
    const host = await loadHost({ STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR: root, STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST: manifestPath });
    const executor = host.module.executor as unknown as { createInput(context: ExecutorContext): Promise<AgentInput> };
    const input = await executor.createInput({ args: ["--message", "Use the external fixture files"],
      paramValues: permissionPolicy === "auto" ? {} : { permissionPolicy },
    } as unknown as ExecutorContext);
    const ai = await import("@earendil-works/pi-ai");
    const faux = ai.fauxProvider({ models: [{ id: "fixture", name: "Fixture", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }] });
    const models = ai.createModels(); models.setProvider(faux.provider);
    const calls = [
      ["read", { path: existing }], ["write", { path: created, content: "created" }],
      ["edit", { path: existing, edits: [{ oldText: "before", newText: "after" }] }],
      ["grep", { path: outside, pattern: "after" }], ["ls", { path: outside }],
    ] as const;
    faux.setResponses([...calls.map(([name, args]) => () => ai.fauxAssistantMessage([ai.fauxToolCall(name, args)], { stopReason: "toolUse" })),
      () => ai.fauxAssistantMessage([ai.fauxText("done")])]);
    // The pinned upstream fixture and bundled Core declarations have separate transcript brands.
    const runtime = await createAgentRuntime({ models: models as unknown as NonNullable<AgentProjectOptions["models"]>, provider: "faux", model: "fixture", workdir: root });
    const results = [];
    try {
      for await (const event of runtime.run(input)) if (event.type === "tool" && event.phase === "end") results.push(event);
    } finally { await runtime.close(); }
    expect(results).toHaveLength(calls.length);
    expect(results.every(event => event.isError === (permissionPolicy === "workspace"))).toBe(true);
    expect(await readFile(existing, "utf8")).toBe(permissionPolicy === "auto" ? "after" : "before");
    if (permissionPolicy === "auto") expect(await readFile(created, "utf8")).toBe("created");
    else await expect(readFile(created, "utf8")).rejects.toThrow();
  });

  it.each(["desktop", "unknown"])("rejects unsupported host %s", async (value) => {
    const unknown = await loadHost({ STEAMHARNESS_DEVELOPER_ASSISTANT_HOST: value });
    await expect(unknown.options.createTools!({} as NodeContext)).rejects.toThrow("Unsupported assistant host");
  });
});
