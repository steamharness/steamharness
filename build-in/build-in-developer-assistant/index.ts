const readHostEnvironment = (key: string) => process.env[key];
import path from "node:path";
import type {
  AgentInput,
  AgentToolSet,
} from "steamharness";
import { createDeveloperAssistantSystemPrompt, type DeveloperAssistantHost } from "./assistant-prompt";
import { steamharness } from "./workflow-runtime";
import { loadDeveloperAssistantWorkspaceManifest } from "./workspace-manifest";
import { createStudioControlTools } from "./studio-control-mcp";
import type {
  DeveloperAssistantPermissionPolicy,
} from "./interface";

const ASSISTANT_WORKDIR_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR";
const ASSISTANT_WORKSPACE_MANIFEST_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST";
const DEFAULT_DEVELOPER_ASSISTANT_PERMISSION_POLICY = "inherit";
const STEAMHARNESS_NAME = "developer-assistant";
const SKILLS_DIRECTORY = path.join(import.meta.dirname, "skills");

// One gate for the process: it is stateless apart from the run it is handed,
// and every tool it guards is addressed by the id the host granted.
const toolApproval = steamharness.createToolApprovalGate();

/**
 * Core owns the whole pipeline — input parsing, the agent stream, approval
 * pauses, compaction, output items, token usage and the conversation write.
 *
 * What is left here is the assistant's identity: the workspace it was pointed
 * at, the persona that workspace implies, and the capabilities Studio offers.
 */

