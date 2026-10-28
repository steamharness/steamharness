import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectAggregateProjectStructure, inspectLocalProjectStructure } from "steamharness";

const projectDir = path.resolve(process.cwd());
// Run-scoped Knowledge and KV must not expose the assistant's store as project data.
const CORE_TOOL_NAMES = [
  "workflow-memory_global_memory",
  "workflow-ui_present_card",
  "skill",
];
const RUN_SCOPED_CORE_TOOL_NAMES = [
  "workflow-knowledge_knowledge_documents",
  "workflow-kv_kv_store",
];
const CODING_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const CONTROL_TOOL_NAMES = ["workflow-studio_get_configurations", "workflow-studio_manage_configurations", "workflow-studio_open_configurations", "workflow-studio_studio_state", "workflow-studio_get_entries", "workflow-studio_get_diagnostics", "workflow-studio_open_file",
  "workflow-studio_set_theme", "workflow-studio_open_terminal", "workflow-studio_show_view"];
const SESSION_TOOL_NAMES = ["tool_search", "codemode", "update_plan", "subagent"];
const EXPECTED_TOOL_NAMES = [...SESSION_TOOL_NAMES, ...CONTROL_TOOL_NAMES, ...CORE_TOOL_NAMES, ...CODING_TOOL_NAMES];

