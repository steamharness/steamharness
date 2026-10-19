import path from "node:path";
import type {
  AgentInput,
  AgentOutputPayload,
  AgentToolSet,
} from "steamharness";
import { createDeveloperAssistantSystemPrompt, type DeveloperAssistantHost } from "./assistant-prompt";
import { workflow } from "./workflow-runtime";
import { loadDeveloperAssistantWorkspaceManifest } from "./workspace-manifest";
import { createStudioControlTools } from "./studio-control-mcp";
import type {
  DeveloperAssistantPermissionPolicy,
  OpenAIConversationHostInput,
} from "./interface";

const ASSISTANT_WORKDIR_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR";
const ASSISTANT_WORKSPACE_MANIFEST_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST";
const DEFAULT_DEVELOPER_ASSISTANT_PERMISSION_POLICY: DeveloperAssistantPermissionPolicy = "auto";
const STEAMHARNESS_NAME = "developer-assistant";
const OUTPUT_ITEM_ID = "developer-assistant-answer";
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
const assistantProject = steamharness.createAgentConversationProject({
  projectName: STEAMHARNESS_NAME,
  outputItemId: OUTPUT_ITEM_ID,
  session: { subagents: { tools: ["read", "grep", "find", "ls"], maxAgents: 4 }, planFork: "asOf", toolSearch: {},
    codeMode: steamharness.getEnv("STEAMHARNESS_DEVELOPER_ASSISTANT_CODE_MODE") === "true" ? {} : undefined },
  async createTools(context): Promise<AgentToolSet> {
    readAssistantHost();
    const approve = async (toolId: string, args: unknown): Promise<void> => {
      await toolApproval.approve({ name: toolId, arguments: args }, context);
    };

    // Run-scoped Knowledge and KV address the assistant's own store, not the
    // user's project. Studio Control provides editor capabilities separately.
    const capabilityToolIdsToOffer = new Set([
      "workflow-memory_global_memory",
      "workflow-ui_present_card",
    ]);
    const capabilities = (await steamharness.createProjectCapabilityTools({
      context,
      globalMemory: true,
      approve,
    })).filter((tool) => capabilityToolIdsToOffer.has(tool.name));
    const skills = await steamharness.createSkillTools({ directories: [SKILLS_DIRECTORY], approve });
    const control = await createStudioControlTools(approve,
      readDeveloperAssistantPermissionPolicy(context.metadata?.studioControlPermissionPolicy as string | undefined),
      toolId => context.toolPermissions?.getTool(toolId)?.enabled !== false);

    const offered = [...capabilities, ...skills, ...control.tools].filter(
      (tool) => context.toolPermissions?.getTool(tool.name)?.enabled !== false,
    );
    return { tools: offered, ...(control.catalogs ? { catalogs: control.catalogs } : {}) };
  },
});

/**
 * The project declaration.
 *
 * `conversation`, `tokenUsage`, `tools` and `params` have to stay inline
 * object literals: Core reads them off this file's AST to build the structure
 * report the host renders, and anything reached through a function call is
 * invisible to it.
 */
