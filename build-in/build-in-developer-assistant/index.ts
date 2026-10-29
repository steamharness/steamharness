const readHostEnvironment = (key: string) => process.env[key];
import path from "node:path";
import type {
  AgentInput,
  AgentOutputPayload,
  AgentToolSet,
} from "steamharness";
import { createDeveloperAssistantSystemPrompt, type DeveloperAssistantHost } from "./assistant-prompt";
import { steamharness } from "./workflow-runtime";
import { loadDeveloperAssistantWorkspaceManifest } from "./workspace-manifest";
import { createStudioControlTools } from "./studio-control-mcp";
import type {
  DeveloperAssistantPermissionPolicy,
  OpenAIConversationHostInput,
} from "./interface";

const ASSISTANT_WORKDIR_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR";
const ASSISTANT_WORKSPACE_MANIFEST_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST";
const DEFAULT_DEVELOPER_ASSISTANT_PERMISSION_POLICY = "inherit";
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
  modelSource: "user-settings",
  executorName: STEAMHARNESS_NAME,
  outputItemId: OUTPUT_ITEM_ID,
  skills: { directories: [SKILLS_DIRECTORY] },
  session: { subagents: { tools: ["read", "grep", "find", "ls", "skill"], maxAgents: 4 }, planFork: "asOf", toolSearch: {} },
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
    const control = await createStudioControlTools(approve,
      readDeveloperAssistantPermissionPolicy(context.metadata?.studioControlPermissionPolicy as string | undefined),
      toolId => context.toolPermissions?.getTool(toolId)?.enabled !== false);

    const offered = [...capabilities, ...control.tools].filter(
      (tool) => context.toolPermissions?.getTool(tool.name)?.enabled !== false,
    );
    return { tools: offered, ...(control.catalogs ? { catalogs: control.catalogs } : {}) };
  },
});

/**
 * The project declaration.
 *
 * `conversation`, `tokenUsage` and `tools` have to stay inline
 * object literals: Core reads them off this file's AST to build the structure
 * report the host renders, and anything reached through a function call is
 * invisible to it. Core Agent params and their resolver are inherited from the workflow.
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
    { name: "workflow-studio_get_configurations", label: "Project configurations", description: "Query or export local/Server project configurations with the panel closed.", enabled: true, autoApprove: true },
    { name: "workflow-studio_manage_configurations", label: "Manage project configurations", description: "Create, copy, rename, select or delete profiles; set/clear values; manage custom fields and import complete configurations with revision checks; authorized authors can manage publication.save drafts, field and JSON Pointer permissions. Downloaders only edit allowed personal values.", enabled: true, autoApprove: false },
    { name: "workflow-studio_open_configurations", label: "Open project configurations", description: "Display the configuration panel for a specific project and storage.", enabled: true, autoApprove: false },
    { name: "workflow-studio_studio_state", label: "Studio state", description: "Read the current Studio workspace, editor and supported capabilities.", enabled: true, autoApprove: true },
    { name: "workflow-studio_get_entries", label: "Project entries", description: "Read the permitted aggregate project identity and registered entry IDs, names and types.", enabled: true, autoApprove: true },
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

  createContext({ paramValues }) {
    return { metadata: { studioControlPermissionPolicy: readDeveloperAssistantPermissionPolicy(paramValues.permissionPolicy) } };
  },
  async createInput(context) {
    const workdir = readAssistantWorkdir();
    const manifest = await loadDeveloperAssistantWorkspaceManifest(
      workdir,
      readHostEnvironment(ASSISTANT_WORKSPACE_MANIFEST_ENV),
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
  if (policy === "inherit") return steamharness.getUserSettings().agent.permissionPolicy;
  if (policy === "read-only" || policy === "workspace" || policy === "auto") return policy;
  throw new Error(`Invalid tool permission policy: ${policy}`);
}