describe("developer assistant workflow", () => {
  it("keeps its distributed identity and records an approved database ID for assistant data", async () => {
    const manifest = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    expect(manifest.id).toBe("a3aca697-b086-459b-84e4-d357ad2d9fb2");
    expect(manifest.steamHarness.entries[0]).toMatchObject({ entryId: "main", type: "conversation", databases: [expect.objectContaining({ alias: "memory", databaseId: expect.any(String) })] });
  });
  it("registers Studio Control within the same project and analyzes each executor independently", () => {
    const aggregate = inspectAggregateProjectStructure(projectDir);
    expect(aggregate.projectId).toBe("a3aca697-b086-459b-84e4-d357ad2d9fb2");
    expect(aggregate.defaultEntry).toBe("main");
    expect(aggregate.entries.map(entry => [entry.entryId, entry.projectType])).toEqual([
      ["main", "conversation"], ["studio-control", "workflow"],
    ]);
    const control = aggregate.entries[1];
    expect(control.diagnostics).toEqual({ warnings: [], violations: [] });
    expect(control.defaultEntrypoint).toBe("studio_state");
    expect(control.entrypoints?.map(entrypoint => entrypoint.id).sort()).toEqual(CONTROL_TOOL_NAMES.map(name => name.slice("workflow-studio_".length)).sort());
  });
  it("does not offer a Code Mode configuration parameter", async () => {
    const manifest = JSON.parse(await readFile(path.join(projectDir, "configuration.json"), "utf8"));
    expect(manifest.fields).toEqual([]);
  });
  it("runs on Core's agent with system AI quick params and declared tools", async () => {
    const structure = inspectLocalProjectStructure({ projectDir });
    const source = await readFile(path.join(projectDir, "index.ts"), "utf8");

    expect(structure.diagnostics).toEqual({ warnings: [], violations: [] });
    expect(structure.definitions.apiCalls.map((call) => call.method))
      .toContain("createAgentConversationProject");
    expect(structure.params?.filter((param) => param.panel === "quick").map((param) => param.name))
      .toEqual(["provider", "model", "effort", "permissionPolicy"]);
    expect(structure.paramLayout?.actions).toEqual([
      { kind: "quick", id: "model", label: "Model", icon: "sparkle", summary: ["model"], params: ["provider", "model"] },
      { kind: "quick", id: "effort", label: "Effort", icon: "lightbulb", summary: ["effort"], params: ["effort"] },
      { kind: "slash", name: "plan" },
      { kind: "quick", id: "permission", label: "Permission", icon: "shield", summary: ["permissionPolicy"], params: ["permissionPolicy"] },
    ]);
    expect(structure.params?.some(param => param.name === "contextWindow")).toBe(false);
    expect(structure.params?.find((param) => param.name === "effort")).toMatchObject({
      label: "Effort",
      defaultValue: "high",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "" }),
        expect.objectContaining({ value: "max" }),
      ]),
    });
    expect(structure.params?.find(param => param.name === "model")?.userSetting).toEqual({ key: "agent.model", mode: "default" });
    expect(source).toContain('modelSource: "user-settings"');
    expect(structure.params?.find((param) => param.name === "permissionPolicy")).toMatchObject({
      label: "Permission",
      userSetting: { key: "agent.permissionPolicy", mode: "fixed" },
      options: [
        expect.objectContaining({ value: "read-only", label: "Read only" }),
        expect.objectContaining({ value: "workspace", label: "Workspace" }),
        expect.objectContaining({ value: "auto", label: "Auto approve" }),
      ],
    });
    expect(structure.params?.find((param) => param.name === "plan")).toMatchObject({
      flag: "--plan",
      type: "boolean",
      defaultValue: "false",
      panel: "slash",
    });
    expect(structure.params?.some((param) => param.name === "agent")).toBe(false);
    expect(structure.params?.find((param) => param.name === "plan")?.options).toBeUndefined();
    expect(source.match(/agent: paramValues.plan === "true" \? "plan" : "build"/g)).toHaveLength(2);
    expect(structure.paramResolver).toEqual({ enabled: true });
    expect(structure.projectType).toBe("conversation");
    // The conversation block is read off this file's AST, so the output item
    // id has to be a literal in the declaration — a constant reference reads
    // as no output item at all.
    expect(structure.conversation).toMatchObject({
      footer: [{ text: "Plan mode", localizedText: { "zh-CN": "Plan 模式" }, when: { param: "plan", value: "true" } }],
      userInput: { effects: [{ when: { type: "agent-plan-approval", values: { decision: "approve" } }, params: { plan: "false" } }] },
      commands: [expect.objectContaining({ command: "export", action: { kind: "export" } }),
        expect.objectContaining({ command: "compact", action: { kind: "prompt", text: "/compact" } })],
      attachments: { images: true },
      inputQueue: { enabled: true },
      openai: { enabled: true, outputItemId: "developer-assistant-answer" },
    });
    expect(structure.tools?.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    expect(structure.conversation?.durable).toEqual({ enabled: true });
    expect(structure.tools?.filter(tool => SESSION_TOOL_NAMES.includes(tool.name))).toEqual(
      SESSION_TOOL_NAMES.map(name => expect.objectContaining({ name, enabled: true, autoApprove: true })),
    );
    expect(structure.tools?.filter(tool => CORE_TOOL_NAMES.includes(tool.name))).toEqual(
      CORE_TOOL_NAMES.map((name) => expect.objectContaining({ name, enabled: true, autoApprove: true })),
    );
    expect(structure.tools?.filter(tool => CONTROL_TOOL_NAMES.includes(tool.name))).toEqual(
      CONTROL_TOOL_NAMES.map(name => expect.objectContaining({ name, enabled: true,
        autoApprove: ["workflow-studio_get_configurations", "workflow-studio_studio_state", "workflow-studio_get_entries", "workflow-studio_get_diagnostics"].includes(name) })),
    );
    for (const name of RUN_SCOPED_CORE_TOOL_NAMES) {
      expect(structure.tools?.some((tool) => tool.name === name)).toBe(false);
    }

    expect(structure.tools?.some((tool) => tool.name.startsWith("workflow-desktop_"))).toBe(false);
    expect(structure.tools?.some((tool) => tool.name === "workflow-host_host_project_configuration")).toBe(false);
    expect(structure.tools?.some((tool) => tool.name === "steamharness-kanban_kanban_methods")).toBe(false);
  });

  it("assembles its tools from Core without Desktop Control", async () => {
    const source = await readFile(path.join(projectDir, "index.ts"), "utf8");

    // The four workflow capabilities come from Core, described once and
    // rendered both as MCP servers and as agent tools.
    expect(source).toContain("steamharness.createProjectCapabilityTools({");
    expect(source).toContain("globalMemory: true");
    // Skills are read on demand rather than injected into every prompt.
    expect(source).toContain('steamharness.createSkillTools({ directories: [SKILLS_DIRECTORY], approve })');
    expect(source).not.toContain("skillPaths");
    expect(source).not.toContain("desktop-control-mcp");
    expect(source).not.toContain("connectMcpServer");
    expect(source).toContain("context.toolPermissions?.getTool(tool.name)?.enabled !== false");
    expect(source).toContain('steamharness.createAgentProjectParamResolver({ modelSource: "user-settings" })');
    expect(source).not.toContain("openCodeDependency");
    expect(source).not.toContain("STEAMHARNESS_BUILTIN_OPENCODE_ENTRY");
  });

  it("takes the workspace, the persona and the attachments from the run", async () => {
    const source = await readFile(path.join(projectDir, "index.ts"), "utf8");
    const [, prompt, packageJson] = await Promise.all([
      readFile(path.join(projectDir, "index.ts"), "utf8"),
      readFile(path.join(projectDir, "assistant-prompt.ts"), "utf8"),
      readFile(path.join(projectDir, "package.json"), "utf8"),
    ]);

    // The workspace decides what the tools may touch, so it travels on the
    // input rather than being fixed when the module was built.
    expect(source).toContain("allowedDirectories: [");
    expect(source).toContain('root.role === "linked"');
    expect(source).toContain("systemPrompt: createDeveloperAssistantSystemPrompt(manifest, readAssistantHost(), permissionPolicy)");
    expect(source).toContain('(readHostEnvironment(ASSISTANT_WORKDIR_ENV) ?? "").trim()');
    expect(source).toContain("ASSISTANT_WORKSPACE_MANIFEST_ENV");
    expect(source).toContain("steamharness.readOpenAIConversationHostInput(context)");
    expect(source).toContain("steamharness.parseConversationDefaultInputArgs(context.args)");
    expect(source).toContain("readDeveloperAssistantPermissionPolicy(paramValues.permissionPolicy)");

    // The composer's attachments are references to bytes this process can
    // read but `createInput` cannot: only a node holds the file store, so the
    // references travel to Core's input node. Resolving them here is what made
    // the assistant answer a picture it never received.
    expect(source).toContain("imageFiles: defaults.images");
    expect(source).not.toContain("images: await toInlineImages");
    expect(source).not.toContain("readFile(filePath)");
    // An OpenAI request carries its bytes inline and still needs no store.
    expect(source).toContain("return toDataUrlImages(");

    const manifest = JSON.parse(packageJson) as {
      steamHarness: { builtinRelease: { dependencies: Array<{ id: string }> } };
      devDependencies: Record<string, string>;
    };
    // The assistant no longer delegates to another built-in project, so it
    // must not claim to depend on one.
    expect(manifest.steamHarness.builtinRelease.dependencies.map((entry) => entry.id))
      .toEqual([]);
    expect(manifest.steamHarness.builtinRelease.dependencies.map((entry) => entry.id))
      .not.toContain("opencode");

    expect(prompt).toContain("Workspace roots define default working directories, not file-access boundaries");
    expect(prompt).toContain("Never access files outside those roots");
    expect(prompt).toContain("Linked roots are separate workspaces");
    expect(prompt).toContain("Check Git status only when that root is a Git repository");
    expect(prompt).toContain("Workspace warnings are non-blocking");
    expect(prompt).toContain("Bundled skill paths are instruction sources, not implied task targets");
    expect(prompt).toContain("if a required file is missing, denied or only partially available");
    expect(prompt).toContain("select only the minimum relevant set");
    expect(prompt).toContain("distinguish framework source from preview artifacts");
    expect(prompt).toContain("existing one-shot build script");
    expect(prompt).toContain("Never start dev, watch, serve, HMR");
    expect(prompt).toContain("preview artifact was not updated");
    expect(prompt).toContain("Never store secrets, credentials or transient progress");
    expect(prompt).not.toContain("workflow-desktop");
    expect(prompt).not.toContain("create_cloud_app");
    expect(prompt).not.toContain("open_dock_tool");
    expect(prompt).toContain("inherit this run's storage environment");
    expect(prompt).toContain("STEAMHARNESS_KV_STORE_DIR, STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR and STEAMHARNESS_FILE_STORE_DIR");
    expect(prompt).toContain("project-local scratch directories");
    expect(prompt).toContain("never delete or repair a store directory");
  });

  it("loads as a project against the injected runtime", async () => {
    const { installProjectRuntimeGlobal } = await import("steamharness/runtime-api");
    const runtime = installProjectRuntimeGlobal();

    // Loading the module is itself the assertion: `createToolApprovalGate()`
    // runs at module scope, and `defineExecutor` validates the declaration —
    // both against the runtime the host injects, not against an import.
    const module = await import("../index");

    // The executor type is a union across project types; these fields belong
    // to the conversation member this project declares.
    const executor = module.executor as unknown as {
      projectType: string;
      workflow: { name: string };
      createInput?: unknown;
      tools?: Array<{ name: string }>;
    };

    expect(runtime).toBe(globalThis.steamharness);
    expect(executor.projectType).toBe("conversation");
    expect(executor.workflow.name).toBe("developer-assistant");
    expect(typeof executor.createInput).toBe("function");
    expect(executor.tools?.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("keeps the skill it ships as the one its own tool reads", async () => {
    const [generatorSkill, repairReference] = await Promise.all([
      readFile(path.join(projectDir, "skills", "workflow-generator", "SKILL.md"), "utf8"),
      readFile(path.join(
        projectDir,
        "skills",
        "workflow-generator",
        "references",
        "project-repair.md",
      ), "utf8"),
    ]);

    expect(generatorSkill).toContain("references/project-repair.md");
    expect(generatorSkill).toContain("旧 CLI 返回 `0` 也不能证明 Desktop 能重新识别项目");
    expect(generatorSkill).toContain("数据库绑定尚未完成");
    expect(repairReference).toContain("必需知识门禁");
    expect(repairReference).toContain("旧版 CLI 返回 `0` 也不能覆盖直接发现的合同错误");
    expect(repairReference).toContain("context.databases.get(alias)");
    expect(repairReference).toContain("不要把字段机械改名");
    expect(repairReference).toContain("入口只记录 alias 与 databaseId");
    expect(repairReference).toContain("代码工作区授权");
    expect(repairReference).toContain("KV 权限");
  });

  it("documents how each parameter action renders", async () => {
    const [generatorSkill, panelReference] = await Promise.all([
      readFile(path.join(projectDir, "skills", "workflow-generator", "SKILL.md"), "utf8"),
      readFile(path.join(
        projectDir,
        "skills",
        "workflow-generator",
        "references",
        "param-panels.md",
      ), "utf8"),
    ]);

    // The skill has to point at the reference, or the assistant never opens it.
    expect(generatorSkill).toContain("references/param-panels.md");
    expect(panelReference).toContain("每个声明形成一个独立的可收缩面板");
    expect(panelReference).toContain("每个声明形成一个摘要 chip 和弹层菜单");
    expect(panelReference).toContain("按 `params` 数组顺序从左到右排列");
    expect(panelReference).toContain("在 Quick 内同形");
    expect(panelReference).toContain("单击切到下一个选项");
    expect(panelReference).toContain("要求多个收缩面板时创建多个 Auxiliary");
  });
});