export const executor = steamharness.defineExecutor<AgentInput, AgentOutputPayload>({
  projectType: "conversation",
  workflow: assistantProject,
  conversation: {
    recovery: { enabled: true },
    durable: { enabled: true },
    commands: [
      { command: "export", label: "Export conversation", localizedLabel: { "zh-CN": "导出对话" },
        description: "Export the complete current conversation.", localizedDescription: { "zh-CN": "导出当前会话的全部对话内容。" }, action: { kind: "export" } },
      { command: "compact", label: "Summarize context", localizedLabel: { "zh-CN": "上下文总结" },
        description: "Summarize the agent context now.", localizedDescription: { "zh-CN": "立即总结 Agent 上下文。" }, action: { kind: "prompt", text: "/compact" } },
    ],
    footer: [{ text: "Plan mode", localizedText: { "zh-CN": "Plan 模式" }, when: { param: "plan", value: "true" } }],
    userInput: { effects: [{ when: { type: "agent-plan-approval", values: { decision: "approve" } }, params: { plan: "false" } }] },
    attachments: { images: true },
    inputQueue: { enabled: true },
    openai: {
      enabled: true,
      // Literal on purpose: the structure report is built from this file's
      // AST, and a constant reference reads as no output item at all.
      outputItemId: "developer-assistant-answer",
    },
  },
  tokenUsage: { enabled: true, display: true },
  tools: [
    { name: "tool_search", label: "Find tools", description: "Discover tools in the authorized project catalogs.", enabled: true, autoApprove: true },
    { name: "codemode", label: "Code Mode", description: "Compose authorized tools in an isolated QuickJS script when enabled by the host.", enabled: true, autoApprove: true },
    { name: "update_plan", label: "Task plan", description: "Save task steps and progress in this conversation.", enabled: true, autoApprove: true },
    { name: "subagent", label: "Delegate task", description: "Delegate a task with the project's restricted read-only tools.", enabled: true, autoApprove: true },
    { name: "workflow-studio_studio_state", label: "Studio state", description: "Read the current Studio workspace, editor and supported capabilities.", enabled: true, autoApprove: true },
    { name: "workflow-studio_get_related_projects", label: "Related projects", description: "Read a permitted project's declared related projects and verified Studio imports.", enabled: true, autoApprove: true },
    { name: "workflow-studio_get_diagnostics", label: "Studio diagnostics", description: "Read errors and warnings within the selected permission policy's file scope.", enabled: true, autoApprove: true },
    { name: "workflow-studio_open_file", label: "Open file in Studio", description: "Open a permitted file and reveal a line and column.", enabled: true, autoApprove: false },
    { name: "workflow-studio_set_theme", label: "Studio theme", description: "Change the installed VS Code color theme.", enabled: true, autoApprove: false },
    { name: "workflow-studio_open_terminal", label: "Studio terminal", description: "Open a terminal in a permitted directory without executing commands.", enabled: true, autoApprove: false },
    { name: "workflow-studio_show_view", label: "Studio view", description: "Show Explorer, Search, Source Control, Terminal or Assistant.", enabled: true, autoApprove: false },
    {
      name: "workflow-memory_global_memory",
      label: "Global memory",
      description: "Remember stable user preferences, changes, and project decisions.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "workflow-ui_present_card",
      label: "Conversation resource card",
      description: "Show, update, pin, or remove a file or browser resource card in the conversation.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "skill",
      label: "Skills",
      description: "List the written procedures available for this workspace and read the one a task calls for.",
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
  params: [
    {
      kind: "quick",
      id: "ai",
      label: "AI",
      icon: "sparkle",
      summary: ["model", "effort"],
      fields: [
        {
          name: "provider",
          flag: "--provider",
          type: "string",
          required: true,
          label: "Provider",
          description: "SteamHarness Server system AI configuration.",
          control: "select",
          options: [],
        },
        {
          name: "model",
          flag: "--model",
          type: "string",
          required: true,
          label: "Model",
          description: "Model exposed by the selected system AI configuration.",
          control: "select",
          options: [],
        },
        {
          name: "effort",
          flag: "--effort",
          type: "string",
          required: false,
          label: "Effort",
          description: "思考强度。超出模型支持范围时会自动收敛到该模型支持的档位。",
          defaultValue: "high",
          control: "select",
          options: [
            { value: "", label: "模型默认", description: "交给模型决定。" },
            { value: "off", label: "Off", description: "不做推理。" },
            { value: "minimal", label: "Minimal" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" },
            { value: "max", label: "Max", description: "仅部分模型支持。" },
          ],
        },
      ],
    },
    {
      kind: "slash",
      name: "plan",
      flag: "--plan",
      type: "boolean",
      required: false,
      label: "Plan",
      description: "开启或关闭 Plan 模式。",
      // A literal, because the structure report only carries statically readable defaults.
      defaultValue: "false",
    },
    {
      kind: "quick",
      id: "permission",
      label: "Permission",
      icon: "shield",
      summary: ["permissionPolicy"],
      fields: [
        {
          name: "permissionPolicy",
          flag: "--permission-policy",
          type: "string",
          required: false,
          label: "Permission",
          description: "工具权限策略：read-only 隐藏写入与命令工具，workspace 限定在工作区内，auto 批准一切未被显式拒绝的权限。",
          defaultValue: "auto",
          control: "select",
          options: [
            { value: "read-only", label: "Read only", description: "隐藏写入与命令工具。" },
            { value: "workspace", label: "Workspace", description: "工作区内自动批准编辑和命令；读写与检索工具只能访问工作区与挂载目录，shell 命令不受此限制。" },
            { value: "auto", label: "Auto approve", description: "批准一切未被显式拒绝的权限，包括工作区之外的路径。" },
          ],
        },
      ],
    },
  ],
  resolveParams: steamharness.createAgentProjectParamResolver(),
  createContext({ paramValues }) {
    return { metadata: { studioControlPermissionPolicy: readDeveloperAssistantPermissionPolicy(paramValues.permissionPolicy) } };
  },
  async createInput(context) {
    const workdir = readAssistantWorkdir();
    const manifest = await loadDeveloperAssistantWorkspaceManifest(
      workdir,
      steamharness.getEnv(ASSISTANT_WORKSPACE_MANIFEST_ENV),
    );
    const { paramValues } = context;
    const permissionPolicy = readDeveloperAssistantPermissionPolicy(paramValues.permissionPolicy);
    const openai = steamharness.readOpenAIConversationHostInput(context);

    // Scope and permission policy travel with each run rather than the node.
    const scope: Partial<AgentInput> = {
      workdir,
      allowedDirectories: [
        workdir,
        ...manifest.roots.filter((root) => root.role === "linked").map((root) => root.rootPath),
      ],
      systemPrompt: createDeveloperAssistantSystemPrompt(manifest, readAssistantHost(), permissionPolicy),
    };

    if (openai !== undefined) {
      return {
        ...scope,
        errCode: 0,
        errMessage: "",
        prompt: readOpenAIPrompt(openai),
        images: readOpenAIImages(openai),
        provider: readParamString(paramValues.provider),
        model: readParamString(paramValues.model),
        effort: readAgentEffort(paramValues.effort),
        agent: paramValues.plan === "true" ? "plan" : "build",
        permissionPolicy,
        // The gateway keeps this run's transcript in its own store, so the
        // workflow conversation is left to the turns that came from the
        // composer — the same split the built-in Conversation project makes.
        hostInput: openai,
      } satisfies AgentInput;
    }

    const defaults = steamharness.parseConversationDefaultInputArgs(context.args);
    return {
      ...scope,
      errCode: 0,
      errMessage: "",
      prompt: defaults.message,
      // Attachments travel as the references the composer stored. Only a node
      // has the file store that can read them, so Core's input node turns them
      // into image parts — and a reference nothing can read fails that turn
      // instead of quietly arriving as a model that ignored the picture.
      imageFiles: defaults.images,
      provider: readParamString(paramValues.provider),
      model: readParamString(paramValues.model),
      effort: readAgentEffort(paramValues.effort),
      agent: paramValues.plan === "true" ? "plan" : "build",
      permissionPolicy,
    } satisfies AgentInput;
  },
});

export { assistantProject as workflow };
export default assistantProject;

function readAssistantWorkdir(): string {
  const workdir = (steamharness.getEnv(ASSISTANT_WORKDIR_ENV) ?? "").trim();
  if (workdir === "") {
    throw new steamharness.HarnessError({
      type: "input_validation",
      message: "小助手缺少经过宿主校验的目标工作区目录。",
    });
  }
  return workdir;
}

function readAssistantHost(): DeveloperAssistantHost {
  const host = (steamharness.getEnv("STEAMHARNESS_DEVELOPER_ASSISTANT_HOST") ?? "vscode").trim();
  if (host === "vscode") return host;
  throw new steamharness.HarnessError({ type: "input_validation", message: `Unsupported assistant host: ${host}` });
}

/** The last user message, which is the turn this run answers. */
function readOpenAIPrompt(openai: OpenAIConversationHostInput): string {
  for (let index = openai.messages.length - 1; index >= 0; index -= 1) {
    const message = openai.messages[index];
    if (message?.role !== "user") continue;
    const text = message.content
      .filter((part): part is { type: "input_text"; text: string } => part.type === "input_text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

function readOpenAIImages(openai: OpenAIConversationHostInput): AgentInput["images"] {
  return toDataUrlImages(
    openai.messages
      .flatMap((message) => message.content)
      .flatMap((part) => (part.type === "input_image" ? [part.image_url] : [])),
  );
}

/**
 * Inlines the images an OpenAI host sent.
 *
 * That path already carries the bytes — an `input_image` part is a data URL —
 * so it needs no file store. The composer's attachments are references, and
 * those are resolved by Core instead. A value that is not a data URL carries
 * nothing readable and is left out; the part was malformed, not unreadable.
 */
function toDataUrlImages(urls: readonly string[]): AgentInput["images"] {
  const images: NonNullable<AgentInput["images"]> = [];
  for (const url of urls) {
    const inline = readDataUrl(url);
    if (inline !== undefined) images.push(inline);
  }
  return images;
}

function readDataUrl(value: string): { data: string; mimeType: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(value);
  return match === null ? undefined : { mimeType: match[1]!, data: match[2]! };
}

function readParamString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readAgentEffort(value: string | string[] | undefined): AgentInput["effort"] {
  const effort = readParamString(value);
  return effort === undefined ? undefined : (effort as AgentInput["effort"]);
}

function readDeveloperAssistantPermissionPolicy(
  value: string | string[] | undefined,
): DeveloperAssistantPermissionPolicy {
  const policy = readParamString(value) ?? DEFAULT_DEVELOPER_ASSISTANT_PERMISSION_POLICY;
  if (policy === "read-only" || policy === "workspace" || policy === "auto") return policy;
  throw new Error(`Invalid tool permission policy: ${policy}`);
}