/** Core supplies execution and output; this declaration supplies the assistant's tools and workspace input. */
export const executor = steamharness.defineBot<AgentInput>({
  name: STEAMHARNESS_NAME,
  agent: {
  modelSource: "user-settings",
  skills: { directories: [SKILLS_DIRECTORY] },
  session: { subagents: { tools: ["read", "grep", "find", "ls", "skill"], maxAgents: 4 }, planFork: "asOf", toolSearch: {} },
  async createTools(context, input): Promise<AgentToolSet> {
    readAssistantHost();
    const approve = async (toolId: string, args: unknown): Promise<void> => {
      await toolApproval.approve({ name: toolId, arguments: args }, context);
    };

    // Run-scoped Knowledge address the assistant's own store, not the
    // user's project. Studio Control provides editor capabilities separately.
    const capabilityToolIdsToOffer = new Set([
      "workflow-ui_present_card",
    ]);
    const capabilities = (await steamharness.createProjectCapabilityTools({
      context,
      approve,
    })).filter((tool) => capabilityToolIdsToOffer.has(tool.name));
    const control = await createStudioControlTools(approve,
      readDeveloperAssistantPermissionPolicy(input.permissionPolicy),
      toolId => context.toolPermissions?.getTool(toolId)?.enabled !== false);

    const offered = [...capabilities, ...control.tools].filter(
      (tool) => context.toolPermissions?.getTool(tool.name)?.enabled !== false,
    );
    return { tools: offered, ...(control.catalogs ? { catalogs: control.catalogs } : {}) };
  },
},
  conversation: {
    commands: [
      { command: "export", label: "Export conversation", localizedLabel: { "zh-CN": "导出对话" },
        description: "Export the complete current conversation.", localizedDescription: { "zh-CN": "导出当前会话的全部对话内容。" }, action: { kind: "export" } },
      { command: "compact", label: "Summarize context", localizedLabel: { "zh-CN": "上下文总结" },
        description: "Summarize the agent context now.", localizedDescription: { "zh-CN": "立即总结 Agent 上下文。" }, action: { kind: "prompt", text: "/compact" } },
    ],
    footer: [{ text: "Plan mode", localizedText: { "zh-CN": "Plan 模式" }, when: { param: "plan", value: "true" } }],
    userInput: { effects: [{ when: { type: "agent-plan-approval", values: { decision: "approve" } }, params: { plan: "false" } }] },
    attachments: { images: true },

  },
  tools: [
    { name: "tool_search", label: "Find tools", description: "Discover tools in the authorized project catalogs.", enabled: true, autoApprove: true },
    { name: "codemode", label: "Code Mode", description: "Compose authorized tools in an isolated QuickJS script when enabled by the host.", enabled: true, autoApprove: true },
    { name: "update_plan", label: "Task plan", description: "Save task steps and progress in this conversation.", enabled: true, autoApprove: true },
    { name: "subagent", label: "Delegate task", description: "Delegate a task with the project's restricted read-only tools.", enabled: true, autoApprove: true },
    { name: "workflow-studio_get_configurations", label: "Project configurations", description: "Query or export local/Server project configurations with the panel closed.", enabled: true, autoApprove: true },
    { name: "workflow-studio_manage_configurations", label: "Manage project configurations", description: "Create, copy, rename, select or delete profiles; set/clear values; manage custom fields and import complete configurations with revision checks; authorized authors can manage publication.save drafts, field and JSON Pointer permissions. Downloaders only edit allowed personal values.", enabled: true, autoApprove: false },
    { name: "workflow-studio_open_configurations", label: "Open project configurations", description: "Display the configuration panel for a specific project and storage.", enabled: true, autoApprove: false },
    { name: "workflow-studio_studio_state", label: "Studio state", description: "Read the current Studio workspace, editor and supported capabilities.", enabled: true, autoApprove: true },
    { name: "workflow-studio_get_entries", label: "Project entries", description: "Read the permitted aggregate project identity and registered entry IDs, names and types.", enabled: true, autoApprove: true },
    { name: "workflow-studio_get_diagnostics", label: "Studio diagnostics", description: "Read errors and warnings within the selected permission policy's file scope.", enabled: true, autoApprove: true },
    { name: "workflow-studio_get_kanban_diagnostics", label: "Kanban runtime diagnostics", description: "Read the open Kanban preview's configuration, bridge failures and registered readOnly page methods; query actual image readiness without changing project data.", enabled: true, autoApprove: true },
    { name: "workflow-studio_open_file", label: "Open file in Studio", description: "Open a permitted file and reveal a line and column.", enabled: true, autoApprove: false },
    { name: "workflow-studio_set_theme", label: "Studio theme", description: "Change the installed VS Code color theme.", enabled: true, autoApprove: false },
    { name: "workflow-studio_open_terminal", label: "Studio terminal", description: "Open a terminal in a permitted directory without executing commands.", enabled: true, autoApprove: false },
    { name: "workflow-studio_show_view", label: "Studio view", description: "Show Explorer, Search, Source Control, Terminal or Assistant.", enabled: true, autoApprove: false },
    {
      name: "workflow-ui_present_card",
      label: "Conversation resource card",
      description: "Show, update, pin, or remove a file or browser resource card in the conversation.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "skill",
      label: "List and read skill guides",
      description: "Browse the task guides bundled with this assistant.\nlist: list skill names, descriptions and files.\nread: set skill to a listed name; omit path for SKILL.md, or supply a relative reference path such as references/task-map.md. Continue truncated pages with offset=nextOffset until truncated=false.\nRead the guide before following its steps. The bundled steamharness-generator covers SteamHarness project development. File edits and commands use the corresponding tools and permissions.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "read",
      label: "Read",
      description: "Read a text file within the selected permission policy's file scope.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "write",
      label: "Write",
      description: "Create or overwrite a file within the selected permission policy's file scope.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "edit",
      label: "Edit",
      description: "Change a permitted file by exact text block.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "bash",
      label: "Shell",
      description: "Run a shell command in the workspace (as the host process; the working directory is not a sandbox).",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "grep",
      label: "Search",
      description: "Search file contents by regular expression.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "find",
      label: "Find files",
      description: "Find files by path substring.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "ls",
      label: "List",
      description: "List a directory.",
      enabled: true,
      autoApprove: true,
    },
  ],

  async prepareInput(input) {
    const workdir = readAssistantWorkdir();
    const manifest = await loadDeveloperAssistantWorkspaceManifest(workdir, readHostEnvironment(ASSISTANT_WORKSPACE_MANIFEST_ENV));
    const permissionPolicy = readDeveloperAssistantPermissionPolicy(input.permissionPolicy);
    return { ...input, workdir, permissionPolicy,
      allowedDirectories: [workdir, ...manifest.roots.filter(root => root.role === "linked").map(root => root.rootPath)],
      systemPrompt: createDeveloperAssistantSystemPrompt(manifest, readAssistantHost(), permissionPolicy) };
  },
});

export default executor;

function readAssistantWorkdir(): string {
  const workdir = (readHostEnvironment(ASSISTANT_WORKDIR_ENV) ?? "").trim();
  if (workdir === "") {
    throw new steamharness.HarnessError({
      type: "input_validation",
      message: "小助手缺少经过宿主校验的目标工作区目录。",
    });
  }
  return workdir;
}

function readAssistantHost(): DeveloperAssistantHost {
  const host = (readHostEnvironment("STEAMHARNESS_DEVELOPER_ASSISTANT_HOST") ?? "vscode").trim();
  if (host === "vscode") return host;
  throw new steamharness.HarnessError({ type: "input_validation", message: `Unsupported assistant host: ${host}` });
}

function readParamString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readDeveloperAssistantPermissionPolicy(
  value: string | string[] | undefined,
): DeveloperAssistantPermissionPolicy {
  const policy = readParamString(value) ?? DEFAULT_DEVELOPER_ASSISTANT_PERMISSION_POLICY;
  if (policy === "inherit") return steamharness.getUserSettings().agent.permissionPolicy;
  if (policy === "read-only" || policy === "workspace" || policy === "auto") return policy;
  throw new Error(`Invalid tool permission policy: ${policy}`);
}
